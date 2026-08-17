/**
 * tests/btw.test.js
 *
 * Integration tests for POST /api/btw — the throwaway side question
 * (design/mockup-btw-composer-fold.html).
 *
 * The defining property is what does NOT happen: the answer streams back to
 * the caller and the chat's message list is untouched. Everything else the
 * route does (context, ladder failover) is shared with existing routes.
 */

jest.mock('openai');
const OpenAI = require('openai');

const request = require('supertest');
const { createApp } = require('../server');
const { createDb } = require('../database');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'btw_test.db');

let app;
let db;
let mockCreate;

function makeStream(words) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const word of words) {
        yield { choices: [{ delta: { content: word } }] };
      }
      yield { choices: [{ delta: {} }] };
    },
  };
}

function parseSSE(text) {
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.slice(6)));
}

beforeEach(() => {
  mockCreate = jest.fn();
  OpenAI.mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));

  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
  // Local path — bypasses the cloud default (ADR-0008).
  require('../llm').setSetting(db, 'llm_provider', 'ollama');
  app = createApp(db);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

describe('POST /api/btw', () => {
  it('streams an answer without writing anything to the chat', async () => {
    const chatId = 1;
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
      .run(chatId, 'Attention', new Date().toISOString());
    mockCreate.mockResolvedValue(makeStream(['A logit ', 'is a raw score.']));

    const res = await request(app)
      .post('/api/btw')
      .send({ chatId, question: 'what does logit mean again?' });

    expect(res.status).toBe(200);
    const events = parseSSE(res.text);
    const answer = events.filter((e) => e.delta).map((e) => e.delta).join('');
    expect(answer).toBe('A logit is a raw score.');
    expect(events.some((e) => e.done)).toBe(true);

    const stored = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?').get(chatId);
    expect(stored.n).toBe(0);
  });

  // The traffic is one-way: the aside reads the conversation so that "what
  // does this mean?" lands in context, but nothing it says ever reaches the
  // conversation (decision 2026-08-08).
  it('sends the conversation so far along with the question', async () => {
    const chatId = 1;
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
      .run(chatId, 'Attention', new Date().toISOString());
    const insert = db.prepare(
      'INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    insert.run('m1', chatId, 'user', 'Why divide by the square root of d_k?', new Date().toISOString());
    insert.run('m2', chatId, 'assistant', 'Because the dot products grow with dimension.', new Date().toISOString());
    mockCreate.mockResolvedValue(makeStream(['ok']));

    await request(app).post('/api/btw').send({ chatId, question: 'what does logit mean again?' });

    const sent = mockCreate.mock.calls[0][0].messages;
    expect(sent.some((m) => m.content?.includes('dot products grow with dimension'))).toBe(true);
    expect(sent[sent.length - 1].role).toBe('user');
    expect(sent[sent.length - 1].content).toContain('what does logit mean again?');
  });
});

// ─── Keeping an aside (mockup §03) ──────────────────────────────────────────
// The one path where an aside becomes permanent. Both buttons of the panel
// end up here: "Keep in chat" writes the pair into the current thread,
// "Make a branch" writes only the answer into the freshly created branch —
// its question already lives in the branch header as the parent quote.

describe('POST /api/btw/keep', () => {
  it('appends the question and the answer as two ordinary messages', async () => {
    const chatId = 1;
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
      .run(chatId, 'Attention', new Date().toISOString());
    db.prepare('INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('m1', chatId, 'user', 'first question', new Date().toISOString());

    const res = await request(app)
      .post('/api/btw/keep')
      .send({ chatId, question: 'what does logit mean again?', answer: 'A raw score.' });

    expect(res.status).toBe(200);
    const rows = db.prepare('SELECT role, content FROM messages WHERE chat_id = ? ORDER BY rowid').all(chatId);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual({ role: 'user', content: 'what does logit mean again?' });
    expect(rows[2]).toEqual({ role: 'assistant', content: 'A raw score.' });
  });

  it('writes only the answer when there is no question to keep', async () => {
    const chatId = 2;
    db.prepare('INSERT INTO chats (id, title, parent_word, created_at) VALUES (?, ?, ?, ?)')
      .run(chatId, 'About logit', 'what does logit mean again?', new Date().toISOString());

    const res = await request(app).post('/api/btw/keep').send({ chatId, answer: 'A raw score.' });

    expect(res.status).toBe(200);
    const rows = db.prepare('SELECT role, content FROM messages WHERE chat_id = ? ORDER BY rowid').all(chatId);
    expect(rows).toEqual([{ role: 'assistant', content: 'A raw score.' }]);
  });

  // Caught in the running app, not by any of the tests above: without an
  // explicit id the rows land with id NULL, React renders two children with
  // the same key and the kept messages never appear (2026-08-08).
  it('gives every kept message an id', async () => {
    const chatId = 3;
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
      .run(chatId, 'Attention', new Date().toISOString());

    const res = await request(app)
      .post('/api/btw/keep')
      .send({ chatId, question: 'q', answer: 'a' });

    expect(res.body.messages).toHaveLength(2);
    for (const m of res.body.messages) expect(typeof m.id).toBe('string');
    expect(res.body.messages[0].id).not.toBe(res.body.messages[1].id);
  });

  it('rejects an answer for a chat that does not exist', async () => {
    const res = await request(app).post('/api/btw/keep').send({ chatId: 999, answer: 'x' });
    expect(res.status).toBe(404);
  });
});

// ─── Automatic model switch (mockup §05) ────────────────────────────────────
// A side question is not worth a decision: when the chat's model is out of
// quota the route walks the shared ladder by itself and only says WHO
// answered instead.

describe('POST /api/btw – exhausted models switch themselves', () => {
  const quotaError = () =>
    Object.assign(new Error('Quota exceeded for metric generate_requests_per_model_per_day'), { status: 429 });

  function useGeminiAndGroq() {
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'gemini');
    setSetting(db, 'gemini_api_key', 'AIza-test');
    setSetting(db, 'gemini_model', 'gemini-pro-latest');
    setSetting(db, 'groq_api_key', 'gsk-test');
  }

  it('answers from the next model on the ladder and names the switch', async () => {
    useGeminiAndGroq();
    const chatId = 1;
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
      .run(chatId, 'Attention', new Date().toISOString());
    mockCreate
      .mockRejectedValueOnce(quotaError())
      .mockResolvedValueOnce(makeStream(['A raw score.']));

    const res = await request(app).post('/api/btw').send({ chatId, question: 'what does logit mean?' });

    const events = parseSSE(res.text);
    expect(events.filter((e) => e.delta).map((e) => e.delta).join('')).toBe('A raw score.');
    const done = events.find((e) => e.done);
    expect(done.model).toBe('gemini-flash-latest');
    expect(done.switchedFrom).toBe('gemini-pro-latest');
    expect(done.switchedFromProvider).toBe('gemini');
    expect(done.provider).toBe('gemini');
  });

  it('says nothing about models when the chat’s own model answered', async () => {
    useGeminiAndGroq();
    const chatId = 1;
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
      .run(chatId, 'Attention', new Date().toISOString());
    mockCreate.mockResolvedValueOnce(makeStream(['A raw score.']));

    const res = await request(app).post('/api/btw').send({ chatId, question: 'q' });

    const done = parseSSE(res.text).find((e) => e.done);
    expect(done.switchedFrom).toBeUndefined();
  });
});
