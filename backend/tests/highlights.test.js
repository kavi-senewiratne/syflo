process.env.OPENAI_API_KEY = 'test-key-for-unit-tests';
const request = require('supertest');
const { createApp } = require('../server');
const { createDb } = require('../database');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'highlights.test.db');

let app;
let db;
let paperId;

// Each test gets a clean DB so we can assert exact counts without ordering
// noise from previous tests. The paperId is created in beforeEach so the
// POST/PATCH/DELETE tests have a valid foreign key to attach to.
beforeEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
  app = createApp(db);
  paperId = 'paper-1';
  db.prepare(
    `INSERT INTO papers (id, uploaded_at, pdf_path, status) VALUES (?, ?, ?, ?)`,
  ).run(paperId, '2026-05-25T00:00:00.000Z', '/dev/null', 'ready');
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

function makeRects() {
  return [{ left: 10, top: 20, width: 100, height: 14 }];
}

describe('GET /api/papers/:id/highlights', () => {
  it('returns empty array when paper has no highlights', async () => {
    const res = await request(app).get(`/api/papers/${paperId}/highlights`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns highlights in creation order', async () => {
    // Create three highlights with the API itself so we exercise the same
    // shape that the GET will return.
    await request(app).post(`/api/papers/${paperId}/highlights`).send({
      color: 'yellow', text: 'first', pageNumber: 1, rects: makeRects(),
    });
    await request(app).post(`/api/papers/${paperId}/highlights`).send({
      color: 'green', text: 'second', pageNumber: 2, rects: makeRects(),
    });
    await request(app).post(`/api/papers/${paperId}/highlights`).send({
      color: 'blue', text: 'third', pageNumber: 1, rects: makeRects(),
    });

    const res = await request(app).get(`/api/papers/${paperId}/highlights`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body.map((h) => h.text)).toEqual(['first', 'second', 'third']);
    expect(res.body.map((h) => h.color)).toEqual(['yellow', 'green', 'blue']);
  });
});

describe('POST /api/papers/:id/highlights', () => {
  it('creates a highlight with all required fields', async () => {
    const res = await request(app).post(`/api/papers/${paperId}/highlights`).send({
      color: 'yellow',
      text: 'marginal contribution function',
      pageNumber: 1,
      rects: [{ left: 10, top: 20, width: 200, height: 14 }],
      prefix: 'the ',
      suffix: ' that aligns',
      quoteHash: 'abc123',
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.color).toBe('yellow');
    expect(res.body.text).toBe('marginal contribution function');
    expect(res.body.pageNumber).toBe(1);
    expect(res.body.rects).toHaveLength(1);
    expect(res.body.prefix).toBe('the ');
    expect(res.body.suffix).toBe(' that aligns');
    expect(res.body.quoteHash).toBe('abc123');
    expect(res.body.chatId).toBeNull();
    expect(res.body.createdAt).toBeDefined();
  });

  it('rejects invalid color', async () => {
    const res = await request(app).post(`/api/papers/${paperId}/highlights`).send({
      color: 'purple', text: 'x', pageNumber: 1, rects: makeRects(),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/color/);
  });

  it('rejects empty text', async () => {
    const res = await request(app).post(`/api/papers/${paperId}/highlights`).send({
      color: 'yellow', text: '   ', pageNumber: 1, rects: makeRects(),
    });
    expect(res.status).toBe(400);
  });

  it('rejects empty rects', async () => {
    const res = await request(app).post(`/api/papers/${paperId}/highlights`).send({
      color: 'yellow', text: 'x', pageNumber: 1, rects: [],
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 when paper does not exist', async () => {
    const res = await request(app).post('/api/papers/missing/highlights').send({
      color: 'yellow', text: 'x', pageNumber: 1, rects: makeRects(),
    });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/highlights/:hid', () => {
  let hid;
  beforeEach(async () => {
    const create = await request(app).post(`/api/papers/${paperId}/highlights`).send({
      color: 'yellow', text: 'x', pageNumber: 1, rects: makeRects(),
    });
    hid = create.body.id;
  });

  it('changes color', async () => {
    const res = await request(app).patch(`/api/highlights/${hid}`).send({ color: 'green' });
    expect(res.status).toBe(200);
    expect(res.body.color).toBe('green');
  });

  it('links and unlinks a chat', async () => {
    // Create a chat to link against. Going through DB directly keeps the test
    // independent of the chats router's exact payload shape.
    db.prepare(
      'INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)',
    ).run('chat-1', 'test', '2026-05-25T00:00:00.000Z');

    const linkRes = await request(app).patch(`/api/highlights/${hid}`).send({ chatId: 'chat-1' });
    expect(linkRes.status).toBe(200);
    expect(linkRes.body.chatId).toBe('chat-1');

    const unlinkRes = await request(app).patch(`/api/highlights/${hid}`).send({ chatId: null });
    expect(unlinkRes.status).toBe(200);
    expect(unlinkRes.body.chatId).toBeNull();
  });

  it('rejects invalid color', async () => {
    const res = await request(app).patch(`/api/highlights/${hid}`).send({ color: 'rainbow' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown highlight', async () => {
    const res = await request(app).patch('/api/highlights/missing').send({ color: 'green' });
    expect(res.status).toBe(404);
  });

  it('survives deleting the branch via the real chat route (Issue 06)', async () => {
    // The central "highlight survives the chat" contract. Unlike in Syflo
    // we test via DELETE /api/chats/:id (the real deletion path), because
    // Syflo does not enable SQLite FKs — the route decouples explicitly.
    db.prepare(
      'INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)',
    ).run('chat-doomed', 'test', '2026-05-25T00:00:00.000Z');
    await request(app).patch(`/api/highlights/${hid}`).send({ chatId: 'chat-doomed' });

    const del = await request(app).delete('/api/chats/chat-doomed');
    expect(del.status).toBe(200);

    const after = await request(app).get(`/api/papers/${paperId}/highlights`);
    expect(after.body).toHaveLength(1);
    expect(after.body[0].chatId).toBeNull();
  });

  it('also decouples highlights from deleted child branches', async () => {
    // The recursive delete removes the whole subtree — highlights on
    // child chats must be decoupled just like on the root chat.
    db.prepare(
      'INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)',
    ).run('parent-1', 'parent', '2026-05-25T00:00:00.000Z');
    db.prepare(
      'INSERT INTO chats (id, title, parent_id, created_at) VALUES (?, ?, ?, ?)',
    ).run('child-1', 'child', 'parent-1', '2026-05-25T00:00:00.000Z');
    await request(app).patch(`/api/highlights/${hid}`).send({ chatId: 'child-1' });

    await request(app).delete('/api/chats/parent-1');

    const after = await request(app).get(`/api/papers/${paperId}/highlights`);
    expect(after.body).toHaveLength(1);
    expect(after.body[0].chatId).toBeNull();
  });
});

describe('DELETE /api/highlights/:hid', () => {
  it('removes the highlight and underlying text_range', async () => {
    const create = await request(app).post(`/api/papers/${paperId}/highlights`).send({
      color: 'yellow', text: 'x', pageNumber: 1, rects: makeRects(),
    });
    const hid = create.body.id;

    const del = await request(app).delete(`/api/highlights/${hid}`);
    expect(del.status).toBe(204);

    const after = await request(app).get(`/api/papers/${paperId}/highlights`);
    expect(after.body).toEqual([]);

    // text_range should also be gone — we own it, no point keeping orphan rows
    const trCount = db.prepare('SELECT COUNT(*) as n FROM text_ranges').get().n;
    expect(trCount).toBe(0);
  });

  it('returns 404 for unknown highlight', async () => {
    const res = await request(app).delete('/api/highlights/missing');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/highlight-labels', () => {
  it('returns the 5 default labels on a fresh DB', async () => {
    const res = await request(app).get('/api/highlight-labels');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      yellow: 'Important',
      green: 'Agree',
      blue: 'Reference',
      pink: 'Question',
      orange: 'Disagree',
    });
  });
});

describe('PUT /api/highlight-labels/:color', () => {
  it('renames a color', async () => {
    const res = await request(app).put('/api/highlight-labels/blue').send({ label: 'Cite later' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ color: 'blue', label: 'Cite later' });

    const get = await request(app).get('/api/highlight-labels');
    expect(get.body.blue).toBe('Cite later');
    // Other labels untouched
    expect(get.body.yellow).toBe('Important');
  });

  it('resets to default when label is empty', async () => {
    await request(app).put('/api/highlight-labels/blue').send({ label: 'Custom' });
    await request(app).put('/api/highlight-labels/blue').send({ label: '   ' });
    const get = await request(app).get('/api/highlight-labels');
    expect(get.body.blue).toBe('Reference');
  });

  it('truncates labels longer than 24 chars', async () => {
    const long = 'A'.repeat(50);
    const res = await request(app).put('/api/highlight-labels/yellow').send({ label: long });
    expect(res.body.label).toHaveLength(24);
  });

  it('rejects unknown color', async () => {
    const res = await request(app).put('/api/highlight-labels/teal').send({ label: 'x' });
    expect(res.status).toBe(400);
  });
});
