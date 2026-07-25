/**
 * tests/messages.test.js
 *
 * Integration tests for POST /api/chats/:chatId/messages.
 * This endpoint streams SSE events, so the tests parse the raw response text
 * to extract and verify each event.
 *
 * The Ollama client is mocked. The first call to mockCreate returns an async
 * iterable (simulating the streaming response). The second call returns a plain
 * object (simulating the title-generation follow-up call).
 */

jest.mock('openai');
const OpenAI = require('openai');

const request = require('supertest');
const { createApp } = require('../server');
const { createDb } = require('../database');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'messages_test.db');

let app;
let db;
let mockCreate;

// Helper: creates an async iterable that yields streaming chunks, mimicking
// what Ollama returns when stream: true is set.
function makeStream(words) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const word of words) {
        yield { choices: [{ delta: { content: word } }] };
      }
      // Final chunk has an empty delta — signals end of stream
      yield { choices: [{ delta: {} }] };
    },
  };
}

// Helper: parse SSE event text into an array of parsed JSON objects.
function parseSSE(text) {
  return text
    .split('\n\n')
    .filter(block => block.startsWith('data: '))
    .map(block => JSON.parse(block.slice(6)));
}

beforeEach(() => {
  mockCreate = jest.fn();
  OpenAI.mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));

  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
  app = createApp(db);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

// ─── Prefix-Warm-up (POST /api/chats/:chatId/messages/warmup) ───────────────
// Öffnet der Nutzer einen Chat, liest das Modell den (Paper-)Kontext schon
// einmal ein — die erste echte Frage trifft dann auf einen warmen KV-Cache.

