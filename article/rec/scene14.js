const { record, toGif } = require('./lib');
record('14-pdf-select', async (p, h) => {
  await h.click(p.getByText('Attention Is All You Nee').first(), { ms: 600 });
  await p.waitForTimeout(2500);
  // scroll the PDF pane to the Hardware and Schedule section
  const pdf = p.locator('.pdf-page, canvas').first();
  const box = await pdf.boundingBox();
  await h.glide(box.x + box.width / 2, box.y + 250, 500);
  for (let i = 0; i < 12; i++) { await p.mouse.wheel(0, 400); await p.waitForTimeout(140); }
  await p.waitForTimeout(1500);
  // select the GPU sentence in the visible text layer
  const tl = p.locator('.pdf-pane, main').first();
  await h.dragSelect(p.locator('body'), 'We trained our models on one machine with 8 NVIDIA P100 GPUs', { ms: 700 });
  await p.waitForTimeout(1200);
  // the popup opens on mouseup — choose Ask in chat
  await h.click(p.getByText('Ask in chat'), { ms: 600 });
  await p.waitForTimeout(1000);
  await h.ask('How long did the full training run take?', { maxSec: 90 });
  await p.waitForTimeout(800);
}, { tail: 1500 }).then(() => toGif('14-pdf-select', { speed: 1.3 }));
