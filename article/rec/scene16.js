const { record, toGif } = require('./lib');
let t0 = 0, cuts = [];
const mark = () => (Date.now() - t0) / 1000;
record('16-transcript-select', async (p, h) => {
  t0 = Date.now();
  await h.click(p.getByText('Attention in transformers').first(), { ms: 600 });
  await p.waitForTimeout(3000);
  // jump the video via a chapter timestamp
  await h.click(p.getByText('04:40', { exact: true }).first(), { ms: 800 });
  await p.waitForTimeout(2500);
  // open the transcript
  await h.click(p.getByText('Transcript', { exact: true }).first(), { ms: 700 });
  await p.waitForTimeout(2000);
  // pick a plain sentence from the visible transcript and select it
  const needle = await p.evaluate(() => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let best = ''; let n;
    while ((n = w.nextNode())) {
      const t = n.textContent;
      if (t.length > best.length && t.length < 200 && /^[\x20-\x7E‘-’]+$/.test(t)) {
        const el = n.parentElement;
        if (el && el.getClientRects().length) {
          const r = el.getBoundingClientRect();
          if (r.y > 150 && r.y < 500 && r.x < 760) best = t;
        }
      }
    }
    const words = best.trim().split(/\s+/);
    const start = Math.max(0, Math.floor(words.length / 2) - 3);
    return words.slice(start, start + 5).join(' ');
  });
  console.log('needle:', JSON.stringify(needle));
  await h.dragSelect(p.locator('body'), needle, { ms: 650 });
  await p.waitForTimeout(1500);
  await h.click(p.getByText('Ask in chat'), { ms: 600 });
  await p.waitForTimeout(1200);
  await h.click(h.composer(), { ms: 400 });
  await h.type('What does this line mean?', 32);
  await p.waitForTimeout(400);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(4000);
  const s1 = mark() + 2;
  await h.waitIdle(120);
  cuts.push([s1, mark() - 5]);
  await p.waitForTimeout(500);
}, { tail: 1600 }).then(() => {
  console.log('cuts', JSON.stringify(cuts));
  toGif('16-transcript-select', { cut: cuts, speed: 1.4 });
});
