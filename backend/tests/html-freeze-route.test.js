/**
 * tests/html-freeze-route.test.js
 *
 * Freezing at upload + retry (ADR-0013, decision 7), on route level with a
 * fake fetchFn — the network is never touched.
 */
const request = require('supertest');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { createApp } = require('../server');
const { createDb } = require('../database');

const PAGE = '<!doctype html><html><head><title>Lecture</title>'
  + '<script src="https://cdn.test/mathjax.js"></script></head>'
  + '<body><h1>Intro</h1><p>Hello <a href="https://cdn.test/other.html">link</a></p></body></html>';

describe('HTML source resource freezing', () => {
  const TEST_DB_PATH = path.join(__dirname, 'html-freeze-route-test.db');
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syflo-html-freeze-'));
  let app;
  let db;
  let online;
  let calls;

  const fetchFn = async (url) => {
    calls.push(url);
    if (!online) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    return new Response('window.mj = true;', { status: 200, headers: { 'content-type': 'text/javascript' } });
  };
  const lookupFn = async () => [{ address: '93.184.216.34', family: 4 }];

  beforeEach(() => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    db = createDb(TEST_DB_PATH);
    app = createApp(db, { uploadsDir, htmlSources: { fetchFn, lookupFn } });
    online = true;
    calls = [];
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  async function upload(html = PAGE) {
    const chat = (await request(app).post('/api/chats').send({ title: 'New chat' })).body;
    return request(app)
      .post('/api/html-sources')
      .field('chat_id', chat.id)
      .attach('html', Buffer.from(html), { filename: 'lecture.html', contentType: 'text/html' });
  }
  const stored = (id) => fs.readFileSync(db.prepare('SELECT html_path FROM html_sources WHERE id = ?').get(id).html_path, 'utf8');

  it('embeds the resources into the stored copy and reports nothing unfrozen', async () => {
    const res = await upload();

    expect(res.status).toBe(201);
    expect(res.body.unfrozen).toEqual([]);
    const html = stored(res.body.id);
    expect(html).toContain('<script>window.mj = true;</script>');
    expect(html).toContain('href="https://cdn.test/other.html"');
    expect((await request(app).get(`/api/html-sources/${res.body.id}`)).body.unfrozen).toEqual([]);
  });

  it('still creates the source when a resource fails and lists it with its reason', async () => {
    online = false;

    const res = await upload();

    expect(res.status).toBe(201);
    expect(res.body.unfrozen).toEqual([{ url: 'https://cdn.test/mathjax.js', kind: 'script', reason: 'no-internet' }]);
    expect(stored(res.body.id)).toContain('<script src="https://cdn.test/mathjax.js"></script>');
    const got = await request(app).get(`/api/html-sources/${res.body.id}`);
    expect(got.body.unfrozen).toEqual(res.body.unfrozen);
    expect(got.body.sections).toEqual([{ level: 1, heading: 'Intro' }]);
  });

  it('retry freezes what is still missing and clears the warning', async () => {
    online = false;
    const { body } = await upload();
    online = true;
    calls = [];

    const retry = await request(app).post(`/api/html-sources/${body.id}/freeze`);

    expect(retry.status).toBe(200);
    expect(retry.body.unfrozen).toEqual([]);
    expect(calls).toEqual(['https://cdn.test/mathjax.js']);
    expect(stored(body.id)).toContain('<script>window.mj = true;</script>');
    expect((await request(app).get(`/api/html-sources/${body.id}`)).body.unfrozen).toEqual([]);

    calls = [];
    await request(app).post(`/api/html-sources/${body.id}/freeze`);
    expect(calls).toEqual([]); // already inlined resources are not fetched again
  });

  it('retry keeps reporting a resource that still fails', async () => {
    online = false;
    const { body } = await upload();

    const retry = await request(app).post(`/api/html-sources/${body.id}/freeze`);

    expect(retry.body.unfrozen).toEqual([{ url: 'https://cdn.test/mathjax.js', kind: 'script', reason: 'no-internet' }]);
  });

  it('retry on an unknown id is a 404', async () => {
    const res = await request(app).post('/api/html-sources/nope/freeze');
    expect(res.status).toBe(404);
  });

  it('never fetches a private address and reports it as blocked', async () => {
    const res = await upload('<html><body><h1>A</h1><img src="http://192.168.1.5/x.png"></body></html>');

    expect(calls).toEqual([]);
    expect(res.body.unfrozen).toEqual([{ url: 'http://192.168.1.5/x.png', kind: 'image', reason: 'blocked-local-address' }]);
  });

  it('retry keeps reporting a blocked address even though its tag was neutralized', async () => {
    const res = await upload('<html><body><h1>A</h1><img src="http://192.168.1.5/x.png"></body></html>');

    const retry = await request(app).post(`/api/html-sources/${res.body.id}/freeze`);

    expect(retry.status).toBe(200);
    expect(retry.body.unfrozen).toEqual([{ url: 'http://192.168.1.5/x.png', kind: 'image', reason: 'blocked-local-address' }]);
  });

  it('keeps the outline working on frozen html', async () => {
    const res = await upload();
    expect(res.body.sections).toEqual([{ level: 1, heading: 'Intro' }]);
  });
});
