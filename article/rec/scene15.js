const { record, toGif } = require('./lib');
record('15-definition', async (p, h) => {
  await h.click(p.getByText('Attention Is All You Nee').first(), { ms: 600 });
  await p.waitForTimeout(2600);
  await h.scrollToText('normalizes the variance back to');
  await p.waitForTimeout(400);
  // find the word "variance" in the visible answer and right-click it
  const r = await p.evaluate(() => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const i = n.textContent.indexOf('normalizes the variance back');
      if (i < 0) continue;
      const j = n.textContent.indexOf('variance', i);
      const rg = document.createRange();
      rg.setStart(n, j); rg.setEnd(n, j + 8);
      const q = rg.getBoundingClientRect();
      if (q.y < 0 || q.y > innerHeight - 20) continue;
      return { x: q.x + q.width / 2, y: q.y + q.height / 2 };
    }
    return null;
  });
  if (!r) throw new Error('word not found');
  await h.clickXY(r.x, r.y, { button: 'right', ms: 700 });
  // wait for the definition to load
  await p.waitForTimeout(600);
  for (let i = 0; i < 20; i++) {
    const loading = await p.getByText('Loading definition').count();
    if (!loading) break;
    await p.waitForTimeout(500);
  }
  await p.waitForTimeout(3200); // read it
  await h.click(p.getByRole('button', { name: 'Close' }).last(), { ms: 500 });
  await p.waitForTimeout(600);
}, { tail: 1200 }).then(() => toGif('15-definition', { speed: 1.3 }));
