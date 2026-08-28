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
  // This suite tests the local path — bypass the cloud default (ADR-0008).
  require('../llm').setSetting(db, 'llm_provider', 'ollama');
  app = createApp(db);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

// ─── Prefix warm-up (POST /api/chats/:chatId/messages/warmup) ───────────────
// When the user opens a chat, the model reads in the (paper) context once
// already — the first real question then hits a warm KV cache.

describe('POST /api/chats/:chatId/messages/warmup', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    // extendOllamaKeepAlive talks to the native Ollama API — mocked here.
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
    // 1-token prefill with the same prefix as a real message:
    // system prompt + full history, thinking off.
    const call = mockCreate.mock.calls[0][0];
    expect(call.max_tokens).toBe(1);
    expect(call.reasoning_effort).toBe('none');
    expect(call.messages[0].role).toBe('system');
    expect(call.messages.at(-1)).toMatchObject({ role: 'user', content: 'What is attention?' });
    // TTL extension via the native API (keep_alive is ignored by /v1).
    const keepAliveCall = global.fetch.mock.calls.find(c => String(c[0]).endsWith('/api/generate'));
    expect(keepAliveCall).toBeDefined();
    expect(JSON.parse(keepAliveCall[1].body)).toMatchObject({ keep_alive: '1h', prompt: '' });
  });

  it('returns 404 for an unknown chat', async () => {
    const res = await request(app).post('/api/chats/nope/messages/warmup');
    expect(res.status).toBe(404);
  });

  it('aborts an in-flight warm-up as soon as a real message arrives', async () => {
    // Warm-up is advance work — it must never block a real question.
    // Measured 2026-07-21: without aborting, the question waited up to
    // ~40 s (paper prefill) in Ollama's queue.
    const chat = await request(app).post('/api/chats').send({ title: 'Busy' });

    // The warm-up hangs (simulated long paper prefill) until the abort.
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

    // Real message → the warm-up must be aborted immediately.
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
    // The usage chunk arrives as the last chunk with an empty choices array
    // (stream_options.include_usage) — the perf event is built from it.
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
    // The stop button aborts the upstream request — the SDK then throws an
    // AbortError mid-stream. Whatever is already there is preserved.
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

    // The client abort is passed through to the SDK via AbortSignal.
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

  it('stores the quote anchor so the rendered quote can jump back to its source', async () => {
    // "Ask in chat" quotes carry the highlight they were taken from
    // (mockup-quote-jump-to-source.html, variant A). The quote text itself
    // stays inside content as blockquote lines — only the anchor is new.
    mockCreate.mockResolvedValueOnce(makeStream(['Because they are independent.']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Coins' } }] });

    await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .send({ content: '> 0.5 × 0.5 = 0.25\n\nWhy multiply?', quoteHighlightId: 'hl-42' })
      .buffer(true);

    const chatRes = await request(app).get(`/api/chats/${chatId}`);
    expect(chatRes.body.messages[0].quote_highlight_id).toBe('hl-42');
    // The answer is not a quote and must not inherit the anchor.
    expect(chatRes.body.messages[1].quote_highlight_id).toBeNull();
  });

  it('carries the quote anchor in the started and done events', async () => {
    // These two events REPLACE the frontend's optimistic question. An anchor
    // missing here left the just-sent quote unclickable until a reload —
    // invisible to every DB-level assertion (found in the running app,
    // 2026-08-08).
    mockCreate.mockResolvedValueOnce(makeStream(['Because they are independent.']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Coins' } }] });

    const res = await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .send({ content: '> 0.5 × 0.5 = 0.25\n\nWhy multiply?', quoteHighlightId: 'hl-42' })
      .buffer(true);

    const events = parseSSE(res.text);
    const started = events.find(e => e.started);
    const done = events.find(e => e.done);
    expect(started.userMessage.quote_highlight_id).toBe('hl-42');
    expect(done.userMessage.quote_highlight_id).toBe('hl-42');
  });

  it('leaves the quote anchor null for a question sent without a quote', async () => {
    mockCreate.mockResolvedValueOnce(makeStream(['Plain answer']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Plain' } }] });

    await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .send({ content: 'No quote here' })
      .buffer(true);

    const chatRes = await request(app).get(`/api/chats/${chatId}`);
    expect(chatRes.body.messages[0].quote_highlight_id).toBeNull();
  });

  it('title generation reuses the conversation prompt prefix instead of evicting it', async () => {
    // Ollama has only ONE cache slot (vision models: Parallel:1). A
    // standalone title prompt would evict the paper prefix; that is why
    // the title call must start byte-identical to the conversation prefix.
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

  it('titles a branch chat after the selected passage, not the first question (2026-07-26)', async () => {
    // Branch with a marked passage as parent_word. (The parent chat has no
    // messages here, so branch creation triggers no summary warm-up call.)
    const branch = await request(app).post('/api/chats').send({
      title: 'About: Energie',
      parent_id: chatId,
      parent_word: 'Die Energie $E(w_t)$ vereinfacht den Umgang mit Out-of-Vocabulary-Wörtern.',
    });
    await new Promise(r => setTimeout(r, 25));

    mockCreate.mockResolvedValueOnce(makeStream(['Reply']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Energie und OOV' } }] });

    await request(app)
      .post(`/api/chats/${branch.body.id}/messages`)
      .send({ content: 'Kannst du mir alle Details erklären?' })
      .buffer(true);

    // The title instruction (last message of the title call) asks for a
    // summary of the passage and quotes it verbatim. (On the Ollama path the
    // call still carries the conversation prefix for the KV cache — the
    // instruction at the end is what steers the summary.)
    const titleCall = mockCreate.mock.calls.find(c =>
      c[0].messages.some(m => typeof m.content === 'string' && m.content.includes('selected the passage'))
    );
    expect(titleCall).toBeDefined();
    const instruction = titleCall[0].messages[titleCall[0].messages.length - 1].content;
    expect(instruction).toContain('selected the passage below');
    expect(instruction).toContain('Die Energie $E(w_t)$');
    expect(instruction).not.toContain('Kannst du mir alle Details');

    const chatRes = await request(app).get(`/api/chats/${branch.body.id}`);
    expect(chatRes.body.title).toBe('Energie und OOV');
  });

  it('parses the branch reply instead of storing it verbatim (2026-08-02)', async () => {
    // The branch instruction asks for TITLE/QUOTE lines. Taking the reply
    // as-is put the raw object into the tree: `{ "title": "θ₂ Update`.
    const branch = await request(app).post('/api/chats').send({
      title: 'About: θ 2',
      parent_id: chatId,
      parent_word: 'θ 2 ← θ 2 − α m m ∑ i =1 ∂F 2 (x i , θ 2 ) ∂ θ 2',
    });
    await new Promise(r => setTimeout(r, 25));

    mockCreate.mockResolvedValueOnce(makeStream(['Reply']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content:
      'TITLE: $\\Theta_2$ Update\n'
      + 'QUOTE: $\\Theta_2 \\leftarrow \\Theta_2 - \\frac{\\alpha}{m}\\sum_{i=1}^{m}'
      + '\\frac{\\partial F_2(x_i, \\Theta_2)}{\\partial \\Theta_2}$',
    } }] });

    await request(app)
      .post(`/api/chats/${branch.body.id}/messages`)
      .send({ content: 'Was bedeutet das?' })
      .buffer(true);

    const chatRes = await request(app).get(`/api/chats/${branch.body.id}`);
    expect(chatRes.body.title).toBe('$\\Theta_2$ Update');
    // The branch header gets the restored formula too, even though the
    // pre-branch lookup came back empty.
    expect(chatRes.body.parent_word_display).toContain('\\frac{\\partial F_2');
  });

  it('stores the outcome line from the same call as the title (2026-08-02)', async () => {
    // The mindmap node shows the title AND what the conversation produced
    // (design/mockup-mindmap-node-final.html §03). Both come out of the ONE
    // call that already runs after the first answer — no extra LLM round.
    const branch = await request(app).post('/api/chats').send({
      title: 'About: scaling',
      parent_id: chatId,
      parent_word: 'we scale the dot products by 1/ d k',
    });
    await new Promise(r => setTimeout(r, 25));

    mockCreate.mockResolvedValueOnce(makeStream(['Because the variance grows']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content:
      'TITLE: Scaled dot-product\n'
      + 'QUOTE: we scale the dot products by $1/\\sqrt{d_k}$\n'
      + 'OUTCOME: Hält die Varianz bei 1, Softmax bleibt im steilen Bereich',
    } }] });

    await request(app)
      .post(`/api/chats/${branch.body.id}/messages`)
      .send({ content: 'Warum?' })
      .buffer(true);

    const chatRes = await request(app).get(`/api/chats/${branch.body.id}`);
    expect(chatRes.body.title).toBe('Scaled dot-product');
    expect(chatRes.body.outcome).toBe('Hält die Varianz bei 1, Softmax bleibt im steilen Bereich');

    // The instruction must actually ask for it, in the passage's language.
    const titleCall = mockCreate.mock.calls.find(c =>
      c[0].messages.some(m => typeof m.content === 'string' && m.content.includes('selected the passage'))
    );
    expect(titleCall[0].messages.at(-1).content).toContain('OUTCOME:');
  });

  it('carries the answer INSIDE the outcome instruction, for every provider (2026-08-03)', async () => {
    // The first version asked what "the conversation above" had established.
    // On the Ollama path that conversation is really there (the call reuses the
    // prompt prefix for the KV cache); on every cloud provider the call is the
    // single instruction, so the model had nothing to read and left the line
    // empty — 22 of 60 branches were stuck on "Ergebnis folgt …". The answer
    // now lives in the instruction itself, which is the one message all
    // providers get.
    const branch = await request(app).post('/api/chats').send({
      title: 'About: warmup',
      parent_id: chatId,
      parent_word: 'we used warmup steps = 4000',
    });
    await new Promise(r => setTimeout(r, 25));

    mockCreate.mockResolvedValueOnce(makeStream(['Die Lernrate steigt linear und fällt danach mit 1/sqrt(step).']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content:
      'TITLE: Warmup-Schritte\nQUOTE: we used warmup steps $= 4000$\n'
      + 'OUTCOME: Lernrate steigt linear, dann invers zur Wurzel',
    } }] });

    await request(app)
      .post(`/api/chats/${branch.body.id}/messages`)
      .send({ content: 'Was macht das?' })
      .buffer(true);

    const titleCall = mockCreate.mock.calls.find(c =>
      c[0].messages.some(m => typeof m.content === 'string' && m.content.includes('selected the passage'))
    );
    const instruction = titleCall[0].messages.at(-1).content;
    // The answer is quoted in the instruction, fenced and scoped to OUTCOME.
    expect(instruction).toContain('Die Lernrate steigt linear');
    expect(instruction).toContain('Use it ONLY for the OUTCOME line');
    // …and the question still is not, or the title starts summarizing the
    // question again (rule from 2026-07-26).
    expect(instruction).not.toContain('Was macht das?');

    const chatRes = await request(app).get(`/api/chats/${branch.body.id}`);
    expect(chatRes.body.outcome).toBe('Lernrate steigt linear, dann invers zur Wurzel');
  });

  it('catches the outcome up on a later answer when the first attempt returned none (2026-08-03)', async () => {
    // The outcome used to be written only inside the title gate, which opens
    // exactly once. A title call that timed out, hit a quota, or came back
    // without the OUTCOME line left the node on its placeholder forever.
    const branch = await request(app).post('/api/chats').send({
      title: 'About: dropout',
      parent_id: chatId,
      parent_word: 'we apply dropout to the output of each sub-layer',
    });
    await new Promise(r => setTimeout(r, 25));

    // First exchange: title and quote arrive, the OUTCOME line does not.
    mockCreate.mockResolvedValueOnce(makeStream(['Erste Antwort']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content:
      'TITLE: Dropout je Sub-Layer\nQUOTE: we apply dropout to the output of each sub-layer',
    } }] });
    await request(app)
      .post(`/api/chats/${branch.body.id}/messages`)
      .send({ content: 'Warum?' })
      .buffer(true);

    let chatRes = await request(app).get(`/api/chats/${branch.body.id}`);
    expect(chatRes.body.outcome).toBeNull();

    // Second exchange: the catch-up call asks for the one missing line.
    mockCreate.mockClear();
    mockCreate.mockResolvedValueOnce(makeStream(['Dropout mit p = 0.1 wirkt regularisierend.']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content:
      'OUTCOME: Regularisiert jede Sub-Layer-Ausgabe mit $p = 0.1$',
    } }] });
    await request(app)
      .post(`/api/chats/${branch.body.id}/messages`)
      .send({ content: 'Und der Wert?' })
      .buffer(true);

    const catchUp = mockCreate.mock.calls.find(c =>
      c[0].messages.some(m => typeof m.content === 'string' && m.content.includes('OUTCOME:'))
    );
    const instruction = catchUp[0].messages.at(-1).content;
    // One line asked for, and no title machinery: re-titling a branch the user
    // has been reading for days is not an acceptable side effect.
    expect(instruction).toContain('EXACTLY ONE line');
    expect(instruction).not.toContain('TITLE:');
    expect(instruction).toContain('Dropout mit p = 0.1');

    chatRes = await request(app).get(`/api/chats/${branch.body.id}`);
    expect(chatRes.body.outcome).toBe('Regularisiert jede Sub-Layer-Ausgabe mit $p = 0.1$');
    expect(chatRes.body.title).toBe('Dropout je Sub-Layer');
  });

  it('walks the failover ladder for the outcome line when the active model is out of quota (2026-08-06)', async () => {
    // Live report 2026-08-06: mindmap nodes stuck on "Ergebnis folgt …". The
    // outcome call used the configured model and nothing else, so an exhausted
    // Gemini quota killed the line — and the next answer retried on exactly
    // the model that had just hit the wall. Now it walks the same candidate
    // ladder as the answer itself (quota.js).
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'gemini');
    setSetting(db, 'gemini_api_key', 'AIza-test');
    setSetting(db, 'gemini_model', 'gemini-flash-latest');
    app = createApp(db);

    const root = await request(app).post('/api/chats').send({ title: 'Root' });
    const branch = await request(app).post('/api/chats').send({
      title: 'About: beam search',
      parent_id: root.body.id,
      parent_word: 'we use beam search with a beam size of 4',
    });
    await new Promise(r => setTimeout(r, 25));

    mockCreate.mockImplementation(async (body) => {
      // The answer stream itself succeeds on the active model.
      if (body.stream) return makeStream(['Beam search vergleicht 4 Kandidaten.']);
      // The side call: the active model is out of quota, the next candidate
      // delivers.
      if (body.model === 'gemini-flash-latest') {
        throw Object.assign(new Error('429 quota exceeded'), { status: 429 });
      }
      return { choices: [{ message: { content: 'OUTCOME: Beam 4 schlägt Greedy um 1,2 BLEU' } }] };
    });

    await request(app)
      .post(`/api/chats/${branch.body.id}/messages`)
      .send({ content: 'Warum 4?' })
      .buffer(true);

    const chatRes = await request(app).get(`/api/chats/${branch.body.id}`);
    expect(chatRes.body.outcome).toBe('Beam 4 schlägt Greedy um 1,2 BLEU');

    // A second model was actually asked — the ladder moved, it did not just
    // retry the same name.
    const sideModels = mockCreate.mock.calls
      .filter(c => !c[0].stream)
      .map(c => c[0].model);
    expect(sideModels[0]).toBe('gemini-flash-latest');
    expect(sideModels.some(m => m !== 'gemini-flash-latest')).toBe(true);
  });

  it('stops asking once an outcome is stored (2026-08-03)', async () => {
    // The catch-up must not turn into a per-answer tax: an outcome that exists
    // is never regenerated.
    const branch = await request(app).post('/api/chats').send({
      title: 'About: label smoothing',
      parent_id: chatId,
      parent_word: 'label smoothing of value 0.1',
    });
    await new Promise(r => setTimeout(r, 25));

    mockCreate.mockResolvedValueOnce(makeStream(['Antwort']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content:
      'TITLE: Label Smoothing\nQUOTE: label smoothing of value $0.1$\n'
      + 'OUTCOME: Verschlechtert Perplexität, verbessert BLEU',
    } }] });
    await request(app)
      .post(`/api/chats/${branch.body.id}/messages`)
      .send({ content: 'Was bringt das?' })
      .buffer(true);

    mockCreate.mockClear();
    mockCreate.mockResolvedValueOnce(makeStream(['Zweite Antwort']));
    await request(app)
      .post(`/api/chats/${branch.body.id}/messages`)
      .send({ content: 'Noch etwas?' })
      .buffer(true);

    // Exactly one call: the answer stream. No title, no outcome.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const chatRes = await request(app).get(`/api/chats/${branch.body.id}`);
    expect(chatRes.body.outcome).toBe('Verschlechtert Perplexität, verbessert BLEU');
  });
});

