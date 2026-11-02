/**
 * html-freeze.js — embeds the network resources of an HTML source into the
 * stored copy (ADR-0013, decision 7), so it works offline for good.
 *
 * Resources: <script src>, <link rel=stylesheet>, <img src>, and what a
 * stylesheet (or inline <style>) loads: url(...) fonts/images and @import.
 * <a href> links are never touched. A resource that cannot be fetched keeps
 * its original tag and is reported in `unfrozen` with a machine reason:
 * no-internet | timeout | http-<status> | too-large | blocked-local-address.
 *
 * Inlined scripts lose async/defer (they run in place, in document order).
 * SSRF guard: loopback/private/link-local addresses are never fetched —
 * literal IPs, resolved DNS results and every redirect hop are checked.
 *
 * parse5 is ESM-only, so it is imported lazily (same reason as html-source.js).
 */
const dns = require('dns');
const net = require('net');

const MAX_REDIRECTS = 5;
const MAX_CSS_DEPTH = 4;
const CONCURRENCY = 6;

let parse5Promise;
function loadParse5() {
  if (!parse5Promise) parse5Promise = import('parse5');
  return parse5Promise;
}

class FreezeError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// SSRF guard

function isBlockedIPv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 127 || a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254);
}

function isBlockedIPv6(ip) {
  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIPv4(mapped[1]);
  // ::ffff:7f00:1 style (hex form of a mapped IPv4)
  const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isBlockedIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (lower === '::' || lower === '::1') return true;
  const first = parseInt(lower.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 // fc00::/7
    || (first & 0xffc0) === 0xfe80; // fe80::/10
}

function isBlockedAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIPv4(ip);
  if (family === 6) return isBlockedIPv6(ip);
  return true; // not an address we can reason about
}

async function assertPublicHost(hostname, lookupFn) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new FreezeError('blocked-local-address');
    return;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) throw new FreezeError('blocked-local-address');
  let addresses;
  try {
    addresses = await lookupFn(host, { all: true });
  } catch (err) {
    throw new FreezeError('no-internet');
  }
  const list = Array.isArray(addresses) ? addresses : [addresses];
  if (list.length === 0) throw new FreezeError('no-internet');
  if (list.some((a) => isBlockedAddress(a.address))) throw new FreezeError('blocked-local-address');
}

// ---------------------------------------------------------------------------
// Fetching

// Resolves a reference found in the page/stylesheet to an absolute http(s)
// URL, or null when it is not a network resource we handle.
function resolveUrl(raw, base) {
  const ref = (raw || '').trim();
  if (!ref || ref.startsWith('#')) return null;
  if (/^(data|blob|about|javascript|mailto|cid):/i.test(ref)) return null;
  try {
    let url;
    if (ref.startsWith('//')) url = new URL(`${base ? new URL(base).protocol : 'https:'}${ref}`);
    else if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) url = new URL(ref);
    else if (base) url = new URL(ref, base);
    else return null;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch (_) {
    return null;
  }
}

function classifyFetchError(err) {
  if (err instanceof FreezeError) return err.reason;
  if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) return 'timeout';
  return 'no-internet';
}

function makeDownloader({ fetchFn, lookupFn, maxResourceBytes, maxTotalBytes, timeoutMs }) {
  const cache = new Map();
  let total = 0;

  async function fetchOnce(startUrl) {
    let url = startUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      await assertPublicHost(new URL(url).hostname, lookupFn);
      const res = await fetchFn(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const next = resolveUrl(res.headers.get('location'), url);
        if (!next) throw new FreezeError(`http-${res.status}`);
        url = next;
        continue;
      }
      if (res.status < 200 || res.status >= 300) throw new FreezeError(`http-${res.status}`);
      const declared = Number(res.headers.get('content-length'));
      if (declared > maxResourceBytes) throw new FreezeError('too-large');
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > maxResourceBytes) throw new FreezeError('too-large');
      if (total + buffer.length > maxTotalBytes) throw new FreezeError('too-large');
      total += buffer.length;
      return { buffer, contentType: (res.headers.get('content-type') || '').split(';')[0].trim(), finalUrl: url };
    }
    throw new FreezeError(`http-302`);
  }

  // The whole attempt (DNS, redirects, body) shares one timeout, and a fetchFn
  // that ignores the abort signal is still cut off by the race.
  function download(url) {
    if (!cache.has(url)) {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new FreezeError('timeout')), timeoutMs);
      });
      const attempt = Promise.race([fetchOnce(url), timeout])
        .catch((err) => { throw new FreezeError(classifyFetchError(err)); })
        .finally(() => clearTimeout(timer));
      attempt.catch(() => {}); // avoid unhandled rejection on the cached promise
      cache.set(url, attempt);
    }
    return cache.get(url);
  }
  return download;
}

