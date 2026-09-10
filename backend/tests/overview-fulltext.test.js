/**
 * tests/overview-fulltext.test.js
 *
 * The Video overview never runs in retrieval mode (user decision 2026-08-20).
 *
 * Retrieval answers "where does he say X?" by fetching the chunks that match
 * the question. The overview asks for the WHOLE video in order, and no handful
 * of chunks matches that — worse, the video retrieval branch of the system
 * prompt carries no overview rule at all, so the answer comes back without the
 * `## Topic [m:ss - m:ss]` headings the chapter list is parsed from.
 *
 * Measured on 2026-08-20: makemore Part 4 (108 393 chars) was the first
 * transcript ever to exceed the budget (97 184 chars). Its overview arrived as
 * 4 694 chars with no time mark, and the chapter list stayed empty; every
 * shorter video had gone through full text and produced chapters.
 *
 * Same warmup-free route as messages.test.js: post a real message and read the
 * system prompt off the mocked completion call.
 */
process.env.OPENAI_API_KEY = 'test-key-for-unit-tests';
jest.mock('openai');
const OpenAI = require('openai');

const request = require('supertest');
const { createApp } = require('../server');
const { createDb } = require('../database');
const { setSetting } = require('../llm');
const { contextBudget } = require('../ancestor-context');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'overview-fulltext-test.db');

let db;
let mockCreate;
const realFetch = global.fetch;

/** A transcript comfortably past the budget, with a time mark every minute. */
function longSegments(minutes) {
  return Array.from({ length: minutes }, (_, i) => ({
    // `startMs`, not `offsetMs`: that is the key buildTranscriptText reads.
    // With the wrong one every block came out marked "[NaN:NaN]", and the
    // truncation note quietly fell back to its "[00:00]" default — the tests
    // below still passed because they only ask WHETHER a note is there
    // (found 2026-09-02, while wiring covered_until_seconds).
    startMs: i * 60_000,
    text: `Minute ${i}: ` + 'the speaker keeps explaining backpropagation by hand. '.repeat(40),
  }));
}

beforeEach(() => {
  mockCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'x' } }] });
  OpenAI.mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });

  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
  setSetting(db, 'llm_provider', 'ollama');
});

