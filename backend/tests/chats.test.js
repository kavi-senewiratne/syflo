process.env.OPENAI_API_KEY = 'test-key-for-unit-tests';
const request = require('supertest');
const { createApp } = require('../server');
const { createDb } = require('../database');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'test.db');

let app;
let db;

beforeEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
  app = createApp(db);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

describe('GET /api/chats', () => {
  it('returns empty array when no chats exist', async () => {
    const res = await request(app).get('/api/chats');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('POST /api/chats', () => {
  it('creates a new chat', async () => {
    const res = await request(app).post('/api/chats').send({ title: 'Test Chat' });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Test Chat');
    expect(res.body.id).toBeDefined();
    expect(res.body.parent_id).toBeNull();
  });

  it('returns 400 when title is missing', async () => {
    const res = await request(app).post('/api/chats').send({});
    expect(res.status).toBe(400);
  });

  it('creates a child chat with parent_id', async () => {
    const parent = await request(app).post('/api/chats').send({ title: 'Parent' });
    const child = await request(app).post('/api/chats').send({
      title: 'Child',
      parent_id: parent.body.id,
      parent_word: 'test',
    });
    expect(child.status).toBe(201);
    expect(child.body.parent_id).toBe(parent.body.id);
    expect(child.body.parent_word).toBe('test');
  });
});

describe('GET /api/chats/:id', () => {
  it('returns chat with messages and children', async () => {
    const chat = await request(app).post('/api/chats').send({ title: 'Test' });
    const res = await request(app).get(`/api/chats/${chat.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(chat.body.id);
    expect(res.body.messages).toEqual([]);
    expect(res.body.children).toEqual([]);
  });

  it('returns 404 for unknown chat', async () => {
    const res = await request(app).get('/api/chats/nonexistent');
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/chats/:id', () => {
  it('updates chat title', async () => {
    const chat = await request(app).post('/api/chats').send({ title: 'Old Title' });
    const res = await request(app).patch(`/api/chats/${chat.body.id}`).send({ title: 'New Title' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('New Title');
  });
});

describe('DELETE /api/chats/:id', () => {
  it('deletes a chat', async () => {
    const chat = await request(app).post('/api/chats').send({ title: 'To Delete' });
    const del = await request(app).delete(`/api/chats/${chat.body.id}`);
    expect(del.status).toBe(200);
    const get = await request(app).get(`/api/chats/${chat.body.id}`);
    expect(get.status).toBe(404);
  });

  it('deletes children recursively', async () => {
    const parent = await request(app).post('/api/chats').send({ title: 'Parent' });
    const child = await request(app).post('/api/chats').send({ title: 'Child', parent_id: parent.body.id });
    await request(app).delete(`/api/chats/${parent.body.id}`);
    const getChild = await request(app).get(`/api/chats/${child.body.id}`);
    expect(getChild.status).toBe(404);
  });
});

describe('GET /api/chats/tree', () => {
  it('returns nested tree structure', async () => {
    const parent = await request(app).post('/api/chats').send({ title: 'Parent' });
    await request(app).post('/api/chats').send({ title: 'Child', parent_id: parent.body.id });
    const res = await request(app).get('/api/chats/tree');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
  });

  // Sidebar request 2026-07-24: newest root chats on top. The branch order
  // within a tree stays ascending — it feeds the tree lines.
  it('returns roots newest-first while branches stay in creation order', async () => {
    const ins = db.prepare(
      'INSERT INTO chats (id, title, parent_id, parent_word, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    ins.run('r-old', 'Oldest root', null, null, '2026-07-20 10:00:00');
    ins.run('r-new', 'Newest root', null, null, '2026-07-24 10:00:00');
    ins.run('r-mid', 'Middle root', null, null, '2026-07-22 10:00:00');
    ins.run('b-1', 'First branch', 'r-old', 'alpha', '2026-07-21 09:00:00');
    ins.run('b-2', 'Second branch', 'r-old', 'beta', '2026-07-23 09:00:00');

    const res = await request(app).get('/api/chats/tree');

    expect(res.body.map(c => c.id)).toEqual(['r-new', 'r-mid', 'r-old']);
    const oldRoot = res.body.find(c => c.id === 'r-old');
    expect(oldRoot.children.map(c => c.id)).toEqual(['b-1', 'b-2']);
  });
});