// ---------------------------------------------------------------------------
// CSS

const FONT_EXT = /\.(woff2?|ttf|otf|eot)(\?|#|$)/i;
const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif', bmp: 'image/bmp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
};

function toDataUri(url, contentType, buffer) {
  const ext = (new URL(url).pathname.match(/\.([a-z0-9]+)$/i) || [])[1];
  const mime = (contentType && contentType !== 'application/octet-stream' && contentType)
    || MIME_BY_EXT[(ext || '').toLowerCase()] || 'application/octet-stream';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

// Replaces every match asynchronously (String.replace cannot await).
async function replaceAsync(str, regex, fn) {
  const matches = [...str.matchAll(regex)];
  const parts = await Promise.all(matches.map((m) => fn(m)));
  let out = '';
  let last = 0;
  matches.forEach((m, i) => {
    out += str.slice(last, m.index) + parts[i];
    last = m.index + m[0].length;
  });
  return out + str.slice(last);
}

const IMPORT_RE = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)|"([^"]*)"|'([^']*)')\s*([^;]*);/gi;
const URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)/gi;

// Inlines @import and url(...) of a stylesheet. `base` is the stylesheet's own
// URL (or the page's baseUrl for an inline <style>).
async function freezeCss(css, base, ctx, depth = 0) {
  let out = css;
  if (depth < MAX_CSS_DEPTH) {
    out = await replaceAsync(out, IMPORT_RE, async (m) => {
      const raw = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
      const media = (m[6] || '').trim();
      const url = resolveUrl(raw, base);
      if (!url) return m[0];
      try {
        const { buffer, finalUrl } = await ctx.download(url);
        const inner = await freezeCss(buffer.toString('utf8'), finalUrl, ctx, depth + 1);
        return media ? `@media ${media} {\n${inner}\n}` : inner;
      } catch (err) {
        ctx.fail(url, 'stylesheet', err.reason);
        return m[0];
      }
    });
  }
  return replaceAsync(out, URL_RE, async (m) => {
    const raw = m[1] ?? m[2] ?? m[3];
    const url = resolveUrl(raw, base);
    if (!url) return m[0];
    const kind = FONT_EXT.test(url) ? 'font' : 'image';
    const quote = m[1] !== undefined ? '"' : m[2] !== undefined ? "'" : '';
    try {
      const { buffer, contentType, finalUrl } = await ctx.download(url);
      return `url(${quote}${toDataUri(finalUrl, contentType, buffer)}${quote})`;
    } catch (err) {
      ctx.fail(url, kind, err.reason);
      // Inlined CSS loses its own base URL, so keep the absolute address.
      return `url(${quote}${url}${quote})`;
    }
  });
}

// ---------------------------------------------------------------------------
// HTML

function serializeAttrs(attrs) {
  return attrs
    .map(({ name, value }) => ` ${name}="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`)
    .join('');
}

function walk(node, visit) {
  visit(node);
  for (const child of node.childNodes || []) walk(child, visit);
  if (node.content) walk(node.content, visit); // <template>
}

async function pool(tasks, limit) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const task = tasks[next];
      next += 1;
      await task();
    }
  });
  await Promise.all(workers);
}

// Libraries such as MathJax and webpack chunk loaders read document.currentScript.src
// to find their sibling files. Once a script is inlined that address is gone, so the
// copy would look for them next to the page. Two tiny scripts around the inlined one
// fake the address for exactly the time it runs.
function withOriginalAddress(url, inlineTag, type) {
  if ((type || '').toLowerCase() === 'module') return inlineTag; // modules have no currentScript
  const u = JSON.stringify(url).replace(/</g, '\\u003c');
  const before = `<script>(function(){var u=${u};try{Object.defineProperty(document,'currentScript',{configurable:true,get:function(){return{src:u,tagName:'SCRIPT',nodeName:'SCRIPT',getAttribute:function(n){return n==='src'?u:null}}}})}catch(e){}})()</script>`;
  const after = "<script>try{delete document.currentScript}catch(e){}</script>";
  return before + inlineTag + after;
}

