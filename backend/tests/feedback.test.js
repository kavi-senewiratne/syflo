/**
 * tests/feedback.test.js
 *
 * Route test for GET /api/feedback/config (ADR-0010, corrected 2026-08-06):
 * Web3Forms' free plan rejects server-to-server submissions ("Use our API
 * in client side or contact support ... Pro plan is required") — the actual
 * POST to Web3Forms must happen from the browser, not proxied through our
 * backend. This route only hands the frontend the (non-secret, client-safe)
 * access key plus server-side diagnostics; api.sendFeedback posts directly
 * to Web3Forms from there.
 */
const express = require('express');
const request = require('supertest');
const path = require('path');
const fs = require('fs');
const { createDb } = require('../database');
const { setSetting } = require('../llm');
const feedbackRouter = require('../routes/feedback');

const TEST_DB_PATH = path.join(__dirname, 'feedback-test.db');

let db;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/feedback', feedbackRouter(db));
  return app;
}

beforeEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

describe('GET /api/feedback/config', () => {
  it('returns the access key plus diagnostic metadata', async () => {
    setSetting(db, 'llm_provider', 'gemini');
    process.env.WEB3FORMS_ACCESS_KEY = 'test-access-key';
    const app = makeApp();

    const res = await request(app).get('/api/feedback/config');

    expect(res.status).toBe(200);
    expect(res.body.accessKey).toBe('test-access-key');
    expect(res.body.provider).toBe('gemini');
    expect(typeof res.body.version).toBe('string');
    expect(typeof res.body.platform).toBe('string');
    delete process.env.WEB3FORMS_ACCESS_KEY;
  });

  it('falls back to the shipped default key when no env override is set', async () => {
    // Hybrid feedback (2026-08-08): npm installs have no .env, so a
    // client-safe default key ships in code — feedback works out of the box.
    delete process.env.WEB3FORMS_ACCESS_KEY;
    const app = makeApp();

    const res = await request(app).get('/api/feedback/config');

    expect(res.status).toBe(200);
    expect(typeof res.body.accessKey).toBe('string');
    expect(res.body.accessKey.length).toBeGreaterThan(0);
  });

  it('always hands out the GitHub issues URL as the degradation target', async () => {
    const app = makeApp();

    const res = await request(app).get('/api/feedback/config');

    expect(res.body.issuesUrl).toBe('https://github.com/kavi-senewiratne/syflo/issues');
  });
});
