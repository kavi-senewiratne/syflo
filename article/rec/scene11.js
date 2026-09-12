const { record, toGif } = require('./lib');
let t0 = 0, cuts = [];
const mark = () => (Date.now() - t0) / 1000;
record('11-mentions', async (p, h) => {
  t0 = Date.now();
  await h.click(p.getByText('LoRA Fine', { exact: false }).first(), { ms: 600 });
  await h.composer().waitFor({ timeout: 15000 });
  await p.waitForTimeout(1800);
  const attach = async (file, alias, n) => {
    await h.click(p.getByRole('button', { name: /attach/i }).first(), { ms: 500 });
    await p.waitForTimeout(500);
    const target = await h.center(p.getByText('Media', { exact: true }));
    await h.glide(target.x, target.y, 400);
    const [fc] = await Promise.all([p.waitForEvent('filechooser', { timeout: 15000 }), p.getByText('Media', { exact: true }).click()]);
    await fc.setFiles(process.env.SP + '/' + file);
    await p.waitForTimeout(2000);
    await h.click(p.getByText('@foto' + n), { ms: 550 });
    await p.waitForTimeout(500);
    await p.keyboard.press('Meta+a');
    await h.type(alias, 40);
    await p.waitForTimeout(300);
    await p.keyboard.press('Tab');
    await p.waitForTimeout(900);
  };
  await attach('architecture.png', 'architecture', 1);
  await attach('results.png', 'results', 1);
  // the question, with @-alias autocomplete
  await h.click(h.composer(), { ms: 450 });
  await h.type('does the diagram in @arch', 34);
  await p.waitForTimeout(1000);
  await h.click(p.getByText('architecture.png').last(), { ms: 500 });
  await p.waitForTimeout(500);
  await h.type('match the numbers in @res', 34);
  await p.waitForTimeout(1000);
  await h.click(p.getByText('results.png').last(), { ms: 500 });
  await p.waitForTimeout(500);
  await h.type('?', 40);
  await p.waitForTimeout(600);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(4000);
  const s1 = mark() + 3;
  await h.waitIdle(120);
  cuts.push([s1, mark() - 5]);
  await p.waitForTimeout(400);
}, { tail: 1600 }).then(() => {
  console.log('cuts', JSON.stringify(cuts));
  toGif('11-mentions', { cut: cuts, speed: 1.4 });
});
