/**
 * tests/url-import.test.js
 *
 * URL import of an HTML source (ADR-0013, "Web pages"): POST
 * /api/html-sources/from-url. The renderer, the raw fetch and DNS are all
 * injected, so the network is never touched.
 */
const request = require('supertest');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { createApp } = require('../server');
const { createDb } = require('../database');

const BODY_TEXT = 'A page whose content is built by JavaScript. '.repeat(8);
const PAGE = `<!doctype html><html><head><title>Rendered Lecture</title></head><body><h1>Intro</h1><p>${BODY_TEXT}</p></body></html>`;
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

describe('POST /api/html-sources/from-url', () => {
  const TEST_DB_PATH = path.join(__dirname, 'url-import-test.db');
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syflo-url-import-'));
  let app;
  let db;
  let renderCalls;
  let renderFn;

  const build = (urlImport = {}) => createApp(db, {
    uploadsDir,
    htmlSources: { lookupFn: publicLookup, fetchFn: async () => new Response('', { status: 200 }), urlImport: { renderFn, lookupFn: publicLookup, ...urlImport } },
  });
  const newChat = async () => (await request(app).post('/api/chats').send({ title: 'New chat' })).body;
  const importUrl = async (url, chatId) => request(app).post('/api/html-sources/from-url').send({ chat_id: chatId ?? (await newChat()).id, url });
  const sourceCount = () => db.prepare('SELECT COUNT(*) AS n FROM html_sources').get().n;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    db = createDb(TEST_DB_PATH);
    renderCalls = [];
    renderFn = async (url) => { renderCalls.push(url); return { html: PAGE, finalUrl: url }; };
    app = build();
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  it('stores the rendered page as an HTML source bound to the tree, answering like an upload plus source_url', async () => {
    const chat = await newChat();

    const res = await importUrl('https://example.com/lecture', chat.id);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      title: 'Rendered Lecture',
      sections: [{ level: 1, heading: 'Intro' }],
      unfrozen: [],
      source_url: 'https://example.com/lecture',
    });
    expect(renderCalls).toEqual(['https://example.com/lecture']);
    const bound = db.prepare('SELECT html_source_id FROM chats WHERE id = ?').get(chat.id);
    expect(bound.html_source_id).toBe(res.body.id);
    const row = db.prepare('SELECT * FROM html_sources WHERE id = ?').get(res.body.id);
    expect(row.source_url).toBe('https://example.com/lecture');
    expect(fs.readFileSync(row.html_path, 'utf8')).toContain('Rendered Lecture');
    expect((await request(app).get(`/api/html-sources/${res.body.id}`)).body.source_url).toBe('https://example.com/lecture');
  });

  it('drops the scripts of a rendered page: its DOM is already built and must not build itself twice', async () => {
    renderFn = async (url) => ({
      html: PAGE.replace('</body>', "<script>document.body.append('DUPLICATED')</script></body>"),
      finalUrl: url,
    });
    app = build({ renderFn });

    const res = await importUrl('https://example.com/lecture');

    expect(res.status).toBe(201);
    const row = db.prepare('SELECT html_path FROM html_sources WHERE id = ?').get(res.body.id);
    expect(fs.readFileSync(row.html_path, 'utf8')).not.toMatch(/<script/i);
  });

  it('uses the final URL of the render as source_url and the freeze base', async () => {
    renderFn = async () => ({ html: PAGE.replace('<body>', '<body><img src="/logo.png">'), finalUrl: 'https://example.com/moved' });
    const fetched = [];
    app = createApp(db, { uploadsDir, htmlSources: {
      lookupFn: publicLookup,
      fetchFn: async (url) => { fetched.push(url); return new Response('PNG', { status: 200, headers: { 'content-type': 'image/png' } }); },
      urlImport: { renderFn, lookupFn: publicLookup },
    } });

    const res = await importUrl('https://example.com/start');

    expect(res.body.source_url).toBe('https://example.com/moved');
    expect(fetched).toEqual(['https://example.com/logo.png']);
  });

  it('rejects anything but http(s) with 400 and never renders it', async () => {
    for (const url of ['ftp://example.com/a', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url', '']) {
      const res = await importUrl(url);
      expect(res.status).toBe(400);
    }
    expect(renderCalls).toEqual([]);
  });

  it('requires an existing chat', async () => {
    expect((await request(app).post('/api/html-sources/from-url').send({ url: 'https://example.com/' })).status).toBe(400);
    expect((await importUrl('https://example.com/', 'no-such-chat')).status).toBe(404);
  });

  it('refuses loopback, private and link-local targets before rendering (SSRF)', async () => {
    for (const url of ['http://127.0.0.1:3001/api/chats', 'http://localhost/x', 'http://[::1]/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data']) {
      const res = await importUrl(url);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('blocked-local-address');
    }
    app = build({ lookupFn: async () => [{ address: '10.1.2.3', family: 4 }] });
    expect((await importUrl('http://intranet.example/')).body.error).toBe('blocked-local-address');
    expect(renderCalls).toEqual([]);
    expect(sourceCount()).toBe(0);
  });

  it('answers 422 no-readable-text and stores nothing when the page shows too little text', async () => {
    renderFn = async (url) => ({ html: '<html><head><title>Login</title></head><body><p>Please sign in.</p></body></html>', finalUrl: url });
    app = build();
    const before = fs.readdirSync(path.join(uploadsDir, 'html-sources')).length;
    const chat = await newChat();

    const res = await importUrl('https://example.com/wall', chat.id);

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('no-readable-text');
    expect(sourceCount()).toBe(0);
    expect(db.prepare('SELECT html_source_id FROM chats WHERE id = ?').get(chat.id).html_source_id).toBeNull();
    expect(fs.readdirSync(path.join(uploadsDir, 'html-sources')).length).toBe(before);
  });

  it('answers 409 tree-has-source when the tree already has a source', async () => {
    const chat = await newChat();
    expect((await importUrl('https://example.com/a', chat.id)).status).toBe(201);

    const res = await importUrl('https://example.com/b', chat.id);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('tree-has-source');
    expect(sourceCount()).toBe(1);
  });

  it('falls back to the hostname when the page has no <title>', async () => {
    renderFn = async (url) => ({ html: `<html><body><p>${BODY_TEXT}</p></body></html>`, finalUrl: url });
    app = build();

    const res = await importUrl('https://docs.example.org/guide');

    expect(res.body.title).toBe('docs.example.org');
  });

  describe('without a renderer (raw fetch fallback)', () => {
    const html = (body = PAGE) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    const redirect = (to) => new Response('', { status: 302, headers: { location: to } });
    const rawApp = (fetchFn, extra = {}) => { app = build({ renderFn: undefined, channelFile: null, env: {}, fetchFn, ...extra }); };

    it('fetches the page and stores it under the final URL after redirects', async () => {
      const calls = [];
      rawApp(async (url, init) => {
        calls.push([url, init.redirect]);
        return url.endsWith('/old') ? redirect('/new') : html();
      });

      const res = await importUrl('https://example.com/old');

      expect(res.status).toBe(201);
      expect(res.body.source_url).toBe('https://example.com/new');
      expect(calls).toEqual([['https://example.com/old', 'manual'], ['https://example.com/new', 'manual']]);
    });

    it('guards every redirect hop', async () => {
      rawApp(async () => redirect('http://169.254.169.254/latest'));
      const res = await importUrl('https://example.com/r');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('blocked-local-address');
    });

    it('stops after 5 redirects', async () => {
      rawApp(async (url) => redirect(`${url}x`));
      expect((await importUrl('https://example.com/r')).status).toBe(502);
    });

    it('answers 413 above 5 MB, 504 on timeout, 502 on an HTTP error and 415 for non-HTML', async () => {
      rawApp(async () => new Response('x'.repeat(5 * 1024 * 1024 + 1), { status: 200, headers: { 'content-type': 'text/html' } }));
      expect((await importUrl('https://example.com/big')).status).toBe(413);
      rawApp(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); });
      expect((await importUrl('https://example.com/slow')).status).toBe(504);
      rawApp(async () => new Response('nope', { status: 404 }));
      expect((await importUrl('https://example.com/gone')).body.error).toBe('http-404');
      rawApp(async () => new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } }));
      expect((await importUrl('https://example.com/a.pdf')).status).toBe(415);
    });
  });

  describe('default renderer (Electron main over loopback)', () => {
    let channel;
    let seen;
    beforeEach(async () => {
      seen = [];
      channel = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          seen.push({ auth: req.headers.authorization, url: req.url, body: JSON.parse(body) });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ html: PAGE, finalUrl: 'https://example.com/final' }));
        });
      });
      await new Promise((r) => channel.listen(0, '127.0.0.1', r));
    });
    afterEach(() => new Promise((r) => { channel.close(r); channel.closeAllConnections(); }));

    it('calls SYFLO_RENDER_URL with the bearer token', async () => {
      app = build({ renderFn: undefined, channelFile: null, env: { SYFLO_RENDER_URL: `http://127.0.0.1:${channel.address().port}`, SYFLO_RENDER_TOKEN: 'tok' } });

      const res = await importUrl('https://example.com/a');

      expect(res.status).toBe(201);
      expect(res.body.source_url).toBe('https://example.com/final');
      expect(seen).toEqual([{ auth: 'Bearer tok', url: '/render', body: { url: 'https://example.com/a' } }]);
    });

    it('finds the channel in the discovery file when the backend was started before Electron', async () => {
      const channelFile = path.join(uploadsDir, 'render-channel.json');
      fs.writeFileSync(channelFile, JSON.stringify({ url: `http://127.0.0.1:${channel.address().port}`, token: 'filetok' }));
      app = build({ renderFn: undefined, channelFile, env: {} });

      expect((await importUrl('https://example.com/a')).status).toBe(201);
      expect(seen[0].auth).toBe('Bearer filetok');
    });

    it('maps renderer verdicts: 403 blocked -> 400, 504 -> 504', async () => {
      channel.removeAllListeners('request');
      channel.on('request', (req, res) => { req.resume(); res.writeHead(504, { 'content-type': 'application/json' }); res.end('{"error":"timeout"}'); });
      app = build({ renderFn: undefined, channelFile: null, env: { SYFLO_RENDER_URL: `http://127.0.0.1:${channel.address().port}`, SYFLO_RENDER_TOKEN: 't' } });

      const res = await importUrl('https://example.com/a');

      expect(res.status).toBe(504);
      expect(res.body.error).toBe('timeout');
    });

    it('falls back to the raw fetch when the renderer is not reachable', async () => {
      const port = channel.address().port;
      await new Promise((r) => { channel.close(r); channel.closeAllConnections(); });
      channel.listen = () => {}; // afterEach closes an already closed server
      app = build({
        renderFn: undefined, channelFile: null, env: { SYFLO_RENDER_URL: `http://127.0.0.1:${port}`, SYFLO_RENDER_TOKEN: 't' },
        fetchFn: async () => new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } }),
      });

      expect((await importUrl('https://example.com/a')).status).toBe(201);
    });
  });
});
