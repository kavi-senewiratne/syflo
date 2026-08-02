/**
 * tests/ancestor-warmup.test.js
 *
 * Integration tests for the summary warm-up on branch creation
 * (POST /api/chats with parent_id kicks off background summary generation
 * for the new branch's ancestor chain) and for GET /api/chats/:id/ancestors
 * (the UI's read-only view of the inherited context).
 */

jest.mock('openai');
const OpenAI = require('openai');

const request = require('supertest');
const path = require('path');
const fs = require('fs');
const { createApp } = require('../server');
const { createDb } = require('../database');

const TEST_DB_PATH = path.join(__dirname, 'ancestor_warmup_test.db');

let app;
let db;
let mockCreate;

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

function seedChatWithMessages(id, title, parentId = null, parentWord = null) {
  db.prepare(
    'INSERT INTO chats (id, title, parent_id, parent_word, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, title, parentId, parentWord, new Date().toISOString());
  db.prepare(
    'INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(`${id}-m1`, id, 'user', `Question in ${title}`, '2026-01-01T00:00:01Z');
  db.prepare(
    'INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(`${id}-m2`, id, 'assistant', `Answer in ${title}`, '2026-01-01T00:00:02Z');
}

// Warm-up runs fire-and-forget in the background; poll the cache briefly.
async function waitForSummary(chatId, timeoutMs = 1000) {
  const started = Date.now();
  for (;;) {
    const row = db.prepare('SELECT summary FROM chats WHERE id = ?').get(chatId);
    if (row && row.summary) return row.summary;
    if (Date.now() - started > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ─── Warm-up on branch creation ──────────────────────────────────────────────

describe('POST /api/chats – summary warm-up', () => {
  it('creating a branch warms up the ancestor summaries in the background', async () => {
    seedChatWithMessages('root', 'Root Chat');
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Warmed-up root summary.' } }],
    });

    const res = await request(app).post('/api/chats').send({
      title: 'Branch',
      parent_id: 'root',
      parent_word: 'question',
    });
    expect(res.status).toBe(201);

    const summary = await waitForSummary('root');
    expect(summary).toBe('Warmed-up root summary.');
  });

  it('does not block or fail chat creation when summary generation errors', async () => {
    seedChatWithMessages('root', 'Root Chat');
    mockCreate.mockRejectedValue(new Error('LLM down'));

    const res = await request(app).post('/api/chats').send({
      title: 'Branch',
      parent_id: 'root',
      parent_word: 'question',
    });

    expect(res.status).toBe(201);
    // Give the background task a tick to fail silently
    await new Promise((r) => setTimeout(r, 50));
    const row = db.prepare('SELECT summary FROM chats WHERE id = ?').get('root');
    expect(row.summary).toBeNull();
  });
});

// ─── GET /api/chats/:id/ancestors ────────────────────────────────────────────

describe('GET /api/chats/:id/ancestors', () => {
  it('returns the path from root to parent with cached summaries', async () => {
    seedChatWithMessages('root', 'Transformers');
    seedChatWithMessages('mid', 'Attention', 'root', 'attention');
    seedChatWithMessages('leaf', 'Softmax', 'mid', 'softmax');
    db.prepare('UPDATE chats SET summary = ? WHERE id = ?').run('Root summary.', 'root');

    const res = await request(app).get('/api/chats/leaf/ancestors');

    expect(res.status).toBe(200);
    expect(res.body.map((a) => a.id)).toEqual(['root', 'mid']);
    expect(res.body[0]).toMatchObject({
      id: 'root',
      title: 'Transformers',
      parent_word: null,
      summary: 'Root summary.',
    });
    expect(res.body[1]).toMatchObject({
      id: 'mid',
      title: 'Attention',
      parent_word: 'attention',
      summary: null,
    });
  });

  it('returns an empty array for a root chat', async () => {
    seedChatWithMessages('root', 'Solo');
    const res = await request(app).get('/api/chats/root/ancestors');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns 404 for an unknown chat', async () => {
    const res = await request(app).get('/api/chats/nope/ancestors');
    expect(res.status).toBe(404);
  });
});
