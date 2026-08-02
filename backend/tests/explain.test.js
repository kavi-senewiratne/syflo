/**
 * tests/explain.test.js
 *
 * Integration tests for POST /api/explain.
 * The Ollama client (OpenAI SDK) is mocked so these tests run without a
 * running Ollama server. Each test controls exactly what the mock returns.
 */

// Mock the openai module before anything else is required.
// jest.mock is hoisted so the mock is in place when routes/explain.js is loaded.
jest.mock('openai');
const OpenAI = require('openai');

const request = require('supertest');
const { createApp } = require('../server');
const { createDb } = require('../database');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'explain_test.db');

let app;
let db;
let mockCreate;

beforeEach(() => {
  // Create a fresh mock for `chat.completions.create` before each test so
  // tests don't share return values.
  mockCreate = jest.fn();
  OpenAI.mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));

  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
  // This suite tests the local path — bypass the cloud default (ADR-0008).
  require('../llm').setSetting(db, 'llm_provider', 'ollama');
  app = createApp(db);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

// ─── Validation ─────────────────────────────────────────────────────────────

describe('POST /api/explain – validation', () => {
  it('returns 400 when word is missing', async () => {
    const res = await request(app).post('/api/explain').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns 400 when word is an empty string', async () => {
    const res = await request(app).post('/api/explain').send({ word: '' });
    expect(res.status).toBe(400);
  });
});

// ─── Successful responses ────────────────────────────────────────────────────

describe('POST /api/explain – success', () => {
  it('returns an explanation for a word', async () => {
    // Mock Ollama returning an explanation
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Quantum is the smallest discrete unit of energy.' } }],
    });

    const res = await request(app)
      .post('/api/explain')
      .send({ word: 'quantum' });

    expect(res.status).toBe(200);
    expect(res.body.explanation).toBe('Quantum is the smallest discrete unit of energy.');
    // Definitions must come instantly — reasoning models must never ponder here.
    expect(mockCreate.mock.calls[0][0].reasoning_effort).toBe('none');
  });

  it('passes context to the model when provided', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'In this context, entropy means disorder.' } }],
    });

    await request(app)
      .post('/api/explain')
      .send({ word: 'entropy', context: 'thermodynamics lecture' });

    // The model should have been called with a prompt that includes the context
    const calledWith = mockCreate.mock.calls[0][0];
    const userMessage = calledWith.messages.find(m => m.role === 'user');
    expect(userMessage.content).toContain('entropy');
    expect(userMessage.content).toContain('thermodynamics lecture');
  });

  it('works without context (word only)', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Serendipity means a happy accident.' } }],
    });

    const res = await request(app)
      .post('/api/explain')
      .send({ word: 'serendipity' });

    expect(res.status).toBe(200);
    expect(res.body.explanation).toBeDefined();
  });
});

// ─── App language (grill decision 2026-07-24) ────────────────────────────────
// Explain is a dictionary and explains in the reader's language: the
// frontend sends the App language along as `language`, and the system
// prompt gets an explicit target-language instruction. Without (or with an
// invalid) parameter the previous implicit behavior stays unchanged.

describe('POST /api/explain – target language (App language)', () => {
  beforeEach(() => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Eine Erklärung.' } }],
    });
  });

  const systemPrompt = () =>
    mockCreate.mock.calls[0][0].messages.find(m => m.role === 'system').content;

  it('instructs the model to answer in German when language=de', async () => {
    await request(app).post('/api/explain').send({ word: 'entropy', language: 'de' });
    expect(systemPrompt()).toContain('Answer in German');
  });

  it('instructs the model to answer in English when language=en', async () => {
    await request(app).post('/api/explain').send({ word: 'Entropie', language: 'en' });
    expect(systemPrompt()).toContain('Answer in English');
  });

  it('adds no language instruction when the parameter is missing', async () => {
    await request(app).post('/api/explain').send({ word: 'entropy' });
    expect(systemPrompt()).not.toContain('Answer in');
  });

  it('ignores unknown language values', async () => {
    await request(app).post('/api/explain').send({ word: 'entropy', language: 'fr' });
    expect(systemPrompt()).not.toContain('Answer in');
  });
});

