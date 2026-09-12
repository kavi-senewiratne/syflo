const { record, toGif } = require('./lib');
let t0 = 0, cuts = [];
const mark = () => (Date.now() - t0) / 1000;
record('10-btw-branch', async (p, h) => {
  t0 = Date.now();
  await h.click(p.getByText('Attention Is All You Nee').first(), { ms: 600 });
  await p.waitForTimeout(2600);
  const ed = h.composer();
  await h.click(ed, { ms: 500 });
  await h.type('/btw when was this paper published?', 32);
  await p.waitForTimeout(600);
  await p.keyboard.press('Enter');
  await h.waitIdle(60);
  await p.waitForTimeout(2400);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(800);
  // provider cooldown — cut out of the gif
  const c1 = mark() + 2;
  await p.waitForTimeout(65000);
  cuts.push([c1, mark() - 0.5]);
  await h.click(ed, { ms: 450 });
  await h.type('/branch positional encoding', 32);
  await p.waitForTimeout(900);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(4000); // branch opens, auto-answer starts
  const s1 = mark() + 4;        // keep the start of the stream
  await h.waitIdle(90);
  cuts.push([s1, mark() - 5]);  // fast-forward the middle of the stream
  await p.waitForTimeout(500);
}, { tail: 1800 }).then(() => {
  console.log('cuts', JSON.stringify(cuts));
  toGif('10-btw-branch', { cut: cuts, speed: 1.4 });
});
