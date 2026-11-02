// node --test electron/tests — pure parts of the page renderer (no Electron needed).
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { startRenderServer } = require('../render-server');

function post(server, pathName, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${server.url}${pathName}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('renders through renderPage when the bearer token matches', async () => {
  const server = await startRenderServer({ token: 's3cret', renderPage: async (url) => ({ html: `<p>${url}</p>`, finalUrl: `${url}/final` }) });
  try {
    const res = await post(server, '/render', { url: 'https://example.com' }, { authorization: 'Bearer s3cret' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { html: '<p>https://example.com</p>', finalUrl: 'https://example.com/final' });
  } finally { await server.close(); }
});

test('rejects a missing or wrong token with 401', async () => {
  let called = false;
  const server = await startRenderServer({ token: 's3cret', renderPage: async () => { called = true; return {}; } });
  try {
    assert.strictEqual((await post(server, '/render', { url: 'https://example.com' })).status, 401);
    assert.strictEqual((await post(server, '/render', { url: 'https://example.com' }, { authorization: 'Bearer nope' })).status, 401);
    assert.strictEqual(called, false);
  } finally { await server.close(); }
});

test('rejects non-http(s) urls with 400 and maps renderer errors to statuses', async () => {
  const server = await startRenderServer({
    token: 't',
    renderPage: async (url) => {
      if (url.includes('blocked')) throw Object.assign(new Error('x'), { reason: 'blocked-local-address' });
      if (url.includes('slow')) throw Object.assign(new Error('x'), { reason: 'timeout' });
      throw new Error('boom');
    },
  });
  const auth = { authorization: 'Bearer t' };
  try {
    assert.strictEqual((await post(server, '/render', { url: 'file:///etc/passwd' }, auth)).status, 400);
    assert.strictEqual((await post(server, '/render', {}, auth)).status, 400);
    assert.deepStrictEqual(await post(server, '/render', { url: 'http://blocked.test' }, auth), { status: 403, body: { error: 'blocked-local-address' } });
    assert.strictEqual((await post(server, '/render', { url: 'http://slow.test' }, auth)).status, 504);
    assert.strictEqual((await post(server, '/render', { url: 'http://x.test' }, auth)).status, 502);
    assert.strictEqual((await post(server, '/other', { url: 'http://x.test' }, auth)).status, 404);
  } finally { await server.close(); }
});

test('rejects a foreign Host header (DNS rebinding) with 403', async () => {
  const server = await startRenderServer({ token: 't', renderPage: async () => ({ html: '', finalUrl: '' }) });
  try {
    const res = await post(server, '/render', { url: 'https://example.com' }, { authorization: 'Bearer t', host: 'evil.test' });
    assert.strictEqual(res.status, 403);
  } finally { await server.close(); }
});
