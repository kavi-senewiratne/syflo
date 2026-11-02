/**
 * tests/e2e/local-library.spec.ts
 *
 * The local library in the running app, against a real Ollama (grill
 * 2026-10-27, decisions 2–10). One long scenario, in the order a user with a
 * fresh GPU meets it:
 *
 *   1. Settings → Model → Ollama: the machine is named, the recommended model
 *      is named, and the models that also fit have their own doors.
 *   2. The recommended model is removed (Remove door) so the download path
 *      is real — the picker then points to it as a quiet row.
 *   3. Download IN the app: progress bar, then "ready · 32k window". The app
 *      has NOT switched by itself (decision 8).
 *   4. "Answer locally now" switches provider + model; Ollama's own records
 *      show the baked window (decision 7).
 *   5. A real question is answered by the local model.
 *
 * Needs the backend on :3001, Vite on :5173 and Ollama on :11434. The model
 * ends up installed, as the user wants it.
 */

import { test, expect, type Page } from '@playwright/test';

const BACKEND = 'http://localhost:3001';
const OLLAMA = 'http://localhost:11434';

async function openOllamaLibrary(page: Page) {
  await page.getByRole('button', { name: 'Open settings' }).first().click();
  // The tab button carries a titled status dot, so its accessible name is
  // longer than its label — match the text, not the name.
  await page.locator('nav button').filter({ hasText: /^Model$/ }).click();
  await page.getByTestId('provider-card-ollama').click();
  await expect(page.getByTestId('hardware-line')).toBeVisible();
}

async function closeSettings(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('hardware-line')).toBeHidden();
}

test('a 16 GB NVIDIA machine gets its model: recommend, download, bake the window, switch, answer', async ({ page, request }) => {
  const rec = await (await request.get(`${BACKEND}/api/system/recommendation`)).json();
  test.skip(!rec.ollamaReachable, 'Ollama is not running — start it on :11434 first.');
  const name: string = rec.recommended.name;

  await page.goto('/');
  await openOllamaLibrary(page);

  // 1. The machine and the model that fits it.
  const hardware = page.getByTestId('hardware-line');
  await expect(hardware).toContainText(rec.hardware.gpu ? rec.hardware.gpu.name : 'no GPU');
  await expect(hardware).toContainText(`${Math.round(rec.hardware.usableGb)} GB`);
  for (const m of rec.alsoFits) {
    if (!m.installed) await expect(page.getByTestId(`download-${m.name}`)).toBeVisible();
  }

  // 2. Make the download real: remove the recommended model if it is there.
  // Every model appears once (§07 C): while installed it is a badged row and
  // there is no card; once removed, the card with the download door returns.
  if (rec.recommended.installed) {
    await expect(page.getByTestId('recommended-card')).toBeHidden();
    await expect(page.getByTestId(`library-row-${name}`)).toContainText('Recommended');
    await page.getByRole('button', { name: `Remove ${name}` }).click();
    await expect(page.getByTestId(`library-row-${name}`)).toBeHidden();
  }
  await expect(page.getByTestId('recommended-card')).toContainText(name);
  await expect(page.getByTestId('download-recommended')).toBeVisible();
  const tags = await (await request.get(`${OLLAMA}/api/tags`)).json();
  expect(tags.models.map((m: { name: string }) => m.name)).not.toContain(name);

  // The picker points to it, quietly, and lands on the Ollama card.
  await closeSettings(page);
  await page.reload();
  // The composer exists only inside a chat. On a fresh install with no
  // usable model at all the composer shows the onboarding door ("Set up
  // model") instead of the pill — that door leads to Settings too. With a
  // usable model the pill's quiet row must name the recommended model.
  await page.getByRole('button', { name: 'New Chat' }).first().click();
  const pill = page.getByTestId('model-pill');
  const setupDoor = page.getByRole('button', { name: 'Set up model' });
  await expect(pill.or(setupDoor).first()).toBeVisible();
  if (await pill.isVisible()) {
    await pill.click();
    const hint = page.getByTestId('recommended-hint-row');
    await expect(hint).toContainText(name);
    await hint.click();
  } else {
    await setupDoor.click();
    await page.getByTestId('provider-card-ollama').click();
  }
  await expect(page.getByTestId('recommended-card')).toBeVisible();

  // 3. Download in the app.
  const before = await (await request.get(`${BACKEND}/api/settings`)).json();
  await page.getByTestId('download-recommended').click();
  await expect(page.getByTestId(`download-progress-${name}`)).toBeVisible();
  await expect(page.getByTestId('switch-local')).toBeVisible({ timeout: 12 * 60 * 1000 });
  await expect(page.getByTestId('recommended-ready')).toContainText('32k');
  // Decision 8: nothing switched by itself.
  const after = await (await request.get(`${BACKEND}/api/settings`)).json();
  expect(after.llm_provider).toBe(before.llm_provider);

  // Decision 7: the window is in the model itself, and the backend knows it.
  const show = await (await request.post(`${OLLAMA}/api/show`, { data: { model: name } })).json();
  expect(show.parameters).toMatch(/num_ctx\s+32768/);
  const recAfter = await (await request.get(`${BACKEND}/api/system/recommendation`)).json();
  expect(recAfter.recommended.installed).toBe(true);

  // 4. Switch on request.
  await page.getByTestId('switch-local').click();
  await expect.poll(async () => (await (await request.get(`${BACKEND}/api/settings`)).json()).llm_provider).toBe('ollama');
  const switched = await (await request.get(`${BACKEND}/api/settings`)).json();
  expect(switched.ollama_model).toBe(name);
  // The card is gone; the model is a selected, badged row carrying the
  // in-use marker — the same list the cloud providers use.
  await expect(page.getByTestId('recommended-card')).toBeHidden();
  const row = page.getByTestId(`library-row-${name}`);
  await expect(row).toHaveAttribute('aria-checked', 'true');
  await expect(row).toContainText('Recommended');
  await expect(row).toContainText('Active');
  await closeSettings(page);
  await expect(page.getByTestId('model-pill')).toContainText(name);

  // 5. A real answer from the local model.
  const composer = page.locator('textarea').first();
  await composer.click();
  await composer.fill('Reply with exactly one short sentence: what is 2 + 2?');
  await composer.press('Enter');
  const rows = page.locator('[data-testid^="message-row-"]');
  await expect(rows).toHaveCount(2, { timeout: 3 * 60 * 1000 });
  const answerRow = rows.nth(1);
  await expect(answerRow).toContainText(/4|four/i, { timeout: 3 * 60 * 1000 });
  await expect(answerRow).not.toContainText(/\*Failed\*|\*Interrupted\*/);

  // Restore the provider the user had before, model stays installed.
  await request.put(`${BACKEND}/api/settings`, { data: { llm_provider: before.llm_provider } });
});