// ─── Prompt prefix stability (KV cache) ──────────────────────────────────────
// Ollama's prefix cache only hits when the warm-up and the real request
// start byte-identically — including paper text, history, and tool
// definitions.

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

    // Byte-identical prefix: same tools, same messages — the real request
    // only appends the new user message at the end.
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

    // The prompt should reference the parent word and include parent context:
    // the inherited context in the system prompt, the selection in the focus
    // block right before the question.
    const branchCall = mockCreate.mock.calls.find(c =>
      c[0].messages.some(m => typeof m.content === 'string' && m.content.includes('exploring the term'))
    );
    const systemMessage = branchCall[0].messages.find(m => m.role === 'system');
    const focus = branchCall[0].messages.at(-2).content;
    expect(systemMessage.content).toContain('quantum');
    expect(systemMessage.content).toContain('Parent question');
    // Chat-selection branch: no PDF wording, no math-flattening note.
    expect(focus).toContain('from a previous conversation');
    expect(focus).not.toContain('PDF source');
  });

  it('uses the PDF-selection wording with the surroundings when parent_context is set (decision 2026-07-26)', async () => {
    const parent = await request(app).post('/api/chats').send({ title: 'Paper chat' });
    mockCreate.mockResolvedValueOnce(makeStream(['Parent reply']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Parent Title' } }] });
    await request(app)
      .post(`/api/chats/${parent.body.id}/messages`)
      .send({ content: 'Parent question' })
      .buffer(true);

    // Branch from a PDF selection: the text layer flattened R^m to "Rm";
    // the frontend sends the surrounding text-layer lines along.
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Parent summary.' } }] });
    const child = await request(app).post('/api/chats').send({
      title: 'About: Rm',
      parent_id: parent.body.id,
      parent_word: 'Rm',
      parent_context: 'wird durch eine Matrix C der Dimension |V| × m in einen Merkmalsvektor C(i) ∈ Rm umgewandelt',
    });
    await new Promise(r => setTimeout(r, 25));

    mockCreate.mockResolvedValueOnce(makeStream(['Child reply']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Child Title' } }] });

    await request(app)
      .post(`/api/chats/${child.body.id}/messages`)
      .send({ content: 'Was bedeutet dieses Symbol?' })
      .buffer(true);

    const branchCall = mockCreate.mock.calls.find(c =>
      c[0].messages.some(m => typeof m.content === 'string' && m.content.includes('PDF source'))
    );
    expect(branchCall).toBeDefined();
    const focus = branchCall[0].messages.at(-2).content;
    expect(focus).toContain('selected "Rm" inside the tree\'s PDF source');
    expect(focus).toContain('Merkmalsvektor C(i)');
    expect(focus).toContain('flattens math notation');
    expect(focus).not.toContain('from a previous conversation');
  });

  it('puts the selection LAST in the system prompt, behind the parent transcript', async () => {
    // Bug 2026-08-08: "Ich habe dies nicht verstanden." in a fresh branch made
    // the model explain the whole paper. The selection was one clause in the
    // middle of the prompt — between the source text and the parent
    // transcript, i.e. the weakest position. What the model read LAST was a
    // conversation about the entire source, so "this" resolved to the source.
    const parent = await request(app).post('/api/chats').send({ title: 'Paper chat' });
    mockCreate.mockResolvedValueOnce(makeStream(['Parent reply']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Parent Title' } }] });
    await request(app)
      .post(`/api/chats/${parent.body.id}/messages`)
      .send({ content: 'Parent question' })
      .buffer(true);

    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Parent summary.' } }] });
    const child = await request(app).post('/api/chats').send({
      title: 'About: perplexity',
      parent_id: parent.body.id,
      parent_word: 'Below, we report the geometric average',
    });
    await new Promise(r => setTimeout(r, 25));

    mockCreate.mockResolvedValueOnce(makeStream(['Child reply']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Child Title' } }] });
    await request(app)
      .post(`/api/chats/${child.body.id}/messages`)
      .send({ content: 'Ich habe dies nicht verstanden.' })
      .buffer(true);

    const branchCall = mockCreate.mock.calls.find(c =>
      c[0].messages.some(m => typeof m.content === 'string' && m.content.includes('exploring the term'))
    );
    // The focus block is its OWN message directly before the question — the
    // last thing the model reads, behind the inherited parent transcript.
    const focus = branchCall[0].messages.at(-2);
    // A LATE block travels as a labelled user turn, never as a second system
    // message: on Gemini a second system message erases the first — and with
    // it the paper text (bug 2026-08-10, see llm.js).
    expect(focus.role).toBe('user');
    expect(focus.content).toContain("THE USER'S CURRENT FOCUS");
    expect(focus.content).toContain('Below, we report the geometric average');
  });

  it('repeats the origin paragraph in the focus block and stops forbidding the parent chat', async () => {
    // Bug 2026-08-09 (overcorrection of the 2026-08-08 fix): the focus block
    // demoted the inherited conversation to "background" and forbade it
    // outright — "never the earlier conversation". Flash Lite obeyed: a
    // selection saying word embeddings need no "imaginary" part was answered
    // as language philosophy, although the parent chat had explained
    // imaginary NUMBERS two messages earlier. Fix: separate WHAT to explain
    // (the passage) from WHERE its words get their meaning (the parent), and
    // repeat the origin paragraph HERE, next to the selection, instead of
    // leaving it behind ~58k characters of source text.
    const parentReply =
      'Reelle Zahlen sind die ganz normalen Dezimalzahlen.\n\n' +
      'Daneben gibt es die **imaginäre Einheit** $i$ mit $i^2 = -1$.\n\n' +
      'Man braucht keine komplexen Zahlen, weil die Bedeutung eines Wortes ' +
      'keinen imaginären Anteil braucht.';
    const parent = await request(app).post('/api/chats').send({ title: 'Paper chat' });
    mockCreate.mockResolvedValueOnce(makeStream([parentReply]));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Parent Title' } }] });
    await request(app)
      .post(`/api/chats/${parent.body.id}/messages`)
      .send({ content: 'Was sind reelle Zahlen?' })
      .buffer(true);

    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Parent summary.' } }] });
    const child = await request(app).post('/api/chats').send({
      title: 'About: imaginär',
      parent_id: parent.body.id,
      parent_word: 'weil die Bedeutung eines Wortes keinen imaginären Anteil braucht',
    });
    await new Promise(r => setTimeout(r, 25));

    mockCreate.mockResolvedValueOnce(makeStream(['Child reply']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Child Title' } }] });
    await request(app)
      .post(`/api/chats/${child.body.id}/messages`)
      .send({ content: 'Warum?' })
      .buffer(true);

    const branchCall = mockCreate.mock.calls.find(c =>
      c[0].messages.some(m => typeof m.content === 'string' && m.content.includes('exploring the term'))
    );
    const focus = branchCall[0].messages.at(-2).content;
    // The disambiguating paragraph now sits in the LAST block before the
    // question, not only in the system message far above.
    expect(focus).toContain('selected from this part of the parent conversation');
    expect(focus).toContain('imaginäre Einheit');
    // The prohibition that caused the bug is gone …
    expect(focus).not.toContain('never the earlier conversation');
    expect(focus).not.toMatch(/inherited conversation\) is only\s+background/);
    // … replaced by an instruction to READ the selection through the parent.
    expect(focus).toMatch(/in the sense the earlier conversation above gave them/i);
    // … while the 2026-08-08 protection survives: the passage stays the subject.
    expect(focus).toContain('THE SELECTED PASSAGE');
    expect(focus).toMatch(/only when the user explicitly asks/);
  });

  it('omits the origin block when the selection cannot be located', async () => {
    // PDF branches, selections spanning several messages, edited parents: the
    // block is dropped rather than guessed at, and the rest still holds.
    const parent = await request(app).post('/api/chats').send({ title: 'Paper chat' });
    mockCreate.mockResolvedValueOnce(makeStream(['Parent reply about something else.']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Parent Title' } }] });
    await request(app)
      .post(`/api/chats/${parent.body.id}/messages`)
      .send({ content: 'Parent question' })
      .buffer(true);

    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Parent summary.' } }] });
    const child = await request(app).post('/api/chats').send({
      title: 'About: Rm',
      parent_id: parent.body.id,
      parent_word: 'a real vector C(i) in Rm',
      parent_context: 'mapping C from any element i of V to a real vector C(i) in Rm.',
    });
    await new Promise(r => setTimeout(r, 25));

    mockCreate.mockResolvedValueOnce(makeStream(['Child reply']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Child Title' } }] });
    await request(app)
      .post(`/api/chats/${child.body.id}/messages`)
      .send({ content: 'Warum?' })
      .buffer(true);

    const branchCall = mockCreate.mock.calls.find(c =>
      c[0].messages.some(m => typeof m.content === 'string' && m.content.includes("CURRENT FOCUS"))
    );
    const focus = branchCall[0].messages.at(-2).content;
    expect(focus).not.toContain('selected from this part of the parent conversation');
    // The PDF branch keeps its own surroundings and the math-flattening note.
    expect(focus).toContain('inside the tree\'s PDF source');
    expect(focus).toContain('THE SELECTED PASSAGE');
  });

  it('prefixes the question sent to the model with the selected passage', async () => {
    // Measured against the real app 2026-08-08 (gemini-flash-lite, same
    // 67k-char prompt): with the selection only in a system message the model
    // explained the whole paper; with it prefixed to the user turn it
    // explained the passage. Same thing the user did by hand when they wrote
    // "also ich meine, was ich markiert habe". The STORED message stays raw —
    // the passage is prompt scaffolding, not something the user typed.
    const parent = await request(app).post('/api/chats').send({ title: 'Paper chat' });
    mockCreate.mockResolvedValueOnce(makeStream(['Parent reply']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Parent Title' } }] });
    await request(app)
      .post(`/api/chats/${parent.body.id}/messages`)
      .send({ content: 'Parent question' })
      .buffer(true);

    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Parent summary.' } }] });
    const child = await request(app).post('/api/chats').send({
      title: 'About: perplexity',
      parent_id: parent.body.id,
      parent_word: 'Below, we report the geometric average',
    });
    await new Promise(r => setTimeout(r, 25));

    mockCreate.mockResolvedValueOnce(makeStream(['Child reply']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Child Title' } }] });
    await request(app)
      .post(`/api/chats/${child.body.id}/messages`)
      .send({ content: 'Ich habe dies nicht verstanden.' })
      .buffer(true);

    const branchCall = mockCreate.mock.calls.find(c =>
      c[0].messages.some(m => typeof m.content === 'string' && m.content.includes('exploring the term'))
    );
    const question = branchCall[0].messages.at(-1);
    expect(question.role).toBe('user');
    expect(question.content).toContain('Below, we report the geometric average');
    expect(question.content).toContain('Ich habe dies nicht verstanden.');

    // What the UI shows and what the tree stores is the raw question.
    const stored = db
      .prepare("SELECT content FROM messages WHERE chat_id = ? AND role = 'user'")
      .get(child.body.id);
    expect(stored.content).toBe('Ich habe dies nicht verstanden.');
  });

  it('marks the inherited transcript as another conversation, not its own last turn', async () => {
    // Observed 2026-08-08 in the running app: the model opened with
    // "Entschuldigung, wenn meine vorherige Antwort unklar war" and repeated
    // the parent's paper explanation — it read the inherited transcript as
    // its OWN previous answer, so "I didn't understand this" became "explain
    // your last answer again" instead of "explain the selection".
    const parent = await request(app).post('/api/chats').send({ title: 'Paper chat' });
    mockCreate.mockResolvedValueOnce(makeStream(['Parent reply']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Parent Title' } }] });
    await request(app)
      .post(`/api/chats/${parent.body.id}/messages`)
      .send({ content: 'Parent question' })
      .buffer(true);

    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Parent summary.' } }] });
    const child = await request(app).post('/api/chats').send({
      title: 'Child',
      parent_id: parent.body.id,
      parent_word: 'perplexity',
    });
    await new Promise(r => setTimeout(r, 25));

    mockCreate.mockResolvedValueOnce(makeStream(['Child reply']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Child Title' } }] });
    await request(app)
      .post(`/api/chats/${child.body.id}/messages`)
      .send({ content: 'Ich habe dies nicht verstanden.' })
      .buffer(true);

    // The inherited transcript lives in the ONE system message at the front —
    // the parent chat's own call also contains the string 'Parent question',
    // as its user turn, so match on the system message itself.
    const branchCall = mockCreate.mock.calls.find(c =>
      c[0].messages[0].content.includes('Parent question')
    );
    const system = branchCall[0].messages[0].content;
    expect(system).toContain('not your own earlier answers');
  });

  it('tells the model that vague references ("this", "it") mean the selection', async () => {
    // Without an explicit resolution rule the model resolves "this" against
    // the LARGEST context in the prompt — the source — instead of the passage
    // the branch was opened from.
    const parent = await request(app).post('/api/chats').send({ title: 'Paper chat' });
    mockCreate.mockResolvedValueOnce(makeStream(['Parent reply']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Parent Title' } }] });
    await request(app)
      .post(`/api/chats/${parent.body.id}/messages`)
      .send({ content: 'Parent question' })
      .buffer(true);

    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Parent summary.' } }] });
    const child = await request(app).post('/api/chats').send({
      title: 'About: Rm',
      parent_id: parent.body.id,
      parent_word: 'Rm',
      parent_context: 'C(i) ∈ Rm',
    });
    await new Promise(r => setTimeout(r, 25));

    mockCreate.mockResolvedValueOnce(makeStream(['Child reply']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Child Title' } }] });
    await request(app)
      .post(`/api/chats/${child.body.id}/messages`)
      .send({ content: 'Ich habe dies nicht verstanden.' })
      .buffer(true);

    const branchCall = mockCreate.mock.calls.find(c =>
      c[0].messages.some(m => typeof m.content === 'string' && m.content.includes('PDF source'))
    );
    const focus = branchCall[0].messages.at(-2).content;
    expect(focus).toContain('"this"');
    expect(focus).toContain('SELECTED PASSAGE');
  });

  it('ignores parent_context on chats without a parent_word', async () => {
    const res = await request(app).post('/api/chats').send({
      title: 'Root',
      parent_context: 'should be dropped',
    });
    const row = db.prepare('SELECT parent_context FROM chats WHERE id = ?').get(res.body.id);
    expect(row.parent_context).toBeNull();
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

// ─── Latency log (perf) on the real endpoint ─────────────────────────────────
// The [perf] line carries mode/cache/source size; conversation content NEVER.

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
    expect(perfLine).toContain('mode=none'); // chat without a source
    expect(perfLine).toContain('cache=cold'); // first question
    expect(perfLine).toContain('prompt_tokens=1200');
    // Privacy: the question itself must NEVER appear in the log.
    expect(perfLine).not.toContain(SECRET);
  });
});

// ─── Retrieval mode for long sources (ADR-0006) ──────────────────────────────
// Papers that blow the context window are no longer bluntly truncated:
// the system prompt gets a stable skeleton (start + outline + end), and
// per question the best-matching chunks go in as their own block AFTER
// the history — the KV-cache prefix stays byte-identical.

describe('POST /api/chats/:chatId/messages – retrieval mode for long papers', () => {
  const FACT_PARA =
    'Rotary positional encodings twist query and key vectors by an angle proportional to position.';

  // > MAX_SYSTEM_CONTEXT_CHARS (~40k), FACT_PARA deep in the middle — far
  // behind the skeleton start and before the skeleton end.
  function longPaperText() {
    const paras = Array.from(
      { length: 520 },
      (_, i) => `Paragraph ${i} discussing unrelated background material in sufficient detail to fill space.`
    );
    paras[260] = FACT_PARA;
    return paras.join('\n\n');
  }

  // Deterministic fake embeddings: only the FACT paragraph (and the
  // question about it) point along axis 0.
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
    // Skeleton instead of full text in the system prompt …
    expect(system.content).toContain('PAPER SKELETON START');
    expect(system.content).not.toContain('PAPER TEXT START');
    // … the FACT paragraph from the middle of the document is NOT in the prefix …
    expect(system.content).not.toContain(FACT_PARA);
    // … but in the excerpts block directly before the user message.
    const excerpts = call.messages.at(-2);
    expect(excerpts.role).toBe('user');
    expect(excerpts.content).toContain('EXCERPTS');
    expect(excerpts.content).toContain(FACT_PARA);
    expect(call.messages.at(-1)).toMatchObject({
      role: 'user',
      content: 'Explain rotary positional encodings',
    });
    // Chunks live persistently in source_chunks (embedded once).
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

      // The warm-up prompt is exactly the prefix of the real request —
      // only the excerpts block and the new question are appended.
      expect(realCall.messages.slice(0, warmupCall.messages.length)).toEqual(warmupCall.messages);
      expect(realCall.messages.length).toBe(warmupCall.messages.length + 2);
    } finally {
      global.fetch = realFetch;
    }
  });

  it('retrieves for the branch selection, not only for a contentless question', async () => {
    // Bug 2026-08-08: in retrieval mode the query was the raw user message.
    // "Ich habe dies nicht verstanden." carries no content word, so it
    // matched nothing and the answer was built on the skeleton alone — the
    // passage the branch was opened from never made it into the excerpts.
    const app2 = retrievalApp();
    const parent = await request(app2).post('/api/chats').send({ title: 'Long' });
    bindPaper(parent.body.id);

    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Parent summary.' } }] });
    const child = await request(app2).post('/api/chats').send({
      title: 'About: RoPE',
      parent_id: parent.body.id,
      parent_word: 'Rotary positional encodings twist query and key vectors',
    });
    await new Promise(r => setTimeout(r, 25));

    mockCreate.mockResolvedValueOnce(makeStream(['Answer']));
    await request(app2)
      .post(`/api/chats/${child.body.id}/messages`)
      .send({ content: 'Ich habe dies nicht verstanden.' })
      .buffer(true);

    const call = mockCreate.mock.calls.at(-1)[0];
    const excerpts = call.messages.at(-2);
    expect(excerpts.role).toBe('user');
    expect(excerpts.content).toContain(FACT_PARA);
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

    // No retrieval — but the chat works as it did before ADR-0006.
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

// ─── Language mirroring (grill decision 2026-07-23) ──────────────────────────
// Answer, title, and summaries follow the user's language — German in,
// German out; mixed messages → dominant language.

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
    // Exponents/formulas belong in $…$ (renders as 10^{50}); raw ^/_ are forbidden.
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

// ─── Custom instructions (grill 2026-07-23) ──────────────────────────────────
// User free text from the settings that is attached to every chat system
// prompt — with explicit precedence over the built-in style rules. Applies
// ONLY to chat replies (+ warm-up, same prefix!), not to titles.

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
    // Precedence framing: user instructions beat the built-in style rules.
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
    // Scope decision (grill 2026-07-23): titles stay untouched. On Ollama
    // the title call INTENTIONALLY shares the conversation prefix (one KV
    // slot, measurement 2026-07-21) — there the block rides along as cache
    // ballast, and the title instruction at the end rules. Only the cloud
    // path has its own mini prompt, and that one must stay clean.
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

    // The last message of the title call is the title instruction — the
    // preceding prefix (incl. the custom-instructions block) is identical
    // to the conversation prompt, otherwise the title evicts the expensive
    // KV prefix.
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

  // ─── Instruction sandwich (2026-08-09) ────────────────────────────────────
  // Reported symptom: in deep trees the answers stopped following the
  // settings instructions. The block sat at the FRONT of a prompt that had
  // grown past 20k tokens. Same fix as the branch focus (2026-08-08): repeat
  // it next to the question.

  it('repeats the instructions in their own message behind the history', async () => {
    setSetting(db, 'custom_instructions', 'Correct my German after every answer.');

    await sendMessage();

    const messages = mockCreate.mock.calls[0][0].messages;
    // Last message is the question; the reminder sits directly before it.
    expect(messages.at(-1).role).toBe('user');
    const reminder = messages.at(-2);
    expect(reminder.role).toBe('user');
    expect(reminder.content).toContain('REMINDER');
    expect(reminder.content).toContain('Correct my German after every answer.');
    // Still present up front too — the shared prefix must not change, or
    // Ollama's KV cache and the warm-up contract break.
    expect(messages[0].content).toContain('Correct my German after every answer.');
  });

  it('adds no reminder when the toggle is off', async () => {
    setSetting(db, 'custom_instructions', 'Correct my German after every answer.');
    setSetting(db, 'custom_instructions_enabled', 'false');

    await sendMessage();

    for (const m of mockCreate.mock.calls[0][0].messages) {
      expect(m.content).not.toContain('Correct my German');
    }
  });

  it('adds no reminder while the text is empty (default)', async () => {
    await sendMessage();

    for (const m of mockCreate.mock.calls[0][0].messages) {
      expect(String(m.content)).not.toContain('REMINDER');
    }
  });

  it('keeps the reminder in the warm-up too (identical prompt, KV cache)', async () => {
    const realFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    try {
      setSetting(db, 'custom_instructions', 'Correct my German after every answer.');
      const chat = await request(app).post('/api/chats').send({ title: 'Warm' });
      mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'x' } }] });

      await request(app).post(`/api/chats/${chat.body.id}/messages/warmup`);

      const messages = mockCreate.mock.calls[0][0].messages;
      expect(messages.at(-1).content).toContain('REMINDER');
    } finally {
      global.fetch = realFetch;
    }
  });

  it('does not let the branch focus demote the instructions', async () => {
    // The focus block closes a branch prompt and used to open with
    // "everything above is only background" — which included the settings
    // instructions sitting above it. It must demote source and inherited
    // conversation only.
    setSetting(db, 'custom_instructions', 'Correct my German after every answer.');
    const parent = await request(app).post('/api/chats').send({ title: 'Paper chat' });
    mockCreate.mockResolvedValueOnce(makeStream(['Parent reply']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Parent Title' } }] });
    await request(app)
      .post(`/api/chats/${parent.body.id}/messages`)
      .send({ content: 'Parent question' })
      .buffer(true);

    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Parent summary.' } }] });
    const child = await request(app).post('/api/chats').send({
      title: 'About: perplexity',
      parent_id: parent.body.id,
      parent_word: 'geometric average',
    });
    await new Promise(r => setTimeout(r, 25));

    mockCreate.mockResolvedValueOnce(makeStream(['Child reply']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Child Title' } }] });
    await request(app)
      .post(`/api/chats/${child.body.id}/messages`)
      .send({ content: 'Ich habe dies nicht verstanden.' })
      .buffer(true);

    const branchCall = mockCreate.mock.calls.find(c =>
      c[0].messages.some(m => typeof m.content === 'string' && m.content.includes('exploring the term'))
    );
    const messages = branchCall[0].messages;
    const focus = messages.at(-2);
    // The focus keeps the last word (fix 2026-08-08) — the reminder sits
    // right before it, still within reach of the question.
    expect(focus.content).toContain("THE USER'S CURRENT FOCUS");
    expect(focus.content).not.toContain('everything above is only background');
    expect(focus.content).toMatch(/custom instructions above still apply/i);
    expect(messages.at(-3).content).toContain('REMINDER');
  });
});

// ─── Send queue, failure marker, and regenerate (2026-07-24) ─────────────────
// Ollama has one KV slot: concurrent questions run FIFO through a backend
// queue (user insert only at dequeue → answer 1 is in question 2's
// context). Errors persist a '*Failed*' marker instead of vanishing
// silently; /regenerate re-answers the last question without duplicating it.

describe('POST /api/chats/:chatId/messages – send queue', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  });
  afterEach(() => { global.fetch = realFetch; });

  // Chat with history + its own title: msgCount > 2 ⇒ no title calls
  // that would dilute the mockCreate count.
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

    // Answer 1 hangs on a gate until question 2 is enqueued.
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

    // Question 2 waited (queued event with one job ahead) and then got a
    // started event with its now-persisted question.
    expect(events2.find(e => e.queued)?.queued.ahead).toBe(1);
    const started2 = events2.find(e => e.started);
    expect(started2.userMessage.content).toBe('Second?');
    expect(events1.find(e => e.done).assistantMessage.content).toBe('Answer one');
    expect(events2.find(e => e.done).assistantMessage.content).toBe('Answer two');

    // Question 2's context contains question 1 AND answer 1 (hence the FIFO rule).
    const call2Messages = mockCreate.mock.calls[1][0].messages;
    const texts = call2Messages.map(m => m.content);
    expect(texts).toContain('First?');
    expect(texts).toContain('Answer one');

    // DB order: answer 1 comes BEFORE question 2.
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

    // Warm-up while a question is running: rejected instead of lining up
    // in Ollama's queue and evicting the answering chat's prefix.
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

    // The error event carries the persisted question + the marker for the frontend.
    const errEvent = events.find(e => e.error);
    expect(errEvent.error).toBe('Ollama exploded');
    expect(errEvent.userMessage.content).toBe('Doomed?');
    expect(errEvent.assistantMessage.content).toBe('*Failed*');

    // Both in the DB: the question is preserved, the marker survives reloads.
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

    // started/done carry the EXISTING question (same id, no duplicate).
    expect(events.find(e => e.started).userMessage.id).toBe('q1');
    expect(events.find(e => e.done).assistantMessage.content).toBe('Recovered answer');

    const rows = db.prepare(
      'SELECT id, role, content FROM messages WHERE chat_id = ? ORDER BY created_at ASC, id ASC'
    ).all(chatId);
    expect(rows.filter(r => r.content === 'Unlucky question')).toHaveLength(1);
    expect(rows.some(r => r.content === '*Failed*')).toBe(false);
    expect(rows.at(-1).content).toBe('Recovered answer');

    // Context: the question goes into the model as the last user message,
    // the marker appears nowhere.
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

// ─── Vision gate (ADR-0008 slice 3) ──────────────────────────────────────────
// Text-only cloud models (e.g. Groq gpt-oss-120b) may be selectable, but
// image attachments must fail with a clear hint — never silent dropping.

describe('vision gate for text-only cloud models', () => {
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );

  function useGroq() {
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'groq');
    setSetting(db, 'groq_api_key', 'gsk-test');
    setSetting(db, 'groq_model', 'openai/gpt-oss-120b');
  }

  it('rejects an image attachment with a clear hint instead of dropping it', async () => {
    useGroq();
    const chat = await request(app).post('/api/chats').send({ title: 'Vision' });

    const res = await request(app)
      .post(`/api/chats/${chat.body.id}/messages`)
      .field('text', 'What does this figure show?')
      .attach('files', PNG, { filename: 'figure.png', contentType: 'image/png' });

    const events = parseSSE(res.text);
    const errorEvent = events.find((e) => e.error);
    expect(errorEvent).toBeDefined();
    expect(errorEvent.error).toMatch(/image|bild/i);
    expect(errorEvent.error).toMatch(/gpt-oss-120b/);
    // No model call: the image must never be dropped silently.
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('still answers plain text questions on the same model', async () => {
    useGroq();
    mockCreate.mockResolvedValueOnce(makeStream(['Sure.']));
    // Title generation (cloud path, non-streaming)
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Title' } }] });
    const chat = await request(app).post('/api/chats').send({ title: 'Vision' });

    const res = await request(app)
      .post(`/api/chats/${chat.body.id}/messages`)
      .field('text', 'Just text, no image.');

    const events = parseSSE(res.text);
    expect(events.find((e) => e.done)).toBeDefined();
    expect(events.find((e) => e.error)).toBeUndefined();
  });
});

// ─── 429 handling (ADR-0008 slice 5) ─────────────────────────────────────────
// Cloud free tiers throttle. Per-minute limits: visible auto-retry in the
// queue (respect Retry-After). Daily limits: fail immediately with a
// switch-provider hint — waiting until midnight helps nobody.

describe('cloud rate limits (429)', () => {
  function useGemini() {
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'gemini');
    setSetting(db, 'gemini_api_key', 'AIza-test');
  }

  function err429(message, retryAfter) {
    const e = new Error(message);
    e.status = 429;
    if (retryAfter !== undefined) e.headers = { 'retry-after': String(retryAfter) };
    return e;
  }

  it('switches instantly on a per-minute 429 when a sibling model is free — no waiting', async () => {
    useGemini();
    mockCreate
      .mockRejectedValueOnce(err429('Rate limit exceeded, slow down', 0)) // flash limited
      .mockResolvedValueOnce(makeStream(['Recovered.']))                  // pro answers at once
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Title' } }] });
    const chat = await request(app).post('/api/chats').send({ title: 'RL' });

    const res = await request(app)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({ content: 'hello' });

    const events = parseSSE(res.text);
    // No countdown, no waiting: an immediate failover to the sibling model.
    // The ladder only gambles on FREE-tier siblings (cost tiers 2026-07-30):
    // Pro has no free quota, so the candidate is Flash Lite.
    expect(events.find((e) => e.rateLimit)).toBeUndefined();
    expect(events.find((e) => e.failover).failover).toMatchObject({
      fromModel: 'gemini-flash-latest', model: 'gemini-flash-lite-latest',
    });
    expect(events.find((e) => e.done)).toBeDefined();
    expect(events.find((e) => e.error)).toBeUndefined();
  });

  it('waits with a visible countdown only when ALL candidates are limited', async () => {
    useGemini();
    mockCreate
      .mockRejectedValueOnce(err429('Rate limit exceeded', 0)) // flash limited → failover
      .mockRejectedValueOnce(err429('Rate limit exceeded', 0)) // pro limited too → nobody left
      .mockResolvedValueOnce(makeStream(['Recovered.']))       // pro succeeds after the wait
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Title' } }] });
    const chat = await request(app).post('/api/chats').send({ title: 'RL' });

    const res = await request(app)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({ content: 'hello' });

    const events = parseSSE(res.text);
    expect(events.find((e) => e.failover)).toBeDefined();
    const rl = events.find((e) => e.rateLimit);
    expect(rl).toBeDefined();
    // Variant C (mockup-quota-states §10): the event names WHICH minute
    // limit bit and on which model, for the precise wait row.
    expect(rl.rateLimit.scope).toBe('requests');
    expect(typeof rl.rateLimit.model).toBe('string');
    expect(events.find((e) => e.done)).toBeDefined();
    expect(events.find((e) => e.error)).toBeUndefined();
  });

  it('fails fast with a switch-provider hint when the daily quota is gone', async () => {
    useGemini();
    mockCreate.mockRejectedValue(
      err429('Quota exceeded for metric generate_requests_per_model_per_day')
    );
    const chat = await request(app).post('/api/chats').send({ title: 'RL' });

    const res = await request(app)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({ content: 'hello' });

    const events = parseSSE(res.text);
    const errorEvent = events.find((e) => e.error);
    expect(errorEvent).toBeDefined();
    expect(errorEvent.error).toMatch(/daily|Tages/i);
    expect(errorEvent.error).toMatch(/switch|wechsel/i);
    // No retry on a daily limit, but the FREE sibling of the same provider
    // (Flash Lite, separate quota) is tried once before giving up. Pro is
    // never gambled on: without billing it fails deterministically
    // (cost tiers 2026-07-30).
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls.map((c) => c[0].model)).toEqual([
      'gemini-flash-latest',
      'gemini-flash-lite-latest',
    ]);
  });

  it('classifies a zero-limit 429 as billing: no retry time, no failover gamble', async () => {
    useGemini();
    const { setSetting } = require('../llm');
    setSetting(db, 'gemini_model', 'gemini-pro-latest');
    // Google's limit-0 shape: the free tier of this model is literally zero.
    mockCreate.mockRejectedValue(
      err429('You exceeded your current quota, please check your plan and billing details. ' +
        '"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier","quotaValue":"0"')
    );
    const chat = await request(app).post('/api/chats').send({ title: 'RL' });

    const res = await request(app)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({ content: 'hello' });

    const events = parseSSE(res.text);
    const errorEvent = events.find((e) => e.error);
    expect(errorEvent).toBeDefined();
    expect(errorEvent.quotaReason).toBe('billing');
    // Not a daily limit: it does not come back at midnight, so no clock.
    expect(errorEvent.retryAt).toBeUndefined();
    expect(errorEvent.failProvider).toBe('gemini');
    expect(errorEvent.failModel).toBe('gemini-pro-latest');
    // The user picked Pro deliberately — switching is THEIR call (W4 card),
    // not an automatic ladder move.
    expect(events.find((e) => e.failover)).toBeUndefined();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('gives up with *Failed* after three rate-limited attempts', async () => {
    useGemini();
    mockCreate.mockRejectedValue(err429('Rate limit exceeded', 0));
    const chat = await request(app).post('/api/chats').send({ title: 'RL' });

    const res = await request(app)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({ content: 'hello' });

    const events = parseSSE(res.text);
    expect(events.find((e) => e.error)).toBeDefined();
    // One attempt on the active model (then instant failover), three waited
    // attempts on the sibling — only then *Failed*.
    expect(mockCreate).toHaveBeenCalledTimes(4);
  });
});

// ─── Overloaded provider (503) ───────────────────────────────────────────────
// "This model is currently experiencing high demand" is neither a quota nor a
// key problem: measured 2026-08-16, the same prompt drew five 503s and one
// clean answer inside four minutes. So it is retried in place, the wait is
// announced, and the model keeps its place in the picker
// (design/mockup-truncated-answer.html §03).

describe('overloaded provider (503)', () => {
  function useGemini() {
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'gemini');
    setSetting(db, 'gemini_api_key', 'AIza-test');
  }

  function err503() {
    const e = new Error('This model is currently experiencing high demand. Please try again later.');
    e.status = 503;
    return e;
  }

  // Zero-second pauses: the production ladder waits 2+4+8 s, which this suite
  // would otherwise spend doing nothing.
  const fastApp = () => createApp(db, { messages: { overloadBackoffSeconds: [0, 0, 0] } });

  async function send(appUnderTest) {
    const chat = await request(app).post('/api/chats').send({ title: 'OL' });
    const res = await request(appUnderTest)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({ content: 'hello' });
    return parseSSE(res.text);
  }

  it('retries the SAME model and announces the wait', async () => {
    useGemini();
    mockCreate
      .mockRejectedValueOnce(err503())
      .mockResolvedValueOnce(makeStream(['Recovered.']))
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Title' } }] });

    const events = await send(fastApp());

    const ol = events.find((e) => e.overloaded);
    expect(ol).toBeDefined();
    expect(ol.overloaded).toMatchObject({ attempt: 1, maxAttempts: 3, provider: 'gemini' });
    expect(typeof ol.overloaded.retryInSeconds).toBe('number');
    // Same model, no ladder move: the model is fine, its servers are busy.
    expect(events.find((e) => e.failover)).toBeUndefined();
    expect(events.find((e) => e.done)).toBeDefined();
    expect(events.find((e) => e.error)).toBeUndefined();
  });

  it('never puts an overloaded model on cooldown — the picker keeps offering it', async () => {
    useGemini();
    mockCreate
      .mockRejectedValueOnce(err503())
      .mockResolvedValueOnce(makeStream(['Recovered.']))
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Title' } }] });

    await send(fastApp());

    const res = await request(app).get('/api/quota-cooldowns');
    const list = Array.isArray(res.body) ? res.body : res.body.cooldowns ?? [];
    expect(list.filter((c) => c.model === 'gemini-flash-latest')).toEqual([]);
  });

  it('gives up after three attempts and names the cause', async () => {
    useGemini();
    mockCreate.mockRejectedValue(err503());

    const events = await send(fastApp());

    const err = events.find((e) => e.error);
    expect(err).toBeDefined();
    expect(err.failReason).toBe('overloaded');
    // One first try plus three retries — the 429 budget stays untouched.
    expect(mockCreate).toHaveBeenCalledTimes(4);
  });
});

// ─── A cloud provider that stops answering (measured 2026-08-26) ────────────
// Google's gemini-flash-latest did not only answer 503 that day: a second
// request produced NOTHING AT ALL — no headers, no error, no chunk, still
// open after 60 s. The SDK is built with maxRetries 0 and the stream had no
// deadline, so the whole answer waited forever: no text, no error card, just
// a spinner. A silence is the same event as a 503 from where the user sits,
// so it is fed into the SAME ladder instead of a mechanism of its own.
describe('a cloud provider that goes silent', () => {
  function useGemini() {
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'gemini');
    setSetting(db, 'gemini_api_key', 'AIza-test');
  }

  // Never resolves on its own — only the stall deadline can end it, exactly
  // like the socket that hung open against Google.
  const silent = () => (_payload, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      const e = new Error('Request was aborted.');
      e.name = 'AbortError';
      reject(e);
    }, { once: true });
  });

  // Alive, just unhurried: a gap between chunks must re-arm the deadline,
  // otherwise a long answer would be cut off mid-sentence.
  function makeSlowStream(words, gapMs) {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const word of words) {
          await new Promise((r) => setTimeout(r, gapMs));
          yield { choices: [{ delta: { content: word } }] };
        }
        yield { choices: [{ delta: {} }] };
      },
    };
  }

  // Milliseconds instead of the production 60 s, and no pauses between the
  // overload retries — this suite asserts the wiring, not the clock.
  const watchedApp = (stallMs) =>
    createApp(db, { messages: { stallMs, overloadBackoffSeconds: [0, 0, 0] } });

  async function send(appUnderTest) {
    const chat = await request(app).post('/api/chats').send({ title: 'Silent' });
    const res = await request(appUnderTest)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({ content: 'hello' });
    return parseSSE(res.text);
  }

  it('treats silence as an overload: same model, announced wait, then the answer', async () => {
    useGemini();
    mockCreate
      .mockImplementationOnce(silent())
      .mockResolvedValueOnce(makeStream(['Recovered.']))
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Title' } }] });

    const events = await send(watchedApp(120));

    const ol = events.find((e) => e.overloaded);
    expect(ol).toBeDefined();
    expect(ol.overloaded).toMatchObject({ attempt: 1, provider: 'gemini' });
    // The model is not at fault, so it keeps its place: no ladder move.
    expect(events.find((e) => e.failover)).toBeUndefined();
    expect(events.find((e) => e.error)).toBeUndefined();
    expect(events.filter((e) => e.delta).map((e) => e.delta).join('')).toBe('Recovered.');
  });

  it('gives up with a named cause instead of hanging forever', async () => {
    useGemini();
    mockCreate.mockImplementation(silent());

    const events = await send(watchedApp(60));

    const err = events.find((e) => e.error);
    expect(err).toBeDefined();
    expect(err.failReason).toBe('overloaded');
    expect(mockCreate).toHaveBeenCalledTimes(4);
  });

  it('never puts a silent model on cooldown — the silence passes on its own', async () => {
    useGemini();
    mockCreate.mockImplementation(silent());

    await send(watchedApp(60));

    const res = await request(app).get('/api/quota-cooldowns');
    const list = Array.isArray(res.body) ? res.body : res.body.cooldowns ?? [];
    expect(list.filter((c) => c.model === 'gemini-flash-latest')).toEqual([]);
  });

  it('every chunk re-arms the deadline — a slow answer is not cut off', async () => {
    useGemini();
    mockCreate
      .mockResolvedValueOnce(makeSlowStream(['One ', 'two ', 'three ', 'four.'], 40))
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Title' } }] });

    const events = await send(watchedApp(120));

    expect(events.find((e) => e.error)).toBeUndefined();
    expect(events.find((e) => e.overloaded)).toBeUndefined();
    expect(events.filter((e) => e.delta).map((e) => e.delta).join('')).toBe('One two three four.');
  });

  // The local provider keeps the unwatched path (CLAUDE.md: no complexity on
  // the local path). Ingesting a whole paper legitimately sits silent for a
  // minute or more on the 24 GB Mac, and a deadline tuned to the cloud would
  // kill exactly the calls that are working hardest.
  it('leaves Ollama unwatched — a long local prefill still gets through', async () => {
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'ollama');
    mockCreate
      .mockResolvedValueOnce(makeSlowStream(['Local.'], 120))
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Title' } }] });

    const events = await send(watchedApp(30));

    expect(events.find((e) => e.error)).toBeUndefined();
    expect(events.find((e) => e.overloaded)).toBeUndefined();
    expect(events.filter((e) => e.delta).map((e) => e.delta).join('')).toBe('Local.');
  });
});

// ─── Automatic provider failover (user requests 2026-07-25, two rounds) ─────
// Limits are PER MODEL, so failover first tries the other models of the SAME
// provider (same key), then other providers. Models that reported a daily
// quota are remembered (until UTC midnight) and skipped proactively — no
// re-running into known walls; per-minute exhaustion cools down for 90 s.

describe('automatic provider failover on quota exhaustion', () => {
  const dailyQuotaError = () =>
    Object.assign(new Error('Quota exceeded for metric generate_requests_per_model_per_day'), { status: 429 });

  function useGroqAndGemini() {
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'groq');
    setSetting(db, 'groq_api_key', 'gsk-test');
    setSetting(db, 'gemini_api_key', 'AIza-test');
  }

  async function send(text = 'hello') {
    const chat = await request(app).post('/api/chats').send({ title: 'FO' });
    const res = await request(app)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({ content: text });
    return parseSSE(res.text);
  }

  it('fails over to another model of the SAME provider first (limits are per model)', async () => {
    useGroqAndGemini();
    mockCreate
      .mockRejectedValueOnce(dailyQuotaError())               // groq gpt-oss: daily gone
      .mockResolvedValueOnce(makeStream(['From Llama.']))     // groq llama answers
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Title' } }] });

    const events = await send();

    const failover = events.find((e) => e.failover);
    expect(failover.failover).toMatchObject({
      from: 'groq', to: 'groq',
      fromModel: 'openai/gpt-oss-120b', model: 'llama-3.3-70b-versatile',
    });
    expect(events.find((e) => e.done).assistantMessage.content).toBe('From Llama.');
    // The answer call went to the sibling model.
    expect(mockCreate.mock.calls[1][0].model).toBe('llama-3.3-70b-versatile');
  });

  it('remembers exhausted models and skips them proactively on the next message', async () => {
    useGroqAndGemini();
    // Message 1: gpt-oss daily-quota → llama answers.
    mockCreate
      .mockRejectedValueOnce(dailyQuotaError())
      .mockResolvedValueOnce(makeStream(['From Llama.']))
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Title' } }] });
    await send();

    // Message 2: gpt-oss must NOT be tried again — first call goes straight
    // to llama, with a failover notice but zero wasted requests.
    mockCreate.mockClear();
    mockCreate
      .mockResolvedValueOnce(makeStream(['Still Llama.']))
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Title' } }] });
    const events = await send('again');

    expect(mockCreate.mock.calls[0][0].model).toBe('llama-3.3-70b-versatile');
    expect(events.find((e) => e.failover)).toBeDefined();
    expect(events.find((e) => e.done).assistantMessage.content).toBe('Still Llama.');
  });

  it('walks through providers and fails with the switch hint only when ALL candidates are exhausted', async () => {
    useGroqAndGemini();
    mockCreate.mockRejectedValue(dailyQuotaError()); // everyone is out of quota

    const events = await send();

    // Tried: groq gpt-oss + groq llama + gemini flash + gemini flash lite
    // = 4 calls. Gemini Pro is paid-only and never gambled on (2026-07-30).
    expect(mockCreate.mock.calls.map((c) => c[0].model)).toEqual([
      'openai/gpt-oss-120b',
      'llama-3.3-70b-versatile',
      'gemini-flash-latest',
      'gemini-flash-lite-latest',
    ]);
    expect(events.find((e) => e.error).error).toMatch(/switch/i);
  });

  it('keeps the global setting untouched after a failover', async () => {
    useGroqAndGemini();
    mockCreate
      .mockRejectedValueOnce(dailyQuotaError())
      .mockResolvedValueOnce(makeStream(['ok']))
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Title' } }] });
    await send();

    const settings = await request(app).get('/api/settings');
    expect(settings.body.llm_provider).toBe('groq');
    expect(settings.body.groq_model).toBe('openai/gpt-oss-120b');
  });

  it('skips text-only candidates when the question carries an image', async () => {
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'groq');
    setSetting(db, 'groq_api_key', 'gsk-test');
    setSetting(db, 'groq_model', 'llama-3.3-70b-versatile');
    setSetting(db, 'gemini_api_key', 'AIza-test');
    // Active groq model is text-only + image attached → vision gate skips
    // BOTH text-only groq models; the candidate is the free vision-capable
    // Gemini Flash.
    mockCreate
      .mockResolvedValueOnce(makeStream(['From Gemini.']))
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Title' } }] });
    const PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    const chat = await request(app).post('/api/chats').send({ title: 'FO' });

    const res = await request(app)
      .post(`/api/chats/${chat.body.id}/messages`)
      .field('text', 'what is in this figure?')
      .attach('files', PNG, { filename: 'fig.png', contentType: 'image/png' });

    const events = parseSSE(res.text);
    expect(events.find((e) => e.failover).failover).toMatchObject({ to: 'gemini' });
    expect(events.find((e) => e.done).assistantMessage.content).toBe('From Gemini.');
  });

  it('never silently switches an image question onto a PAID vision model', async () => {
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'groq');
    setSetting(db, 'groq_api_key', 'gsk-test');
    setSetting(db, 'groq_model', 'llama-3.3-70b-versatile');
    setSetting(db, 'openai_api_key', 'sk-test');
    // Only paid vision candidates exist (OpenAI). Spending money unasked is
    // worse than a clear card (cost tiers 2026-07-30) — the no-vision hint
    // surfaces and OpenAI is never called.
    const PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    const chat = await request(app).post('/api/chats').send({ title: 'FO' });

    const res = await request(app)
      .post(`/api/chats/${chat.body.id}/messages`)
      .field('text', 'what is in this figure?')
      .attach('files', PNG, { filename: 'fig.png', contentType: 'image/png' });

    const events = parseSSE(res.text);
    const errorEvent = events.find((e) => e.error);
    expect(errorEvent.failReason).toBe('no_vision');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// ─── Failover rebuilds the prompt for the candidate (fix 2026-07-29) ─────────
// The prompt used to be built ONCE, sized to the ACTIVE model's budget cap,
// and shipped verbatim to every failover candidate. A Gemini-sized full-text
// prompt (32k cap) hit Groq's 8k cap as a deterministic 413 on every Groq
// model, and the card claimed "too large for the cloud limits" although a
// Groq-sized prompt (retrieval mode) would have fit — proven live 2026-07-29
// by a manual switch-to-Groq retry that answered fine.

describe('failover rebuilds the prompt for the candidate model', () => {
  const dailyQuotaError = () =>
    Object.assign(new Error('Quota exceeded for metric generate_requests_per_model_per_day'), { status: 429 });

  const FACT_PARA =
    'The rotary positional encodings rotate query and key vectors by position-dependent angles.';
  // ~50k chars: full text under Gemini's 32k-token cap (~97k chars), far
  // beyond Groq's 8k-token cap (~10.5k chars) and the local window (~40k).
  function longPaperText() {
    const paras = Array.from(
      { length: 520 },
      (_, i) => `Paragraph ${i} discussing unrelated background material in sufficient detail to fill space.`
    );
    paras[260] = FACT_PARA;
    return paras.join('\n\n');
  }
  const fakeEmbed = jest.fn(async (texts) =>
    texts.map((t) => (t.includes('positional encodings') ? [1, 0] : [0, 1]))
  );

  function paperApp() {
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
    ).run('paper-budget', 'RoFormer', new Date().toISOString(), '/fake/long.pdf', 'ready');
    db.prepare('UPDATE chats SET paper_id = ? WHERE id = ?').run('paper-budget', chatId);
  }

  it('re-sizes a Gemini full-text prompt to Groq\'s budget instead of shipping it verbatim', async () => {
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'gemini');
    setSetting(db, 'gemini_api_key', 'AIza-test');
    setSetting(db, 'groq_api_key', 'gsk-test');
    const app2 = paperApp();
    const chat = await request(app2).post('/api/chats').send({ title: 'Budget' });
    bindPaper(chat.body.id);
    mockCreate
      .mockRejectedValueOnce(dailyQuotaError())              // gemini flash: daily gone
      .mockRejectedValueOnce(dailyQuotaError())              // gemini pro: daily gone
      .mockResolvedValueOnce(makeStream(['From Groq.']))     // groq answers
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Title' } }] });

    const res = await request(app2)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({ content: 'Explain rotary positional encodings' })
      .buffer(true);
    const events = parseSSE(res.text);

    // Gemini got the full text — the paper fits ITS budget.
    expect(mockCreate.mock.calls[0][0].messages[0].content).toContain('PAPER TEXT START');
    // Groq gets a prompt rebuilt for ITS budget: skeleton + excerpts.
    const groqCall = mockCreate.mock.calls[2][0];
    expect(groqCall.model).toBe('openai/gpt-oss-120b');
    expect(groqCall.messages[0].content).toContain('PAPER SKELETON START');
    expect(groqCall.messages[0].content).not.toContain('PAPER TEXT START');
    // Hard bound: the whole rebuilt prompt stays under Groq's 8k-token cap
    // (chars/3.5 is the repo's own conservative token estimate).
    const totalChars = groqCall.messages.reduce(
      (n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0
    );
    expect(totalChars).toBeLessThan(8000 * 3.5);
    // The user gets an answer — not a too_large card.
    expect(events.find((e) => e.done).assistantMessage.content).toBe('From Groq.');
    expect(events.find((e) => e.error)).toBeUndefined();
  });

  it('sizes the one-off local regenerate to the LOCAL budget, not the cloud one', async () => {
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'gemini');
    setSetting(db, 'gemini_api_key', 'AIza-test');
    const app2 = paperApp();
    const chatId = 'chat-local-budget';
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
      .run(chatId, 'EX', '2026-07-29T10:00:00.000Z');
    bindPaper(chatId);
    db.prepare('INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('q1', chatId, 'user', 'Explain rotary positional encodings', '2026-07-29T10:00:01.000Z');
    db.prepare('INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('f1', chatId, 'assistant', '*Failed*', '2026-07-29T10:00:02.000Z');
    mockCreate.mockResolvedValueOnce(makeStream(['Local answer.']));

    const res = await request(app2)
      .post(`/api/chats/${chatId}/messages/regenerate`)
      .send({ messageId: 'f1', provider: 'ollama' });
    const events = parseSSE(res.text);

    expect(events.find((e) => e.done).assistantMessage.content).toBe('Local answer.');
    // The 50k-char paper exceeds the local window (~40k chars) — the local
    // one-off must get the retrieval prompt, never Gemini's full text.
    const call = mockCreate.mock.calls[0][0];
    expect(call.model).toBe('qwen3.5:9b');
    expect(call.messages[0].content).toContain('PAPER SKELETON START');
    expect(call.messages[0].content).not.toContain('PAPER TEXT START');
  });
});

// ─── Anchored regenerate (user report 2026-07-25) ───────────────────────────
// With the send queue, several questions can fail in a row. "Try again" must
// answer ITS question — with the history up to that question — and the new
// answer (or a fresh *Failed*) must take the old marker's position, not the
// end of the chat. Otherwise retried answers land under the wrong question.

describe('anchored regenerate for mid-chat failed markers', () => {
  const FAILED = '*Failed*';

  function seedChatWithTwoFailedExchanges() {
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'ollama');
    const chatId = 'chat-anchored';
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
      .run(chatId, 'Anchored', '2026-07-25T10:00:00.000Z');
    const rows = [
      ['q1', 'user', 'first question', '2026-07-25T10:00:01.000Z'],
      ['f1', 'assistant', FAILED, '2026-07-25T10:00:02.000Z'],
      ['q2', 'user', 'second question', '2026-07-25T10:00:03.000Z'],
      ['f2', 'assistant', FAILED, '2026-07-25T10:00:04.000Z'],
    ];
    for (const [id, role, content, ts] of rows) {
      db.prepare('INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, chatId, role, content, ts);
    }
    return chatId;
  }

  it('answers ITS question in place — history stops at that question', async () => {
    const chatId = seedChatWithTwoFailedExchanges();
    mockCreate.mockResolvedValueOnce(makeStream(['Answer to the first.']));

    const res = await request(app)
      .post(`/api/chats/${chatId}/messages/regenerate`)
      .send({ messageId: 'f1' });
    expect(parseSSE(res.text).find((e) => e.done)).toBeDefined();

    // The model saw the history only UP TO the first question — the second
    // exchange must not leak into the context of the first answer.
    const sent = mockCreate.mock.calls[0][0].messages.map((m) => m.content).join('\n');
    expect(sent).toContain('first question');
    expect(sent).not.toContain('second question');

    // Position: the answer replaces the marker — order stays Q1, A1, Q2, F2.
    const chat = await request(app).get(`/api/chats/${chatId}`);
    expect(chat.body.messages.map((m) => m.content)).toEqual([
      'first question',
      'Answer to the first.',
      'second question',
      FAILED,
    ]);
  });

  it('keeps the position even when the retry fails again', async () => {
    const chatId = seedChatWithTwoFailedExchanges();
    mockCreate.mockRejectedValue(new Error('boom'));

    const res = await request(app)
      .post(`/api/chats/${chatId}/messages/regenerate`)
      .send({ messageId: 'f1' });
    expect(parseSSE(res.text).find((e) => e.error)).toBeDefined();

    const chat = await request(app).get(`/api/chats/${chatId}`);
    expect(chat.body.messages.map((m) => m.content)).toEqual([
      'first question',
      FAILED,
      'second question',
      FAILED,
    ]);
  });

  it('still regenerates the LAST question when no messageId is sent (legacy)', async () => {
    const chatId = seedChatWithTwoFailedExchanges();
    mockCreate
      .mockResolvedValueOnce(makeStream(['Answer to the second.']))
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Title' } }] });

    const res = await request(app)
      .post(`/api/chats/${chatId}/messages/regenerate`)
      .send({});
    expect(parseSSE(res.text).find((e) => e.done)).toBeDefined();

    const chat = await request(app).get(`/api/chats/${chatId}`);
    expect(chat.body.messages.map((m) => m.content)).toEqual([
      'first question',
      FAILED,
      'second question',
      'Answer to the second.',
    ]);
  });
});

// ─── Model-unavailable failover (edge case found live 2026-07-25) ───────────
// Google retired the 2.5 models for NEW accounts: a valid key gets HTTP 404
// "no longer available to new users". That must trigger the same failover as
// an exhausted quota — not a bare *Failed*.

describe('failover when the model itself is unavailable (404)', () => {
  it('falls over to the next candidate on a model-unavailable 404', async () => {
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'gemini');
    setSetting(db, 'gemini_api_key', 'AIza-test');
    setSetting(db, 'groq_api_key', 'gsk-test');
    mockCreate
      .mockRejectedValueOnce(Object.assign(
        new Error('This model models/gemini-flash-latest is no longer available to new users.'),
        { status: 404 }
      ))
      .mockRejectedValueOnce(Object.assign(
        new Error('This model models/gemini-pro-latest is no longer available to new users.'),
        { status: 404 }
      ))
      .mockResolvedValueOnce(makeStream(['From Groq instead.']))
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Title' } }] });
    const chat = await request(app).post('/api/chats').send({ title: '404' });

    const res = await request(app)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({ content: 'hello' });

    const events = parseSSE(res.text);
    expect(events.find((e) => e.failover)).toBeDefined();
    expect(events.find((e) => e.done).assistantMessage.content).toBe('From Groq instead.');
    expect(events.find((e) => e.error)).toBeUndefined();
  });
});

// ─── Local emergency fallback (user request 2026-07-25) ─────────────────────
// When ALL cloud candidates are exhausted, the error announces it
// (quotaExhausted flag), and the retry button may answer ONCE via the local
// model — without touching the stored settings.

describe('local emergency fallback when every cloud quota is gone', () => {
  const dailyQuotaError = () =>
    Object.assign(new Error('Quota exceeded for metric generate_requests_per_model_per_day'), { status: 429 });

  it('flags the error event when all candidates are exhausted', async () => {
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'gemini');
    setSetting(db, 'gemini_api_key', 'AIza-test');
    mockCreate.mockRejectedValue(dailyQuotaError());
    const chat = await request(app).post('/api/chats').send({ title: 'EX' });

    const res = await request(app)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({ content: 'hello' });

    const errorEvent = parseSSE(res.text).find((e) => e.error);
    expect(errorEvent.quotaExhausted).toBe(true);
    // retryAt = earliest cooldown expiry (mockup-quota-states §04): a daily
    // limit cools until UTC midnight, so the timestamp lies in the future.
    expect(new Date(errorEvent.retryAt).getTime()).toBeGreaterThan(Date.now());
    // quotaReason picks the precise card copy (mockup-quota-states v3).
    expect(errorEvent.quotaReason).toBe('daily');
  });

  it('reports cooling models on GET /api/quota-cooldowns for the picker badges', async () => {
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'gemini');
    setSetting(db, 'gemini_api_key', 'AIza-test');
    mockCreate.mockRejectedValue(dailyQuotaError());
    const chat = await request(app).post('/api/chats').send({ title: 'EX' });
    await request(app)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({ content: 'hello' });

    const res = await request(app).get('/api/quota-cooldowns');
    expect(res.status).toBe(200);
    expect(res.body.cooldowns.length).toBeGreaterThan(0);
    const entry = res.body.cooldowns.find((c) => c.provider === 'gemini');
    expect(entry).toBeDefined();
    expect(new Date(entry.until).getTime()).toBeGreaterThan(Date.now());
  });

  it('regenerates once via the local model when provider "ollama" is requested', async () => {
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'gemini');
    setSetting(db, 'gemini_api_key', 'AIza-test');
    const chatId = 'chat-local-fb';
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
      .run(chatId, 'EX', '2026-07-25T10:00:00.000Z');
    db.prepare('INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('q1', chatId, 'user', 'the question', '2026-07-25T10:00:01.000Z');
    db.prepare('INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('f1', chatId, 'assistant', '*Failed*', '2026-07-25T10:00:02.000Z');
    mockCreate.mockResolvedValueOnce(makeStream(['Local answer.']));

    const res = await request(app)
      .post(`/api/chats/${chatId}/messages/regenerate`)
      .send({ messageId: 'f1', provider: 'ollama' });

    const events = parseSSE(res.text);
    expect(events.find((e) => e.done).assistantMessage.content).toBe('Local answer.');
    // The one-off answer used the local model — no key, local baseURL…
    expect(mockCreate.mock.calls[0][0].model).toBe('qwen3.5:9b');
    // …and the stored settings stayed on gemini.
    const settings = await request(app).get('/api/settings');
    expect(settings.body.llm_provider).toBe('gemini');
  });

  it('rejects provider overrides other than ollama', async () => {
    const chatId = 'chat-local-fb2';
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
      .run(chatId, 'EX', '2026-07-25T10:00:00.000Z');
    db.prepare('INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('f1', chatId, 'assistant', '*Failed*', '2026-07-25T10:00:02.000Z');

    const res = await request(app)
      .post(`/api/chats/${chatId}/messages/regenerate`)
      .send({ messageId: 'f1', provider: 'openai' });
    expect(res.status).toBe(400);
  });
});

// ─── failReason — honest cards for swallowed errors (mockup-model-flow §05/§06) ─
// no_key / bad_key / no_vision were persisted as bare '*Failed*' markers; the
// UI could only render the generic row with a retry that fails identically.
// The SSE error and the persisted marker now carry the machine-readable cause.

describe('failReason for swallowed errors', () => {
  it('no_key: reports failReason + provider on the error event and persists it', async () => {
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'gemini'); // no gemini_api_key set
    const chat = await request(app).post('/api/chats').send({ title: 'NK' });

    const res = await request(app)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({ content: 'hello' });

    const errorEvent = parseSSE(res.text).find((e) => e.error);
    expect(errorEvent.failReason).toBe('no_key');
    expect(errorEvent.failProvider).toBe('gemini');
    // The marker keeps the cause so the card survives a reload (§06).
    const marker = db.prepare(
      "SELECT * FROM messages WHERE chat_id = ? AND role = 'assistant'"
    ).get(chat.body.id);
    expect(marker.content).toBe('*Failed*');
    expect(marker.fail_reason).toBe('no_key');
    // GET returns the column for the reload path.
    const loaded = await request(app).get(`/api/chats/${chat.body.id}`);
    const row = loaded.body.messages.find((m) => m.role === 'assistant');
    expect(row.fail_reason).toBe('no_key');
  });
});

describe('failReason for swallowed errors — no_vision and bad_key', () => {
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );

  it('no_vision: names the model on the error event and persists the cause', async () => {
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'groq');
    setSetting(db, 'groq_api_key', 'gsk-test');
    setSetting(db, 'groq_model', 'openai/gpt-oss-120b'); // vision: false
    const chat = await request(app).post('/api/chats').send({ title: 'NV' });

    const res = await request(app)
      .post(`/api/chats/${chat.body.id}/messages`)
      .field('text', 'What does this figure show?')
      .attach('files', PNG, { filename: 'figure.png', contentType: 'image/png' });

    const errorEvent = parseSSE(res.text).find((e) => e.error);
    expect(errorEvent.failReason).toBe('no_vision');
    expect(errorEvent.failModel).toBe('openai/gpt-oss-120b');
    const marker = db.prepare(
      "SELECT * FROM messages WHERE chat_id = ? AND role = 'assistant'"
    ).get(chat.body.id);
    expect(marker.fail_reason).toBe('no_vision');
  });

  it('bad_key: a 401 mid-use (key revoked after saving) is classified, not generic', async () => {
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'gemini');
    setSetting(db, 'gemini_api_key', 'AIza-revoked');
    mockCreate.mockRejectedValue(Object.assign(new Error('Invalid API key'), { status: 401 }));
    const chat = await request(app).post('/api/chats').send({ title: 'BK' });

    const res = await request(app)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({ content: 'hello' });

    const errorEvent = parseSSE(res.text).find((e) => e.error);
    expect(errorEvent.failReason).toBe('bad_key');
    expect(errorEvent.failProvider).toBe('gemini');
    const marker = db.prepare(
      "SELECT * FROM messages WHERE chat_id = ? AND role = 'assistant'"
    ).get(chat.body.id);
    expect(marker.fail_reason).toBe('bad_key');
  });
});

// ─── Interrupted gets an exit (mockup-model-flow §09) ────────────────────────
// '*Interrupted*' was a dead end: no retry in the UI and the regenerate
// endpoint accepted only '*Failed*'. Any accidental stop, reload mid-answer
// or connection drop forced the user to re-type the question.

describe('regenerate accepts *Interrupted* markers', () => {
  it('anchored: re-answers the question above an *Interrupted* marker in place', async () => {
    const chatId = 'chat-int-1';
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
      .run(chatId, 'INT', '2026-07-26T10:00:00.000Z');
    db.prepare('INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('q1', chatId, 'user', 'the question', '2026-07-26T10:00:01.000Z');
    db.prepare('INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('i1', chatId, 'assistant', '*Interrupted*', '2026-07-26T10:00:02.000Z');
    mockCreate.mockResolvedValueOnce(makeStream(['Full answer this time.']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Title' } }] });

    const res = await request(app)
      .post(`/api/chats/${chatId}/messages/regenerate`)
      .send({ messageId: 'i1' });

    const events = parseSSE(res.text);
    expect(events.find((e) => e.done).assistantMessage.content).toBe('Full answer this time.');
    // The marker is gone; the replacement takes its slot.
    const rows = db.prepare(
      "SELECT * FROM messages WHERE chat_id = ? AND role = 'assistant'"
    ).all(chatId);
    expect(rows).toHaveLength(1);
    expect(rows[0].created_at).toBe('2026-07-26T10:00:02.000Z');
  });

  it('non-anchored: a trailing *Interrupted* also counts (post-drop reconciliation)', async () => {
    const chatId = 'chat-int-2';
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
      .run(chatId, 'INT', '2026-07-26T10:00:00.000Z');
    db.prepare('INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('q1', chatId, 'user', 'the question', '2026-07-26T10:00:01.000Z');
    db.prepare('INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('i1', chatId, 'assistant', '*Interrupted*', '2026-07-26T10:00:02.000Z');
    mockCreate.mockResolvedValueOnce(makeStream(['Recovered.']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Title' } }] });

    const res = await request(app)
      .post(`/api/chats/${chatId}/messages/regenerate`)
      .send({});

    const events = parseSSE(res.text);
    expect(events.find((e) => e.done).assistantMessage.content).toBe('Recovered.');
  });
});

describe('abort during a rate-limit wait', () => {
  it('persists *Interrupted*, not *Failed* — the UI already says "Unterbrochen"', async () => {
    // Audit 2 (2026-07-26): stop during the 429 sleep hit the generic catch
    // and persisted *Failed*; after a reload the row silently flipped from
    // "Unterbrochen" to a failed row. One abort = one truth: *Interrupted*.
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'gemini');
    setSetting(db, 'gemini_api_key', 'AIza-test');
    const err429 = Object.assign(new Error('Rate limit exceeded'), {
      status: 429, headers: { 'retry-after': '2' },
    });
    mockCreate.mockRejectedValue(err429);
    const chat = await request(app).post('/api/chats').send({ title: 'ABRL' });

    const req = request(app)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({ content: 'hello' });
    setTimeout(() => req.abort(), 300); // both candidates 429'd; job sleeps
    await req.catch(() => { /* aborted by us */ });
    await new Promise((r) => setTimeout(r, 250)); // let the job finish persisting

    const saved = db.prepare(
      "SELECT content, fail_reason FROM messages WHERE chat_id = ? AND role = 'assistant'"
    ).all(chat.body.id);
    expect(saved).toHaveLength(1);
    expect(saved[0].content).toBe('*Interrupted*');
    expect(saved[0].fail_reason).toBeNull();
  });
});

// ─── Nothing gets lost — persist at enqueue (mockup-model-flow §10) ──────────
// The user message used to be persisted only at dequeue; a reload while
// waiting deleted the question WITHOUT TRACE. Now it is persisted as
// pending=1 at enqueue: a disconnect keeps it (silent-loss protection),
// only an explicit DELETE (the stop button on a queued job) removes it.

describe('persist at enqueue', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  });
  afterEach(() => { global.fetch = realFetch; });

  function hangingFirstAnswer() {
    let release;
    const gate = new Promise((r) => { release = r; });
    mockCreate.mockImplementationOnce(() => ({
      [Symbol.asyncIterator]: async function* () {
        await gate;
        yield { choices: [{ delta: { content: 'Answer one' } }] };
        yield { choices: [{ delta: {} }] };
      },
    }));
    return () => release();
  }

  it('a queued question survives a client disconnect as a pending row', async () => {
    const chatA = await request(app).post('/api/chats').send({ title: 'A' });
    const chatB = await request(app).post('/api/chats').send({ title: 'B' });
    const release = hangingFirstAnswer();
    mockCreate.mockResolvedValue({ choices: [{ message: { content: 'Title' } }] });

    const p1 = request(app).post(`/api/chats/${chatA.body.id}/messages`)
      .send({ content: 'Slow?' }).buffer(true).then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    const req2 = request(app).post(`/api/chats/${chatB.body.id}/messages`)
      .send({ content: 'Will I survive a reload?' });
    const p2 = req2.then((r) => r, () => null);
    await new Promise((r) => setTimeout(r, 50));

    try {
      // While queued, the question is already in the DB — marked pending.
      const queuedRow = db.prepare(
        "SELECT * FROM messages WHERE chat_id = ? AND role = 'user'"
      ).get(chatB.body.id);
      expect(queuedRow).toBeDefined();
      expect(queuedRow.pending).toBe(1);
    } finally {
      req2.abort(); // reload/close while waiting
      await p2;
      await new Promise((r) => setTimeout(r, 50));
      release();
      await p1;
    }

    // The question is still there; it never ran (no answer, still pending).
    const rows = db.prepare('SELECT * FROM messages WHERE chat_id = ?').all(chatB.body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('Will I survive a reload?');
    expect(rows[0].pending).toBe(1);
    expect(mockCreate.mock.calls.every((c) => {
      const texts = (c[0].messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join(' ');
      return !texts.includes('Will I survive a reload?');
    })).toBe(true);
  });

  it('DELETE on a pending question removes it — explicit stop counts as never asked', async () => {
    const chatA = await request(app).post('/api/chats').send({ title: 'A' });
    const chatB = await request(app).post('/api/chats').send({ title: 'B' });
    const release = hangingFirstAnswer();
    mockCreate.mockResolvedValue({ choices: [{ message: { content: 'Title' } }] });

    const p1 = request(app).post(`/api/chats/${chatA.body.id}/messages`)
      .send({ content: 'Slow?' }).buffer(true).then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    const req2 = request(app).post(`/api/chats/${chatB.body.id}/messages`)
      .send({ content: 'Cancel me.' });
    const p2 = req2.then((r) => r, () => null);
    await new Promise((r) => setTimeout(r, 50));

    try {
      const queuedRow = db.prepare(
        "SELECT * FROM messages WHERE chat_id = ? AND role = 'user'"
      ).get(chatB.body.id);
      expect(queuedRow).toBeDefined();
      const del = await request(app).delete(`/api/chats/${chatB.body.id}/messages/${queuedRow.id}`);
      expect(del.status).toBe(200);
    } finally {
      req2.abort();
      await p2;
      release();
      await p1;
    }

    expect(db.prepare('SELECT * FROM messages WHERE chat_id = ?').all(chatB.body.id)).toHaveLength(0);
  });

  it('DELETE refuses non-pending messages', async () => {
    const chatId = 'chat-del-guard';
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
      .run(chatId, 'G', '2026-07-26T10:00:00.000Z');
    db.prepare('INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('m1', chatId, 'user', 'answered question', '2026-07-26T10:00:01.000Z');

    const del = await request(app).delete(`/api/chats/${chatId}/messages/m1`);
    expect(del.status).toBe(409);
    expect(db.prepare('SELECT * FROM messages WHERE chat_id = ?').all(chatId)).toHaveLength(1);
  });
});

// ─── Privacy guard — failover never leaves Lokal silently (§11) ──────────────
// Audit 2 (2026-07-26): a missing/mistyped local model 404'd and the ladder
// silently shipped the question INCLUDING paper context to a keyed cloud
// provider, mislabeled as a quota failover, with a 24 h redirect. The local
// provider is a privacy promise: automatic failover never crosses it.

describe('privacy guard for the local provider', () => {
  it('local model missing: fails with local_missing instead of going to the cloud', async () => {
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'ollama');
    setSetting(db, 'gemini_api_key', 'AIza-test'); // a keyed cloud provider exists
    mockCreate.mockRejectedValue(Object.assign(
      new Error('model "qwen3.5:9b" not found, try pulling it first'), { status: 404 }
    ));
    const chat = await request(app).post('/api/chats').send({ title: 'PG' });

    const res = await request(app)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({ content: 'private question about my paper' });

    const events = parseSSE(res.text);
    expect(events.find((e) => e.failover)).toBeUndefined(); // NEVER local→cloud
    const errorEvent = events.find((e) => e.error);
    expect(errorEvent.failReason).toBe('local_missing');
    expect(errorEvent.failModel).toBe('qwen3.5:9b');
    // Exactly one upstream attempt — the question never reached the cloud.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const marker = db.prepare(
      "SELECT * FROM messages WHERE chat_id = ? AND role = 'assistant'"
    ).get(chat.body.id);
    expect(marker.fail_reason).toBe('local_missing');
  });

  it('re-pulled model works immediately — no lingering 24 h cooldown', async () => {
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'ollama');
    mockCreate.mockRejectedValueOnce(Object.assign(
      new Error('model "qwen3.5:9b" not found, try pulling it first'), { status: 404 }
    ));
    const chat = await request(app).post('/api/chats').send({ title: 'PG2' });
    await request(app).post(`/api/chats/${chat.body.id}/messages`).send({ content: 'fails' });

    // "ollama pull" happened — the very next question must reach the model.
    mockCreate.mockResolvedValueOnce(makeStream(['Back again.']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Title' } }] });
    const res = await request(app)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({ content: 'works now?' });

    const events = parseSSE(res.text);
    expect(events.find((e) => e.failover)).toBeUndefined();
    expect(events.find((e) => e.done)?.assistantMessage.content).toBe('Back again.');
  });

  it('Ollama down: fails with local_unreachable instead of the generic row', async () => {
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'ollama');
    mockCreate.mockRejectedValue(new Error('Connection error.'));
    const chat = await request(app).post('/api/chats').send({ title: 'PG3' });

    const res = await request(app)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({ content: 'hello' });

    const errorEvent = parseSSE(res.text).find((e) => e.error);
    expect(errorEvent.failReason).toBe('local_unreachable');
    expect(parseSSE(res.text).find((e) => e.failover)).toBeUndefined();
  });
});

// ─── Honest retryAt + billing provider (§08) ─────────────────────────────────
// retryAt was the global minimum over ALL cooldowns: a sibling's 90 s minute
// cooldown put daily cards below the 5-minute threshold — daily copy with a
// contradictory 90 s countdown and no clock line. The daily card's clock now
// comes from DAILY cooldowns only, and the error names the provider that hit
// the limit so "Limit erhöhen" opens the right billing page.

describe('honest retryAt per quota reason', () => {
  function err429(message) {
    return Object.assign(new Error(message), { status: 429, headers: { 'retry-after': '0' } });
  }

  it('daily error: retryAt comes from the daily cooldown, not a sibling 90 s one', async () => {
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'gemini');
    setSetting(db, 'gemini_api_key', 'AIza-test');
    mockCreate
      .mockRejectedValueOnce(err429('Rate limit exceeded, slow down'))          // flash: minute → 90 s
      .mockRejectedValue(err429('Quota exceeded for generate_requests_per_day')); // pro: daily → midnight

    const chat = await request(app).post('/api/chats').send({ title: 'HR' });
    const res = await request(app)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({ content: 'hello' });

    const errorEvent = parseSSE(res.text).find((e) => e.error);
    expect(errorEvent.quotaReason).toBe('daily');
    // Honest clock: UTC midnight (the daily reset), NOT flash's 90 s cooldown.
    expect(new Date(errorEvent.retryAt).getTime()).toBeGreaterThan(Date.now() + 10 * 60 * 1000);
    // Billing link target: the provider whose limit actually hit.
    expect(errorEvent.failProvider).toBe('gemini');
  });
});

// ─── Queue split — cloud parallel, local FIFO (§07, decided 2026-07-25) ──────
// The FIFO exists for Ollama's single KV slot. Cloud providers rate-limit
// server-side — serializing a sub-second Gemini question behind a minutes-
// long local generation was pure wait. Cloud jobs now bypass the queue.

describe('queue split: cloud parallel, local FIFO', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  });
  afterEach(() => { global.fetch = realFetch; });

  function gatedStream(text) {
    let release;
    const gate = new Promise((r) => { release = r; });
    const stream = {
      [Symbol.asyncIterator]: async function* () {
        await gate;
        yield { choices: [{ delta: { content: text } }] };
        yield { choices: [{ delta: {} }] };
      },
    };
    return { stream, release: () => release() };
  }

  it('two cloud questions run in parallel — no queued event, no waiting', async () => {
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'gemini');
    setSetting(db, 'gemini_api_key', 'AIza-test');
    const slow = gatedStream('Slow cloud answer');
    // Title calls resolve instantly; the gated stream is only the FIRST call.
    mockCreate.mockImplementationOnce(() => slow.stream);
    mockCreate.mockImplementation((payload) =>
      payload.stream === undefined
        ? Promise.resolve({ choices: [{ message: { content: 'Title' } }] })
        : makeStream(['Fast cloud answer']));

    const chatA = await request(app).post('/api/chats').send({ title: 'CA' });
    const chatB = await request(app).post('/api/chats').send({ title: 'CB' });

    const p1 = request(app).post(`/api/chats/${chatA.body.id}/messages`)
      .send({ content: 'Slow?' }).buffer(true).then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    const p2 = request(app).post(`/api/chats/${chatB.body.id}/messages`)
      .send({ content: 'Fast?' }).buffer(true).then((r) => r);
    // Race against a timeout so a serialized (= broken) B fails instead of
    // deadlocking the test: B must finish while A is still generating.
    const res2 = await Promise.race([
      p2,
      new Promise((r) => setTimeout(() => r(null), 1500)),
    ]);

    try {
      expect(res2).not.toBeNull();
      const events2 = parseSSE(res2.text);
      expect(events2.find((e) => e.queued)).toBeUndefined();
      expect(events2.find((e) => e.done)).toBeDefined();
    } finally {
      slow.release();
      await p1;
      await p2;
    }
  });

  it('a cloud question does not wait behind a running local generation', async () => {
    const { setSetting } = require('../llm');
    const slow = gatedStream('Slow local answer');
    mockCreate.mockImplementationOnce(() => slow.stream);
    mockCreate.mockImplementation(() => makeStream(['Cloud answer']));

    const chatA = await request(app).post('/api/chats').send({ title: 'LA' });
    const chatB = await request(app).post('/api/chats').send({ title: 'LB' });

    const p1 = request(app).post(`/api/chats/${chatA.body.id}/messages`)
      .send({ content: 'Slow local?' }).buffer(true).then((r) => r);
    await new Promise((r) => setTimeout(r, 50));

    setSetting(db, 'llm_provider', 'gemini');
    setSetting(db, 'gemini_api_key', 'AIza-test');
    const p2 = request(app).post(`/api/chats/${chatB.body.id}/messages`)
      .send({ content: 'Cloud now?' }).buffer(true).then((r) => r);
    const res2 = await Promise.race([
      p2,
      new Promise((r) => setTimeout(() => r(null), 1500)),
    ]);

    try {
      expect(res2).not.toBeNull();
      const events2 = parseSSE(res2.text);
      expect(events2.find((e) => e.queued)).toBeUndefined();
      expect(events2.find((e) => e.done)).toBeDefined();
    } finally {
      slow.release();
      await p1;
      await p2;
      setSetting(db, 'llm_provider', 'ollama');
    }
  });

  it('queued events name the waiting model and the question currently answering', async () => {
    const slow = gatedStream('Answer one');
    mockCreate.mockImplementationOnce(() => slow.stream);
    mockCreate.mockImplementation(() => makeStream(['Answer two']));

    const chatA = await request(app).post('/api/chats').send({ title: 'QA' });
    const chatB = await request(app).post('/api/chats').send({ title: 'QB' });

    const p1 = request(app).post(`/api/chats/${chatA.body.id}/messages`)
      .send({ content: 'Which LoRA rank did they use?' }).buffer(true).then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    const p2 = request(app).post(`/api/chats/${chatB.body.id}/messages`)
      .send({ content: 'Queued one' }).buffer(true).then((r) => r);
    await new Promise((r) => setTimeout(r, 50));

    slow.release();
    const [, res2] = await Promise.all([p1, p2]);

    const queued = parseSSE(res2.text).find((e) => e.queued)?.queued;
    expect(queued.ahead).toBe(1);
    // The chip: which model will answer this waiting question.
    expect(queued.model).toBe('qwen3.5:9b');
    // The link target: the chat whose question is being answered right now.
    expect(queued.current).toMatchObject({ chatId: chatA.body.id });
    expect(queued.current.question).toContain('Which LoRA rank');
  });
});

describe('queue split: settings kick + prompt hygiene', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  });
  afterEach(() => { global.fetch = realFetch; });

  it('switching to a cloud provider releases waiting local questions immediately', async () => {
    const { setSetting } = require('../llm');
    setSetting(db, 'gemini_api_key', 'AIza-test');
    let release;
    const gate = new Promise((r) => { release = r; });
    mockCreate.mockImplementationOnce(() => ({
      [Symbol.asyncIterator]: async function* () {
        await gate;
        yield { choices: [{ delta: { content: 'Slow local' } }] };
        yield { choices: [{ delta: {} }] };
      },
    }));
    mockCreate.mockImplementation(() => makeStream(['Cloud answer']));

    const chatA = await request(app).post('/api/chats').send({ title: 'KA' });
    const chatB = await request(app).post('/api/chats').send({ title: 'KB' });
    const p1 = request(app).post(`/api/chats/${chatA.body.id}/messages`)
      .send({ content: 'Slow?' }).buffer(true).then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    const p2 = request(app).post(`/api/chats/${chatB.body.id}/messages`)
      .send({ content: 'Waiting…' }).buffer(true).then((r) => r);
    await new Promise((r) => setTimeout(r, 50));

    // The user switches to Gemini — the waiting question must start NOW
    // (cloud never queues), not after the slow local answer.
    await request(app).put('/api/settings').send({ llm_provider: 'gemini' });
    const res2 = await Promise.race([
      p2,
      new Promise((r) => setTimeout(() => r(null), 1500)),
    ]);

    try {
      expect(res2).not.toBeNull();
      expect(parseSSE(res2.text).find((e) => e.done)).toBeDefined();
    } finally {
      release();
      await p1;
      await p2;
      const { setSetting: ss } = require('../llm');
      ss(db, 'llm_provider', 'ollama');
    }
  });

  it('failed and interrupted markers never reach the model prompt', async () => {
    const chatId = 'chat-hygiene';
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
      .run(chatId, 'HY', '2026-07-26T10:00:00.000Z');
    const ins = db.prepare('INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)');
    ins.run('q1', chatId, 'user', 'First question', '2026-07-26T10:00:01.000Z');
    ins.run('f1', chatId, 'assistant', '*Failed*', '2026-07-26T10:00:02.000Z');
    ins.run('q2', chatId, 'user', 'Second question', '2026-07-26T10:00:03.000Z');
    ins.run('i1', chatId, 'assistant', '*Interrupted*', '2026-07-26T10:00:04.000Z');
    ins.run('q3', chatId, 'user', 'Third question', '2026-07-26T10:00:05.000Z');
    ins.run('a3', chatId, 'assistant', 'A real answer', '2026-07-26T10:00:06.000Z');
    mockCreate.mockResolvedValueOnce(makeStream(['Fine.']));

    await request(app).post(`/api/chats/${chatId}/messages`).send({ content: 'Now?' });

    const sent = mockCreate.mock.calls[0][0].messages
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
    expect(sent).not.toContain('*Failed*');
    expect(sent).not.toContain('*Interrupted*');
    expect(sent).toContain('A real answer');
  });

  it('branch ancestor transcripts drop markers and pending questions', async () => {
    const parentId = 'chat-parent-hy';
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
      .run(parentId, 'P', '2026-07-26T10:00:00.000Z');
    const ins = db.prepare('INSERT INTO messages (id, chat_id, role, content, created_at, pending) VALUES (?, ?, ?, ?, ?, ?)');
    ins.run('p1', parentId, 'user', 'Parent question', '2026-07-26T10:00:01.000Z', 0);
    ins.run('p2', parentId, 'assistant', 'Parent answer', '2026-07-26T10:00:02.000Z', 0);
    ins.run('p3', parentId, 'assistant', '*Failed*', '2026-07-26T10:00:03.000Z', 0);
    ins.run('p4', parentId, 'user', 'Still queued', '2026-07-26T10:00:04.000Z', 1);
    const child = await request(app).post('/api/chats')
      .send({ title: 'C', parent_id: parentId, parent_word: 'answer' });
    mockCreate.mockResolvedValueOnce(makeStream(['Child answer.']));
    mockCreate.mockResolvedValue({ choices: [{ message: { content: 'Title' } }] });

    await request(app).post(`/api/chats/${child.body.id}/messages`).send({ content: 'Explain.' });

    // The summary refresh fires in the background too — pick the chat call
    // (its system prompt carries the inherited transcript).
    const chatCall = mockCreate.mock.calls.find((c) =>
      String(c[0].messages[0]?.content || '').includes('Parent answer'));
    const system = chatCall[0].messages[0].content;
    expect(system).toContain('Parent answer');
    expect(system).not.toContain('*Failed*');
    expect(system).not.toContain('Still queued');
  });
});

// ─── The search wish outlives its stream ────────────────────────────────────
// design/mockup-search-wish-card.html: the model called web_search and nobody
// looked. Reported in the running app 2026-08-25 — the card was there, then
// gone after switching chats and back, because the wish lived only in the SSE
// stream. An answer written without a search reads exactly like one written
// with it, so losing the note leaves a stale answer looking current.

describe('a search wish under an answer', () => {
  // One tool round: the model calls web_search, the tool reports that nothing
  // is configured, then the model answers from memory.
  function searchCallThenAnswer() {
    const toolRound = {
      [Symbol.asyncIterator]: async function* () {
        yield {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'tc1',
                type: 'function',
                function: { name: 'web_search', arguments: '{"query":"gold price today"}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        };
      },
    };
    return [toolRound, makeStream(['Answered ', 'from ', 'memory.'])];
  }

  async function askWithSearchWish() {
    const chat = await request(app).post('/api/chats').send({ title: 'Gold' });
    const [round1, round2] = searchCallThenAnswer();
    mockCreate
      .mockResolvedValueOnce(round1)
      .mockResolvedValueOnce(round2)
      // title generation
      .mockResolvedValue({ choices: [{ message: { content: 'Gold' } }] });
    await request(app)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({ content: 'What does gold cost today?' });
    return chat.body.id;
  }

  it('is stored with the answer, so it survives leaving the chat and coming back', async () => {
    const chatId = await askWithSearchWish();

    // Read it back the way the app does after a chat switch: from the DB.
    const row = db.prepare(
      "SELECT * FROM messages WHERE chat_id = ? AND role = 'assistant'"
    ).get(chatId);
    expect(row.search_wish_error).toBe('no-search-provider');
    expect(row.search_wish_query).toBe('gold price today');

    // And it reaches the client through the same endpoint the app reloads with.
    const reload = await request(app).get(`/api/chats/${chatId}`);
    const assistant = reload.body.messages.find(m => m.role === 'assistant');
    expect(assistant.search_wish_error).toBe('no-search-provider');
  });

  it('leaves the columns empty when the search actually ran', async () => {
    const chat = await request(app).post('/api/chats').send({ title: 'Plain' });
    mockCreate
      .mockResolvedValueOnce(makeStream(['Hello.']))
      .mockResolvedValue({ choices: [{ message: { content: 'Plain' } }] });
    await request(app)
      .post(`/api/chats/${chat.body.id}/messages`)
      .send({ content: 'Hi' });

    const row = db.prepare(
      "SELECT * FROM messages WHERE chat_id = ? AND role = 'assistant'"
    ).get(chat.body.id);
    expect(row.search_wish_error).toBeNull();
    expect(row.search_wish_query).toBeNull();
  });
});
