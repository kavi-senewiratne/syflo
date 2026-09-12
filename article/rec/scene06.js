const { record, toGif } = require('./lib');
record('06-highlights', async (p, h) => {
  await h.click(p.getByText('Attention Is All You Nee').first(), { ms: 600 });
  await p.waitForTimeout(2600);
  // 1) highlight a sentence in the PDF abstract
  await h.dragSelect(p.locator('body'), 'a new simple network architecture, the Transformer,', { ms: 650 });
  await p.waitForTimeout(1300);
  await h.click(p.getByLabel("Highlight as Key point").first(), { ms: 550 });
  await p.waitForTimeout(1200);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(500);
  // 2) highlight a phrase in the chat answer
  await h.scrollToText('normalizes the variance back to');
  await p.waitForTimeout(400);
  await h.dragSelect(p.locator('body'), 'normalizes the variance back to', { ms: 600 });
  await p.waitForTimeout(1300);
  await h.click(p.getByLabel("Highlight as Idea").first(), { ms: 550 });
  await p.waitForTimeout(1200);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(500);
  // 3) open the highlights drawer
  await h.click(p.locator("[data-focus-item=\"chat-highlights\"]").first(), { ms: 650 });
  await p.waitForTimeout(1800);
  // 4) click the PDF highlight card to jump back
  await h.click(p.getByText('PDF · p.').first(), { ms: 650 });
  await p.waitForTimeout(2800);
}, { tail: 1400 }).then(() => toGif('06-highlights', { speed: 1.4 }));
