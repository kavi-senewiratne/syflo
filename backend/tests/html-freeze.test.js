/**
 * tests/html-freeze.test.js
 *
 * Freezing network resources into an HTML source (ADR-0013, decision 7).
 * Pure module: fetchFn and lookupFn are injected, nothing touches the network.
 */
const { freezeResources } = require('../html-freeze');
const { extractSections } = require('../html-source');

// Builds a fetchFn from a { url: Response | (() => Response) | Error } table
// and records every requested URL.
function fakeNet(table) {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    const entry = table[url];
    if (entry === undefined) return new Response('not found', { status: 404 });
    if (entry instanceof Error) throw entry;
    return typeof entry === 'function' ? entry() : entry.clone();
  };
  return { fetchFn, calls };
}
const text = (body, type = 'text/plain', status = 200) => new Response(body, { status, headers: { 'content-type': type } });
const bytes = (buf, type) => new Response(buf, { status: 200, headers: { 'content-type': type } });
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const netError = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

const run = (html, table, opts = {}) => {
  const net = fakeNet(table);
  return freezeResources(html, { fetchFn: net.fetchFn, lookupFn: publicLookup, ...opts }).then((r) => ({ ...r, calls: net.calls }));
};

describe('freezeResources — inlining', () => {
  it('inlines a script as an inline <script> and drops src', async () => {
    const { html, unfrozen } = await run(
      '<html><head><script src="https://cdn.test/a.js" async></script></head><body>x</body></html>',
      { 'https://cdn.test/a.js': text('window.a = 1;', 'text/javascript') },
    );
    expect(unfrozen).toEqual([]);
    expect(html).toContain('<script>window.a = 1;</script>');
    expect(html).not.toMatch(/<script[^>]*\ssrc=/); // no network tag left (the URL may live in the shim)
  });

  it('escapes </script> inside the inlined code', async () => {
    const { html } = await run(
      '<script src="https://cdn.test/a.js"></script>',
      { 'https://cdn.test/a.js': text('var s = "</script><b>";', 'text/javascript') },
    );
    expect(html).not.toMatch(/<\/script><b>/);
    expect(html).toContain('<\\/script>');
  });

  it('keeps type=module on an inlined script', async () => {
    const { html } = await run(
      '<script type="module" src="https://cdn.test/m.js"></script>',
      { 'https://cdn.test/m.js': text('export {}', 'text/javascript') },
    );
    expect(html).toContain('<script type="module">export {}</script>');
  });

  it('inlines a stylesheet as <style> and its fonts and images as data: URIs', async () => {
    const css = '@font-face { src: url("fonts/f.woff2") } .a { background: url(/img/bg.png) }';
    const { html, unfrozen } = await run(
      '<link rel="stylesheet" href="https://cdn.test/css/site.css" media="print">',
      {
        'https://cdn.test/css/site.css': text(css, 'text/css'),
        'https://cdn.test/css/fonts/f.woff2': bytes(Buffer.from('FONT'), 'font/woff2'),
        'https://cdn.test/img/bg.png': bytes(Buffer.from('PNG'), 'image/png'),
      },
    );
    expect(unfrozen).toEqual([]);
    expect(html).toMatch(/^<style media="print">/);
    expect(html).toContain(`url("data:font/woff2;base64,${Buffer.from('FONT').toString('base64')}")`);
    expect(html).toContain(`data:image/png;base64,${Buffer.from('PNG').toString('base64')}`);
    expect(html).not.toContain('<link');
  });

  it('inlines @import recursively, resolved against the stylesheet URL', async () => {
    const { html } = await run(
      '<link rel=stylesheet href="https://cdn.test/a/main.css">',
      {
        'https://cdn.test/a/main.css': text('@import "part.css"; .m{}', 'text/css'),
        'https://cdn.test/a/part.css': text('.part{color:red}', 'text/css'),
      },
    );
    expect(html).toContain('.part{color:red}');
    expect(html).not.toContain('@import');
  });

  it('inlines an image as a data: URI and keeps its other attributes', async () => {
    const { html } = await run(
      '<img alt="fig" src="//cdn.test/p.png" width="10">',
      { 'https://cdn.test/p.png': bytes(Buffer.from('PNG'), 'image/png') },
    );
    expect(html).toContain('alt="fig"');
    expect(html).toContain('width="10"');
    expect(html).toContain('src="data:image/png;base64,');
  });

  it('never touches <a href> links, data: URIs or relative URLs without a baseUrl', async () => {
    const src = '<a href="https://example.com/x.js">l</a><img src="data:image/png;base64,AAAA"><img src="local.png"><script src="rel.js"></script>';
    const { html, calls, unfrozen } = await run(src, {});
    expect(html).toBe(src);
    expect(calls).toEqual([]);
    expect(unfrozen).toEqual([]);
  });

  it('resolves relative URLs against baseUrl', async () => {
    const { html } = await run(
      '<script src="js/a.js"></script>',
      { 'https://site.test/lec/js/a.js': text('1;', 'text/javascript') },
      { baseUrl: 'https://site.test/lec/index.html' },
    );
    expect(html).toContain('<script>1;</script>');
  });

  it('is idempotent: freezing frozen html fetches nothing', async () => {
    const first = await run('<script src="https://cdn.test/a.js"></script>', { 'https://cdn.test/a.js': text('1;') });
    const second = await run(first.html, {});
    expect(second.calls).toEqual([]);
    expect(second.html).toBe(first.html);
  });

  it('keeps the outline of frozen html intact', async () => {
    const { html } = await run(
      '<html><head><title>T</title><script src="https://cdn.test/a.js"></script></head><body><h1>Intro</h1><p>Hello</p></body></html>',
      { 'https://cdn.test/a.js': text('var hidden = "not text";') },
    );
    const { text: body, sections } = await extractSections(html);
    expect(body).toBe('Intro\nHello');
    expect(sections[0].heading).toBe('Intro');
  });
});

