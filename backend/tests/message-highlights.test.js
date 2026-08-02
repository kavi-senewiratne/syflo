process.env.OPENAI_API_KEY = 'test-key-for-unit-tests';
const request = require('supertest');
const { createApp } = require('../server');
const { createDb } = require('../database');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'message-highlights.test.db');

let app;
let db;
let chatId;
let messageId;

// Clean DB per test; chat + one assistant message are created in beforeEach
// so POST/PATCH/DELETE have valid foreign keys to attach to.
beforeEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
  app = createApp(db);
  chatId = 'chat-1';
  messageId = 'msg-1';
  db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)').run(
    chatId,
    'Optimizer deep dive',
    '2026-07-19T00:00:00.000Z',
  );
  db.prepare(
    'INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(
    messageId,
    chatId,
    'assistant',
    'Gradient clipping alone is not enough because the problem is the optimizer state.',
    '2026-07-19T00:00:01.000Z',
  );
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

function validBody(overrides = {}) {
  return {
    messageId,
    color: 'pink',
    text: 'Gradient clipping alone is not enough',
    startOffset: 0,
    endOffset: 37,
    ...overrides,
  };
}

describe('GET /api/chats/:chatId/message-highlights', () => {
  it('returns empty array when the chat has no highlights', async () => {
    const res = await request(app).get(`/api/chats/${chatId}/message-highlights`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('404s for an unknown chat', async () => {
    const res = await request(app).get('/api/chats/nope/message-highlights');
    expect(res.status).toBe(404);
  });

  it('returns highlights of all messages in the chat, in creation order', async () => {
    db.prepare(
      'INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('msg-2', chatId, 'user', 'Can clipping prevent that?', '2026-07-19T00:00:02.000Z');

    await request(app)
      .post(`/api/chats/${chatId}/message-highlights`)
      .send(validBody({ color: 'yellow', text: 'first', startOffset: 0, endOffset: 5 }));
    await request(app)
      .post(`/api/chats/${chatId}/message-highlights`)
      .send(validBody({ messageId: 'msg-2', color: 'green', text: 'second', startOffset: 4, endOffset: 12 }));

    const res = await request(app).get(`/api/chats/${chatId}/message-highlights`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.map((h) => h.color)).toEqual(['yellow', 'green']);
    expect(res.body[1].messageId).toBe('msg-2');
    expect(res.body[1].chatId).toBe(chatId);
  });

  it('does not leak highlights from other chats', async () => {
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)').run(
      'chat-2',
      'Other',
      '2026-07-19T00:00:03.000Z',
    );
    db.prepare(
      'INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('msg-other', 'chat-2', 'assistant', 'unrelated text', '2026-07-19T00:00:04.000Z');
    await request(app)
      .post('/api/chats/chat-2/message-highlights')
      .send(validBody({ messageId: 'msg-other', text: 'unrelated', startOffset: 0, endOffset: 9 }));

    const res = await request(app).get(`/api/chats/${chatId}/message-highlights`);
    expect(res.body).toEqual([]);
  });
});

describe('POST /api/chats/:chatId/message-highlights', () => {
  it('creates a highlight and returns the full shape', async () => {
    const res = await request(app)
      .post(`/api/chats/${chatId}/message-highlights`)
      .send(validBody());
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.messageId).toBe(messageId);
    expect(res.body.chatId).toBe(chatId);
    expect(res.body.color).toBe('pink');
    expect(res.body.startOffset).toBe(0);
    expect(res.body.endOffset).toBe(37);
    expect(res.body.text).toBe('Gradient clipping alone is not enough');
    expect(res.body.createdAt).toBeDefined();
  });

  it('rejects an invalid color', async () => {
    const res = await request(app)
      .post(`/api/chats/${chatId}/message-highlights`)
      .send(validBody({ color: 'red' }));
    expect(res.status).toBe(400);
  });

  it('rejects empty text', async () => {
    const res = await request(app)
      .post(`/api/chats/${chatId}/message-highlights`)
      .send(validBody({ text: '   ' }));
    expect(res.status).toBe(400);
  });

  it('rejects endOffset <= startOffset', async () => {
    const res = await request(app)
      .post(`/api/chats/${chatId}/message-highlights`)
      .send(validBody({ startOffset: 10, endOffset: 10 }));
    expect(res.status).toBe(400);
  });

  it('rejects negative startOffset', async () => {
    const res = await request(app)
      .post(`/api/chats/${chatId}/message-highlights`)
      .send(validBody({ startOffset: -1 }));
    expect(res.status).toBe(400);
  });

  it('404s for an unknown message', async () => {
    const res = await request(app)
      .post(`/api/chats/${chatId}/message-highlights`)
      .send(validBody({ messageId: 'nope' }));
    expect(res.status).toBe(404);
  });

  it('rejects a message that belongs to a different chat', async () => {
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)').run(
      'chat-2',
      'Other',
      '2026-07-19T00:00:03.000Z',
    );
    db.prepare(
      'INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('msg-other', 'chat-2', 'assistant', 'unrelated', '2026-07-19T00:00:04.000Z');

    const res = await request(app)
      .post(`/api/chats/${chatId}/message-highlights`)
      .send(validBody({ messageId: 'msg-other' }));
    expect(res.status).toBe(400);
  });

  it('allows overlapping highlights on the same message', async () => {
    const a = await request(app)
      .post(`/api/chats/${chatId}/message-highlights`)
      .send(validBody({ color: 'yellow', startOffset: 0, endOffset: 20 }));
    const b = await request(app)
      .post(`/api/chats/${chatId}/message-highlights`)
      .send(validBody({ color: 'green', startOffset: 10, endOffset: 30 }));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });

  it('defaults childChatId to null when not provided', async () => {
    const res = await request(app)
      .post(`/api/chats/${chatId}/message-highlights`)
      .send(validBody());
    expect(res.body.childChatId).toBeNull();
  });

  it('links a child chat at creation time', async () => {
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)').run(
      'child-1',
      'About clipping',
      '2026-07-19T00:00:05.000Z',
    );
    const res = await request(app)
      .post(`/api/chats/${chatId}/message-highlights`)
      .send(validBody({ childChatId: 'child-1' }));
    expect(res.status).toBe(201);
    expect(res.body.childChatId).toBe('child-1');
  });

  it('404s when childChatId does not reference an existing chat', async () => {
    const res = await request(app)
      .post(`/api/chats/${chatId}/message-highlights`)
      .send(validBody({ childChatId: 'nope' }));
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/message-highlights/:mhid', () => {
  it('recolors a highlight and bumps updated_at', async () => {
    const created = await request(app)
      .post(`/api/chats/${chatId}/message-highlights`)
      .send(validBody());
    const res = await request(app)
      .patch(`/api/message-highlights/${created.body.id}`)
      .send({ color: 'blue' });
    expect(res.status).toBe(200);
    expect(res.body.color).toBe('blue');
  });

  it('rejects an invalid color', async () => {
    const created = await request(app)
      .post(`/api/chats/${chatId}/message-highlights`)
      .send(validBody());
    const res = await request(app)
      .patch(`/api/message-highlights/${created.body.id}`)
      .send({ color: 'crimson' });
    expect(res.status).toBe(400);
  });

  it('404s for an unknown highlight', async () => {
    const res = await request(app)
      .patch('/api/message-highlights/nope')
      .send({ color: 'blue' });
    expect(res.status).toBe(404);
  });

  it('links and unlinks a child chat', async () => {
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)').run(
      'child-1',
      'About clipping',
      '2026-07-19T00:00:05.000Z',
    );
    const created = await request(app)
      .post(`/api/chats/${chatId}/message-highlights`)
      .send(validBody());

    const linkRes = await request(app)
      .patch(`/api/message-highlights/${created.body.id}`)
      .send({ childChatId: 'child-1' });
    expect(linkRes.status).toBe(200);
    expect(linkRes.body.childChatId).toBe('child-1');

    const unlinkRes = await request(app)
      .patch(`/api/message-highlights/${created.body.id}`)
      .send({ childChatId: null });
    expect(unlinkRes.status).toBe(200);
    expect(unlinkRes.body.childChatId).toBeNull();
  });

  it('404s when linking a childChatId that does not reference an existing chat', async () => {
    const created = await request(app)
      .post(`/api/chats/${chatId}/message-highlights`)
      .send(validBody());
    const res = await request(app)
      .patch(`/api/message-highlights/${created.body.id}`)
      .send({ childChatId: 'nope' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/message-highlights/:mhid', () => {
  it('deletes a highlight', async () => {
    const created = await request(app)
      .post(`/api/chats/${chatId}/message-highlights`)
      .send(validBody());
    const del = await request(app).delete(`/api/message-highlights/${created.body.id}`);
    expect(del.status).toBe(204);
    const list = await request(app).get(`/api/chats/${chatId}/message-highlights`);
    expect(list.body).toEqual([]);
  });

  it('404s for an unknown highlight', async () => {
    const res = await request(app).delete('/api/message-highlights/nope');
    expect(res.status).toBe(404);
  });
});