describe('POST /api/chats/:chatId/messages/warmup', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    // extendOllamaKeepAlive spricht die native Ollama-API — hier gemockt.
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  });
  afterEach(() => { global.fetch = realFetch; });

  it('prefills the exact chat prefix with a 1-token call and pins the model for 1h', async () => {
    const chat = await request(app).post('/api/chats').send({ title: 'Warm' });
    db.prepare('INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('m1', chat.body.id, 'user', 'What is attention?', new Date().toISOString());
    mockCreate.mockResolvedValue({ choices: [{ message: { content: 'x' } }] });

    const res = await request(app).post(`/api/chats/${chat.body.id}/messages/warmup`);

    expect(res.status).toBe(200);
    expect(res.body.warmed).toBe(true);
    // 1-Token-Prefill mit demselben Prefix wie eine echte Nachricht:
    // System-Prompt + komplette Historie, Denken aus.
    const call = mockCreate.mock.calls[0][0];
    expect(call.max_tokens).toBe(1);
    expect(call.reasoning_effort).toBe('none');
    expect(call.messages[0].role).toBe('system');
    expect(call.messages.at(-1)).toMatchObject({ role: 'user', content: 'What is attention?' });
    // TTL-Verlängerung über die native API (keep_alive wird von /v1 ignoriert).
    const keepAliveCall = global.fetch.mock.calls.find(c => String(c[0]).endsWith('/api/generate'));
    expect(keepAliveCall).toBeDefined();
    expect(JSON.parse(keepAliveCall[1].body)).toMatchObject({ keep_alive: '1h', prompt: '' });
  });

  it('returns 404 for an unknown chat', async () => {
    const res = await request(app).post('/api/chats/nope/messages/warmup');
    expect(res.status).toBe(404);
  });

  it('aborts an in-flight warm-up as soon as a real message arrives', async () => {
    // Warm-up ist Vorleistung — er darf eine echte Frage nie blockieren.
    // Gemessen 2026-07-21: ohne Abbruch wartete die Frage bis zu ~40 s
    // (Paper-Prefill) in Ollamas Warteschlange.
    const chat = await request(app).post('/api/chats').send({ title: 'Busy' });

    // Der Warm-up hängt (simulierter langer Paper-Prefill) bis zum Abort.
    let warmupSignal;
    mockCreate.mockImplementationOnce((_payload, opts) => {
      warmupSignal = opts?.signal;
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('Request was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const warmupPromise = request(app)
      .post(`/api/chats/${chat.body.id}/messages/warmup`)
      .then(r => r);
    await new Promise(r => setTimeout(r, 25));
    expect(warmupSignal).toBeDefined();
    expect(warmupSignal.aborted).toBe(false);

    // Echte Nachricht → Warm-up muss sofort abgebrochen werden.
    mockCreate.mockResolvedValueOnce(makeStream(['Quick answer']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Title' } }] });
    const msgRes = await request(app)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({ content: 'Now!' })
      .buffer(true);

    const warmupRes = await warmupPromise;
    expect(warmupSignal.aborted).toBe(true);
    expect(warmupRes.body.warmed).toBe(false);
    expect(parseSSE(msgRes.text).find(e => e.done)).toBeDefined();
  });

  it('a newer warm-up supersedes and aborts the previous one', async () => {
    const chatA = await request(app).post('/api/chats').send({ title: 'A' });
    const chatB = await request(app).post('/api/chats').send({ title: 'B' });

    let firstSignal;
    mockCreate.mockImplementationOnce((_payload, opts) => {
      firstSignal = opts?.signal;
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('Request was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const first = request(app).post(`/api/chats/${chatA.body.id}/messages/warmup`).then(r => r);
    await new Promise(r => setTimeout(r, 25));

    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'x' } }] });
    const second = await request(app).post(`/api/chats/${chatB.body.id}/messages/warmup`);

    await first;
    expect(firstSignal.aborted).toBe(true);
    expect(second.body.warmed).toBe(true);
  });

  it('reports partial GPU residency (ollama /api/ps) in the warm-up result', async () => {
    // size_vram < size heißt CPU-Offloading — die UI zeigt dann eine Warnung.
    global.fetch = jest.fn().mockImplementation((url) => {
      if (String(url).endsWith('/api/ps')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ models: [{ name: 'qwen3.5:9b', size: 1000, size_vram: 620 }] }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    const chat = await request(app).post('/api/chats').send({ title: 'GPU' });
    mockCreate.mockResolvedValue({ choices: [{ message: { content: 'x' } }] });

    const res = await request(app).post(`/api/chats/${chat.body.id}/messages/warmup`);

    expect(res.body.warmed).toBe(true);
    expect(res.body.gpu).toEqual({ vramPercent: 62, sizeBytes: 1000, vramBytes: 620 });
  });

  it('does nothing for cloud providers — there is no local cache to warm', async () => {
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'openai');
    setSetting(db, 'openai_api_key', 'sk-test');
    const chat = await request(app).post('/api/chats').send({ title: 'Cloud' });

    const res = await request(app).post(`/api/chats/${chat.body.id}/messages/warmup`);

    expect(res.status).toBe(200);
    expect(res.body.warmed).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// ─── Validation ─────────────────────────────────────────────────────────────

describe('POST /api/chats/:chatId/messages – validation', () => {
  it('returns 400 when content is missing', async () => {
    // Create a real chat first so the route can find it
    const chat = await request(app).post('/api/chats').send({ title: 'Test' });
    const res = await request(app)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 when the chat does not exist', async () => {
    // No mock needed — the route checks the DB before calling Ollama
    const res = await request(app)
      .post('/api/chats/nonexistent-id/messages')
      .send({ content: 'Hello' });
    expect(res.status).toBe(404);
  });
});

// ─── Streaming response ──────────────────────────────────────────────────────

describe('POST /api/chats/:chatId/messages – streaming', () => {
  let chatId;

  beforeEach(async () => {
    const chat = await request(app).post('/api/chats').send({ title: 'Stream Test' });
    chatId = chat.body.id;
  });

  it('streams delta events for each word', async () => {
    // First call: streaming response with two words
    mockCreate.mockResolvedValueOnce(makeStream(['Hello', ' world']));
    // Second call: title generation (non-streaming)
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Hello World Chat' } }],
    });

    const res = await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .send({ content: 'Hi' })
      .buffer(true);

    const events = parseSSE(res.text);
    const deltas = events.filter(e => e.delta).map(e => e.delta);
    expect(deltas).toEqual(['Hello', ' world']);
  });

  it('ends the stream with a done event containing both messages', async () => {
    mockCreate.mockResolvedValueOnce(makeStream(['Test reply']));
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Test Chat Title' } }],
    });

    const res = await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .send({ content: 'Hello' })
      .buffer(true);

    const events = parseSSE(res.text);
    const doneEvent = events.find(e => e.done);

    expect(doneEvent).toBeDefined();
    expect(doneEvent.userMessage.role).toBe('user');
    expect(doneEvent.userMessage.content).toBe('Hello');
    expect(doneEvent.assistantMessage.role).toBe('assistant');
    expect(doneEvent.assistantMessage.content).toBe('Test reply');
  });

  it('disables thinking by default so answers start immediately', async () => {
    mockCreate.mockResolvedValueOnce(makeStream(['Fast reply']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Title' } }] });

    await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .send({ content: 'Hi' })
      .buffer(true);

    // Both the chat call and the title call must suppress the hidden
    // chain of thought (Ollama /v1 maps reasoning_effort 'none' → think off).
    expect(mockCreate.mock.calls[0][0].reasoning_effort).toBe('none');
    expect(mockCreate.mock.calls[1][0].reasoning_effort).toBe('none');
  });

  it('lets the model think when asked, streaming thoughts live but never into the answer', async () => {
    // Thinking models stream the chain of thought as `reasoning` deltas.
    mockCreate.mockResolvedValueOnce({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { reasoning: 'Let me consider' } }] };
        yield { choices: [{ delta: { reasoning: ' the question…' } }] };
        yield { choices: [{ delta: { content: 'Considered' } }] };
        yield { choices: [{ delta: { content: ' answer' } }] };
        yield { choices: [{ delta: {} }] };
      },
    });
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Title' } }] });

    const res = await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .send({ content: 'Hard question', think: true })
      .buffer(true);

    // The chat call must NOT suppress thinking…
    expect(mockCreate.mock.calls[0][0].reasoning_effort).toBeUndefined();

    const events = parseSSE(res.text);
    // …the frontend gets a status event to show tips & quotes…
    expect(events.some(e => e.thinking === true)).toBe(true);
    // …the chain of thought streams live as separate reasoning events for
    // the collapsible thinking panel…
    const reasoning = events.filter(e => e.reasoning).map(e => e.reasoning).join('');
    expect(reasoning).toBe('Let me consider the question…');
    // …but never mixes into the answer text or the DB.
    const deltas = events.filter(e => e.delta).map(e => e.delta).join('');
    expect(deltas).toBe('Considered answer');
    const done = events.find(e => e.done);
    expect(done.assistantMessage.content).toBe('Considered answer');
    const saved = db.prepare(
      "SELECT content FROM messages WHERE chat_id = ? AND role = 'assistant'"
    ).get(chatId);
    expect(saved.content).toBe('Considered answer');
  });

  it('reports latency metrics as a perf event and requests token usage', async () => {
    // Der usage-Chunk kommt als letzter Chunk mit leerem choices-Array
    // (stream_options.include_usage) — daraus entsteht das perf-Event.
    mockCreate.mockResolvedValueOnce({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: 'Hi' } }] };
        yield { choices: [{ delta: {} }] };
        yield { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 42 } };
      },
    });
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Title' } }] });

    const res = await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .send({ content: 'Hi' })
      .buffer(true);

    expect(mockCreate.mock.calls[0][0].stream_options).toEqual({ include_usage: true });

    const perf = parseSSE(res.text).find(e => e.perf)?.perf;
    expect(perf).toBeDefined();
    expect(perf.promptTokens).toBe(1200);
    expect(perf.completionTokens).toBe(42);
    expect(typeof perf.ttftMs).toBe('number');
    expect(typeof perf.totalMs).toBe('number');
  });

  it('keeps the already-streamed partial answer when the stream aborts', async () => {
    // Der Stop-Button bricht die Upstream-Anfrage ab — das SDK wirft dann
    // einen AbortError mitten im Stream. Was schon da ist, bleibt erhalten.
    mockCreate.mockResolvedValueOnce({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: 'Partial' } }] };
        yield { choices: [{ delta: { content: ' answer' } }] };
        const err = new Error('Request was aborted.');
        err.name = 'AbortError';
        throw err;
      },
    });
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Title' } }] });

    const res = await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .send({ content: 'Hello' })
      .buffer(true);

    // Der Client-Abbruch wird per AbortSignal an das SDK durchgereicht.
    expect(mockCreate.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);

    const events = parseSSE(res.text);
    const done = events.find(e => e.done);
    expect(done.assistantMessage.content).toBe('Partial answer');

    const saved = db.prepare(
      "SELECT content FROM messages WHERE chat_id = ? AND role = 'assistant'"
    ).all(chatId);
    expect(saved).toHaveLength(1);
    expect(saved[0].content).toBe('Partial answer');
  });

  it('saves both messages to the database after streaming', async () => {
    mockCreate.mockResolvedValueOnce(makeStream(['DB test reply']));
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'DB Test Title' } }],
    });

    await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .send({ content: 'Save me' })
      .buffer(true);

    // Verify the messages were persisted by fetching the chat
    const chatRes = await request(app).get(`/api/chats/${chatId}`);
    expect(chatRes.body.messages).toHaveLength(2);
    expect(chatRes.body.messages[0].role).toBe('user');
    expect(chatRes.body.messages[0].content).toBe('Save me');
    expect(chatRes.body.messages[1].role).toBe('assistant');
    expect(chatRes.body.messages[1].content).toBe('DB test reply');
  });

  it('title generation reuses the conversation prompt prefix instead of evicting it', async () => {
    // Ollama hat nur EINEN Cache-Slot (Vision-Modelle: Parallel:1). Ein
    // Standalone-Titel-Prompt würde den Paper-Prefix verdrängen; deshalb
    // muss der Titel-Aufruf byte-identisch mit dem Gesprächs-Prefix beginnen.
    mockCreate.mockResolvedValueOnce(makeStream(['The answer']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Neat Title' } }] });

    await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .send({ content: 'First question' })
      .buffer(true);

    const streamCall = mockCreate.mock.calls[0][0];
    const titleCall = mockCreate.mock.calls[1][0];
    expect(titleCall.messages.slice(0, streamCall.messages.length)).toEqual(streamCall.messages);
    expect(titleCall.tools).toEqual(streamCall.tools);
    expect(titleCall.messages.at(-2)).toEqual({ role: 'assistant', content: 'The answer' });
    expect(titleCall.messages.at(-1).content).toContain('2 to 4 word title');
  });

  it('auto-generates and saves the chat title after the first message', async () => {
    mockCreate.mockResolvedValueOnce(makeStream(['Reply']));
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Auto Generated Title' } }],
    });

    await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .send({ content: 'Hello' })
      .buffer(true);

    const chatRes = await request(app).get(`/api/chats/${chatId}`);
    expect(chatRes.body.title).toBe('Auto Generated Title');
  });
});

