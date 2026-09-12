const { record, toGif } = require('./lib');
record('09-keyboard', async (p, h) => {
  await h.click(p.getByText('Attention Is All You Nee').first(), { ms: 600 });
  await p.waitForTimeout(2400);
  await h.click(h.composer(), { ms: 500 });
  await p.waitForTimeout(700);
  const key = async (k, wait = 1000) => { await p.keyboard.press(k); await p.waitForTimeout(wait); };
  await key('Escape', 1400);      // ring lands on the tree root
  await key('ArrowDown');         // softmax function
  await key('ArrowDown');         // vanishing gradients
  await key('ArrowDown');         // why several heads
  await key('Enter', 2600);       // open it
  await h.type('How many heads did they use?', 34);
  await p.waitForTimeout(1600);
}, { tail: 1200 }).then(() => toGif('09-keyboard', { speed: 1.3 }));
