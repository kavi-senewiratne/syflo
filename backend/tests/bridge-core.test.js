// The in-page bridge (ADR-0013 decisions 2, 9, 10): protocol contract with
// the parent frame. jsdom stands in for the served page; window.parent is a
// postMessage spy.
const fs = require('fs');
const { JSDOM } = require('jsdom');
const { build, OUT } = require('../bridge/build-bridge.js');

const TOKEN = 'tok-123';
const BRIDGE = build();
const windows = [];
afterEach(() => { windows.splice(0).forEach((w) => w.close()); });

async function load(body, { token = TOKEN, extraSetup } = {}) {
  const dom = new JSDOM(`<!doctype html><body>${body}</body>`, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://src-1.localhost:3001/',
  });
  const w = dom.window;
  windows.push(w);
  const posted = [];
  const parent = { postMessage: (msg) => posted.push(msg) };
  Object.defineProperty(w, 'parent', { value: parent, configurable: true });
  if (extraSetup) extraSetup(w);
  const s = w.document.createElement('script');
  if (token) s.setAttribute('data-token', token);
  s.textContent = BRIDGE;
  w.document.body.appendChild(s);
  function send(data, { source = parent } = {}) {
    const ev = new w.MessageEvent('message', { data });
    Object.defineProperty(ev, 'source', { value: source });
    w.dispatchEvent(ev);
  }
  const ofType = (t) => posted.filter((m) => m.type === t);
  await tick(); // the bridge starts on DOMContentLoaded
  return { w, doc: w.document, posted, parent, send, ofType };
}

const PAGE =
  '<h1>Title</h1><p>Alpha beta gamma.</p><h2>Second</h2><p>Delta epsilon zeta.</p>' +
  '<h3>Third</h3><p>Eta theta.</p>';

function select(w, node, from, to) {
  const r = w.document.createRange();
  r.setStart(node, from);
  r.setEnd(node, to);
  const sel = w.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  return r;
}
const tick = () => new Promise((r) => setTimeout(r, 20));

describe('bridge.js build', () => {
  test('the committed bridge.js is up to date with anchor.js + bridge-core.js', async () => {
    expect(fs.readFileSync(OUT, 'utf8')).toBe(build());
  });
});

describe('bridge messages page -> parent', () => {
  test('announces ready and the outline, tagged with the token', async () => {
    const { posted, ofType } = await load(PAGE);
    expect(posted.every((m) => m.source === 'syflo-bridge' && m.token === TOKEN)).toBe(true);
    expect(ofType('ready')).toHaveLength(1);
    expect(ofType('outline')[0].sections).toEqual([
      { level: 1, heading: 'Title' },
      { level: 2, heading: 'Second' },
      { level: 3, heading: 'Third' },
    ]);
  });

  test('a selection carries text and an anchor that resolves back', async () => {
    const { w, doc, ofType } = await load(PAGE);
    const t = doc.querySelectorAll('p')[1].firstChild;
    select(w, t, 6, 13);
    doc.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true }));
    await tick();
    const msg = ofType('selection')[0];
    expect(msg.text).toBe('epsilon');
    expect(msg.anchor.exact).toBe('epsilon');
    expect(msg.rect).toEqual(expect.objectContaining({ top: expect.any(Number), left: expect.any(Number) }));
    expect(w.SyfloAnchor.resolveAnchor(doc.body, msg.anchor).toString()).toBe('epsilon');
  });

  test('a selection names the section it sits in, not the one in view', async () => {
    const { w, doc, ofType } = await load(PAGE);
    const t = doc.querySelectorAll('p')[1].firstChild; // "Delta epsilon zeta." under <h2>Second</h2>
    select(w, t, 6, 13);
    doc.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true }));
    await tick();
    expect(ofType('selection')[0].section).toBe('Second');
  });

  test('reports selection-cleared once the selection collapses', async () => {
    const { w, doc, ofType } = await load(PAGE);
    select(w, doc.querySelectorAll('p')[0].firstChild, 0, 5);
    doc.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true }));
    await tick();
    w.getSelection().removeAllRanges();
    doc.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true }));
    await tick();
    expect(ofType('selection-cleared')).toHaveLength(1);
  });

  test('reports the current section when it changes', async () => {
    const { w, doc, ofType } = await load(PAGE);
    const hs = doc.querySelectorAll('h1,h2,h3');
    const tops = [-500, 30, 900];
    hs.forEach((h, i) => { h.getBoundingClientRect = () => ({ top: tops[i], left: 0, right: 0, bottom: 0, width: 0, height: 0 }); });
    w.dispatchEvent(new w.Event('scroll'));
    await new Promise((r) => setTimeout(r, 250));
    const last = ofType('section').pop();
    expect(last).toEqual(expect.objectContaining({ heading: 'Second', index: 1 }));
  });
});

