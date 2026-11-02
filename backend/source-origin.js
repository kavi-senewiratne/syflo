/**
 * source-origin.js — serves each HTML source on its own origin
 * (src-<id>.localhost:<port>, ADR-0013 decision 4).
 *
 * To the browser that host is a different site than Syflo, so the page gets
 * a real localStorage but no access to Syflo's chats or keys. Only the stored
 * snapshot and the bridge script are served; every other path is a 404, and
 * a request on a source host never falls through to the API or /uploads.
 */
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');

const SOURCE_HOST = /^src-([0-9a-f-]{36})\.localhost(:\d+)?$/i;
const BRIDGE_FILE = path.join(__dirname, 'bridge', 'bridge.js');
const BRIDGE_PLACEHOLDER = '/* bridge pending */';

// The app runs from http://localhost:<port> or http://127.0.0.1:<port>
// (Vite dev server, or the backend origin inside Electron).
const FRAME_ANCESTORS = 'frame-ancestors http://localhost:* http://127.0.0.1:*';

// One token per source per server process.
const tokens = new Map();
function tokenFor(id) {
  if (!tokens.has(id)) tokens.set(id, randomBytes(16).toString('hex'));
  return tokens.get(id);
}

// `sourceUrl` (a URL import's web address) lets the bridge resolve the page's
// relative links against the site they came from; an uploaded file has none.
function injectBridge(html, token, sourceUrl = null) {
  const src = sourceUrl ? ` data-source-url="${String(sourceUrl).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"` : '';
  const tag = `<script src="/__syflo/bridge.js" data-token="${token}"${src}></script>`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  const at = doctype ? doctype[0].length : 0;
  return html.slice(0, at) + tag + html.slice(at);
}

function sourceOrigin(db) {
  const getSource = db.prepare('SELECT html_path, source_url FROM html_sources WHERE id = ?');

  return (req, res, next) => {
    const match = SOURCE_HOST.exec(req.headers.host || '');
    if (!match) return next();
    const id = match[1].toLowerCase();

    res.setHeader('Content-Security-Policy', FRAME_ANCESTORS);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const notFound = () => res.status(404).type('text/plain').send('Not found');

    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound();
    const row = getSource.get(id);
    if (!row) return notFound();

    if (req.path === '/__syflo/bridge.js') {
      let script = BRIDGE_PLACEHOLDER;
      try { script = fs.readFileSync(BRIDGE_FILE, 'utf8'); } catch (_) { /* not written yet */ }
      return res.type('application/javascript; charset=utf-8').send(script);
    }
    if (req.path === '/' || req.path === '/index.html') {
      let html;
      try { html = fs.readFileSync(row.html_path, 'utf8'); } catch (_) { return notFound(); }
      return res.type('text/html; charset=utf-8').send(injectBridge(html, tokenFor(id), row.source_url));
    }
    return notFound();
  };
}

module.exports = { sourceOrigin, tokenFor };