describe('freezeResources — failures keep the tag and name the reason', () => {
  const tag = '<script src="https://cdn.test/a.js"></script>';

  it('http-<status>', async () => {
    const { html, unfrozen } = await run(tag, { 'https://cdn.test/a.js': text('x', 'text/plain', 404) });
    expect(html).toBe(tag);
    expect(unfrozen).toEqual([{ url: 'https://cdn.test/a.js', kind: 'script', reason: 'http-404' }]);
  });

  it.each(['ENOTFOUND', 'ECONNREFUSED', 'ENETUNREACH'])('no-internet on %s', async (code) => {
    const { unfrozen } = await run(tag, { 'https://cdn.test/a.js': netError(code) });
    expect(unfrozen[0].reason).toBe('no-internet');
  });

  it('no-internet when DNS lookup fails', async () => {
    const lookupFn = async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); };
    const { unfrozen } = await run(tag, {}, { lookupFn });
    expect(unfrozen[0].reason).toBe('no-internet');
  });

  it('timeout', async () => {
    const { html, unfrozen } = await run(tag, { 'https://cdn.test/a.js': () => new Promise(() => {}) }, { timeoutMs: 30 });
    expect(html).toBe(tag);
    expect(unfrozen[0].reason).toBe('timeout');
  });

  it('too-large per resource', async () => {
    const { unfrozen } = await run(tag, { 'https://cdn.test/a.js': text('x'.repeat(100)) }, { maxResourceBytes: 50 });
    expect(unfrozen[0].reason).toBe('too-large');
  });

  it('too-large when the total budget is used up', async () => {
    const src = '<script src="https://cdn.test/a.js"></script><script src="https://cdn.test/b.js"></script>';
    const { unfrozen } = await run(
      src,
      { 'https://cdn.test/a.js': text('x'.repeat(60)), 'https://cdn.test/b.js': text('y'.repeat(60)) },
      { maxTotalBytes: 100 },
    );
    expect(unfrozen).toHaveLength(1);
    expect(unfrozen[0].reason).toBe('too-large');
  });

  it('reports a failing font inside a stylesheet and keeps an absolute URL there', async () => {
    const { html, unfrozen } = await run(
      '<link rel=stylesheet href="https://cdn.test/s.css">',
      { 'https://cdn.test/s.css': text('@font-face{src:url(f.woff2)}', 'text/css'), 'https://cdn.test/f.woff2': text('', 'text/plain', 500) },
    );
    expect(unfrozen).toEqual([{ url: 'https://cdn.test/f.woff2', kind: 'font', reason: 'http-500' }]);
    expect(html).toContain('<style>');
    expect(html).toContain('url(https://cdn.test/f.woff2)');
  });
});

