process.env.OPENAI_API_KEY = 'test-key-for-unit-tests';
const request = require('supertest');
const { createApp } = require('../server');
const { createDb } = require('../database');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'tree-highlights.test.db');

let app;
let db;

// Fixture: a tree with a paper —
//   root (paper_id=paper-1)
//   └── branch-1 (one message msg-1)
// The endpoint should return the PDF and chat highlights of the WHOLE tree combined.
beforeEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
  app = createApp(db);

  db.prepare(
    'INSERT INTO papers (id, uploaded_at, pdf_path, status) VALUES (?, ?, ?, ?)',
  ).run('paper-1', '2026-07-01T00:00:00.000Z', '/dev/null', 'ready');
  db.prepare(
    'INSERT INTO chats (id, title, created_at, paper_id) VALUES (?, ?, ?, ?)',
  ).run('root', 'CB-MCTS paper', '2026-07-01T00:00:00.000Z', 'paper-1');
  db.prepare(
    'INSERT INTO chats (id, title, parent_id, created_at) VALUES (?, ?, ?, ?)',
  ).run('branch-1', 'entropy bonus', 'root', '2026-07-02T00:00:00.000Z');
  db.prepare(
    "INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)",
  ).run('msg-1', 'branch-1', 'the entropy bonus is annealed', '2026-07-02T00:01:00.000Z');
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

function makeRects() {
  return [{ left: 10, top: 20, width: 100, height: 14 }];
}

async function createPdfHighlight(overrides = {}) {
  const res = await request(app).post('/api/papers/paper-1/highlights').send({
    color: 'yellow', text: 'CB-MCTS', pageNumber: 3, rects: makeRects(),
    ...overrides,
  });
  expect(res.status).toBe(201);
  return res.body;
}

async function createChatHighlight(overrides = {}) {
  const res = await request(app).post('/api/chats/branch-1/message-highlights').send({
    messageId: 'msg-1', color: 'orange', text: 'annealed', startOffset: 22, endOffset: 30,
    ...overrides,
  });
  expect(res.status).toBe(201);
  return res.body;
}