async function freezeResources(html, options = {}) {
  const {
    fetchFn = fetch,
    baseUrl,
    maxResourceBytes = 5 * 1024 * 1024,
    maxTotalBytes = 25 * 1024 * 1024,
    timeoutMs = 10000,
    lookupFn = (host, opts) => dns.promises.lookup(host, opts),
  } = options;

  const parse5 = await loadParse5();
  const doc = parse5.parse(html, { sourceCodeLocationInfo: true });

  const unfrozen = [];
  const seen = new Set();
  const ctx = {
    download: makeDownloader({ fetchFn, lookupFn, maxResourceBytes, maxTotalBytes, timeoutMs }),
    fail(url, kind, reason) {
      const key = `${kind}|${url}`;
      if (seen.has(key)) return;
      seen.add(key);
      unfrozen.push({ url, kind, reason });
    },
  };

  const attr = (node, name) => (node.attrs.find((a) => a.name === name) || {}).value;
  const edits = []; // { start, end, text }
  // A tag pointing at a loopback/private address is replaced by an inert comment:
  // left in place, the stored snapshot would make the user's browser probe their
  // own network every time the source is opened.
  const blockIfLocal = (err, loc, kind, url) => {
    if (err.reason !== 'blocked-local-address') return;
    edits.push({ start: loc.startOffset, end: loc.endOffset, text: `<!-- syflo-blocked: ${kind} ${url.replace(/--/g, '-%2D')} -->` });
  };
  const tasks = [];

  walk(doc, (node) => {
    const loc = node.sourceCodeLocation;
    if (!node.tagName || !loc) return;

    if (node.tagName === 'script' && attr(node, 'src') !== undefined) {
      const url = resolveUrl(attr(node, 'src'), baseUrl);
      if (!url) return;
      tasks.push(async () => {
        try {
          const { buffer } = await ctx.download(url);
          const code = buffer.toString('utf8').replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
          const keep = node.attrs.filter((a) => !['src', 'integrity', 'crossorigin', 'async', 'defer'].includes(a.name));
          edits.push({ start: loc.startOffset, end: loc.endOffset, text: withOriginalAddress(url, `<script${serializeAttrs(keep)}>${code}</script>`, attr(node, 'type')) });
        } catch (err) {
          ctx.fail(url, 'script', err.reason);
          blockIfLocal(err, loc, 'script', url);
        }
      });
    } else if (node.tagName === 'link' && attr(node, 'href') !== undefined
      && (attr(node, 'rel') || '').toLowerCase().split(/\s+/).includes('stylesheet')) {
      const url = resolveUrl(attr(node, 'href'), baseUrl);
      if (!url) return;
      tasks.push(async () => {
        try {
          const { buffer, finalUrl } = await ctx.download(url);
          const css = (await freezeCss(buffer.toString('utf8'), finalUrl, ctx)).replace(/<\/style/gi, '<\\/style');
          const media = attr(node, 'media');
          const keep = media ? [{ name: 'media', value: media }] : [];
          edits.push({ start: loc.startOffset, end: loc.endOffset, text: `<style${serializeAttrs(keep)}>${css}</style>` });
        } catch (err) {
          ctx.fail(url, 'stylesheet', err.reason);
          blockIfLocal(err, loc, 'stylesheet', url);
        }
      });
    } else if (node.tagName === 'img' && attr(node, 'src') !== undefined) {
      const url = resolveUrl(attr(node, 'src'), baseUrl);
      if (!url) return;
      tasks.push(async () => {
        try {
          const { buffer, contentType, finalUrl } = await ctx.download(url);
          const attrs = node.attrs.map((a) => (a.name === 'src' ? { name: 'src', value: toDataUri(finalUrl, contentType, buffer) } : a));
          edits.push({ start: loc.startOffset, end: loc.endOffset, text: `<img${serializeAttrs(attrs)}>` });
        } catch (err) {
          ctx.fail(url, 'image', err.reason);
          blockIfLocal(err, loc, 'image', url);
        }
      });
    } else if (node.tagName === 'style' && node.childNodes.length && node.childNodes[0].sourceCodeLocation) {
      const textNode = node.childNodes[0];
      const tloc = textNode.sourceCodeLocation;
      tasks.push(async () => {
        const css = await freezeCss(textNode.value, baseUrl, ctx);
        if (css !== textNode.value) edits.push({ start: tloc.startOffset, end: tloc.endOffset, text: css.replace(/<\/style/gi, '<\\/style') });
      });
    }
  });

  await pool(tasks, CONCURRENCY);

  let out = html;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return { html: out, unfrozen };
}

module.exports = { freezeResources, assertPublicHost, resolveUrl, FreezeError };
