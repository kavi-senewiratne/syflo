/**
 * tests/branch-trace.test.js
 *
 * The BRANCH TRACE (design/mockup-branch-trace.html, variant A): the mark a
 * `/btw` or `/branch` branch leaves in the chat it was opened from. Both
 * commands lack a passage, so the only anchor available is a place in time —
 * the last message that existed in the parent when the branch was created.
 *
 * These tests pin the server half of that: who gets an anchor, who does not,
 * and that the anchor really is the LAST message (message ids are UUIDs, so
 * nothing here may fall back to id order).
 */

jest.mock('openai');
const OpenAI = require('openai');

const request = require('supertest');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createDb } = require('../database');
const { createApp } = require('../server');

const TEST_DB_PATH = path.join(__dirname, 'branch_trace_test.db');

let db;
let app;

beforeEach(() => {
  OpenAI.mockImplementation(() => ({ chat: { completions: { create: jest.fn() } } }));
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
  require('../llm').setSetting(db, 'llm_provider', 'ollama');
  app = createApp(db);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

function insertMessage(chatId, role, content, createdAt) {
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, chatId, role, content, createdAt || new Date().toISOString());
  return id;
}

async function createParentWithMessages() {
  const res = await request(app).post('/api/chats').send({ title: 'Parent' });
  const parentId = res.body.id;
  insertMessage(parentId, 'user', 'Explain multi-head attention');
  const last = insertMessage(parentId, 'assistant', 'Each head learns a relation …');
  return { parentId, last };
}

describe('branch anchor', () => {
  it('anchors a /btw branch to the last message of the parent', async () => {
    const { parentId, last } = await createParentWithMessages();

    const res = await request(app).post('/api/chats').send({
      title: 'What is a KV cache?',
      parent_id: parentId,
      parent_word: 'What is a KV cache?',
      branch_origin: 'btw',
    });

    expect(res.status).toBe(201);
    expect(res.body.branch_origin).toBe('btw');
    expect(res.body.branch_anchor_message_id).toBe(last);
  });

  it('anchors a /branch topic branch too, though it has no parent_word', async () => {
    const { parentId, last } = await createParentWithMessages();

    const res = await request(app).post('/api/chats').send({
      title: 'Rotary embeddings',
      parent_id: parentId,
      branch_origin: 'topic',
    });

    expect(res.body.parent_word).toBeNull();
    expect(res.body.branch_origin).toBe('topic');
    expect(res.body.branch_anchor_message_id).toBe(last);
  });

  it('leaves selection branches without a trace — the passage is their mark', async () => {
    const { parentId } = await createParentWithMessages();

    const res = await request(app).post('/api/chats').send({
      title: 'Learned matrices',
      parent_id: parentId,
      parent_word: 'The projections are learned matrices',
    });

    expect(res.body.branch_origin).toBeNull();
    expect(res.body.branch_anchor_message_id).toBeNull();
  });

  it('takes the newest message even when created_at ties (kept /btw pairs)', async () => {
    const res = await request(app).post('/api/chats').send({ title: 'Parent' });
    const parentId = res.body.id;
    const sameStamp = '2026-08-09T10:00:00.000Z';
    insertMessage(parentId, 'user', 'question', sameStamp);
    const answer = insertMessage(parentId, 'assistant', 'answer', sameStamp);

    const branch = await request(app).post('/api/chats').send({
      title: 'Follow-up', parent_id: parentId, branch_origin: 'topic',
    });

    expect(branch.body.branch_anchor_message_id).toBe(answer);
  });

  it('gives a branch in an empty parent no anchor — its line floats to the top', async () => {
    const res = await request(app).post('/api/chats').send({ title: 'Fresh tree' });

    const branch = await request(app).post('/api/chats').send({
      title: 'Rotary embeddings', parent_id: res.body.id, branch_origin: 'topic',
    });

    expect(branch.body.branch_origin).toBe('topic');
    expect(branch.body.branch_anchor_message_id).toBeNull();
  });

  it('ignores an unknown origin instead of storing it', async () => {
    const { parentId } = await createParentWithMessages();

    const res = await request(app).post('/api/chats').send({
      title: 'Odd one', parent_id: parentId, branch_origin: 'something-else',
    });

    expect(res.body.branch_origin).toBeNull();
    expect(res.body.branch_anchor_message_id).toBeNull();
  });
});

describe('reading the trace back', () => {
  it('ships anchor and origin with the parent chat, so the transcript can draw the line', async () => {
    const { parentId, last } = await createParentWithMessages();
    const branch = await request(app).post('/api/chats').send({
      title: 'What is a KV cache?', parent_id: parentId, branch_origin: 'btw',
    });

    const parent = await request(app).get(`/api/chats/${parentId}`);
    const child = parent.body.children.find((c) => c.id === branch.body.id);

    expect(child.branch_anchor_message_id).toBe(last);
    expect(child.branch_origin).toBe('btw');
  });

  it('ships them in the tree as well, so the branch header can link back', async () => {
    const { parentId, last } = await createParentWithMessages();
    await request(app).post('/api/chats').send({
      title: 'Rotary embeddings', parent_id: parentId, branch_origin: 'topic',
    });

    const tree = await request(app).get('/api/chats/tree');
    const root = tree.body.find((c) => c.id === parentId);

    expect(root.children[0].branch_anchor_message_id).toBe(last);
    expect(root.children[0].branch_origin).toBe('topic');
  });
});
