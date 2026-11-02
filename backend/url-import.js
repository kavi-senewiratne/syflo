/**
 * url-import.js — gets the HTML of a web page for the URL import (ADR-0013,
 * "Web pages").
 *
 * Preferred path: ask the Electron main process to render the page (many pages
 * build their content with JavaScript). It listens on a loopback port; the
 * address and bearer token arrive as SYFLO_RENDER_URL / SYFLO_RENDER_TOKEN, or
 * — when this backend was started before Electron — in
 * <data dir>/render-channel.json. Fallback (browser dev mode, renderer down):
 * a raw fetch with manual redirects, every hop guarded against SSRF.
 *
 * All collaborators are injectable: renderFn, fetchFn (raw fetch), channelFetchFn
 * (the call to the renderer), lookupFn, env, channelFile.
 */
const dns = require('dns');
const fs = require('fs');
const { assertPublicHost, resolveUrl } = require('./html-freeze');

const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10000;
const RENDER_TIMEOUT_MS = 35000; // the renderer's own limit is 25 s
const USER_AGENT = 'Mozilla/5.0 (compatible; Syflo)';

class UrlImportError extends Error {
  constructor(status, error) {
    super(error);
    this.status = status;
    this.error = error;
  }
}

// http/https only; anything else (or garbage) is a 400.
function parseWebUrl(raw) {
  try {
    const url = new URL(String(raw || '').trim());
    if (url.protocol === 'http:' || url.protocol === 'https:') return url;
  } catch (_) { /* fall through */ }
  throw new UrlImportError(400, 'invalid-url');
}

function readChannel({ env, channelFile }) {
  if (env.SYFLO_RENDER_URL && env.SYFLO_RENDER_TOKEN) return { url: env.SYFLO_RENDER_URL, token: env.SYFLO_RENDER_TOKEN };
  if (!channelFile) return null;
  try {
    const { url, token } = JSON.parse(fs.readFileSync(channelFile, 'utf8'));
    return url && token ? { url, token } : null;
  } catch (_) {
    return null;
  }
}

// Marker for "the renderer could not be reached" (=> use the raw fetch).
class RendererUnreachable extends Error {}

function createHttpRenderFn({ channel, fetchFn }) {
  return async (url) => {
    let res;
    try {
      res = await fetchFn(`${channel.url}/render`, {
        method: 'POST',
        headers: { authorization: `Bearer ${channel.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
      });
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw new UrlImportError(504, 'timeout');
      throw new RendererUnreachable(err && err.message);
    }
    const body = await res.json().catch(() => ({}));
    if (res.status === 200) return { html: body.html, finalUrl: body.finalUrl || url };
    if (res.status === 401 || res.status === 403 && body.error !== 'blocked-local-address') throw new RendererUnreachable(`renderer refused (${res.status})`);
    if (body.error === 'blocked-local-address') throw new UrlImportError(400, 'blocked-local-address');
    if (res.status === 504) throw new UrlImportError(504, 'timeout');
    throw new UrlImportError(502, body.error || 'render-failed');
  };
}

function createRawFetchFn({ fetchFn, lookupFn }) {
  return async (startUrl) => {
    let url = startUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      try {
        await assertPublicHost(new URL(url).hostname, lookupFn);
      } catch (err) {
        throw new UrlImportError(err.reason === 'blocked-local-address' ? 400 : 502, err.reason || 'no-internet');
      }
      let res;
      try {
        res = await fetchFn(url, {
          redirect: 'manual',
          headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch (err) {
        if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw new UrlImportError(504, 'timeout');
        throw new UrlImportError(502, 'no-internet');
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const next = resolveUrl(res.headers.get('location'), url);
        if (!next) throw new UrlImportError(502, `http-${res.status}`);
        url = next;
        continue;
      }
      if (res.status < 200 || res.status >= 300) throw new UrlImportError(502, `http-${res.status}`);
      const type = (res.headers.get('content-type') || '').toLowerCase();
      if (type && !/html|xml/.test(type)) throw new UrlImportError(415, 'not-html');
      if (Number(res.headers.get('content-length')) > MAX_HTML_BYTES) throw new UrlImportError(413, 'too-large');
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > MAX_HTML_BYTES) throw new UrlImportError(413, 'too-large');
      return { html: buffer.toString('utf8'), finalUrl: url };
    }
    throw new UrlImportError(502, 'too-many-redirects');
  };
}

// Returns async (rawUrl) => { html, finalUrl, url }.
function createUrlImporter({
  renderFn, fetchFn = fetch, channelFetchFn = fetch, lookupFn = (host, opts) => dns.promises.lookup(host, opts), env = process.env, channelFile = null,
} = {}) {
  const rawFetch = createRawFetchFn({ fetchFn, lookupFn });
  return async function fetchPage(rawUrl) {
    const url = parseWebUrl(rawUrl);
    try {
      await assertPublicHost(url.hostname, lookupFn);
    } catch (err) {
      throw new UrlImportError(err.reason === 'blocked-local-address' ? 400 : 502, err.reason || 'no-internet');
    }
    const channel = renderFn ? null : readChannel({ env, channelFile });
    const render = renderFn || (channel && createHttpRenderFn({ channel, fetchFn: channelFetchFn }));
    if (render) {
      try {
        return { ...(await render(url.href)), url: url.href, rendered: true };
      } catch (err) {
        if (!(err instanceof RendererUnreachable)) throw err;
      }
    }
    return { ...(await rawFetch(url.href)), url: url.href };
  };
}

module.exports = { createUrlImporter, UrlImportError };
