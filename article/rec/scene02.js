const { record, toGif } = require('./lib');
let t0 = 0, cuts = [];
const mark = () => (Date.now() - t0) / 1000;
record('02-plain-chat', async (p, h) => {
  t0 = Date.now();
  await h.click(p.getByRole('button', { name: 'New Chat' }), { ms: 600 });
  await p.waitForTimeout(1000);
  await h.click(h.composer(), { ms: 450 });
  await h.type('How does LoRA make fine-tuning cheaper?', 30);
  await p.waitForTimeout(400);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(3500);
  const s1 = mark() + 2;
  await h.waitIdle(90);
  cuts.push([s1, mark() - 4]);
  await p.waitForTimeout(800);
  // pick a plain 4-word phrase from the rendered answer to branch on
  const needle = await p.evaluate(() => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let best = '';
    let n;
    while ((n = w.nextNode())) {
      const t = n.textContent;
      if (t.length > best.length && /^[\x20-\x7E\u2010-\u2019]+$/.test(t) && !t.includes('$')) {
        const el = n.parentElement;
        if (!el || !el.closest('.katex')) {
          if (el && el.getClientRects().length) best = t;
        }
      }
    }
    const words = best.trim().split(/\s+/);
    if (words.length < 4) return best.trim();
    const start = Math.max(0, Math.floor(words.length / 2) - 2);
    return words.slice(start, start + 4).join(' ');
  });
  console.log('needle:', JSON.stringify(needle));
  await h.scrollToText(needle);
  await h.dragSelect(p.locator('body'), needle, { ms: 600 });
  await p.waitForTimeout(1500);
  await h.click(p.getByText('Open as new chat'), { ms: 650 });
  await p.waitForTimeout(3200); // branch chat with its chip
  // back to the parent, branch on a typed topic
  await h.click(p.getByText('LoRA', { exact: false }).first(), { ms: 600 }); // root sidebar item
  await p.waitForTimeout(1500);
  await h.click(h.composer(), { ms: 450 });
  await h.type('/branch catastrophic forgetting', 30);
  await p.waitForTimeout(700);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(4500);
  const s2 = mark() + 1;
  await h.waitIdle(90);
  cuts.push([s2, mark() - 4]);
  await p.waitForTimeout(400);
}, { tail: 1500 }).then(() => {
  console.log('cuts', JSON.stringify(cuts));
  toGif('02-plain-chat', { cut: cuts, speed: 1.4 });
});
