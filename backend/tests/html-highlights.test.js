/**
 * tests/html-highlights.test.js
 *
 * The fourth highlight kind (ADR-0013 decision 5): colored marks inside an
 * HTML source, anchored by a QUOTE anchor { exact, prefix, suffix } plus the
 * heading of the section they sit in. The backend only stores the anchor.
 */

const request = require('supertest');
const path = require('path');
const fs = require('fs');
const { createApp } = require('../server');
const { createDb } = require('../database');

const TEST_DB_PATH = path.join(__dirname, 'html_hl_test.db');
const ANCHOR = { exact: 'gradient descent', prefix: 'we use ', suffix: ' to fit' };

let app;
let db;
let sourceId;
let rootChatId;

beforeEach(async () => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
  app = createApp(db);
  sourceId = 'hs-test';
  db.prepare(
    `INSERT INTO html_sources (id, title, html_path, extracted_text, sections_json, uploaded_at)
     VALUES (?, 'Lecture', 'x.html', 'text', '[]', ?)`,
  ).run(sourceId, new Date().toISOString());
  const chat = await request(app).post('/api/chats').send({ title: 'Lecture' });
  rootChatId = chat.body.id;
  db.prepare('UPDATE chats SET html_source_id = ? WHERE id = ?').run(sourceId, rootChatId);
});

afterAll(() => {
  for (const f of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

const create = (body = {}) =>
  request(app)
    .post('/api/html-highlights')
    .send({ htmlSourceId: sourceId, color: 'yellow', anchor: ANCHOR, section: 'Optimization', ...body });

describe('POST /api/html-highlights', () => {
  test('creates a highlight and returns its shape', async () => {
    const res = await create();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      htmlSourceId: sourceId,
      chatId: null,
      color: 'yellow',
      anchor: ANCHOR,
      section: 'Optimization',
    });
    expect(res.body.id).toBeTruthy();
    expect(res.body.createdAt).toBeTruthy();
  });

  test('section is optional and defaults to null', async () => {
    const res = await create({ section: undefined });
    expect(res.status).toBe(201);
    expect(res.body.section).toBeNull();
  });

  test.each([
    ['bad color', { color: 'red' }],
    ['no anchor', { anchor: undefined }],
    ['empty exact', { anchor: { exact: '  ', prefix: '', suffix: '' } }],
    ['non-string prefix', { anchor: { exact: 'a', prefix: 1, suffix: '' } }],
    ['missing suffix', { anchor: { exact: 'a', prefix: '' } }],
    ['non-string section', { section: 5 }],
  ])('rejects %s with 400', async (_name, override) => {
    const res = await create(override);
    expect(res.status).toBe(400);
  });

  test('unknown source -> 404, unknown chat -> 404', async () => {
    expect((await create({ htmlSourceId: 'nope' })).status).toBe(404);
    expect((await create({ chatId: 'nope' })).status).toBe(404);
  });

  test('links the chat opened from the passage', async () => {
    const child = await request(app).post('/api/chats').send({ title: 'Child' });
    const res = await create({ chatId: child.body.id });
    expect(res.status).toBe(201);
    expect(res.body.chatId).toBe(child.body.id);
  });
});

describe('GET /api/html-highlights', () => {
  test('lists the marks of one source only, oldest first', async () => {
    db.prepare(
      `INSERT INTO html_sources (id, title, html_path, extracted_text, sections_json, uploaded_at)
       VALUES ('hs-other', 'Other', 'y.html', 't', '[]', ?)`,
    ).run(new Date().toISOString());
    const a = await create();
    await create({ htmlSourceId: 'hs-other' });
    const b = await create({ color: 'green' });
    const res = await request(app).get(`/api/html-highlights?html_source_id=${sourceId}`);
    expect(res.status).toBe(200);
    expect(res.body.map((h) => h.id)).toEqual([a.body.id, b.body.id]);
  });

  test('requires html_source_id', async () => {
    const res = await request(app).get('/api/html-highlights');
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/html-highlights/:id', () => {
  test('recolors', async () => {
    const { body } = await create();
    const res = await request(app).patch(`/api/html-highlights/${body.id}`).send({ color: 'pink' });
    expect(res.status).toBe(200);
    expect(res.body.color).toBe('pink');
    expect(res.body.anchor).toEqual(ANCHOR);
  });

  test('links and unlinks a chat', async () => {
    const child = await request(app).post('/api/chats').send({ title: 'Child' });
    const { body } = await create();
    const linked = await request(app)
      .patch(`/api/html-highlights/${body.id}`)
      .send({ chatId: child.body.id });
    expect(linked.body.chatId).toBe(child.body.id);
    const unlinked = await request(app).patch(`/api/html-highlights/${body.id}`).send({ chatId: null });
    expect(unlinked.body.chatId).toBeNull();
  });

  test('rejects bad color (400), unknown highlight (404), unknown chat (404)', async () => {
    const { body } = await create();
    expect((await request(app).patch(`/api/html-highlights/${body.id}`).send({ color: 'x' })).status).toBe(400);
    expect((await request(app).patch('/api/html-highlights/nope').send({ color: 'pink' })).status).toBe(404);
    expect((await request(app).patch(`/api/html-highlights/${body.id}`).send({ chatId: 'nope' })).status).toBe(404);
  });
});

describe('DELETE /api/html-highlights/:id', () => {
  test('deletes (204) then 404', async () => {
    const { body } = await create();
    expect((await request(app).delete(`/api/html-highlights/${body.id}`)).status).toBe(204);
    expect((await request(app).delete(`/api/html-highlights/${body.id}`)).status).toBe(404);
  });
});

describe('lifecycle', () => {
  test('marks are removed with their source', async () => {
    await create();
    db.prepare('DELETE FROM html_sources WHERE id = ?').run(sourceId);
    expect(db.prepare('SELECT COUNT(*) AS n FROM html_highlights').get().n).toBe(0);
  });

  test('marks outlive the chat they opened (chat link is SET NULL)', async () => {
    const child = await request(app).post('/api/chats').send({ title: 'Child' });
    const { body } = await create({ chatId: child.body.id });
    db.prepare('DELETE FROM chats WHERE id = ?').run(child.body.id);
    const row = db.prepare('SELECT chat_id FROM html_highlights WHERE id = ?').get(body.id);
    expect(row.chat_id).toBeNull();
  });
});

describe('tree highlights drawer', () => {
  test('lists kind "html" with the section as location', async () => {
    const child = await request(app).post('/api/chats').send({ title: 'Child', parent_id: rootChatId });
    const { body } = await create({ chatId: child.body.id });
    const res = await request(app).get(`/api/chats/${rootChatId}/tree-highlights`);
    expect(res.status).toBe(200);
    const item = res.body.find((i) => i.kind === 'html');
    expect(item).toMatchObject({
      kind: 'html',
      id: body.id,
      color: 'yellow',
      text: ANCHOR.exact,
      htmlSourceId: sourceId,
      anchor: ANCHOR,
      section: 'Optimization',
      chatId: child.body.id,
    });
  });

  test('is reachable from any chat of the tree', async () => {
    const child = await request(app).post('/api/chats').send({ title: 'Child', parent_id: rootChatId });
    await create();
    const res = await request(app).get(`/api/chats/${child.body.id}/tree-highlights`);
    expect(res.body.filter((i) => i.kind === 'html')).toHaveLength(1);
  });
});
