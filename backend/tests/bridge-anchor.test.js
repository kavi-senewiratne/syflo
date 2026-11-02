// Quote anchors for HTML sources (ADR-0013 decision 5).
const { JSDOM } = require('jsdom');
const A = require('../bridge/anchor.js');

function page(html) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  return dom.window.document;
}
function rangeOver(doc, node, from, to) {
  const r = doc.createRange();
  r.setStart(node, from);
  r.setEnd(node, to);
  return r;
}

describe('bridge anchor', () => {
  test('anchors a plain paragraph selection and resolves it back', () => {
    const doc = page('<p>Alpha beta gamma delta.</p>');
    const t = doc.querySelector('p').firstChild;
    const anchor = A.createAnchor(rangeOver(doc, t, 6, 16));
    expect(anchor.exact).toBe('beta gamma');
    expect(anchor.prefix).toBe('Alpha ');
    expect(anchor.suffix).toBe(' delta.');
    const r = A.resolveAnchor(doc.body, anchor);
    expect(r.toString()).toBe('beta gamma');
  });

  test('duplicate text is disambiguated by context', () => {
    const doc = page('<p>first: the cat sat down.</p><p>second: the cat ran away.</p>');
    const t = doc.querySelectorAll('p')[1].firstChild;
    const start = t.data.indexOf('the cat');
    const anchor = A.createAnchor(rangeOver(doc, t, start, start + 7));
    const r = A.resolveAnchor(doc.body, anchor);
    expect(r.startContainer).toBe(t);
    expect(r.startOffset).toBe(start);
  });

  test('a formula is one atomic token carrying its TeX', () => {
    const doc = page(
      '<p>Energy <mjx-container><svg><text>E</text></svg></mjx-container>' +
        '<script type="math/tex">E=mc^2</script> is conserved.</p>');
    expect(A.textModel(doc.body).text).toBe('Energy E=mc^2 is conserved.');
    const p = doc.querySelector('p');
    const r0 = doc.createRange();
    r0.setStart(p.firstChild, 0);
    r0.setEnd(p.lastChild, 3);
    const anchor = A.createAnchor(r0);
    expect(anchor.exact).toBe('Energy E=mc^2 is');
    const back = A.resolveAnchor(doc.body, anchor);
    expect(back.startContainer).toBe(p.firstChild);
    expect(back.endContainer).toBe(p.lastChild);
    // a selection that ends inside the formula snaps to the whole token
    const mjx = doc.querySelector('mjx-container');
    const r1 = doc.createRange();
    r1.setStart(p.firstChild, 7);
    r1.setEnd(mjx.querySelector('text'), 0);
    expect(A.createAnchor(r1).exact).toBe('E=mc^2');
    const aria = page('<p>x <mjx-container aria-label="a^2+b^2">a2</mjx-container> y</p>');
    expect(A.textModel(aria.body).text).toBe('x a^2+b^2 y');
  });

  test('anchor still resolves after nodes are inserted before it', () => {
    const doc = page('<p>Intro.</p><p>The quick brown fox jumps.</p>');
    const t = doc.querySelectorAll('p')[1].firstChild;
    const anchor = A.createAnchor(rangeOver(doc, t, 10, 19));
    const banner = doc.createElement('div');
    banner.innerHTML = '<h2>New</h2><p>Lots of inserted text.</p>';
    doc.body.insertBefore(banner, doc.body.firstChild);
    expect(A.resolveAnchor(doc.body, anchor).toString()).toBe('brown fox');
  });

  test('tolerates whitespace differences', () => {
    const doc = page('<p>The   quick\n brown   fox</p>');
    const r = A.resolveAnchor(doc.body, { exact: 'quick brown fox', prefix: 'The ', suffix: '' });
    expect(r.toString().replace(/\s+/g, ' ')).toBe('quick brown fox');
  });

  test('returns null when the text is gone', () => {
    const doc = page('<p>Something else entirely.</p>');
    expect(A.resolveAnchor(doc.body, { exact: 'brown fox', prefix: 'x', suffix: 'y' })).toBeNull();
  });

  test('script, style, noscript and canvas text is ignored', () => {
    const doc = page('<p>Visible</p><script>var secret = 1;</script><style>.a{}</style>' +
      '<noscript>nojs</noscript><canvas>fallback</canvas><p>text</p>');
    expect(A.textModel(doc.body).text).toBe('Visible text');
  });
});
