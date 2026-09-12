// Recording framework for Syflo article GIFs (2026-09-10 retake, Mushroom Kingdom).
// Usage per scene: const { record } = require('./lib'); record('01-branching', async (p, h) => {...})
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SP = process.env.SP || path.resolve(__dirname, '..');
const VIDS = path.join(SP, 'vids');
const GIFS = path.join(SP, 'gifs');
const APP = 'http://localhost:3002/';
const VIEW = { width: 1100, height: 688 };

fs.mkdirSync(VIDS, { recursive: true });
fs.mkdirSync(GIFS, { recursive: true });

const CURSOR_JS = `
(() => {
  if (window.__fakeCursor) return;
  const c = document.createElement('div');
  c.id = '__cursor';
  c.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;width:22px;height:22px;left:0;top:0;transform:translate(-3px,-3px);transition:none;';
  c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M5 2 L5 19 L9.5 15.5 L12.5 21.5 L15 20 L12 14.5 L18 14 Z" fill="black" stroke="white" stroke-width="1.4"/></svg>';
  document.documentElement.appendChild(c);
  window.__fakeCursor = c;
  window.__setCursor = (x, y) => { c.style.left = x + 'px'; c.style.top = y + 'px'; };
  window.__clickPulse = (x, y) => {
    const r = document.createElement('div');
    r.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;width:34px;height:34px;border-radius:50%;border:2.5px solid rgba(216,67,59,.85);left:'+(x-17)+'px;top:'+(y-17)+'px;transform:scale(.3);opacity:1;transition:transform .35s ease-out,opacity .35s ease-out;';
    document.documentElement.appendChild(r);
    requestAnimationFrame(() => { r.style.transform = 'scale(1.15)'; r.style.opacity = '0'; });
    setTimeout(() => r.remove(), 450);
  };
})();`;

function makeHelpers(page) {
  let cx = 550, cy = 400;

  const ensureCursor = () => page.evaluate(CURSOR_JS);

  const setCursor = async (x, y) => {
    cx = x; cy = y;
    await page.evaluate(([a, b]) => window.__setCursor && window.__setCursor(a, b), [x, y]);
  };

  // Smooth, eased mouse glide to (x, y).
  const glide = async (x, y, ms = 500) => {
    await ensureCursor();
    const steps = Math.max(8, Math.round(ms / 16));
    const x0 = cx, y0 = cy;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
      const nx = x0 + (x - x0) * e, ny = y0 + (y - y0) * e;
      await page.mouse.move(nx, ny);
      await setCursor(nx, ny);
      await page.waitForTimeout(16);
    }
  };

  const center = async (locator) => {
    const box = await locator.boundingBox();
    if (!box) throw new Error('no bounding box');
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
  };

  const click = async (locator, opts = {}) => {
    const { x, y } = await center(locator);
    await glide(x + (opts.dx || 0), y + (opts.dy || 0), opts.ms || 500);
    await page.evaluate(([a, b]) => window.__clickPulse && window.__clickPulse(a, b), [cx, cy]);
    await page.waitForTimeout(120);
    if (opts.button === 'right') await page.mouse.click(cx, cy, { button: 'right' });
    else await page.mouse.click(cx, cy);
  };

  const clickXY = async (x, y, opts = {}) => {
    await glide(x, y, opts.ms || 500);
    await page.evaluate(([a, b]) => window.__clickPulse && window.__clickPulse(a, b), [x, y]);
    await page.waitForTimeout(120);
    await page.mouse.click(x, y, { button: opts.button || 'left' });
  };

  const type = async (text, delay = 34) => {
    await page.keyboard.type(text, { delay });
  };

  // Smoothly scroll the first *visible-candidate* occurrence of `needle`
  // into the centre of its scroll container.
  const scrollToText = async (needle) => {
    await page.evaluate((s) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const i = n.textContent.indexOf(s);
        if (i < 0) continue;
        const el = n.parentElement;
        if (!el) continue;
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') continue;
        if (!el.getClientRects().length) continue;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
    }, needle);
    await page.waitForTimeout(900);
  };

  // Select a substring of a rendered text node by dragging across it.
  // locator: element containing the text; needle: exact substring to select.
  const dragSelect = async (locator, needle, opts = {}) => {
    const handle = await locator.elementHandle();
    const rects = await page.evaluate(([el, s]) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const i = n.textContent.indexOf(s);
        if (i >= 0) {
          const r = document.createRange();
          r.setStart(n, i); r.setEnd(n, i + s.length);
          const list = [...r.getClientRects()].map(q => ({ x: q.x, y: q.y, w: q.width, h: q.height }));
          // skip matches that are scrolled out of view
          if (!list.length) continue;
          const f = list[0];
          if (f.y < 0 || f.y > window.innerHeight - 20 || f.x < 0) continue;
          // skip matches covered by something else (hidden copies, popovers)
          const probe = document.elementFromPoint(f.x + Math.min(f.w / 2, 30), f.y + f.h / 2);
          if (!probe || !(probe === n.parentElement || probe.contains(n.parentElement) || n.parentElement.contains(probe))) continue;
          return list;
        }
      }
      return null;
    }, [handle, needle]);
    if (!rects || !rects.length) throw new Error('needle not found: ' + needle);
    const first = rects[0], last = rects[rects.length - 1];
    const sx = first.x + 1, sy = first.y + first.h / 2;
    const ex = last.x + last.w - 1, ey = last.y + last.h / 2;
    await glide(sx, sy, opts.ms || 500);
    await page.mouse.down();
    // drag in steps so the selection visibly grows
    const steps = 14;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const nx = sx + (ex - sx) * t, ny = sy + (ey - sy) * t;
      await page.mouse.move(nx, ny);
      await setCursor(nx, ny);
      await page.waitForTimeout(28);
    }
    await page.mouse.up();
    cx = ex; cy = ey;
    return { sx, sy, ex, ey };
  };

  // Right-click on the current cursor position (e.g. on a selection).
  const rightClickHere = async () => {
    await page.evaluate(([a, b]) => window.__clickPulse && window.__clickPulse(a, b), [cx, cy]);
    await page.waitForTimeout(100);
    await page.mouse.click(cx, cy, { button: 'right' });
  };

  // Wait until streaming is done: stop button gone AND transcript stopped growing.
  const waitIdle = async (maxSec = 120) => {
    let lastLen = -1, stable = 0;
    for (let i = 0; i < maxSec; i++) {
      await page.waitForTimeout(1000);
      const st = await page.evaluate(() => ({
        stop: !!document.querySelector('[aria-label*="stop" i]'),
        len: document.body.innerText.length,
      }));
      if (!st.stop && st.len === lastLen) { stable++; if (stable >= 2 && i > 3) return; }
      else stable = 0;
      lastLen = st.len;
    }
  };

  const composer = () => page.locator('textarea, [contenteditable="true"]').last();

  const ask = async (text, opts = {}) => {
    const ed = composer();
    await click(ed, { ms: opts.ms || 450 });
    await type(text, opts.delay ?? 30);
    await page.waitForTimeout(opts.pauseBeforeSend ?? 350);
    await page.keyboard.press('Enter');
    if (!opts.noWait) await waitIdle(opts.maxSec || 120);
  };

  return { glide, click, clickXY, type, dragSelect, scrollToText, rightClickHere, waitIdle, composer, ask, center, setCursor, ensureCursor, page };
}

