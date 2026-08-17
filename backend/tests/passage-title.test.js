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
  it('returns title AND restored quote from one call', async () => {
    const formula = '$x^{(k)} = \\frac{x^{(k)} - E[x^{(k)}]}{\\sqrt{Var[x^{(k)}]}}$';
    mockCreate.mockResolvedValue(reply(JSON.stringify({ title: formula, quote: formula })));

    const res = await request(app)
      .post('/api/chats/passage-title')
      .send({ passage: 'x ( k ) = x ( k ) − E [ x ( k ) ] √ Var [ x ( k ) ]' });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe(formula);
    // The quote feeds the branch header — restored, but NOT summarized
    // (user decision 2026-08-02, option B).
    expect(res.body.quote).toBe(formula);
    // One model call for both, not two.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    // The passage reached the prompt, including the reconstruction order.
    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('x ( k ) = x ( k )');
    expect(prompt).toContain('becomes ');
    // No copyable example in the prompt: gemini-flash-lite echoed the old
    // "wt−1 means w_{t-1}" example back as the title for a prose passage
    // (measured 2026-08-02), so the instruction now forbids exactly that.
    expect(prompt).toContain('never reuse wording or symbols');
    expect(prompt).not.toMatch(/w_\{t-1\}/);
  });

  it('reads the two labelled lines the prompt asks for', async () => {
    mockCreate.mockResolvedValue(reply(
      'TITLE: $\\Theta_2$ Update\n'
      + 'QUOTE: $\\Theta_2 \\leftarrow \\Theta_2 - \\frac{\\alpha}{m} \\sum_{i=1}^{m} '
      + '\\frac{\\partial F_2(x_i, \\Theta_2)}{\\partial \\Theta_2}$',
    ));

    const res = await request(app)
      .post('/api/chats/passage-title')
      .send({ passage: 'θ 2 ← θ 2 − α m m ∑ i =1 ∂F 2 (x i , θ 2 ) ∂ θ 2' });

    expect(res.body.title).toBe('$\\Theta_2$ Update');
    expect(res.body.quote).toContain('\\frac{\\partial F_2(x_i, \\Theta_2)}');
    // The labels themselves must never leak into the UI.
    expect(res.body.title).not.toMatch(/TITLE|QUOTE/);
    expect(res.body.quote).not.toMatch(/TITLE|QUOTE/);
  });

  it('tolerates bold labels and a bare title line', async () => {
    mockCreate.mockResolvedValue(reply('**Title:** Gradient Descent Step\n**Quote:** $\\eta \\nabla L$'));

    const res = await request(app)
      .post('/api/chats/passage-title')
      .send({ passage: 'η ∇ L' });

    expect(res.body.title).toBe('Gradient Descent Step');
    expect(res.body.quote).toBe('$\\eta \\nabla L$');
  });

  it('recovers LaTeX from a JSON reply whose backslashes are not escaped', async () => {
    // The live failure of 2026-08-02: models write `{"title": "$\Theta_2$"}`,
    // which is INVALID JSON (`\T` is no escape). JSON.parse threw and the
    // whole object became the title — the tree showed `{ "title": "θ₂ Update`.
    mockCreate.mockResolvedValue(reply(
      '{ "title": "$\\Theta_2$ Update", "quote": "$\\Theta_2 \\leftarrow \\Theta_2 - \\alpha$" }',
    ));

    const res = await request(app)
      .post('/api/chats/passage-title')
      .send({ passage: 'θ 2 ← θ 2 − α' });

    expect(res.body.title).toBe('$\\Theta_2$ Update');
    expect(res.body.quote).toBe('$\\Theta_2 \\leftarrow \\Theta_2 - \\alpha$');
    expect(res.body.title).not.toContain('{');
  });

  it('keeps \\frac and \\neq intact in a JSON reply — they are not escapes', async () => {
    // Repairing only the INVALID escapes would not be enough: `\f` and `\n`
    // are legal JSON escapes, so JSON.parse turns `\frac` into a form feed
    // plus "rac" and `\neq` into a newline plus "eq".
    mockCreate.mockResolvedValue(reply(
      '{"title": "Bias Correction", "quote": "$\\frac{m_t}{1 - \\beta_1^t} \\neq m_t$"}',
    ));

    const res = await request(app)
      .post('/api/chats/passage-title')
      .send({ passage: 'm t 1 − β 1 t ≠ m t' });

    expect(res.body.quote).toBe('$\\frac{m_t}{1 - \\beta_1^t} \\neq m_t$');
    expect(res.body.quote).not.toMatch(/[\f\n]/);
  });

  it('reads heading + formula even when the model drops the labels', async () => {
    // gpt-oss-120b on Groq answers exactly like this (measured 2026-08-02):
    // no labels, title on line one, the reconstruction on line two.
    mockCreate.mockResolvedValue(reply(
      'Multivariate normal density\n'
      + '$p(x)=\\frac{1}{(2\\pi)^{d/2}|\\Sigma|^{1/2}}\\exp\\left(-\\frac12 (x-\\mu)^{T}\\Sigma^{-1}(x-\\mu)\\right)$',
    ));

    const res = await request(app)
      .post('/api/chats/passage-title')
      .send({ passage: 'p ( x ) = 1 ( 2 π ) d / 2 | Σ | 1 / 2 exp ( − 1 2 ( x − μ ) T Σ − 1 ( x − μ ) )' });

    expect(res.body.title).toBe('Multivariate normal density');
    expect(res.body.quote).toContain('\\Sigma^{-1}');
  });

  it('sanitizes the model output like the post-answer path does', async () => {
    mockCreate.mockResolvedValue(reply(JSON.stringify({ title: '"Batch Normalisierung."', quote: 'x' })));

    const res = await request(app)
      .post('/api/chats/passage-title')
      .send({ passage: 'Batch normalization reduces internal covariate shift' });

    expect(res.body.title).toBe('Batch Normalisierung');
  });

  it('still accepts a bare title, the way older prompts answered', async () => {
    mockCreate.mockResolvedValue(reply('Internal Covariate Shift'));

    const res = await request(app)
      .post('/api/chats/passage-title')
      .send({ passage: 'e parameters of the previous layers change' });

    expect(res.body.title).toBe('Internal Covariate Shift');
    expect(res.body.quote).toBeNull();
  });

  it('survives the markdown fences small models like to add', async () => {
    mockCreate.mockResolvedValue(reply('```json\n{"title":"Mini-Batch-Varianz","quote":"$\\\\sigma_B^2$"}\n```'));

    const res = await request(app)
      .post('/api/chats/passage-title')
      .send({ passage: 'σ 2 B ← 1 m m ∑ i =1 ( x i − μ B ) 2' });

    expect(res.body.title).toBe('Mini-Batch-Varianz');
    expect(res.body.quote).toBe('$\\sigma_B^2$');
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

  it('drops a "reconstruction" that just copies the mangled text back', async () => {
    // One model in the ladder returned the passage verbatim as the quote
    // (measured 2026-08-02). A duplicate helps nobody — the UI is better off
    // showing the verbatim passage itself.
    const raw = 'σ 2 B ← 1 m m ∑ i =1 ( x i − μ B ) 2';
    mockCreate.mockResolvedValue(reply(JSON.stringify({ title: 'Batch-Varianz', quote: raw })));

    const res = await request(app).post('/api/chats/passage-title').send({ passage: raw });

    expect(res.body.title).toBe('Batch-Varianz');
    expect(res.body.quote).toBeNull();
  });

  it('keeps a prose passage unchanged as its quote', async () => {
    const prose = 'careful parameter initialization makes training hard';
    mockCreate.mockResolvedValue(reply(JSON.stringify({ title: 'Parameter Initialization', quote: prose })));

    const res = await request(app).post('/api/chats/passage-title').send({ passage: prose });

    expect(res.body.quote).toBe(prose);
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