// ─── Prompt-Prefix-Stabilität (KV-Cache) ─────────────────────────────────────
// Ollamas Prefix-Cache greift nur, wenn Warm-up und echte Anfrage byte-
// identisch beginnen — inklusive Paper-Text, Historie und Tool-Definitionen.

describe('prompt prefix stability between warm-up and real message', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  });
  afterEach(() => { global.fetch = realFetch; });

  it('the real prompt equals the warm-up prompt plus the new user message', async () => {
    const paperApp = createApp(db, {
      messages: { extractPdfTextFn: jest.fn().mockResolvedValue('FULL PAPER TEXT') },
    });
    const chat = await request(paperApp).post('/api/chats').send({ title: 'Prefix' });
    db.prepare(
      'INSERT INTO papers (id, title, uploaded_at, pdf_path, status) VALUES (?, ?, ?, ?, ?)'
    ).run('paper-1', 'Attention Is All You Need', new Date().toISOString(), '/fake/paper.pdf', 'ready');
    db.prepare('UPDATE chats SET paper_id = ? WHERE id = ?').run('paper-1', chat.body.id);
    const mkMsg = db.prepare(
      'INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    mkMsg.run('m1', chat.body.id, 'user', 'First question', '2026-01-01T00:00:01Z');
    mkMsg.run('m2', chat.body.id, 'assistant', 'First answer', '2026-01-01T00:00:02Z');

    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'x' } }] });
    await request(paperApp).post(`/api/chats/${chat.body.id}/messages/warmup`);
    const warmupCall = mockCreate.mock.calls[0][0];

    mockCreate.mockResolvedValueOnce(makeStream(['Second answer']));
    await request(paperApp)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({ content: 'Second question' })
      .buffer(true);
    const realCall = mockCreate.mock.calls[1][0];

    // Byte-identischer Prefix: gleiche Tools, gleiche Messages — die echte
    // Anfrage hängt nur die neue User-Nachricht ans Ende.
    expect(realCall.tools).toEqual(warmupCall.tools);
    expect(realCall.messages.slice(0, -1)).toEqual(warmupCall.messages);
    expect(realCall.messages.at(-1)).toEqual({ role: 'user', content: 'Second question' });
    expect(warmupCall.messages[0].content).toContain('FULL PAPER TEXT');
  });
});

// ─── Parent chat context ─────────────────────────────────────────────────────

