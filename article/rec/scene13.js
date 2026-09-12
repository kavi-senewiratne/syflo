const { record, toGif } = require('./lib');
record('13-local-model', async (p, h) => {
  await h.click(p.getByText('LoRA Fine', { exact: false }).first(), { ms: 600 });
  await h.composer().waitFor({ timeout: 15000 });
  await p.waitForTimeout(1500);
  await h.click(p.getByText('Settings'), { ms: 650 });
  await p.waitForTimeout(1200);
  await h.click(p.getByText('Model', { exact: true }).first(), { ms: 550 });
  await p.waitForTimeout(1600);
  await h.click(p.getByText('Ollama (local)'), { ms: 700 });
  await p.waitForTimeout(2200); // local model list + hardware recommendation
  const qwen = p.getByText('qwen3.5:9b', { exact: false }).first();
  if (await qwen.count()) { await h.click(qwen, { ms: 600 }); await p.waitForTimeout(1200); }
  await h.click(p.getByRole('button', { name: 'Activate' }), { ms: 650 });
  await p.waitForTimeout(1500);
  await h.click(p.getByText('Close', { exact: true }), { ms: 550 });
  await p.waitForTimeout(1800); // composer pill now shows the local model
}, { tail: 1500 }).then(() => toGif('13-local-model', { speed: 1.3 }));
