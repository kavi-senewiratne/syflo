process.env.OPENAI_API_KEY = 'test-key-for-unit-tests';
const request = require('supertest');
const { createApp } = require('../server');
const { createDb } = require('../database');
const path = require('path');
const os = require('os');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'test-security.db');

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

describe('cross-origin isolation', () => {
  it('does not grant foreign websites cross-origin access to the API', async () => {
    const res = await request(app)
      .get('/api/chats')
      .set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects requests with a non-local Host header (DNS rebinding)', async () => {
    const res = await request(app)
      .get('/api/chats')
      .set('Host', 'evil.example:3001');
    expect(res.status).toBe(403);
  });

  it('accepts requests addressed to localhost', async () => {
    const res = await request(app)
      .get('/api/chats')
      .set('Host', 'localhost:3001');
    expect(res.status).toBe(200);
  });
});

describe('uploaded files', () => {
  // A throwaway folder handed to createApp — the real uploads folder holds the
  // user's own attachments and must never be a test's scratch space.
  const UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'syflo-uploads-'));
  const PROBE = path.join(UPLOADS_DIR, 'security-probe.html');

  beforeEach(() => {
    app = createApp(db, { uploadsDir: UPLOADS_DIR });
    fs.writeFileSync(PROBE, '<script>alert(1)</script>');
  });

  afterEach(() => {
    if (fs.existsSync(PROBE)) fs.unlinkSync(PROBE);
  });

  it('are served as downloads, never as executable pages', async () => {
    const res = await request(app).get('/uploads/security-probe.html');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('attachment upload targets', () => {
  // path.join(UPLOADS_DIR, '../pwned-by-test') would land here:
  const ESCAPED_DIR = path.join(__dirname, '..', '..', 'pwned-by-test');
  const STRAY_DIR = path.join(__dirname, '..', '..', 'uploads', 'no-such-chat');

  beforeEach(() => {
    fs.rmSync(ESCAPED_DIR, { recursive: true, force: true });
    fs.rmSync(STRAY_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(ESCAPED_DIR, { recursive: true, force: true });
    fs.rmSync(STRAY_DIR, { recursive: true, force: true });
  });

  it('rejects a traversal chatId before writing anything to disk', async () => {
    const res = await request(app)
      .post(`/api/chats/${encodeURIComponent('../pwned-by-test')}/messages`)
      .field('content', 'hi')
      .attach('files', Buffer.from('x'), 'x.txt');
    expect(res.status).toBe(404);
    expect(fs.existsSync(ESCAPED_DIR)).toBe(false);
  });

  it('rejects uploads to a chat that does not exist without writing files', async () => {
    const res = await request(app)
      .post('/api/chats/no-such-chat/messages')
      .field('content', 'hi')
      .attach('files', Buffer.from('x'), 'x.txt');
    expect(res.status).toBe(404);
    expect(fs.existsSync(STRAY_DIR)).toBe(false);
  });
});
