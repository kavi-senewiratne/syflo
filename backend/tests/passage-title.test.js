/**
 * tests/passage-title.test.js
 *
 * POST /api/chats/passage-title titles a selected passage BEFORE the branch
 * chat exists, so the sidebar never shows the raw passage first. Matters most
 * for formulas marked in a PDF: the text layer flattens them ("x ( k ) = x
 * ( k ) − E [ x ( k ) ] √ Var"), and only the model can write that back as
 * LaTeX (user requirement 2026-08-02).
 *
 * The OpenAI SDK is mocked, so no provider is contacted.
 */

process.env.OPENAI_API_KEY = 'test-key-for-unit-tests';
jest.mock('openai');
const OpenAI = require('openai');

const request = require('supertest');
const { createApp } = require('../server');
const { createDb } = require('../database');
const { setSetting } = require('../llm');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'passage_title_test.db');

let app;
let db;
let mockCreate;

const reply = (content) => ({ choices: [{ message: { content } }] });

beforeEach(() => {
  mockCreate = jest.fn();
  OpenAI.mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
  // A cloud provider with a key: the default (ADR-0008) has none, and
  // without one getLLMClient throws before any prompt is built.
  setSetting(db, 'llm_provider', 'openai');
  setSetting(db, 'openai_api_key', 'test-key-for-unit-tests');
  app = createApp(db);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

describe('POST /api/chats/passage-title', () => {
  it('returns the LaTeX title the model reconstructed from mangled PDF math', async () => {
    mockCreate.mockResolvedValue(reply('$x^{(k)} = \\frac{x^{(k)} - E[x^{(k)}]}{\\sqrt{Var[x^{(k)}]}}$'));

    const res = await request(app)
      .post('/api/chats/passage-title')
      .send({ passage: 'x ( k ) = x ( k ) − E [ x ( k ) ] √ Var [ x ( k ) ]' });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('$x^{(k)} = \\frac{x^{(k)} - E[x^{(k)}]}{\\sqrt{Var[x^{(k)}]}}$');
    // The passage reached the prompt, including the reconstruction order.
    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('x ( k ) = x ( k )');
    expect(prompt).toContain('restore them');
    // No copyable example in the prompt: gemini-flash-lite echoed the old
    // "wt−1 means w_{t-1}" example back as the title for a prose passage
    // (measured 2026-08-02), so the instruction now forbids exactly that.
    expect(prompt).toContain('never reuse wording or symbols');
    expect(prompt).not.toMatch(/w_\{t-1\}/);
  });

  it('sanitizes the model output like the post-answer path does', async () => {
    mockCreate.mockResolvedValue(reply('"Batch Normalisierung."'));

    const res = await request(app)
      .post('/api/chats/passage-title')
      .send({ passage: 'Batch normalization reduces internal covariate shift' });

    expect(res.body.title).toBe('Batch Normalisierung');
  });

  it('never blocks branching: a failing model yields title null, not an error', async () => {
    mockCreate.mockRejectedValue(new Error('429 rate limit'));

    const res = await request(app)
      .post('/api/chats/passage-title')
      .send({ passage: 'irgendein markierter Text' });

    expect(res.status).toBe(200);
    expect(res.body.title).toBeNull();
  });

  it('skips the call on Ollama — one KV slot, the prefix must not be evicted', async () => {
    setSetting(db, 'llm_provider', 'ollama');

    const res = await request(app)
      .post('/api/chats/passage-title')
      .send({ passage: 'x ( k ) = x ( k ) − E [ x ( k ) ]' });

    expect(res.body.title).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('retries once when the provider hiccups with a 5xx', async () => {
    const boom = Object.assign(new Error('503 status code (no body)'), { status: 503 });
    mockCreate.mockRejectedValueOnce(boom).mockResolvedValueOnce(reply('$\\mu_B$'));

    const res = await request(app)
      .post('/api/chats/passage-title')
      .send({ passage: 'μ B ← 1 m ∑ i =1 x i' });

    expect(res.body.title).toBe('$\\mu_B$');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 429 — hammering a rate limit only makes it worse', async () => {
    mockCreate.mockRejectedValue(Object.assign(new Error('429'), { status: 429 }));

    const res = await request(app)
      .post('/api/chats/passage-title')
      .send({ passage: 'irgendein Text' });

    expect(res.body.title).toBeNull();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('fails over to the next provider when the active one is out of quota', async () => {
    // Live failure 2026-08-02: Gemini answered 429 and the user was back to
    // raw PDF text although a Groq key was configured.
    setSetting(db, 'llm_provider', 'gemini');
    setSetting(db, 'gemini_api_key', 'test-key-for-unit-tests');
    setSetting(db, 'groq_api_key', 'test-key-for-unit-tests');
    mockCreate
      .mockRejectedValueOnce(Object.assign(new Error('429 quota'), { status: 429 }))
      .mockResolvedValueOnce(reply('$\\mu_B$'));

    const res = await request(app)
      .post('/api/chats/passage-title')
      .send({ passage: 'μ B ← 1 m ∑ i =1 x i' });

    expect(res.body.title).toBe('$\\mu_B$');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('gives up with title null once every candidate is rate-limited', async () => {
    setSetting(db, 'llm_provider', 'gemini');
    setSetting(db, 'gemini_api_key', 'test-key-for-unit-tests');
    mockCreate.mockRejectedValue(Object.assign(new Error('429 quota'), { status: 429 }));

    const res = await request(app)
      .post('/api/chats/passage-title')
      .send({ passage: 'irgendein Text' });

    expect(res.status).toBe(200);
    expect(res.body.title).toBeNull();
  });

  it('rejects an empty passage', async () => {
    const res = await request(app).post('/api/chats/passage-title').send({ passage: '   ' });
    expect(res.status).toBe(400);
  });

  it('does not collide with the chat routes (POST / still creates a chat)', async () => {
    const res = await request(app).post('/api/chats').send({ title: 'Normaler Chat' });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Normaler Chat');
  });
});