// ─── KV prefix sharing (2026-07-25) ──────────────────────────────────────────
// With chatId, explain appends the define question to the conversation
// context (same builder as chat/warm-up/title generation, incl. tools —
// otherwise the rendered prefix diverges). This way the explanation hits
// Ollama's KV cache instead of evicting the single slot with a standalone
// prompt.

describe('POST /api/explain – shares the conversation prefix (chatId)', () => {
  const createChat = async () => {
    const res = await request(app).post('/api/chats').send({ title: 'Tree' });
    return res.body.id;
  };

  it('appends the define question to the chat context and passes tools', async () => {
    const chatId = await createChat();
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'A prefix is the shared beginning.' } }],
    });

    const res = await request(app)
      .post('/api/explain')
      .send({ word: 'prefix', chatId, language: 'de' });

    expect(res.status).toBe(200);
    const calledWith = mockCreate.mock.calls[0][0];
    // Chat system prompt instead of the standalone dictionary prompt
    expect(calledWith.messages[0].role).toBe('system');
    expect(calledWith.messages[0].content).toContain('You are a friendly and helpful assistant');
    // Define question as the LAST message, with style rules + target language
    const last = calledWith.messages[calledWith.messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toContain('Define "prefix"');
    expect(last.content).toContain('Answer in German');
    // tools as in the conversation — otherwise the template renders a different prefix
    expect(calledWith.tools).toBeDefined();
  });

  it('falls back to the standalone prompt when the model returns no content', async () => {
    const chatId = await createChat();
    mockCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: '' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'A clean definition.' } }] });

    const res = await request(app)
      .post('/api/explain')
      .send({ word: 'prefix', chatId });

    expect(res.status).toBe(200);
    expect(res.body.explanation).toBe('A clean definition.');
    expect(mockCreate).toHaveBeenCalledTimes(2);
    // Second call = standalone dictionary (without conversation context/tools)
    const second = mockCreate.mock.calls[1][0];
    expect(second.messages[0].content).toContain('concise dictionary');
    expect(second.tools).toBeUndefined();
  });

  it('uses the standalone prompt for an unknown chatId', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Standalone definition.' } }],
    });

    const res = await request(app)
      .post('/api/explain')
      .send({ word: 'prefix', chatId: 'does-not-exist' });

    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].messages[0].content).toContain('concise dictionary');
  });
});

// ─── Error handling ──────────────────────────────────────────────────────────

describe('POST /api/explain – error handling', () => {
  it('returns 500 when Ollama is unavailable', async () => {
    mockCreate.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:11434'));

    const res = await request(app)
      .post('/api/explain')
      .send({ word: 'quantum' });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('ECONNREFUSED');
  });
});

// ─── Quota failover (user request 2026-07-28) ────────────────────────────────
// A right-click definition must not die with the active model's quota: like
// the chat (messages.js), explain walks the candidate ladder — remaining
// models of the SAME provider first, then other keyed cloud providers.
// Cooldowns are SHARED with the chat's quota memory, so a limit learned in
// either place is skipped proactively in both. The local provider stays
// outside the ladder in both directions (privacy guard, mockup-model-flow §11).

