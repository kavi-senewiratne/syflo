/**
 * playwright.config.ts — end-to-end checks against the RUNNING app.
 *
 * These specs drive the real thing (CLAUDE.md: "verified in the running app,
 * never on green tests alone"): a backend on :3001, the Vite dev server on
 * :5173, and a real Ollama on :11434. Nothing is mocked, so a spec may pull a
 * model and wait minutes for it. Start the servers first:
 *
 *   cd backend  && node server.js
 *   cd frontend && npx vite --port 5173
 *   npx playwright test
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 15 * 60 * 1000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
    viewport: { width: 1400, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  outputDir: 'tests/e2e/.results',
});
