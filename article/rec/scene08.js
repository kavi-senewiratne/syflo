const { record, toGif } = require('./lib');
record('08-mindmap', async (p, h) => {
  await h.click(p.getByText('Attention Is All You Nee').first(), { ms: 600 });
  await p.waitForTimeout(2600);
  await h.click(p.getByLabel('Switch to Mind Map'), { ms: 650 });
  await p.waitForTimeout(2800); // map layout settles
  // pan the map a little
  await h.glide(700, 300, 400);
  await p.mouse.down();
  await h.glide(760, 360, 500);
  await p.mouse.up();
  await p.waitForTimeout(900);
  await h.glide(650, 320, 300);
  await p.mouse.down();
  await h.glide(600, 280, 450);
  await p.mouse.up();
  await p.waitForTimeout(1200);
  // click a node to land in its chat
  await h.click(p.getByText('why several heads').first(), { ms: 800 });
  await p.waitForTimeout(3200);
}, { tail: 1500 }).then(() => toGif('08-mindmap', { speed: 1.3 }));