describe('bridge commands parent -> page', () => {
  test('rejects commands without a token, with a wrong token, or from another window', async () => {
    const { doc, send } = await load(PAGE);
    const cmd = { type: 'set-highlights', highlights: [{ id: 'h1', color: 'yellow', anchor: { exact: 'beta', prefix: 'Alpha ', suffix: ' gamma.' } }] };
    send({ ...cmd });
    send({ ...cmd, token: 'wrong' });
    send({ ...cmd, token: TOKEN }, { source: { postMessage() {} } });
    expect(doc.querySelectorAll('mark[data-syflo-hl]')).toHaveLength(0);
    send({ ...cmd, token: TOKEN });
    expect(doc.querySelectorAll('mark[data-syflo-hl]')).toHaveLength(1);
  });

  test('a script without a data-token accepts no command', async () => {
    const { doc, send } = await load(PAGE, { token: null });
    send({ type: 'set-highlights', token: '', highlights: [{ id: 'h1', color: 'green', anchor: { exact: 'beta', prefix: '', suffix: '' } }] });
    expect(doc.querySelectorAll('mark[data-syflo-hl]')).toHaveLength(0);
  });

  test('set-highlights repaints everything with fixed color literals and reports what resolved', async () => {
    const { doc, send, ofType } = await load(PAGE);
    const a = (exact, prefix, suffix) => ({ exact, prefix, suffix });
    send({ type: 'set-highlights', token: TOKEN, highlights: [
      { id: 'h1', color: 'yellow', anchor: a('beta', 'Alpha ', ' gamma.') },
      { id: 'h2', color: 'pink', anchor: a('epsilon', 'Delta ', ' zeta.') },
      { id: 'h3', color: 'blue', anchor: a('nowhere', '', '') },
    ] });
    const marks = [...doc.querySelectorAll('mark[data-syflo-hl]')];
    expect(marks.map((m) => [m.dataset.syfloHl, m.dataset.color, m.textContent])).toEqual([
      ['h1', 'yellow', 'beta'], ['h2', 'pink', 'epsilon'],
    ]);
    expect(doc.getElementById('syflo-bridge-style').textContent).toMatch(/#[0-9a-fA-F]{6}|rgba\(/);
    expect(ofType('highlights-painted').pop()).toEqual(expect.objectContaining({ resolved: ['h1', 'h2'], missing: ['h3'] }));
    // repaint replaces, never stacks
    send({ type: 'set-highlights', token: TOKEN, highlights: [{ id: 'h2', color: 'green', anchor: a('epsilon', 'Delta ', ' zeta.') }] });
    expect(doc.querySelectorAll('mark[data-syflo-hl]')).toHaveLength(1);
    expect(doc.body.textContent).toContain('Delta epsilon zeta.');
    send({ type: 'set-highlights', token: TOKEN, highlights: [] });
    expect(doc.querySelectorAll('mark[data-syflo-hl]')).toHaveLength(0);
  });

  test('highlights do not break formula tokens', async () => {
    const { doc, send } = await load('<p>Energy <mjx-container><svg><text>E</text></svg></mjx-container><script type="math/tex">E=mc^2</script> is kept.</p>');
    send({ type: 'set-highlights', token: TOKEN, highlights: [
      { id: 'h1', color: 'orange', anchor: { exact: 'Energy E=mc^2 is', prefix: '', suffix: ' kept.' } },
    ] });
    const mjx = doc.querySelector('mjx-container');
    expect(mjx.querySelector('mark')).toBeNull();
    expect(mjx.querySelector('svg text').textContent).toBe('E');
    expect(mjx.hasAttribute('data-syflo-hl-atom')).toBe(true);
  });

  test('clicking a painted highlight reports its id and rect', async () => {
    const { w, doc, send, ofType } = await load(PAGE);
    send({ type: 'set-highlights', token: TOKEN, highlights: [
      { id: 'h1', color: 'yellow', anchor: { exact: 'beta', prefix: 'Alpha ', suffix: ' gamma.' } },
    ] });
    doc.querySelector('mark').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    expect(ofType('highlight-click')[0]).toEqual(expect.objectContaining({ id: 'h1', rect: expect.any(Object) }));
  });

  test('re-resolves highlights after late DOM changes (MathJax typesetting)', async () => {
    const { doc, send } = await load(PAGE);
    send({ type: 'set-highlights', token: TOKEN, highlights: [
      { id: 'h1', color: 'yellow', anchor: { exact: 'late words', prefix: '', suffix: '' } },
    ] });
    expect(doc.querySelectorAll('mark')).toHaveLength(0);
    const p = doc.createElement('p');
    p.textContent = 'some late words arrive';
    doc.body.appendChild(p);
    await new Promise((r) => setTimeout(r, 500));
    expect(doc.querySelector('mark').textContent).toBe('late words');
  });

  test('paints with the CSS Custom Highlight API when available', async () => {
    const store = new Map();
    const { doc, send } = await load(PAGE, { extraSetup: (w) => {
      w.Highlight = class { constructor(...r) { this.ranges = r; } };
      w.CSS = { highlights: store };
    } });
    send({ type: 'set-highlights', token: TOKEN, highlights: [
      { id: 'h1', color: 'yellow', anchor: { exact: 'beta', prefix: 'Alpha ', suffix: ' gamma.' } },
    ] });
    expect(doc.querySelectorAll('mark')).toHaveLength(0);
    expect([...store.keys()]).toEqual(['syflo-hl-yellow']);
    expect(store.get('syflo-hl-yellow').ranges[0].toString()).toBe('beta');
  });

  test('scroll-to-section scrolls the heading with that index', async () => {
    const { doc, send } = await load(PAGE);
    const spy = jest.fn();
    doc.querySelectorAll('h1,h2,h3').forEach((h) => { h.scrollIntoView = () => spy(h.textContent); });
    send({ type: 'scroll-to-section', token: TOKEN, index: 2 });
    expect(spy).toHaveBeenCalledWith('Third');
  });

  test('scroll-to-anchor scrolls to the quote and flashes it; a missing quote is reported', async () => {
    const { doc, send, ofType } = await load(PAGE);
    const spy = jest.fn();
    doc.querySelectorAll('p').forEach((p) => { p.scrollIntoView = () => spy(p.textContent); });
    send({ type: 'scroll-to-anchor', token: TOKEN, anchor: { exact: 'theta', prefix: 'Eta ', suffix: '.' } });
    expect(spy).toHaveBeenCalledWith('Eta theta.');
    expect(doc.querySelector('mark[data-syflo-flash]').textContent).toBe('theta');
    send({ type: 'scroll-to-anchor', token: TOKEN, anchor: { exact: 'gone', prefix: '', suffix: '' } });
    expect(ofType('anchor-not-found')).toHaveLength(1);
  });

  test('clear-selection empties the page selection', async () => {
    const { w, doc, send } = await load(PAGE);
    select(w, doc.querySelector('p').firstChild, 0, 5);
    send({ type: 'clear-selection', token: TOKEN });
    expect(w.getSelection().isCollapsed).toBe(true);
  });

  test('hello re-announces ready and outline for a late-attached parent', async () => {
    const { send, ofType } = await load(PAGE);
    send({ type: 'hello', token: TOKEN });
    expect(ofType('ready')).toHaveLength(2);
    expect(ofType('outline')).toHaveLength(2);
  });
});

// Links (ADR-0013 decision 3: the snapshot is ONE page). A click on a link to
// another page must never navigate the frame; it is reported as open-link.
describe('links in the page', () => {
  const LINKS =
    '<a id="ext" href="https://www.youtube.com/watch?v=x">video</a>' +
    '<a id="rel" href="pend.html">next</a>' +
    '<a id="hash" href="#sec">jump</a>' +
    '<a id="js" href="javascript:void(0)">quiz</a>' +
    '<a id="mail" href="mailto:russ@mit.edu"><span id="inner">mail</span></a>';

  function click(w, el) {
    const ev = new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  }

  test('an absolute link is blocked and handed to the parent as open-link', async () => {
    const { w, doc, ofType } = await load(LINKS);
    expect(click(w, doc.getElementById('ext'))).toBe(true);
    expect(ofType('open-link')).toEqual([expect.objectContaining({ url: 'https://www.youtube.com/watch?v=x' })]);
  });

  test('a click inside a link (child element) counts as the link', async () => {
    const { w, doc, ofType } = await load(LINKS);
    expect(click(w, doc.getElementById('inner'))).toBe(true);
    expect(ofType('open-link')).toEqual([expect.objectContaining({ url: 'mailto:russ@mit.edu' })]);
  });

  test('in-page anchors and javascript: links stay the page\'s own business', async () => {
    const { w, doc, ofType } = await load(LINKS);
    expect(click(w, doc.getElementById('hash'))).toBe(false);
    expect(click(w, doc.getElementById('js'))).toBe(false);
    expect(ofType('open-link')).toHaveLength(0);
  });

  test('a relative link of an uploaded file (no source address) is blocked and goes nowhere', async () => {
    const { w, doc, ofType } = await load(LINKS);
    expect(click(w, doc.getElementById('rel'))).toBe(true);
    expect(ofType('open-link')).toHaveLength(0);
  });

  test('a relative link of a URL import resolves against the page\'s web address', async () => {
    const dom = new JSDOM(`<!doctype html><body>${LINKS}</body>`, {
      runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://src-1.localhost:3001/',
    });
    const w = dom.window;
    windows.push(w);
    const posted = [];
    Object.defineProperty(w, 'parent', { value: { postMessage: (m) => posted.push(m) }, configurable: true });
    const s = w.document.createElement('script');
    s.setAttribute('data-token', TOKEN);
    s.setAttribute('data-source-url', 'https://underactuated.mit.edu/intro.html');
    s.textContent = BRIDGE;
    w.document.body.appendChild(s);
    await tick();
    expect(click(w, w.document.getElementById('rel'))).toBe(true);
    expect(posted.filter((m) => m.type === 'open-link')).toEqual([
      expect.objectContaining({ url: 'https://underactuated.mit.edu/pend.html' }),
    ]);
  });
});