describe('POST /api/chats/:chatId/messages – parent context', () => {
  it('includes parent chat messages in the system prompt for child chats', async () => {
    // Create parent chat and send a message to it
    const parent = await request(app).post('/api/chats').send({ title: 'Parent' });
    mockCreate.mockResolvedValueOnce(makeStream(['Parent reply']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Parent Title' } }] });
    await request(app)
      .post(`/api/chats/${parent.body.id}/messages`)
      .send({ content: 'Parent question' })
      .buffer(true);

    // Create a child chat branched from the parent. Branch creation kicks off
    // the background summary warm-up — queue its LLM reply and let it flush
    // before queuing the mocks for the actual message.
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Parent summary.' } }] });
    const child = await request(app).post('/api/chats').send({
      title: 'Child',
      parent_id: parent.body.id,
      parent_word: 'quantum',
    });
    await new Promise(r => setTimeout(r, 25));

    mockCreate.mockResolvedValueOnce(makeStream(['Child reply']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Child Title' } }] });

    await request(app)
      .post(`/api/chats/${child.body.id}/messages`)
      .send({ content: 'Child question' })
      .buffer(true);

    // The system message should reference the parent word and include parent context
    const branchCall = mockCreate.mock.calls.find(c =>
      c[0].messages.some(m => m.role === 'system' && m.content.includes('exploring the term'))
    );
    const systemMessage = branchCall[0].messages.find(m => m.role === 'system');
    expect(systemMessage.content).toContain('quantum');
    expect(systemMessage.content).toContain('Parent question');
  });
});

// ─── Ancestor context (multi-level) ──────────────────────────────────────────

describe('POST /api/chats/:chatId/messages – ancestor context', () => {
  it('gives a grandchild the grandparent as summary and the parent verbatim', async () => {
    // Build root → mid → leaf directly in the DB (module-level seams are
    // tested in ancestor-context.test.js; this verifies the HTTP wiring).
    const now = new Date().toISOString();
    const mkChat = db.prepare(
      'INSERT INTO chats (id, title, parent_id, parent_word, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    const mkMsg = db.prepare(
      'INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    mkChat.run('root', 'Transformers', null, null, now);
    mkMsg.run('m1', 'root', 'user', 'Explain transformers.', '2026-01-01T00:00:01Z');
    mkMsg.run('m2', 'root', 'assistant', 'They rely on self-attention.', '2026-01-01T00:00:02Z');
    mkChat.run('mid', 'Attention', 'root', 'attention', now);
    mkMsg.run('m3', 'mid', 'user', 'What is attention exactly?', '2026-01-01T00:00:03Z');
    mkChat.run('leaf', 'Softmax', 'mid', 'softmax', now);

    // Call order: 1) root summary generation, 2) streaming answer, 3) title
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'ROOT SUMMARY about self-attention.' } }],
    });
    mockCreate.mockResolvedValueOnce(makeStream(['Leaf reply']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'T' } }] });

    await request(app)
      .post('/api/chats/leaf/messages')
      .send({ content: 'And what does softmax do here?' })
      .buffer(true);

    const streamCall = mockCreate.mock.calls.find(c => c[0].stream || c[0].tools) || mockCreate.mock.calls[1];
    const systemMessage = streamCall[0].messages.find(m => m.role === 'system');

    // Grandparent only as summary, not verbatim
    expect(systemMessage.content).toContain('ROOT SUMMARY about self-attention.');
    expect(systemMessage.content).not.toContain('Explain transformers.');
    // Parent verbatim
    expect(systemMessage.content).toContain('What is attention exactly?');
    // parent_word chain
    expect(systemMessage.content).toContain('Transformers → attention → softmax');
  });
});

// ─── Paper context ───────────────────────────────────────────────────────────

describe('POST /api/chats/:chatId/messages – paper context', () => {
  // App with an injected fake PDF-text extractor (no real pdf.js in this suite).
  function appWithExtractor(extractFn) {
    return createApp(db, { messages: { extractPdfTextFn: extractFn } });
  }

  function bindPaperToChat(chatId) {
    db.prepare(
      'INSERT INTO papers (id, title, uploaded_at, pdf_path, status) VALUES (?, ?, ?, ?, ?)',
    ).run('paper-1', 'Attention Is All You Need', new Date().toISOString(), '/fake/paper.pdf', 'ready');
    db.prepare('UPDATE chats SET paper_id = ? WHERE id = ?').run('paper-1', chatId);
  }

  it('includes the attached paper text in the system prompt', async () => {
    const paperApp = appWithExtractor(jest.fn().mockResolvedValue('THE TRANSFORMER PAPER FULL TEXT'));
    const chat = await request(paperApp).post('/api/chats').send({ title: 'Paper Chat' });
    bindPaperToChat(chat.body.id);

    mockCreate.mockResolvedValueOnce(makeStream(['Summary…']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Paper Title' } }] });

    await request(paperApp)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({ content: 'give me a summary' })
      .buffer(true);

    const systemMessage = mockCreate.mock.calls[0][0].messages.find(m => m.role === 'system');
    expect(systemMessage.content).toContain('Attention Is All You Need');
    expect(systemMessage.content).toContain('THE TRANSFORMER PAPER FULL TEXT');
  });

  it('branch chats inherit the tree paper context', async () => {
    const paperApp = appWithExtractor(jest.fn().mockResolvedValue('ROOT PAPER TEXT'));
    const root = await request(paperApp).post('/api/chats').send({ title: 'Root' });
    bindPaperToChat(root.body.id);
    const child = await request(paperApp).post('/api/chats').send({
      title: 'Child',
      parent_id: root.body.id,
      parent_word: 'attention',
    });

    mockCreate.mockResolvedValueOnce(makeStream(['Reply']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'T' } }] });

    await request(paperApp)
      .post(`/api/chats/${child.body.id}/messages`)
      .send({ content: 'what does the paper say?' })
      .buffer(true);

    const systemMessage = mockCreate.mock.calls[0][0].messages.find(m => m.role === 'system');
    expect(systemMessage.content).toContain('ROOT PAPER TEXT');
  });

  it('degrades to a normal chat when extraction fails', async () => {
    const paperApp = appWithExtractor(jest.fn().mockRejectedValue(new Error('corrupt')));
    const chat = await request(paperApp).post('/api/chats').send({ title: 'Broken PDF' });
    bindPaperToChat(chat.body.id);

    mockCreate.mockResolvedValueOnce(makeStream(['Still works']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'T' } }] });

    const res = await request(paperApp)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({ content: 'hello' })
      .buffer(true);

    const events = parseSSE(res.text);
    expect(events.filter(e => e.delta).map(e => e.delta)).toEqual(['Still works']);
    const systemMessage = mockCreate.mock.calls[0][0].messages.find(m => m.role === 'system');
    expect(systemMessage.content).not.toContain('PAPER TEXT START');
  });
});

