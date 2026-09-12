const { record, toGif } = require('./lib');
record('12-model-picker', async (p, h) => {
  await h.click(p.getByText('LoRA Fine', { exact: false }).first(), { ms: 600 });
  await h.composer().waitFor({ timeout: 15000 });
  await p.waitForTimeout(1800);
  await h.click(p.getByText('Gemini Flash', { exact: true }).first(), { ms: 700 });
  await p.waitForTimeout(2500); // the menu with Free / Requires billing groups
  // glide over the paid group, then back to a free model
  const paid = p.getByText('Requires billing').first();
  if (await paid.count()) { const c = await h.center(paid); await h.glide(c.x, c.y, 700); }
  await p.waitForTimeout(1400);
  await h.click(p.getByText('gpt-oss 120B').first(), { ms: 800 });
  await p.waitForTimeout(2200); // pill switches
}, { tail: 1500 }).then(() => toGif('12-model-picker', { speed: 1.25 }));
