const { record, toGif } = require('./lib');
record('07-branch-links', async (p, h) => {
  await h.click(p.getByText('Attention Is All You Nee').first(), { ms: 600 });
  await p.waitForTimeout(2600);
  await h.scrollToText('softmax function into saturated regions');
  await p.waitForTimeout(1300);
  // hover the coloured link, then click it
  const link = p.getByText('softmax function into saturated regions').first();
  await h.click(link, { ms: 900 });
  await p.waitForTimeout(3000); // lands in the branch chat
}, { tail: 1500 }).then(() => toGif('07-branch-links', { speed: 1.3 }));