afterEach(() => {
  global.fetch = realFetch;
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

function makeApp(segments, messageOptions = {}) {
  const fetchTranscriptFn = jest.fn().mockResolvedValue({
    title: 'Building makemore Part 4: Becoming a Backprop Ninja',
    channel: 'Andrej Karpathy',
    durationSeconds: 6924,
    language: 'en',
    segments,
  });
  // Deterministic embeddings: retrieval mode must be reachable without Ollama.
  const embedTextsFn = jest.fn(async texts => texts.map((_, i) => [i + 1, 1, 0]));
  return createApp(db, {
    youtube: { fetchTranscriptFn },
    messages: { embedTextsFn, ...messageOptions },
  });
}

async function videoChat(app) {
  const chat = await request(app).post('/api/chats').send({ title: 'New Chat' });
  const imp = await request(app)
    .post('/api/youtube/import')
    .send({ chat_id: chat.body.id, youtube_id: 'q8SA3rM6ckI' });
  expect(imp.status).toBe(201);
  return chat.body.id;
}

function systemPromptOfLastAnswer() {
  const call = mockCreate.mock.calls.find(c => (c[0].messages || []).some(m => m.role === 'system'));
  return call[0].messages.find(m => m.role === 'system').content;
}

describe('a transcript too long for the budget', () => {
  it('stays FULL TEXT when the question is the Video overview', async () => {
    const app = makeApp(longSegments(120));
    const chatId = await videoChat(app);
    // Precondition: this transcript really is over the budget, otherwise the
    // test would pass for the wrong reason.
    const video = db.prepare('SELECT transcript FROM videos LIMIT 1').get();
    expect(video.transcript.length).toBeGreaterThan(contextBudget(db).maxSystemContextChars);

    await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .send({ content: 'Break the whole video down into its sections.', overview: true })
      .buffer(true);

    const system = systemPromptOfLastAnswer();
    expect(system).toContain('--- VIDEO TRANSCRIPT START ---');
    expect(system).not.toContain('SKELETON');
    // The overview rule — the chapter list is parsed from the shape it asks for.
    expect(system).toContain('[m:ss - m:ss]');
    // Trimmed to the budget, and the model is told where the cut is, so
    // overviewStopsShort and the continue endpoint can carry on from there.
    expect(system).toContain('the transcript is truncated at');
  });

  // User report 2026-09-04: 24 sections for 27 minutes of video — a heading
  // per minute, which is a transcript with headings, not an overview.
  it('asks for sections by TOPIC, not one per minute', async () => {
    const app = makeApp(longSegments(120));
    const chatId = await videoChat(app);

    await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .send({ content: 'Break the whole video down into its sections.', overview: true })
      .buffer(true);

    const system = systemPromptOfLastAnswer();
    // 6924 s = 1:55:24 → round(115.4 / 7) = 16 sections.
    expect(system).toContain('should have about 16 sections in total');
    expect(system).toContain('NEVER start a new section merely because another');
    // The old clause pulled the other way — it read as "cut as finely as
    // possible" and is what produced the per-minute headings.
    expect(system).not.toContain('Never merge two topics into one section');
    // Detail is still mandatory; it just lives in the bullets now.
    expect(system).toContain('never skip a passage for being minor');
  });

  it('still uses RETRIEVAL for an ordinary question about the same video', async () => {
    const app = makeApp(longSegments(120));
    const chatId = await videoChat(app);

    await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .send({ content: 'What does he say about batch norm?' })
      .buffer(true);

    const system = systemPromptOfLastAnswer();
    expect(system).toContain('SKELETON');
    expect(system).not.toContain('--- VIDEO TRANSCRIPT START ---');
  });
});

// ─── A silent model is left behind — but the overview goes WITH the question ─
// Since 2026-09-01 a model that says nothing before its first token loses the
// question to the next candidate within seconds instead of being waited out.
// The chapter list under the player is parsed from the `## Topic [m:ss - m:ss]`
// headings, so the model that ACTUALLY answers has to have been asked for
// them: a ladder move that quietly dropped the overview rule — or fell back
// into retrieval — would leave the middle column without chapters, which is
// exactly the failure this whole file exists to prevent.
describe('a model that goes silent while writing the Video overview', () => {
  // Never resolves on its own; only the deadline ends it (see messages.test.js).
  const silent = () => (_payload, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      const e = new Error('Request was aborted.');
      e.name = 'AbortError';
      reject(e);
    }, { once: true });
  });
  const streamOf = (text) => ({
    [Symbol.asyncIterator]: async function* () {
      yield { choices: [{ delta: { content: text } }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    },
  });

  it('hands the fallback model the SAME overview prompt — time marks and all', async () => {
    setSetting(db, 'llm_provider', 'gemini');
    setSetting(db, 'gemini_api_key', 'AIza-test');
    // 80 ms instead of 15 s: this asserts the wiring, not the clock.
    const app = makeApp(longSegments(120), { stallMs: 80, overloadBackoffSeconds: [0, 0, 0] });
    const chatId = await videoChat(app);

    mockCreate
      .mockImplementationOnce(silent())
      .mockResolvedValueOnce(streamOf('## Einführung [0:00 - 1:00]\n\n**Der Sprecher beginnt.**'))
      .mockResolvedValue({ choices: [{ message: { content: 'Title' } }] });

    const res = await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .send({ content: 'Break the whole video down into its sections.', overview: true })
      .buffer(true);

    // The ladder moved, and it said why.
    expect(res.text).toContain('"reason":"stalled"');

    // Two different models were asked the SAME question.
    const [first, second] = mockCreate.mock.calls;
    expect(second[0].model).not.toBe(first[0].model);
    const systemOf = (call) => call[0].messages.find((m) => m.role === 'system').content;
    // The fallback still gets the full transcript, not retrieval chunks…
    expect(systemOf(second)).toContain('--- VIDEO TRANSCRIPT START ---');
    expect(systemOf(second)).not.toContain('SKELETON');
    // …and still the rule the chapter list is parsed from.
    expect(systemOf(second)).toContain('[m:ss - m:ss]');
    // Byte for byte the same prompt: a switch must not quietly reshape it.
    expect(systemOf(second)).toBe(systemOf(first));
  });
});

// ─── The answer remembers how far it could see ─────────────────────────────
describe('a transcript the budget had to cut', () => {
  // The suites above only read the PROMPT, so their mock never has to be a
  // real stream. This one reads the stored ANSWER and does.
  const streamOf = (text) => ({
    [Symbol.asyncIterator]: async function* () {
      yield { choices: [{ delta: { content: text } }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    },
  });

  it('stores where the cut was, so a faked closing mark cannot claim the rest', async () => {
    const app = makeApp(longSegments(120));
    const chatId = await videoChat(app);
    mockCreate
      .mockResolvedValueOnce(streamOf('## Einführung [0:00 - 1:00]\n\n**Beginn.**'))
      .mockResolvedValue({ choices: [{ message: { content: 'Title' } }] });

    await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .send({ content: 'Break the whole video down into its sections.', overview: true })
      .buffer(true);

    const answer = db.prepare(
      "SELECT content, covered_until_seconds FROM messages WHERE chat_id = ? AND role = 'assistant'"
    ).get(chatId);
    // The transcript is 120 minutes long and the budget takes far less, so the
    // answer must carry a real second — and one well short of the video's end.
    expect(answer.content).not.toContain('*Failed*');
    expect(answer.covered_until_seconds).toBeGreaterThan(0);
    expect(answer.covered_until_seconds).toBeLessThan(6924);
    // And the model is told, not just measured: the note names the cut as a
    // ceiling instead of handing it the video's full length to round up to.
    const system = systemPromptOfLastAnswer();
    expect(system).toContain('Never write a time mark past');
  });

  it('leaves the column empty when the whole transcript fitted', async () => {
    const app = makeApp(longSegments(3));
    const chatId = await videoChat(app);
    mockCreate
      .mockResolvedValueOnce(streamOf('## Einführung [0:00 - 1:00]\n\n**Beginn.**'))
      .mockResolvedValue({ choices: [{ message: { content: 'Title' } }] });

    await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .send({ content: 'Break the whole video down into its sections.', overview: true })
      .buffer(true);

    const answer = db.prepare(
      "SELECT covered_until_seconds FROM messages WHERE chat_id = ? AND role = 'assistant'"
    ).get(chatId);
    expect(answer.covered_until_seconds).toBeNull();
  });
});

describe('regenerating a failed Video overview', () => {
  it('stays FULL TEXT — the overview flag survives the retry (regression: it used to fall into retrieval)', async () => {
    const app = makeApp(longSegments(120));
    const chatId = await videoChat(app);

    const userMsgId = 'test-overview-question';
    const failedMarkerId = 'test-overview-failed-marker';
    const now = Date.now();
    db.prepare(
      'INSERT INTO messages (id, chat_id, role, content, created_at, pending, overview_request) VALUES (?, ?, ?, ?, ?, 0, 1)'
    ).run(userMsgId, chatId, 'user', 'Break the whole video down into its sections.', now);
    db.prepare(
      'INSERT INTO messages (id, chat_id, role, content, created_at, pending, overview_request) VALUES (?, ?, ?, ?, ?, 0, 0)'
    ).run(failedMarkerId, chatId, 'assistant', '*Failed*', now + 1);

    await request(app)
      .post(`/api/chats/${chatId}/messages/regenerate`)
      .send({ messageId: failedMarkerId })
      .buffer(true);

    const system = systemPromptOfLastAnswer();
    expect(system).toContain('--- VIDEO TRANSCRIPT START ---');
    expect(system).not.toContain('SKELETON');
  });
});

// ─── The overview gets the budget cap lifted ────────────────────────────────
// User decision 2026-09-04. The cap keeps an ordinary question from dragging a
// whole paper through the window every turn; the overview is asked ONCE per
// video and is the one question that wants the whole source. Lifting it costs
// nothing when the source is smaller than the ceiling — a cap only truncates.
// What it must NOT do is exceed what the model really takes: a free tier that
// meters tokens per minute answers a bigger prompt with a 429, not with more
// text, so there the cap stays exactly where it was.
describe('the budget cap and the Video overview', () => {
  it('lifts the cap to the window for a model with room to spare', () => {
    setSetting(db, 'llm_provider', 'gemini');
    setSetting(db, 'gemini_model', 'gemini-flash-latest');

    const ordinary = contextBudget(db).maxSystemContextChars;
    const forOverview = contextBudget(db, null, { overview: true }).maxSystemContextChars;
    expect(forOverview).toBeGreaterThan(ordinary);
    // A 3:42:37 transcript is ~198 000 characters — one round now, not thirty.
    expect(forOverview).toBeGreaterThan(198_000);
  });

  it('leaves it alone for a model metered per minute — a 429 is not a longer answer', () => {
    setSetting(db, 'llm_provider', 'groq');
    setSetting(db, 'groq_model', 'openai/gpt-oss-120b');

    const ordinary = contextBudget(db).maxSystemContextChars;
    const forOverview = contextBudget(db, null, { overview: true }).maxSystemContextChars;
    expect(forOverview).toBe(ordinary);
  });

  it('never exceeds the context window', () => {
    setSetting(db, 'llm_provider', 'openai');
    setSetting(db, 'openai_model', 'gpt-4o-mini');

    const { contextWindowTokens } = contextBudget(db, null, { overview: true });
    const chars = contextBudget(db, null, { overview: true }).maxSystemContextChars;
    expect(chars).toBeLessThan(contextWindowTokens * 3.5);
  });
});

// ─── The settings instructions do not govern the Video overview ─────────────
// User report 2026-09-04: a video was loaded, the overview was written, and
// the text from Settings ("close every answer with a mental model…") sat in
// the MIDDLE of it, between two chapters. The overview is not a question the
// user typed and its shape is fully prescribed by the overview rule, so the
// instructions are left out of it entirely — first round and every
// continuation round alike.
describe('the Video overview and the custom instructions', () => {
  const INSTRUCTIONS = 'Beende jede Antwort mit einem Abschnitt "## Mentales Modell".';

  /** Every message of the last completion call, system blocks included. */
  function messagesOfLastCall() {
    const calls = mockCreate.mock.calls.filter(c => (c[0].messages || []).some(m => m.role === 'system'));
    return calls[calls.length - 1][0].messages;
  }
  const promptText = () => messagesOfLastCall().map(m =>
    typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
  ).join('\n');

  beforeEach(() => {
    setSetting(db, 'custom_instructions', INSTRUCTIONS);
    setSetting(db, 'custom_instructions_enabled', 'true');
  });

  it('leaves them out of the overview — front block and sandwich reminder both', async () => {
    const app = makeApp(longSegments(120));
    const chatId = await videoChat(app);

    await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .send({ content: 'Break the whole video down into its sections.', overview: true })
      .buffer(true);

    const prompt = promptText();
    expect(prompt).not.toContain(INSTRUCTIONS);
    expect(prompt).not.toContain('CUSTOM INSTRUCTIONS START');
    // The overview itself is still fully specified — dropping the block must
    // not take the rule the chapter list is parsed from with it.
    expect(prompt).toContain('[m:ss - m:ss]');
  });

  it('leaves them out of a continuation round too', async () => {
    const app = makeApp(longSegments(120));
    const chatId = await videoChat(app);

    const now = Date.now();
    const userMsgId = 'test-overview-question';
    const answerId = 'test-overview-answer';
    db.prepare(
      'INSERT INTO messages (id, chat_id, role, content, created_at, pending, overview_request) VALUES (?, ?, ?, ?, ?, 0, 1)'
    ).run(userMsgId, chatId, 'user', 'Break the whole video down into its sections.', now);
    // Reads as finished and stops at 5:00 of a 1:55:24 video — the case the
    // continue endpoint calls 'append'.
    db.prepare(
      'INSERT INTO messages (id, chat_id, role, content, created_at, pending, overview_request, covered_until_seconds) VALUES (?, ?, ?, ?, ?, 0, 0, ?)'
    ).run(answerId, chatId, 'assistant', '## Opening [0:00 - 5:00]\n\n**The speaker starts.**\n', now + 1, 300);

    const res = await request(app)
      .post(`/api/chats/${chatId}/messages/continue`)
      .send({ messageId: answerId })
      .buffer(true);
    expect(res.status).toBe(200);

    const prompt = promptText();
    expect(prompt).not.toContain(INSTRUCTIONS);
    expect(prompt).not.toContain('CUSTOM INSTRUCTIONS START');
  });

  // Language-drift fix (user report 2026-09-05): a German overview over an
  // English transcript drifted into English partway through, because the
  // continuation instruction only said "same language". Now the round names
  // the language of the text written so far, so the outgoing prompt tells the
  // model "in German" outright.
  it('names German in a continuation of a German overview', async () => {
    const app = makeApp(longSegments(120));
    const chatId = await videoChat(app);

    const now = Date.now();
    db.prepare(
      'INSERT INTO messages (id, chat_id, role, content, created_at, pending, overview_request) VALUES (?, ?, ?, ?, ?, 0, 1)'
    ).run('q-de', chatId, 'user', 'Gliedere das ganze Video in seine Abschnitte.', now);
    // A German overview that stopped early — the continue endpoint's 'append'.
    db.prepare(
      'INSERT INTO messages (id, chat_id, role, content, created_at, pending, overview_request, covered_until_seconds) VALUES (?, ?, ?, ?, ?, 0, 0, ?)'
    ).run(
      'a-de', chatId, 'assistant',
      '## Der Einstieg [0:00 - 5:00]\n\n**Der Sprecher stellt sich und seinen Werdegang vor.**\n',
      now + 1, 300,
    );

    const res = await request(app)
      .post(`/api/chats/${chatId}/messages/continue`)
      .send({ messageId: 'a-de' })
      .buffer(true);
    expect(res.status).toBe(200);

    const prompt = promptText();
    expect(prompt).toContain('in German');
    expect(prompt).not.toContain('same format and language');
  });

  it('sends the answer so far CONDENSED, not in full (Groq 413, 2026-09-04)', async () => {
    const app = makeApp(longSegments(120));
    const chatId = await videoChat(app);

    const now = Date.now();
    const userMsgId = 'test-overview-question';
    const answerId = 'test-overview-answer';
    // An overview that has already grown past what a metered model can carry.
    const written =
      '## Opening [0:00 - 5:00]\n\n' + 'Er erklärt das noch einmal. '.repeat(600) +
      '\n\n## Mitte [5:00 - 12:00]\n\n' + 'Er erklärt das noch einmal. '.repeat(600) +
      '\n\n## Schluss [12:00 - 20:00]\n\nund dann sagte er';
    expect(written.length).toBeGreaterThan(30_000);

    db.prepare(
      'INSERT INTO messages (id, chat_id, role, content, created_at, pending, overview_request) VALUES (?, ?, ?, ?, ?, 0, 1)'
    ).run(userMsgId, chatId, 'user', 'Break the whole video down into its sections.', now);
    db.prepare(
      'INSERT INTO messages (id, chat_id, role, content, created_at, pending, overview_request, covered_until_seconds) VALUES (?, ?, ?, ?, ?, 0, 0, ?)'
    ).run(answerId, chatId, 'assistant', written, now + 1, 1200);

    await request(app)
      .post(`/api/chats/${chatId}/messages/continue`)
      .send({ messageId: answerId })
      .buffer(true);

    const sent = messagesOfLastCall().find(m => m.role === 'assistant' && /Opening/.test(String(m.content)));
    expect(sent).toBeDefined();
    expect(String(sent.content).length).toBeLessThan(written.length / 2);
    // The seam and the headings are what the round needs — both survive.
    expect(String(sent.content).endsWith('und dann sagte er')).toBe(true);
    expect(sent.content).toContain('## Opening [0:00 - 5:00]');
    expect(sent.content).toContain('## Mitte [5:00 - 12:00]');
  });

  it('still carries them for an ordinary question about the same video', async () => {
    const app = makeApp(longSegments(120));
    const chatId = await videoChat(app);

    await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .send({ content: 'What does he say about batch norm?' })
      .buffer(true);

    expect(promptText()).toContain(INSTRUCTIONS);
  });
});

describe('a transcript that fits', () => {
  it('is full text either way — the flag changes nothing', async () => {
    const app = makeApp(longSegments(3));
    const chatId = await videoChat(app);

    await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .send({ content: 'What does he say about batch norm?' })
      .buffer(true);

    const system = systemPromptOfLastAnswer();
    expect(system).toContain('--- VIDEO TRANSCRIPT START ---');
    expect(system).not.toContain('SKELETON');
  });
});