async function record(name, fn, opts = {}) {
  const b = await chromium.launch();
  const ctx = await b.newContext({
    viewport: VIEW,
    deviceScaleFactor: 2,
    recordVideo: { dir: VIDS, size: VIEW },
  });
  const page = await ctx.newPage();
  const h = makeHelpers(page);
  await page.goto(APP);
  await page.waitForTimeout(opts.settle ?? 1500);
  await h.ensureCursor();
  let err = null;
  try {
    await fn(page, h);
    await page.waitForTimeout(opts.tail ?? 1200);
  } catch (e) { err = e; }
  const video = page.video();
  await ctx.close();
  const vp = await video.path();
  const dest = path.join(VIDS, name + '.webm');
  fs.renameSync(vp, dest);
  await b.close();
  if (err) { console.error('SCENE FAILED:', err.message); process.exit(1); }
  console.log('video:', dest);
  return dest;
}

// Drive the app without recording (seeding data).
async function drive(fn, opts = {}) {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: VIEW, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const h = makeHelpers(page);
  await page.goto(APP);
  await page.waitForTimeout(opts.settle ?? 1500);
  let err = null;
  try { await fn(page, h); } catch (e) { err = e; }
  await ctx.close(); await b.close();
  if (err) { console.error('DRIVE FAILED:', err.message); process.exit(1); }
}

// webm -> gif. trim: {start, end} seconds optional; cut: [s, e] removes that span.
function toGif(name, opts = {}) {
  const src = path.join(VIDS, name + '.webm');
  const out = path.join(GIFS, name + '.gif');
  const fps = opts.fps || 10;
  const t = (opts.start ? `-ss ${opts.start} ` : '') + (opts.end ? `-to ${opts.end} ` : '');
  const speed = opts.speed || 1.5;
  const colors = opts.colors || 96;
  let pre = '';
  if (opts.cut) {
    const cuts = Array.isArray(opts.cut[0]) ? opts.cut : [opts.cut];
    const expr = cuts.map(([cs, ce]) => `not(between(t,${cs},${ce}))`).join('*');
    pre = `select='${expr}',setpts=N/FRAME_RATE/TB,`;
  }
  const filt = `${pre}${speed !== 1 ? `setpts=PTS/${speed},` : ''}fps=${fps},scale=1100:-1:flags=lanczos`;
  execSync(`ffmpeg -y ${t}-i "${src}" -vf "${filt},split[s0][s1];[s0]palettegen=stats_mode=diff:max_colors=${colors}[p];[s1][p]paletteuse=dither=none:diff_mode=rectangle" "${out}"`, { stdio: 'pipe' });
  const kb = Math.round(fs.statSync(out).size / 1024);
  console.log('gif:', out, kb + 'KB');
  return out;
}

module.exports = { record, drive, toGif, APP, SP };