// ─── Latenz-Log (perf) am echten Endpoint ────────────────────────────────────
// Die [perf]-Zeile trägt Modus/Cache/Quellengröße; Gesprächsinhalte NIE.

describe('POST /api/chats/:chatId/messages – perf logging', () => {
  let logSpy;
  beforeEach(() => { logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { logSpy.mockRestore(); });

  it('logs an enriched [perf] line with mode and cache, without leaking the question', async () => {
    const chat = await request(app).post('/api/chats').send({ title: 'Perf' });
    mockCreate.mockResolvedValueOnce({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: 'Hi' } }] };
        yield { choices: [{ delta: {} }] };
        yield { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 42 } };
      },
    });
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Title' } }] });

    const SECRET = 'PINEAPPLE-onboarding-passphrase';
    await request(app)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({ content: `Tell me about ${SECRET}` })
      .buffer(true);

    const perfLine = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('[perf]'));
    expect(perfLine).toBeDefined();
    expect(perfLine).toContain('mode=none'); // Chat ohne Quelle
    expect(perfLine).toContain('cache=cold'); // erste Frage
    expect(perfLine).toContain('prompt_tokens=1200');
    // Datenschutz: die Frage selbst darf NIE im Log stehen.
    expect(perfLine).not.toContain(SECRET);
  });
});

// ─── Retrieval-Modus für lange Quellen (ADR-0006) ────────────────────────────
// Papers, die das Kontextfenster sprengen, werden nicht mehr stumpf gekappt:
// der System-Prompt bekommt ein stabiles Skeleton (Anfang + Gliederung +
// Ende), und pro Frage wandern die passendsten Chunks als eigener Block
// HINTER die Historie — der KV-Cache-Prefix bleibt byte-identisch.

describe('POST /api/chats/:chatId/messages – retrieval mode for long papers', () => {
  const FACT_PARA =
    'Rotary positional encodings twist query and key vectors by an angle proportional to position.';

  // > MAX_SYSTEM_CONTEXT_CHARS (~40k), FACT_PARA tief in der Mitte — weit
  // hinter dem Skeleton-Anfang und vor dem Skeleton-Ende.
  function longPaperText() {
    const paras = Array.from(
      { length: 520 },
      (_, i) => `Paragraph ${i} discussing unrelated background material in sufficient detail to fill space.`
    );
    paras[260] = FACT_PARA;
    return paras.join('\n\n');
  }

  // Deterministische Fake-Embeddings: nur der FACT-Absatz (und die Frage
  // danach) zeigen auf Achse 0.
  const fakeEmbed = jest.fn(async (texts) =>
    texts.map((t) => (t.includes('positional encodings') ? [1, 0] : [0, 1]))
  );

  function retrievalApp() {
    return createApp(db, {
      messages: {
        extractPdfTextFn: jest.fn().mockResolvedValue(longPaperText()),
        embedTextsFn: fakeEmbed,
      },
    });
  }

  function bindPaper(chatId) {
    db.prepare(
      'INSERT INTO papers (id, title, uploaded_at, pdf_path, status) VALUES (?, ?, ?, ?, ?)'
    ).run('paper-long', 'RoFormer', new Date().toISOString(), '/fake/long.pdf', 'ready');
    db.prepare('UPDATE chats SET paper_id = ? WHERE id = ?').run('paper-long', chatId);
  }

  it('sends the skeleton in the system prompt and the retrieved chunks after the history', async () => {
    const app2 = retrievalApp();
    const chat = await request(app2).post('/api/chats').send({ title: 'Long' });
    bindPaper(chat.body.id);
    mockCreate.mockResolvedValueOnce(makeStream(['Answer']));

    await request(app2)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({ content: 'Explain rotary positional encodings' })
      .buffer(true);

    const call = mockCreate.mock.calls[0][0];
    const system = call.messages[0];
    // Skeleton statt Volltext im System-Prompt …
    expect(system.content).toContain('PAPER SKELETON START');
    expect(system.content).not.toContain('PAPER TEXT START');
    // … der FACT-Absatz aus der Dokument-Mitte steht NICHT im Prefix …
    expect(system.content).not.toContain(FACT_PARA);
    // … sondern im Auszugs-Block direkt vor der User-Nachricht.
    const excerpts = call.messages.at(-2);
    expect(excerpts.role).toBe('system');
    expect(excerpts.content).toContain('EXCERPTS');
    expect(excerpts.content).toContain(FACT_PARA);
    expect(call.messages.at(-1)).toMatchObject({
      role: 'user',
      content: 'Explain rotary positional encodings',
    });
    // Chunks liegen persistent in source_chunks (einmalig eingebettet).
    const n = db.prepare("SELECT COUNT(*) AS n FROM source_chunks WHERE source_id = 'paper-long'").get().n;
    expect(n).toBeGreaterThan(5);
  });

  it('keeps the warm-up prefix stable: real prompt = warm-up prompt + excerpts + question', async () => {
    const realFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    try {
      const app2 = retrievalApp();
      const chat = await request(app2).post('/api/chats').send({ title: 'Warm long' });
      bindPaper(chat.body.id);

      mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'x' } }] });
      await request(app2).post(`/api/chats/${chat.body.id}/messages/warmup`);
      const warmupCall = mockCreate.mock.calls[0][0];

      mockCreate.mockResolvedValueOnce(makeStream(['Answer']));
      await request(app2)
        .post(`/api/chats/${chat.body.id}/messages`)
        .send({ content: 'Explain rotary positional encodings' })
        .buffer(true);
      const realCall = mockCreate.mock.calls[1][0];

      // Der Warm-up-Prompt ist exakt der Prefix der echten Anfrage — nur
      // Auszugs-Block und neue Frage kommen hinten dazu.
      expect(realCall.messages.slice(0, warmupCall.messages.length)).toEqual(warmupCall.messages);
      expect(realCall.messages.length).toBe(warmupCall.messages.length + 2);
    } finally {
      global.fetch = realFetch;
    }
  });

  it('falls back to the old full-text truncation when embedding is unavailable', async () => {
    const app2 = createApp(db, {
      messages: {
        extractPdfTextFn: jest.fn().mockResolvedValue(longPaperText()),
        embedTextsFn: jest.fn().mockRejectedValue(new Error('model "nomic-embed-text" not found')),
      },
    });
    const chat = await request(app2).post('/api/chats').send({ title: 'No embed' });
    bindPaper(chat.body.id);
    mockCreate.mockResolvedValueOnce(makeStream(['Still answers']));

    const res = await request(app2)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({ content: 'Explain rotary positional encodings' })
      .buffer(true);

    // Kein Retrieval — aber der Chat funktioniert wie vor ADR-0006.
    const call = mockCreate.mock.calls[0][0];
    const system = call.messages[0];
    expect(system.content).toContain('PAPER TEXT START');
    expect(system.content).not.toContain('PAPER SKELETON');
    expect(parseSSE(res.text).find(e => e.done)).toBeDefined();
  });

  it('leaves short papers on the full-text path (no skeleton, no chunks)', async () => {
    const app2 = createApp(db, {
      messages: {
        extractPdfTextFn: jest.fn().mockResolvedValue('SHORT PAPER FULL TEXT'),
        embedTextsFn: fakeEmbed,
      },
    });
    const chat = await request(app2).post('/api/chats').send({ title: 'Short' });
    bindPaper(chat.body.id);
    mockCreate.mockResolvedValueOnce(makeStream(['Answer']));

    await request(app2)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({ content: 'Summarize' })
      .buffer(true);

    const call = mockCreate.mock.calls[0][0];
    expect(call.messages[0].content).toContain('SHORT PAPER FULL TEXT');
    expect(call.messages[0].content).not.toContain('SKELETON');
    const n = db.prepare("SELECT COUNT(*) AS n FROM source_chunks WHERE source_id = 'paper-long'").get().n;
    expect(n).toBe(0);
  });
});

