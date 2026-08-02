/**
 * tests/feedback.test.js
 *
 * Route tests for POST /api/feedback (ADR-0010): a thin proxy to Web3Forms,
 * same pattern as routes/search.js for SearXNG. The actual send is injected
 * via options.sendFn — no real network in tests.
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
let mockSendFn;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/feedback', feedbackRouter(db, { sendFn: mockSendFn }));
  return app;
}

beforeEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
  mockSendFn = jest.fn().mockResolvedValue(undefined);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

describe('POST /api/feedback', () => {
  it('sends the kind, text and diagnostic metadata, and confirms success', async () => {
    setSetting(db, 'llm_provider', 'gemini');
    const app = makeApp();

    const res = await request(app)
      .post('/api/feedback')
      .send({ kind: 'bug', text: 'The highlight picker closes too fast.' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockSendFn).toHaveBeenCalledTimes(1);
    const payload = mockSendFn.mock.calls[0][0];
    expect(payload.kind).toBe('bug');
    expect(payload.text).toBe('The highlight picker closes too fast.');
    expect(payload.provider).toBe('gemini');
    expect(typeof payload.version).toBe('string');
    expect(typeof payload.platform).toBe('string');
  });

  it('rejects a body missing kind or text without calling sendFn', async () => {
    const app = makeApp();

    const missingText = await request(app).post('/api/feedback').send({ kind: 'idea' });
    const missingKind = await request(app).post('/api/feedback').send({ text: 'no kind here' });

    expect(missingText.status).toBe(400);
    expect(missingKind.status).toBe(400);
    expect(mockSendFn).not.toHaveBeenCalled();
  });
});
