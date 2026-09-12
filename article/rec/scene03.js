const { record, toGif } = require('./lib');
record('03-paper', async (p, h) => {
  await h.click(p.getByRole('button', { name: 'New Chat' }), { ms: 600 });
  await p.waitForTimeout(900);
  await h.click(p.getByRole('button', { name: /attach/i }), { ms: 550 });
  await p.waitForTimeout(500);
  await h.click(p.getByText('Research paper'), { ms: 450 });
  await p.waitForTimeout(700);
  const inp = p.locator('input:visible').first();
  await h.click(inp, { ms: 400 });
  await h.type('Attention Is All You Need', 40);
  // results appear via debounce
  await p.getByText('Ashish Vaswani').waitFor({ timeout: 20000 });
  await p.waitForTimeout(900);
  await h.click(p.getByRole('button', { name: 'Import' }).first(), { ms: 650 });
  // wait for the PDF to render in the centre pane
  await p.waitForTimeout(1500);
  await p.locator('.pdf-page, canvas').first().waitFor({ timeout: 30000 });
  await p.waitForTimeout(2500);
  // ask a natural question
  await h.ask('Why are the dot products scaled by 1/sqrt(dk)?', { maxSec: 90 });
  await p.waitForTimeout(600);
  // click a citation quote if the answer produced one
  const quote = p.locator('[title="Go to the source of this quote"]').first();
  if (await quote.count()) {
    await h.click(quote, { ms: 700 });
    await p.waitForTimeout(2200);
  }
}, { tail: 1500 }).then(() => toGif('03-paper', { speed: 1.3 }));