// ─── Sprachspiegelung (Grill-Entscheidung 2026-07-23) ────────────────────────
// Antwort, Titel und Summaries folgen der Sprache des Nutzers — Deutsch rein,
// Deutsch raus; gemischte Nachrichten → dominante Sprache.

describe('POST /api/chats/:chatId/messages – language mirroring', () => {
  let chatId;

  beforeEach(async () => {
    const chat = await request(app).post('/api/chats').send({ title: 'New Chat' });
    chatId = chat.body.id;
  });

  it('instructs the model to render math with $…$ and never bare carets', async () => {
    mockCreate.mockResolvedValueOnce(makeStream(['Antwort']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Titel' } }] });

    await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .send({ content: 'Was ist 10 hoch 50?' })
      .buffer(true);

    const systemMessage = mockCreate.mock.calls[0][0].messages.find((m) => m.role === 'system');
    // Hochzahlen/Formeln gehören in $…$ (rendert als 10^{50}), rohe ^/_ sind verboten.
    expect(systemMessage.content).toMatch(/\$…\$|\$\\dots\$|inline math|\$10\^\{50\}\$/i);
    expect(systemMessage.content).toMatch(/exponent|superscript|\^/);
  });

  it('instructs the model to reply in the language of the latest user message', async () => {
    mockCreate.mockResolvedValueOnce(makeStream(['Antwort']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Titel' } }] });

    await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .send({ content: 'Was ist Attention?' })
      .buffer(true);

    const systemMessage = mockCreate.mock.calls[0][0].messages.find(m => m.role === 'system');
    expect(systemMessage.content).toMatch(/language of the user's most recent message/i);
  });

  it('instructs the title call to write the title in the conversation language', async () => {
    mockCreate.mockResolvedValueOnce(makeStream(['Antwort']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Titel' } }] });

    await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .send({ content: 'Was ist Attention?' })
      .buffer(true);

    const titleCall = mockCreate.mock.calls[1][0];
    const instruction = titleCall.messages.at(-1).content;
    expect(instruction).toContain('2 to 4 word title');
    expect(instruction).toMatch(/language of the conversation/i);
  });
});

// ─── Custom instructions (Grill 2026-07-23) ──────────────────────────────────
// Nutzer-Freitext aus den Settings, der jedem Chat-System-Prompt mitgegeben
// wird — mit explizitem Vorrang vor den eingebauten Stilregeln. Gilt NUR für
// Chat-Antworten (+ Warm-up, gleicher Prefix!), nicht für Titel.

describe('POST /api/chats/:chatId/messages – custom instructions', () => {
  const { setSetting } = require('../llm');

  async function sendMessage(content = 'Hallo, wie geht es dir?') {
    const chat = await request(app).post('/api/chats').send({ title: 'Deutsch' });
    mockCreate.mockResolvedValueOnce(makeStream(['Gut!']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Titel' } }] });
    await request(app).post(`/api/chats/${chat.body.id}/messages`).send({ content }).buffer(true);
    return chat.body.id;
  }

  function systemMessageOf(call) {
    return call[0].messages.find(m => m.role === 'system');
  }

  it('injects the instructions with an explicit precedence frame when enabled', async () => {
    setSetting(db, 'custom_instructions', 'Correct my German after every answer.');

    await sendMessage();

    const system = systemMessageOf(mockCreate.mock.calls[0]);
    expect(system.content).toContain('Correct my German after every answer.');
    // Vorrang-Rahmung: Nutzer-Anweisungen schlagen die eingebauten Stilregeln.
    expect(system.content).toMatch(/take precedence over the style rules above/i);
  });

  it('omits them when the toggle is off — the text stays saved but inert', async () => {
    setSetting(db, 'custom_instructions', 'Correct my German after every answer.');
    setSetting(db, 'custom_instructions_enabled', 'false');

    await sendMessage();

    const system = systemMessageOf(mockCreate.mock.calls[0]);
    expect(system.content).not.toContain('Correct my German');
    expect(system.content).not.toMatch(/custom instructions/i);
  });

  it('adds no frame at all while the text is empty (default)', async () => {
    await sendMessage();

    const system = systemMessageOf(mockCreate.mock.calls[0]);
    expect(system.content).not.toMatch(/custom instructions/i);
  });

  it('keeps the cloud title prompt free of custom instructions (scope: chat replies only)', async () => {
    // Scope-Entscheidung (Grill 2026-07-23): Titel bleiben unberührt. Auf
    // Ollama teilt der Titel-Aufruf ABSICHTLICH den Gesprächs-Prefix (ein
    // KV-Slot, Messung 2026-07-21) — dort fährt der Block als Cache-Ballast
    // mit, die Titel-Anweisung am Ende regiert. Nur der Cloud-Pfad hat einen
    // eigenen Mini-Prompt, und der muss sauber bleiben.
    setSetting(db, 'custom_instructions', 'Correct my German after every answer.');
    setSetting(db, 'llm_provider', 'openai');
    setSetting(db, 'openai_api_key', 'sk-test');

    await sendMessage();

    const titleCall = mockCreate.mock.calls[1];
    for (const m of titleCall[0].messages) {
      expect(m.content).not.toContain('Correct my German');
    }
  });

  it('appends the title instruction after the shared prefix on Ollama (cache stays warm)', async () => {
    setSetting(db, 'custom_instructions', 'Correct my German after every answer.');

    await sendMessage();

    // Letzte Nachricht des Titel-Aufrufs ist die Titel-Anweisung — der davor
    // liegende Prefix (inkl. Custom-Instructions-Block) ist identisch mit dem
    // Gesprächs-Prompt, sonst verdrängt der Titel den teuren KV-Prefix.
    const titleCall = mockCreate.mock.calls[1];
    const streamCall = mockCreate.mock.calls[0];
    expect(titleCall[0].messages.at(-1).content).toMatch(/title/i);
    expect(titleCall[0].messages[0]).toEqual(streamCall[0].messages[0]);
  });

  it('sends the identical instruction block in the warm-up (KV-cache prefix)', async () => {
    const realFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    try {
      setSetting(db, 'custom_instructions', 'Correct my German after every answer.');
      const chat = await request(app).post('/api/chats').send({ title: 'Warm' });
      mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'x' } }] });

      await request(app).post(`/api/chats/${chat.body.id}/messages/warmup`);

      const system = systemMessageOf(mockCreate.mock.calls[0]);
      expect(system.content).toContain('Correct my German after every answer.');
    } finally {
      global.fetch = realFetch;
    }
  });
});

// ─── Sende-Warteschlange, Fehler-Marker und Regenerate (2026-07-24) ─────────
// Ollama hat einen KV-Slot: gleichzeitige Fragen laufen FIFO durch eine
// Backend-Warteschlange (User-Insert erst beim Dequeue → Antwort 1 steht in
// Frage 2s Kontext). Fehler persistieren einen '*Failed*'-Marker statt stumm
// zu verschwinden; /regenerate beantwortet die letzte Frage neu ohne Duplikat.

describe('POST /api/chats/:chatId/messages – send queue', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  });
  afterEach(() => { global.fetch = realFetch; });

  // Chat mit Historie + eigenem Titel: msgCount > 2 ⇒ keine Titel-Aufrufe,
  // die die mockCreate-Zählung verwässern würden.
  async function seedChatWithHistory() {
    const chat = await request(app).post('/api/chats').send({ title: 'Queue Test' });
    const insert = db.prepare(
      'INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    insert.run('h1', chat.body.id, 'user', 'Earlier question', '2026-07-24T00:00:00.000Z');
    insert.run('h2', chat.body.id, 'assistant', 'Earlier answer', '2026-07-24T00:00:01.000Z');
    return chat.body.id;
  }

  it('answers concurrent questions strictly in order, with answer 1 in question 2\'s context', async () => {
    const chatId = await seedChatWithHistory();

    // Antwort 1 hängt an einem Gate, bis Frage 2 eingereiht ist.
    let releaseFirst;
    const gate = new Promise(r => { releaseFirst = r; });
    mockCreate.mockImplementationOnce(() => ({
      [Symbol.asyncIterator]: async function* () {
        await gate;
        yield { choices: [{ delta: { content: 'Answer one' } }] };
        yield { choices: [{ delta: {} }] };
      },
    }));
    mockCreate.mockImplementationOnce(() => makeStream(['Answer two']));

    const p1 = request(app).post(`/api/chats/${chatId}/messages`)
      .send({ content: 'First?' }).buffer(true).then(r => r);
    await new Promise(r => setTimeout(r, 50));
    const p2 = request(app).post(`/api/chats/${chatId}/messages`)
      .send({ content: 'Second?' }).buffer(true).then(r => r);
    await new Promise(r => setTimeout(r, 50));
    releaseFirst();

    const [res1, res2] = await Promise.all([p1, p2]);
    const events1 = parseSSE(res1.text);
    const events2 = parseSSE(res2.text);

    // Frage 2 hat gewartet (queued-Event mit einem Job davor) und dann ein
    // started-Event mit ihrer jetzt persistierten Frage bekommen.
    expect(events2.find(e => e.queued)?.queued.ahead).toBe(1);
    const started2 = events2.find(e => e.started);
    expect(started2.userMessage.content).toBe('Second?');
    expect(events1.find(e => e.done).assistantMessage.content).toBe('Answer one');
    expect(events2.find(e => e.done).assistantMessage.content).toBe('Answer two');

    // Frage 2s Kontext enthält Frage 1 UND Antwort 1 (deshalb die FIFO-Regel).
    const call2Messages = mockCreate.mock.calls[1][0].messages;
    const texts = call2Messages.map(m => m.content);
    expect(texts).toContain('First?');
    expect(texts).toContain('Answer one');

    // DB-Reihenfolge: Antwort 1 steht VOR Frage 2.
    const rows = db.prepare(
      'SELECT role, content FROM messages WHERE chat_id = ? ORDER BY created_at ASC, id ASC'
    ).all(chatId);
    expect(rows.map(r => r.content)).toEqual([
      'Earlier question', 'Earlier answer', 'First?', 'Answer one', 'Second?', 'Answer two',
    ]);
  });

  it('rejects warm-ups while a question is running or waiting', async () => {
    const chatId = await seedChatWithHistory();
    let releaseFirst;
    const gate = new Promise(r => { releaseFirst = r; });
    mockCreate.mockImplementationOnce(() => ({
      [Symbol.asyncIterator]: async function* () {
        await gate;
        yield { choices: [{ delta: { content: 'Slow answer' } }] };
        yield { choices: [{ delta: {} }] };
      },
    }));

    const p1 = request(app).post(`/api/chats/${chatId}/messages`)
      .send({ content: 'Slow?' }).buffer(true).then(r => r);
    await new Promise(r => setTimeout(r, 50));

    // Warm-up während der laufenden Frage: abgelehnt, statt sich in Ollamas
    // Schlange zu stellen und den Prefix des antwortenden Chats zu verdrängen.
    const warmup = await request(app).post(`/api/chats/${chatId}/messages/warmup`);
    expect(warmup.body).toEqual({ warmed: false, reason: 'busy' });

    releaseFirst();
    await p1;
  });

  it('persists a *Failed* marker and reports both messages when generation errors', async () => {
    const chatId = await seedChatWithHistory();
    mockCreate.mockRejectedValueOnce(new Error('Ollama exploded'));

    const res = await request(app).post(`/api/chats/${chatId}/messages`)
      .send({ content: 'Doomed?' }).buffer(true);
    const events = parseSSE(res.text);

    // Fehler-Event trägt die persistierte Frage + den Marker fürs Frontend.
    const errEvent = events.find(e => e.error);
    expect(errEvent.error).toBe('Ollama exploded');
    expect(errEvent.userMessage.content).toBe('Doomed?');
    expect(errEvent.assistantMessage.content).toBe('*Failed*');

    // Beides in der DB: die Frage bleibt erhalten, der Marker überlebt Reloads.
    const rows = db.prepare(
      'SELECT role, content FROM messages WHERE chat_id = ? ORDER BY created_at ASC, id ASC'
    ).all(chatId);
    expect(rows.at(-2)).toEqual({ role: 'user', content: 'Doomed?' });
    expect(rows.at(-1)).toEqual({ role: 'assistant', content: '*Failed*' });
  });
});

describe('POST /api/chats/:chatId/messages/regenerate', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  });
  afterEach(() => { global.fetch = realFetch; });

  async function seedFailedChat() {
    const chat = await request(app).post('/api/chats').send({ title: 'Retry Test' });
    const insert = db.prepare(
      'INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    insert.run('h1', chat.body.id, 'user', 'Earlier question', '2026-07-24T00:00:00.000Z');
    insert.run('h2', chat.body.id, 'assistant', 'Earlier answer', '2026-07-24T00:00:01.000Z');
    insert.run('q1', chat.body.id, 'user', 'Unlucky question', '2026-07-24T00:00:02.000Z');
    insert.run('f1', chat.body.id, 'assistant', '*Failed*', '2026-07-24T00:00:03.000Z');
    return chat.body.id;
  }

  it('regenerates the answer without duplicating the question and removes the marker', async () => {
    const chatId = await seedFailedChat();
    mockCreate.mockResolvedValueOnce(makeStream(['Recovered answer']));

    const res = await request(app).post(`/api/chats/${chatId}/messages/regenerate`)
      .send({}).buffer(true);
    const events = parseSSE(res.text);

    // started/done tragen die BESTEHENDE Frage (gleiche id, kein Duplikat).
    expect(events.find(e => e.started).userMessage.id).toBe('q1');
    expect(events.find(e => e.done).assistantMessage.content).toBe('Recovered answer');

    const rows = db.prepare(
      'SELECT id, role, content FROM messages WHERE chat_id = ? ORDER BY created_at ASC, id ASC'
    ).all(chatId);
    expect(rows.filter(r => r.content === 'Unlucky question')).toHaveLength(1);
    expect(rows.some(r => r.content === '*Failed*')).toBe(false);
    expect(rows.at(-1).content).toBe('Recovered answer');

    // Kontext: die Frage geht als letzte User-Nachricht ins Modell, der
    // Marker taucht nirgends auf.
    const callMessages = mockCreate.mock.calls[0][0].messages;
    expect(callMessages.at(-1)).toMatchObject({ role: 'user', content: 'Unlucky question' });
    expect(callMessages.some(m => String(m.content).includes('*Failed*'))).toBe(false);
  });

  it('also answers a bare trailing user question (legacy silent failure)', async () => {
    const chatId = await seedFailedChat();
    db.prepare('DELETE FROM messages WHERE id = ?').run('f1');
    mockCreate.mockResolvedValueOnce(makeStream(['Late answer']));

    const res = await request(app).post(`/api/chats/${chatId}/messages/regenerate`)
      .send({}).buffer(true);
    const events = parseSSE(res.text);

    expect(events.find(e => e.started).userMessage.id).toBe('q1');
    const rows = db.prepare(
      'SELECT role, content FROM messages WHERE chat_id = ? ORDER BY created_at ASC, id ASC'
    ).all(chatId);
    expect(rows.filter(r => r.content === 'Unlucky question')).toHaveLength(1);
    expect(rows.at(-1).content).toBe('Late answer');
  });

  it('returns 409 when the last message is a real answer', async () => {
    const chat = await request(app).post('/api/chats').send({ title: 'Fine Chat' });
    const insert = db.prepare(
      'INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    insert.run('u1', chat.body.id, 'user', 'Question', '2026-07-24T00:00:00.000Z');
    insert.run('a1', chat.body.id, 'assistant', 'Perfectly fine answer', '2026-07-24T00:00:01.000Z');

    const res = await request(app).post(`/api/chats/${chat.body.id}/messages/regenerate`).send({});
    expect(res.status).toBe(409);
  });

  it('returns 404 for an unknown chat', async () => {
    const res = await request(app).post('/api/chats/nope/messages/regenerate').send({});
    expect(res.status).toBe(404);
  });
});
