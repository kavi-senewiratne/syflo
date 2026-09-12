const { record, toGif } = require('./lib');
record('01-branching', async (p, h) => {
  await h.click(p.getByText('Attention Is All You Nee').first(), { ms: 600 });
  await p.waitForTimeout(2600);
  await h.scrollToText('softmax function into saturated regions');
  await p.waitForTimeout(500);
  await h.dragSelect(p.locator('body'), 'softmax function into saturated regions', { ms: 650 });
  await p.waitForTimeout(1700); // popup shows: definition, colours, ask, branch
  await h.click(p.getByText('Open as new chat'), { ms: 700 });
  await p.waitForTimeout(3200); // branch chat opens
  await h.ask('What does saturated mean here?', { maxSec: 90 });
  await p.waitForTimeout(600);
}, { tail: 1600 }).then(() => toGif('01-branching'));
