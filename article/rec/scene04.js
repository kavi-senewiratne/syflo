const { record, toGif } = require('./lib');
let t0 = 0, cuts = [];
const mark = () => (Date.now() - t0) / 1000;
record('04-youtube', async (p, h) => {
  t0 = Date.now();
  await h.click(p.getByRole('button', { name: 'New Chat' }), { ms: 600 });
  await p.waitForTimeout(1000);
  await h.click(p.getByRole('button', { name: /attach/i }).first(), { ms: 550 });
  await p.waitForTimeout(500);
  await h.click(p.getByText('YouTube Transcript'), { ms: 500 });
  await p.waitForTimeout(900);
  const inp = p.locator('input:visible').first();
  await h.click(inp, { ms: 400 });
  await h.type('https://www.youtube.com/watch?v=eMlx5fFNoYc', 14);
  await p.waitForTimeout(4000); // the pasted link resolves to the video card
  const imp = p.getByRole('button', { name: 'Add' }).first();
  await imp.waitFor({ timeout: 25000 });
  await p.waitForTimeout(600);
  await h.click(imp, { ms: 600 });
  // transcript attaches, the overview prompt sends itself, chapters stream in
  await p.waitForTimeout(9000);
  const s1 = mark() + 3;
  await h.waitIdle(150);
  cuts.push([s1, mark() - 6]);
  await p.waitForTimeout(1000);
  // click a timestamp in the overview -> the video jumps there
  const mark1 = p.locator('[title="Open the video at this point"]').nth(1);
  if (await mark1.count()) {
    await h.click(mark1, { ms: 800 });
    await p.waitForTimeout(3000);
  }
}, { tail: 1800, settle: 1800 }).then(() => {
  console.log('cuts', JSON.stringify(cuts));
  toGif('04-youtube', { cut: cuts, speed: 1.4 });
});