describe('POST /api/explain – quota failover between cloud models', () => {
  const dailyQuotaError = () =>
    Object.assign(new Error('Quota exceeded for metric generate_requests_per_model_per_day'), { status: 429 });
  const minuteQuotaError = () =>
    Object.assign(new Error('Rate limit exceeded, slow down'), { status: 429 });

  function useGeminiAndGroq() {
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'gemini');
    setSetting(db, 'gemini_api_key', 'AIza-test');
    setSetting(db, 'gemini_model', 'gemini-pro-latest');
    setSetting(db, 'groq_api_key', 'gsk-test');
  }

  const explain = () => request(app).post('/api/explain').send({ word: 'quantum', language: 'de' });

  it('falls over to the sibling model of the SAME provider on a 429', async () => {
    useGeminiAndGroq();
    mockCreate
      .mockRejectedValueOnce(dailyQuotaError()) // gemini-pro: daily gone
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Kleinste Einheit.' } }] });

    const res = await explain();

    expect(res.status).toBe(200);
    expect(res.body.explanation).toBe('Kleinste Einheit.');
    expect(mockCreate.mock.calls[0][0].model).toBe('gemini-pro-latest');
    expect(mockCreate.mock.calls[1][0].model).toBe('gemini-flash-latest');
  });

  it('walks on to other keyed providers when the whole provider is exhausted', async () => {
    useGeminiAndGroq();
    mockCreate
      .mockRejectedValueOnce(dailyQuotaError())  // gemini-pro (active selection)
      .mockRejectedValueOnce(minuteQuotaError()) // gemini-flash
      .mockRejectedValueOnce(minuteQuotaError()) // gemini-flash-lite
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Von Groq.' } }] });

    const res = await explain();

    expect(res.status).toBe(200);
    expect(res.body.explanation).toBe('Von Groq.');
    expect(mockCreate.mock.calls[3][0].model).toBe('openai/gpt-oss-120b');
  });

  it('remembers the exhausted model and skips it on the next definition', async () => {
    useGeminiAndGroq();
    mockCreate
      .mockRejectedValueOnce(dailyQuotaError())
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Erste.' } }] });
    await explain();

    mockCreate.mockClear();
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'Zweite.' } }] });
    const res = await explain();

    expect(res.status).toBe(200);
    // gemini-pro is cooling down → the first call goes straight to the sibling.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].model).toBe('gemini-flash-latest');
  });

  it('shares the cooldown memory with the chat (picker badges see it)', async () => {
    useGeminiAndGroq();
    mockCreate
      .mockRejectedValueOnce(dailyQuotaError())
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Ok.' } }] });
    await explain();

    const res = await request(app).get('/api/quota-cooldowns');
    expect(res.body.cooldowns).toContainEqual(
      expect.objectContaining({ provider: 'gemini', model: 'gemini-pro-latest', kind: 'daily' })
    );
  });

  it('fails with a clear message when every cloud candidate is exhausted', async () => {
    useGeminiAndGroq();
    mockCreate.mockRejectedValue(dailyQuotaError());

    const res = await explain();

    expect(res.status).toBe(500);
    // Tried: gemini pro (active selection) + flash + flash lite, groq
    // gpt-oss + llama = 5 keyed cloud models. Paid models beyond the active
    // selection are never ladder material (cost tiers 2026-07-30).
    expect(mockCreate).toHaveBeenCalledTimes(5);
    expect(res.body.error).toMatch(/local model/i);
  });

  it('treats a retired model (404) like a quota and moves on', async () => {
    useGeminiAndGroq();
    mockCreate
      .mockRejectedValueOnce(
        Object.assign(new Error('model gemini-pro-latest not found or no longer available'), { status: 404 })
      )
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Trotzdem da.' } }] });

    const res = await explain();

    expect(res.status).toBe(200);
    expect(res.body.explanation).toBe('Trotzdem da.');
  });

  it('does NOT fail over on non-quota errors (e.g. an invalid key)', async () => {
    useGeminiAndGroq();
    mockCreate.mockRejectedValue(Object.assign(new Error('Incorrect API key provided'), { status: 401 }));

    const res = await explain();

    expect(res.status).toBe(500);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(res.body.error).toContain('Incorrect API key');
  });

  it('never falls over from the local provider to the cloud (privacy guard)', async () => {
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'ollama');
    setSetting(db, 'gemini_api_key', 'AIza-test'); // a key exists — must stay unused
    mockCreate.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:11434'));

    const res = await explain();

    expect(res.status).toBe(500);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
