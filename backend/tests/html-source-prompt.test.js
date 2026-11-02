/**
 * tests/html-source-prompt.test.js
 *
 * The chat reads an HTML source (ADR-0013, decision 6): the visible text,
 * section by section, in the same budget slot as paper text / transcript.
 * Too long for the window -> ADR-0006 retrieval with heading-carrying chunks.
 */
process.env.OPENAI_API_KEY = 'test-key-for-unit-tests';
jest.mock('openai');
const OpenAI = require('openai');

const request = require('supertest');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { createApp } = require('../server');
const { createDb } = require('../database');
const { setSetting } = require('../llm');
const { contextBudget } = require('../ancestor-context');
const { sweepAbandonedChats } = require('../cleanup');

const TEST_DB_PATH = path.join(__dirname, 'html-source-prompt-test.db');
const TEST_UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'syflo-html-prompt-'));
const realFetch = global.fetch;

let db;
let app;
let mockCreate;
let embedTextsFn;

beforeEach(() => {
  mockCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'x' } }] });
  OpenAI.mockImplementation(() => ({ chat: { completions: { create: mockCreate } } }));
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
  setSetting(db, 'llm_provider', 'ollama');
  embedTextsFn = jest.fn(async (texts) => texts.map((_, i) => [i + 1, 1, 0]));
  app = createApp(db, {
    uploadsDir: TEST_UPLOADS_DIR,
    htmlSources: { embedTextsFn },
    messages: { embedTextsFn },
  });
});

