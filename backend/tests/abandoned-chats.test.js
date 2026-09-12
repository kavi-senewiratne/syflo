const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { createDb } = require('../database');
const { sweepAbandonedChats } = require('../cleanup');

const TEST_DB_PATH = path.join(__dirname, 'abandoned-chats-test.db');

let db;

beforeEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-09-12T12:00:00.000Z');

function insertChat({ ageMs = HOUR, parentId = null, paperId = null, videoId = null, pinned = false } = {}) {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO chats (id, title, parent_id, paper_id, video_id, pinned_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    'New chat',
    parentId,
    paperId,
    videoId,
    pinned ? new Date(NOW).toISOString() : null,
    new Date(NOW - ageMs).toISOString(),
  );
  return id;
}

function insertMessage(chatId) {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, chatId, 'user', 'hello', new Date(NOW).toISOString());
  return id;
}

function chatExists(id) {
  return db.prepare('SELECT 1 FROM chats WHERE id = ?').get(id) !== undefined;
}

describe('sweepAbandonedChats', () => {
  it('deletes an old empty root chat', () => {
    const id = insertChat();
    expect(sweepAbandonedChats(db, { now: NOW })).toBe(1);
    expect(chatExists(id)).toBe(false);
  });

  it('spares a chat younger than the grace period', () => {
    const id = insertChat({ ageMs: 60 * 1000 });
    expect(sweepAbandonedChats(db, { now: NOW })).toBe(0);
    expect(chatExists(id)).toBe(true);
  });

  it('spares a chat with messages', () => {
    const id = insertChat();
    insertMessage(id);
    sweepAbandonedChats(db, { now: NOW });
    expect(chatExists(id)).toBe(true);
  });

  it('spares a chat with branches — and never deletes branches themselves', () => {
    const parent = insertChat();
    const child = insertChat({ parentId: parent });
    expect(sweepAbandonedChats(db, { now: NOW })).toBe(0);
    expect(chatExists(parent)).toBe(true);
    expect(chatExists(child)).toBe(true);
  });

  it('spares a chat with a bound paper or video', () => {
    db.prepare(
      "INSERT INTO papers (id, title, uploaded_at, pdf_path, status) VALUES ('p1', 'Paper', ?, '/tmp/p.pdf', 'ready')",
    ).run(new Date(NOW).toISOString());
    db.prepare(
      "INSERT INTO videos (id, youtube_id, title, transcript, url, created_at) VALUES ('v1', 'yt1', 'Video', 't', 'https://youtu.be/yt1', ?)",
    ).run(new Date(NOW).toISOString());
    const withPaper = insertChat({ paperId: 'p1' });
    const withVideo = insertChat({ videoId: 'v1' });
    expect(sweepAbandonedChats(db, { now: NOW })).toBe(0);
    expect(chatExists(withPaper)).toBe(true);
    expect(chatExists(withVideo)).toBe(true);
  });

  it('spares a pinned chat', () => {
    const id = insertChat({ pinned: true });
    expect(sweepAbandonedChats(db, { now: NOW })).toBe(0);
    expect(chatExists(id)).toBe(true);
  });

  it('sweeps several abandoned chats at once and reports the count', () => {
    insertChat();
    insertChat({ ageMs: 24 * HOUR });
    const kept = insertChat({ ageMs: 60 * 1000 });
    expect(sweepAbandonedChats(db, { now: NOW })).toBe(2);
    expect(chatExists(kept)).toBe(true);
  });
});