describe('freezeResources — scripts that look up their own address', () => {
  // MathJax, webpack chunk loaders and the like read document.currentScript.src to
  // find their siblings. Inlined, that address is gone unless the freezer keeps it.
  it('an inlined script still sees its original document.currentScript.src while it runs', async () => {
    const { JSDOM } = require('jsdom');
    const url = 'https://cdn.test/lib/tex-svg.js';
    const { html } = await run(
      `<html><head><script src="${url}"></script></head><body></body></html>`,
      { [url]: text('window.seen = document.currentScript && document.currentScript.src;', 'text/javascript') },
    );

    const dom = new JSDOM(html, { runScripts: 'dangerously' });

    expect(dom.window.seen).toBe(url);
  });

  it('the address is only faked during the inlined script, not afterwards', async () => {
    const { JSDOM } = require('jsdom');
    const url = 'https://cdn.test/lib/a.js';
    const { html } = await run(
      `<html><head><script src="${url}"></script><script>window.after = document.currentScript && document.currentScript.src;</script></head><body></body></html>`,
      { [url]: text('window.a = 1;', 'text/javascript') },
    );

    const dom = new JSDOM(html, { runScripts: 'dangerously' });

    expect(dom.window.after).not.toBe(url);
  });
});

describe('freezeResources — SSRF guard', () => {
  it.each([
    'http://127.0.0.1/a.js', 'http://10.1.2.3/a.js', 'http://172.16.0.1/a.js', 'http://172.31.255.255/a.js',
    'http://192.168.1.1/a.js', 'http://169.254.169.254/a.js', 'http://0.0.0.0/a.js', 'http://[::1]/a.js',
    'http://[fc00::1]/a.js', 'http://[fe80::1]/a.js', 'http://[::ffff:127.0.0.1]/a.js',
    'http://localhost/a.js', 'http://app.localhost:3000/a.js',
  ])('blocks %s without fetching', async (url) => {
    const tag = `<script src="${url}"></script>`;
    const { html, unfrozen, calls } = await run(tag, {});
    expect(calls).toEqual([]);
    // Neutralized: the stored snapshot must not probe the user's LAN on every open.
    expect(html).toMatch(/^<!-- syflo-blocked: script /);
    expect(html).not.toContain('<script');
    expect(unfrozen[0].reason).toBe('blocked-local-address');
  });

  it('blocks a public hostname that resolves to a private address', async () => {
    const lookupFn = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }];
    const { unfrozen, calls } = await run('<script src="https://evil.test/a.js"></script>', {}, { lookupFn });
    expect(calls).toEqual([]);
    expect(unfrozen[0].reason).toBe('blocked-local-address');
  });

  it('blocks a redirect to a private address (every hop is re-checked)', async () => {
    const redirect = new Response(null, { status: 302, headers: { location: 'http://192.168.0.10/secret.js' } });
    const { unfrozen, calls } = await run('<script src="https://cdn.test/a.js"></script>', { 'https://cdn.test/a.js': redirect });
    expect(calls).toEqual(['https://cdn.test/a.js']);
    expect(unfrozen[0].reason).toBe('blocked-local-address');
  });

  it('follows a public redirect', async () => {
    const redirect = new Response(null, { status: 301, headers: { location: '/moved.js' } });
    const { html, calls } = await run('<script src="https://cdn.test/a.js"></script>', {
      'https://cdn.test/a.js': redirect,
      'https://cdn.test/moved.js': text('moved();'),
    });
    expect(calls).toEqual(['https://cdn.test/a.js', 'https://cdn.test/moved.js']);
    expect(html).toContain('<script>moved();</script>');
  });

  it('gives up after 5 redirects', async () => {
    const hop = () => new Response(null, { status: 302, headers: { location: 'https://cdn.test/a.js' } });
    const { unfrozen } = await run('<script src="https://cdn.test/a.js"></script>', { 'https://cdn.test/a.js': hop });
    expect(unfrozen[0].reason).toBe('http-302');
  });
});
