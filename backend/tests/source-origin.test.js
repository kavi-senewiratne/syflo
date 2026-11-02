/**
 * tests/source-origin.test.js — one origin per HTML source (ADR-0013 decision 4).
 */
process.env.OPENAI_API_KEY = 'test-key-for-unit-tests';
const request = require('supertest');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { createApp } = require('../server');
const { createDb } = require('../database');

const TEST_DB_PATH = path.join(__dirname, 'test-source-origin.db');
const UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'syflo-src-origin-'));

let app;
let db;
let id;
const PAGE = '<!DOCTYPE html><HTML><HEAD><title>Lecture</title></HEAD><body><p>Hello quiz</p></body></html>';

function addSource(html) {
  const sid = randomUUID();
  const file = path.join(UPLOADS_DIR, `${sid}.html`);
  fs.writeFileSync(file, html);
  db.prepare(`INSERT INTO html_sources (id, title, html_path, extracted_text, sections_json, uploaded_at)
    VALUES (?, 'Lecture', ?, 'Hello quiz', '[]', '2026-09-29')`).run(sid, file);
  return sid;
}
const srcHost = (sid, port = 3001) => `src-${sid}.localhost:${port}`;
const embed = (sid) => request(app).get(`/api/html-sources/${sid}/embed`).set('Host', 'localhost:3001');

beforeEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
  app = createApp(db, { uploadsDir: UPLOADS_DIR });
  id = addSource(PAGE);
});
afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

describe('GET /api/html-sources/:id/embed', () => {
  it('returns the source origin url and a stable per-source token', async () => {
    const res = await embed(id);
    expect(res.status).toBe(200);
    expect(res.body.origin).toBe(`http://src-${id}.localhost:3001`);
    expect(res.body.url).toBe(`http://src-${id}.localhost:3001/`);
    expect(res.body.token).toMatch(/^[0-9a-f]{32,}$/);
    expect((await embed(id)).body.token).toBe(res.body.token);
    expect((await embed(addSource(PAGE))).body.token).not.toBe(res.body.token);
  });

  it('404s for an unknown source', async () => {
    expect((await embed(randomUUID())).status).toBe(404);
  });
});

describe('source origin', () => {
  it('serves the snapshot with exactly one bridge tag carrying the token, right after <head>', async () => {
    const { token } = (await embed(id)).body;
    for (const p of ['/', '/index.html']) {
      const res = await request(app).get(p).set('Host', srcHost(id));
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.text).toContain('<p>Hello quiz</p>');
      expect(res.text.startsWith('<!DOCTYPE html>')).toBe(true);
      const tag = `<script src="/__syflo/bridge.js" data-token="${token}"></script>`;
      expect(res.text.split(tag)).toHaveLength(2);
      expect(res.text).toContain(`<HEAD>${tag}`);
    }
  });

  it('puts the tag at the start when there is no head, after a doctype if present', async () => {
    const bare = addSource('<p>bare</p>');
    const { token } = (await embed(bare)).body;
    const res = await request(app).get('/').set('Host', srcHost(bare));
    expect(res.text).toBe(`<script src="/__syflo/bridge.js" data-token="${token}"></script><p>bare</p>`);
    const dt = addSource('<!doctype html><body>x</body>');
    const res2 = await request(app).get('/').set('Host', srcHost(dt));
    expect(res2.text.startsWith('<!doctype html><script src="/__syflo/bridge.js"')).toBe(true);
  });

  it('sets isolation headers and no CORS headers', async () => {
    const res = await request(app).get('/').set('Host', srcHost(id)).set('Origin', 'http://localhost:3001');
    expect(res.headers['content-security-policy']).toBe('frame-ancestors http://localhost:* http://127.0.0.1:*');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves the bridge script (placeholder or real file) as javascript', async () => {
    const res = await request(app).get('/__syflo/bridge.js').set('Host', srcHost(id));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.text.length).toBeGreaterThan(0);
  });

  it('tells the bridge the web address of a URL import, so relative links resolve against it', async () => {
    const sid = randomUUID();
    const file = path.join(UPLOADS_DIR, `${sid}.html`);
    fs.writeFileSync(file, PAGE);
    db.prepare(`INSERT INTO html_sources (id, title, html_path, extracted_text, sections_json, uploaded_at, source_url)
      VALUES (?, 'Notes', ?, 'Hello quiz', '[]', '2026-09-30', ?)`).run(sid, file, 'https://underactuated.mit.edu/intro.html?a=1&b="2"');
    const { token } = (await embed(sid)).body;
    const res = await request(app).get('/').set('Host', srcHost(sid));
    expect(res.text).toContain(
      `<script src="/__syflo/bridge.js" data-token="${token}" data-source-url="https://underactuated.mit.edu/intro.html?a=1&amp;b=&quot;2&quot;"></script>`,
    );
    // An uploaded file carries no address at all.
    expect((await request(app).get('/').set('Host', srcHost(id))).text).not.toContain('data-source-url');
  });

  it('404s every other path, unknown sources and missing files', async () => {
    expect((await request(app).get('/other.css').set('Host', srcHost(id))).status).toBe(404);
    expect((await request(app).get('/__syflo/../server.js').set('Host', srcHost(id))).status).toBe(404);
    expect((await request(app).get('/').set('Host', srcHost(randomUUID()))).status).toBe(404);
    fs.unlinkSync(db.prepare('SELECT html_path p FROM html_sources WHERE id = ?').get(id).p);
    expect((await request(app).get('/').set('Host', srcHost(id))).status).toBe(404);
  });

  it('cannot reach the API or /uploads from the source host', async () => {
    fs.writeFileSync(path.join(UPLOADS_DIR, 'probe.txt'), 'secret');
    for (const p of ['/api/chats', '/api/settings', '/uploads/probe.txt']) {
      const res = await request(app).get(p).set('Host', srcHost(id));
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('secret');
    }
  });

  it('leaves other hosts untouched', async () => {
    expect((await request(app).get('/api/chats').set('Host', 'localhost:3001')).status).toBe(200);
    expect((await request(app).get('/api/chats').set('Host', 'src-x.localhost:3001')).status).toBe(403);
    expect((await request(app).get('/').set('Host', `src-${id}.evil.example`)).status).toBe(403);
  });
});
