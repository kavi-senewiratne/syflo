process.env.OPENAI_API_KEY = 'test-key-for-unit-tests';
const request = require('supertest');
const { createApp } = require('../server');
const { createDb } = require('../database');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'mindmap-tree.test.db');

let app;
let db;

// Fixture: a tree with a paper —
//   root (paper_id=paper-1)
//   ├── pdf-branch    (opened from a PDF highlight)
//   └── chat-branch   (opened from a chat-text highlight on msg-root)
// The mindmap needs each branch's highlight kind (its color) so the node can
// carry the color bar — design/mockup-mindmap-node-final.html.
beforeEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
  app = createApp(db);

  db.prepare(
    'INSERT INTO papers (id, uploaded_at, pdf_path, status) VALUES (?, ?, ?, ?)',
  ).run('paper-1', '2026-08-01T00:00:00.000Z', '/dev/null', 'ready');
  db.prepare(
    'INSERT INTO chats (id, title, created_at, paper_id) VALUES (?, ?, ?, ?)',
  ).run('root', 'Attention Is All You Need', '2026-08-01T00:00:00.000Z', 'paper-1');
  db.prepare(
    "INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)",
  ).run('msg-root', 'root', 'eight heads run in parallel', '2026-08-01T00:01:00.000Z');
  db.prepare(
    'INSERT INTO chats (id, title, parent_id, parent_word, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('pdf-branch', 'Scaled dot-product', 'root', 'we scale the dot products', '2026-08-01T00:02:00.000Z');
  db.prepare(
    'INSERT INTO chats (id, title, parent_id, parent_word, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('chat-branch', 'Multi-head attention', 'root', 'eight heads', '2026-08-01T00:03:00.000Z');
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

// Links a PDF highlight of the given color to a branch chat.
function linkPdfHighlight(chatId, color) {
  db.prepare(
    'INSERT INTO text_ranges (id, paper_id, text, page_number, bbox_json) VALUES (?, ?, ?, ?, ?)',
  ).run(`tr-${chatId}`, 'paper-1', 'we scale the dot products', 4, '[]');
  db.prepare(
    `INSERT INTO highlights (id, text_range_id, chat_id, color, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(`hl-${chatId}`, `tr-${chatId}`, chatId, color, '2026-08-01T00:02:00.000Z', '2026-08-01T00:02:00.000Z');
}

// Links a chat-text highlight of the given color to a branch chat.
function linkChatHighlight(chatId, color) {
  db.prepare(
    `INSERT INTO message_highlights
       (id, message_id, start_offset, end_offset, text, color, created_at, updated_at, child_chat_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(`mh-${chatId}`, 'msg-root', 0, 11, 'eight heads', color,
    '2026-08-01T00:03:00.000Z', '2026-08-01T00:03:00.000Z', chatId);
}

function nodeById(tree, id) {
  const walk = (chat) => {
    if (chat.id === id) return chat;
    for (const child of chat.children || []) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  for (const root of tree) {
    const hit = walk(root);
    if (hit) return hit;
  }
  return null;
}

describe('GET /api/chats/tree — highlight kind per node', () => {
  it('carries the color of the PDF highlight a branch was opened from', async () => {
    linkPdfHighlight('pdf-branch', 'pink');

    const res = await request(app).get('/api/chats/tree');
    expect(res.status).toBe(200);
    expect(nodeById(res.body, 'pdf-branch').highlight_color).toBe('pink');
  });

  it('carries the color of the chat-text highlight a branch was opened from', async () => {
    linkChatHighlight('chat-branch', 'yellow');

    const res = await request(app).get('/api/chats/tree');
    expect(nodeById(res.body, 'chat-branch').highlight_color).toBe('yellow');
  });

  it('carries the outcome line of a branch', async () => {
    db.prepare('UPDATE chats SET outcome = ? WHERE id = ?')
      .run('Hält die Varianz bei 1', 'pdf-branch');

    const res = await request(app).get('/api/chats/tree');
    expect(nodeById(res.body, 'pdf-branch').outcome).toBe('Hält die Varianz bei 1');
    expect(nodeById(res.body, 'chat-branch').outcome).toBeNull();
  });

  it('counts only real answers, so a failed branch promises no outcome (2026-08-03)', async () => {
    // The node's "Ergebnis folgt …" placeholder hangs off answer_count. A
    // branch whose only answer is a '*Failed*'/'*Interrupted*' marker
    // established nothing — counting messages promised an outcome that could
    // never arrive.
    db.prepare(
      "INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)",
    ).run('m1', 'pdf-branch', 'Warum?', '2026-08-01T00:04:00.000Z');
    db.prepare(
      "INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)",
    ).run('m2', 'pdf-branch', '*Failed*', '2026-08-01T00:04:01.000Z');
    db.prepare(
      "INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)",
    ).run('m3', 'chat-branch', 'Warum?', '2026-08-01T00:05:00.000Z');
    db.prepare(
      "INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)",
    ).run('m4', 'chat-branch', 'Weil acht Köpfe parallel laufen.', '2026-08-01T00:05:01.000Z');

    const res = await request(app).get('/api/chats/tree');
    expect(nodeById(res.body, 'pdf-branch').message_count).toBe(2);
    expect(nodeById(res.body, 'pdf-branch').answer_count).toBe(0);
    expect(nodeById(res.body, 'chat-branch').answer_count).toBe(1);
  });

  it('leaves highlight_color null for branches opened without a highlight', async () => {
    const res = await request(app).get('/api/chats/tree');
    expect(nodeById(res.body, 'pdf-branch').highlight_color).toBeNull();
    expect(nodeById(res.body, 'root').highlight_color).toBeNull();
  });
});