describe('GET /api/chats/:id/tree-highlights', () => {
  it('returns document order: PDF by page, then chats in tree order', async () => {
    // Second branch, created AFTER branch-1, with its own message.
    db.prepare(
      'INSERT INTO chats (id, title, parent_id, created_at) VALUES (?, ?, ?, ?)',
    ).run('branch-2', 'marginal contribution', 'root', '2026-07-03T00:00:00.000Z');
    db.prepare(
      "INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)",
    ).run('msg-2', 'branch-2', 'the Shapley-value connection', '2026-07-03T00:01:00.000Z');
    // Message in the root chat — in tree order the root comes before the branches.
    db.prepare(
      "INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)",
    ).run('msg-root', 'root', 'softmax sampling avoids brittleness', '2026-07-01T00:01:00.000Z');

    // PDF highlights deliberately created in the "wrong" order: page 5 first.
    await createPdfHighlight({ text: 'page five', pageNumber: 5 });
    await createPdfHighlight({ text: 'page two', pageNumber: 2 });

    // Chat highlights created in scrambled order: branch-2 first, then root,
    // then two in branch-1 with descending offsets in the same message.
    await request(app).post('/api/chats/branch-2/message-highlights').send({
      messageId: 'msg-2', color: 'blue', text: 'Shapley', startOffset: 4, endOffset: 11,
    });
    await request(app).post('/api/chats/root/message-highlights').send({
      messageId: 'msg-root', color: 'green', text: 'softmax', startOffset: 0, endOffset: 7,
    });
    await createChatHighlight({ text: 'annealed', startOffset: 22, endOffset: 30 });
    await createChatHighlight({ text: 'entropy', startOffset: 4, endOffset: 11 });

    const res = await request(app).get('/api/chats/root/tree-highlights');
    expect(res.status).toBe(200);
    expect(res.body.map((h) => h.text)).toEqual([
      'page two',    // PDF, page 2
      'page five',   // PDF, page 5
      'softmax',     // chat: root first
      'entropy',     // chat: branch-1 (older than branch-2), offset 4 before 22
      'annealed',    // chat: branch-1, offset 22
      'Shapley',     // chat: branch-2 last
    ]);
  });

  it('combines the tree\'s PDF and chat highlights with source metadata', async () => {
    const pdfH = await createPdfHighlight();
    const chatH = await createChatHighlight();

    const res = await request(app).get('/api/chats/root/tree-highlights');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);

    const pdfItem = res.body.find((h) => h.kind === 'pdf');
    expect(pdfItem).toMatchObject({
      id: pdfH.id,
      kind: 'pdf',
      color: 'yellow',
      text: 'CB-MCTS',
      paperId: 'paper-1',
      pageNumber: 3,
    });
    expect(pdfItem.rects).toHaveLength(1);

    const chatItem = res.body.find((h) => h.kind === 'chat');
    expect(chatItem).toMatchObject({
      id: chatH.id,
      kind: 'chat',
      color: 'orange',
      text: 'annealed',
      chatId: 'branch-1',
      chatTitle: 'entropy bonus',
      messageId: 'msg-1',
      startOffset: 22,
      endOffset: 30,
      childChatId: null,
    });
  });

  it('includes childChatId when a chat highlight is linked to a branch', async () => {
    db.prepare(
      'INSERT INTO chats (id, title, parent_id, created_at) VALUES (?, ?, ?, ?)',
    ).run('branch-2', 'annealing schedule', 'branch-1', '2026-07-03T00:00:00.000Z');
    const chatH = await createChatHighlight({ childChatId: 'branch-2' });

    const res = await request(app).get('/api/chats/root/tree-highlights');
    const chatItem = res.body.find((h) => h.kind === 'chat' && h.id === chatH.id);
    expect(chatItem.childChatId).toBe('branch-2');
  });

  it('resolves from a branch id to the root — same response as with the root id', async () => {
    await createPdfHighlight();
    await createChatHighlight();

    const viaRoot = await request(app).get('/api/chats/root/tree-highlights');
    const viaBranch = await request(app).get('/api/chats/branch-1/tree-highlights');
    expect(viaBranch.status).toBe(200);
    expect(viaBranch.body).toEqual(viaRoot.body);
  });

  it('returns no highlights from other trees', async () => {
    // Second, independent tree with its own paper, chat, message and highlights.
    db.prepare(
      'INSERT INTO papers (id, uploaded_at, pdf_path, status) VALUES (?, ?, ?, ?)',
    ).run('paper-other', '2026-07-05T00:00:00.000Z', '/dev/null', 'ready');
    db.prepare(
      'INSERT INTO chats (id, title, created_at, paper_id) VALUES (?, ?, ?, ?)',
    ).run('other-root', 'other tree', '2026-07-05T00:00:00.000Z', 'paper-other');
    db.prepare(
      "INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)",
    ).run('msg-other', 'other-root', 'unrelated text here', '2026-07-05T00:01:00.000Z');
    await request(app).post('/api/papers/paper-other/highlights').send({
      color: 'pink', text: 'foreign pdf', pageNumber: 1, rects: makeRects(),
    });
    await request(app).post('/api/chats/other-root/message-highlights').send({
      messageId: 'msg-other', color: 'pink', text: 'unrelated', startOffset: 0, endOffset: 9,
    });

    await createPdfHighlight();
    await createChatHighlight();

    const res = await request(app).get('/api/chats/root/tree-highlights');
    expect(res.body).toHaveLength(2);
    expect(res.body.every((h) => h.color !== 'pink')).toBe(true);
  });

  it('returns 404 for an unknown chat id', async () => {
    const res = await request(app).get('/api/chats/missing/tree-highlights');
    expect(res.status).toBe(404);
  });

  it('works for trees without a PDF — chat highlights only', async () => {
    db.prepare(
      'INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)',
    ).run('nopdf-root', 'plain tree', '2026-07-06T00:00:00.000Z');
    db.prepare(
      "INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)",
    ).run('msg-nopdf', 'nopdf-root', 'just chatting along', '2026-07-06T00:01:00.000Z');
    await request(app).post('/api/chats/nopdf-root/message-highlights').send({
      messageId: 'msg-nopdf', color: 'green', text: 'chatting', startOffset: 5, endOffset: 13,
    });

    const res = await request(app).get('/api/chats/nopdf-root/tree-highlights');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].kind).toBe('chat');
  });
});
