/**
 * render-server.js — the loopback channel between the backend process and the
 * Electron main process (ADR-0013, "Web pages").
 *
 * `POST /render {url}` -> 200 {html, finalUrl} | 4xx/5xx {error}. Listens on a
 * random 127.0.0.1 port; every call needs the random bearer token, comes from a
 * loopback peer and carries a loopback Host header (no DNS rebinding). At most
 * MAX_CONCURRENT windows render at once, the rest wait.
 */
const http = require('http');
const crypto = require('crypto');

const MAX_CONCURRENT = 2;
const MAX_BODY_BYTES = 64 * 1024;
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const STATUS_BY_REASON = { 'blocked-local-address': 403, timeout: 504, 'no-internet': 502 };

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

async function startRenderServer({ renderPage, token = crypto.randomBytes(24).toString('hex'), port = 0 }) {
  let active = 0;
  const waiting = [];
  const acquire = () => new Promise((resolve) => {
    if (active < MAX_CONCURRENT) { active += 1; resolve(); } else waiting.push(resolve);
  });
  const release = () => {
    const next = waiting.shift();
    if (next) next(); else active -= 1;
  };

  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!LOOPBACK_PEERS.has(req.socket.remoteAddress)) return send(403, { error: 'forbidden' });
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(req.headers.host || '')) return send(403, { error: 'forbidden' });
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || !safeEqual(auth.slice(7), token)) return send(401, { error: 'unauthorized' });
    if (req.method !== 'POST' || req.url !== '/render') return send(404, { error: 'not-found' });

    let url;
    try {
      ({ url } = await readJson(req));
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('scheme');
    } catch (_) {
      return send(400, { error: 'invalid-url' });
    }
    await acquire();
    try {
      const { html, finalUrl } = await renderPage(url);
      return send(200, { html, finalUrl });
    } catch (err) {
      const reason = (err && err.reason) || 'render-failed';
      return send(STATUS_BY_REASON[reason] || 502, { error: reason });
    } finally {
      release();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    token,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}

module.exports = { startRenderServer };