afterEach(() => {
  global.fetch = realFetch;
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

async function createChat(parent_id) {
  return (await request(app).post('/api/chats').send({ title: 'New Chat', parent_id })).body;
}

async function uploadHtml(chatId, html) {
  const res = await request(app)
    .post('/api/html-sources')
    .field('chat_id', chatId)
    .attach('html', Buffer.from(html), { filename: 'lecture.html', contentType: 'text/html' });
  expect(res.status).toBe(201);
  return res.body;
}

async function ask(chatId, content = 'What is the pendulum section about?') {
  await request(app).post(`/api/chats/${chatId}/messages`).send({ content }).buffer(true);
}

function systemPromptOfLastAnswer() {
  const calls = mockCreate.mock.calls.filter((c) => (c[0].messages || []).some((m) => m.role === 'system'));
  return calls[calls.length - 1][0].messages.find((m) => m.role === 'system').content;
}

const SHORT_LECTURE = `<!doctype html><html><head><title>Underactuated</title>
  <script>window.cheat = 'script-payload';</script>
  <script type="application/json" id="quizdata">{"q":"quiz-answer-42"}</script></head>
  <body><h1>Pendulum</h1><p>The pendulum obeys $\\ddot\\theta = -g/l \\sin\\theta$.</p>
  <h2>LQR</h2><p>LQR minimises a quadratic cost.</p></body></html>`;

describe('a short HTML source', () => {
  it('lands in the system prompt section by section, without script or quiz payloads', async () => {
    const chat = await createChat();
    await uploadHtml(chat.id, SHORT_LECTURE);

    await ask(chat.id);

    const system = systemPromptOfLastAnswer();
    expect(system).toContain('## Pendulum');
    expect(system).toContain('$\\ddot\\theta = -g/l \\sin\\theta$');
    expect(system).toContain('## LQR');
    expect(system).toContain('LQR minimises a quadratic cost.');
    expect(system).not.toContain('script-payload');
    expect(system).not.toContain('quiz-answer-42');
    expect(system).not.toContain('SKELETON');
  });

  it('restates the web-search rule after the source (user report 2026-11-02: a local model answered "the text does not say" instead of searching)', async () => {
    const chat = await createChat();
    await uploadHtml(chat.id, SHORT_LECTURE);

    await ask(chat.id, 'What is the author doing today?');

    const system = systemPromptOfLastAnswer();
    const sourceAt = system.indexOf('--- DOCUMENT TEXT END ---');
    const ruleAt = system.indexOf('The attached source does not change rule (4)');
    expect(sourceAt).toBeGreaterThan(-1);
    expect(ruleAt).toBeGreaterThan(sourceAt);
    expect(system.slice(ruleAt)).toContain('call the web_search tool FIRST');
    // ...and the user turn ends on the same reminder (measured 2026-11-02:
    // the system-prompt sentence alone left qwen3.5:9b at 1/5 calls).
    const calls = mockCreate.mock.calls.filter((c) => (c[0].messages || []).some((m) => m.role === 'system'));
    const lastUser = [...calls[calls.length - 1][0].messages].reverse().find((m) => m.role === 'user');
    expect(lastUser.content).toMatch(/^What is the author doing today\?\n\n\[If this question is about the present/);
    // The stored message keeps the raw question.
    const stored = db.prepare("SELECT content FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1").get(chat.id);
    expect(stored.content).toBe('What is the author doing today?');
  });
});

/** A lecture comfortably past the budget: many sections of prose. */
function longLecture(sectionCount) {
  const sections = Array.from({ length: sectionCount }, (_, i) =>
    `<h2>Chapter ${i}</h2>` +
    Array.from({ length: 12 }, (_, j) => `<p>Chapter ${i} paragraph ${j}: ${'the acrobot swings up. '.repeat(30)}</p>`).join('')
  ).join('');
  return `<html><head><title>Long Lecture</title></head><body><h1>Opening</h1><p>Welcome.</p>${sections}</body></html>`;
}

describe('a long HTML source', () => {
  it('switches to retrieval: skeleton in the system prompt, heading-carrying chunks in source_chunks and excerpts in the question', async () => {
    const chat = await createChat();
    await uploadHtml(chat.id, longLecture(60));
    const source = db.prepare('SELECT extracted_text FROM html_sources').get();
    expect(source.extracted_text.length).toBeGreaterThan(contextBudget(db).maxSystemContextChars);

    await ask(chat.id, 'What happens in chapter 7?');

    const system = systemPromptOfLastAnswer();
    expect(system).toContain('DOCUMENT SKELETON');
    expect(system).toContain('- Chapter 7');
    expect(system).not.toContain('--- DOCUMENT TEXT START ---');

    const chunks = db
      .prepare("SELECT heading FROM source_chunks WHERE source_type = 'html' ORDER BY chunk_index")
      .all();
    expect(chunks.length).toBeGreaterThan(10);
    expect(chunks.every((c) => /^Chapter \d+$|^Opening$/.test(c.heading))).toBe(true);

    const calls = mockCreate.mock.calls.filter((c) => (c[0].messages || []).some((m) => m.role === 'system'));
    const all = JSON.stringify(calls[calls.length - 1][0].messages);
    expect(all).toContain('RELEVANT DOCUMENT EXCERPTS');
    expect(all).toContain('[Section: Chapter');
  });
});

describe('source_chunks migration', () => {
  it('rebuilds a table with the old (paper, video) constraint to allow html and keeps its rows', () => {
    // Put the table back into its pre-ADR-0013 shape, with one cached chunk.
    db.exec('DROP TABLE source_chunks');
    db.exec(`
      CREATE TABLE source_chunks (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL CHECK(source_type IN ('paper', 'video')),
        source_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        heading TEXT,
        content TEXT NOT NULL,
        embedding BLOB,
        text_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        embedding_model TEXT NOT NULL DEFAULT 'nomic-embed-text'
      )`);
    db.prepare(
      "INSERT INTO source_chunks VALUES ('c1','paper','p1',0,'Intro','kept',NULL,'h','2026-01-01','bge-m3')"
    ).run();
    db.close();

    db = createDb(TEST_DB_PATH); // second start = the migration
    db.close();
    db = createDb(TEST_DB_PATH); // and it is idempotent

    expect(db.prepare("SELECT content, embedding_model FROM source_chunks WHERE id = 'c1'").get())
      .toEqual({ content: 'kept', embedding_model: 'bge-m3' });
    expect(() =>
      db.prepare(
        "INSERT INTO source_chunks VALUES ('c2','html','h1',0,'A','x',NULL,'h','2026-01-01','bge-m3')"
      ).run()
    ).not.toThrow();
  });
});

describe('after the upload', () => {
  it('a long source is chunked and embedded in the background, before the first question', async () => {
    const chat = await createChat();
    await uploadHtml(chat.id, longLecture(60));

    for (let i = 0; i < 50 && embedTextsFn.mock.calls.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const n = db.prepare("SELECT COUNT(*) AS n FROM source_chunks WHERE source_type = 'html'").get().n;
    expect(n).toBeGreaterThan(10);
  });

  it('a short source is not chunked at all', async () => {
    const chat = await createChat();
    await uploadHtml(chat.id, SHORT_LECTURE);
    await new Promise((r) => setTimeout(r, 100));
    expect(embedTextsFn).not.toHaveBeenCalled();
  });
});

describe('branches', () => {
  it('see the same source as their root', async () => {
    const root = await createChat();
    await uploadHtml(root.id, SHORT_LECTURE);
    const branch = await createChat(root.id);

    await ask(branch.id);

    const system = systemPromptOfLastAnswer();
    expect(system).toContain('## Pendulum');
    expect(system).toContain('LQR minimises a quadratic cost.');
  });
});

describe('abandoned-chat sweep', () => {
  it('keeps an empty root chat that carries an HTML source', async () => {
    const chat = await createChat();
    await uploadHtml(chat.id, SHORT_LECTURE);
    const empty = await createChat();

    const removed = sweepAbandonedChats(db, { now: Date.now() + 60 * 60 * 1000 });

    expect(removed).toBe(1);
    const ids = db.prepare('SELECT id FROM chats').all().map((r) => r.id);
    expect(ids).toContain(chat.id);
    expect(ids).not.toContain(empty.id);
  });
});
