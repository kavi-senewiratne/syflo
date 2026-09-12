const { record, toGif } = require('./lib');
record('05-themes', async (p, h) => {
  await h.click(p.getByText('Search-Based Testing').first(), { ms: 600 });
  await p.waitForTimeout(2800);
  const pickTheme = async (name) => {
    await h.click(p.getByLabel('Open settings'), { ms: 600 });
    await p.waitForTimeout(1100); // Appearance tab is the default
    await h.click(p.getByText(name, { exact: true }), { ms: 600 });
    await p.waitForTimeout(1300); // applies instantly
    await h.click(p.getByText('Close', { exact: true }), { ms: 500 });
    await p.waitForTimeout(2300); // linger on the recolored app
  };
  await pickTheme('Simply Blue');
  await pickTheme('Hyrule');
  await pickTheme('Matrix');
  await pickTheme('Mushroom Kingdom');
}, { tail: 2000 }).then(() => toGif('05-themes', { speed: 1.35 }));
