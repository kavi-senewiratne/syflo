/**
 * tests/settings.test.js
 *
 * Integration tests for GET/PUT /api/settings + LLM-Provider-Switch.
 * Mocks the OpenAI SDK so we can verify which baseURL/apiKey the helper
 * instantiates when the active provider is changed.
 */

jest.mock('openai');
const OpenAI = require('openai');

const request = require('supertest');
const { createApp } = require('../server');
const { createDb } = require('../database');
const { getLLMClient } = require('../llm');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'settings_test.db');

let app;
let db;

beforeEach(() => {
  // Default mock: any key passes validation (models.list resolves successfully).
  // Individual tests can override the models.list behaviour to simulate failures.
  OpenAI.mockImplementation((opts) => ({
    _opts: opts,
    chat: { completions: { create: jest.fn() } },
    models: { list: jest.fn().mockResolvedValue({ data: [] }) },
  }));
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
  app = createApp(db);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

describe('GET /api/settings', () => {
  it('returns defaults when nothing is configured (ADR-0008: cloud default)', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      llm_provider: 'gemini',
      gemini_model: 'gemini-flash-latest',
      gemini_api_key_set: false,
      openai_model: 'gpt-4o-mini',
      ollama_model: 'qwen3.5:9b',
      openai_api_key_set: false,
      custom_instructions: '',
      custom_instructions_enabled: true,
    });
  });

  it('never returns the raw API key', async () => {
    await request(app).put('/api/settings').send({ openai_api_key: 'sk-supersecret' });
    const res = await request(app).get('/api/settings');
    expect(JSON.stringify(res.body)).not.toContain('sk-supersecret');
    expect(res.body.openai_api_key_set).toBe(true);
  });
});

describe('PUT /api/settings', () => {
  it('updates only the fields that are sent', async () => {
    const res = await request(app).put('/api/settings').send({ llm_provider: 'openai' });
    expect(res.status).toBe(200);
    expect(res.body.llm_provider).toBe('openai');
    // Other fields keep their defaults
    expect(res.body.openai_model).toBe('gpt-4o-mini');
  });

  it('rejects invalid providers', async () => {
    const res = await request(app).put('/api/settings').send({ llm_provider: 'skynet' });
    expect(res.status).toBe(400);
  });

  it('lets the user clear the API key with empty string', async () => {
    await request(app).put('/api/settings').send({ openai_api_key: 'sk-abc' });
    await request(app).put('/api/settings').send({ openai_api_key: '' });
    const res = await request(app).get('/api/settings');
    expect(res.body.openai_api_key_set).toBe(false);
  });
});

// ─── Custom instructions (grill session 2026-07-23) ─────────────────────────
// Free text written by the user that is passed along with every chat system
// prompt. Global, can be disabled without losing the text, max 2000 chars.

describe('custom instructions', () => {
  it('saves the text and returns it on GET', async () => {
    const res = await request(app).put('/api/settings').send({
      custom_instructions: 'Correct my German after every answer.',
    });
    expect(res.status).toBe(200);
    expect(res.body.custom_instructions).toBe('Correct my German after every answer.');

    const get = await request(app).get('/api/settings');
    expect(get.body.custom_instructions).toBe('Correct my German after every answer.');
  });

  it('turns instructions off without deleting the text', async () => {
    await request(app).put('/api/settings').send({ custom_instructions: 'Use analogies.' });
    const res = await request(app).put('/api/settings').send({ custom_instructions_enabled: false });

    expect(res.body.custom_instructions_enabled).toBe(false);
    expect(res.body.custom_instructions).toBe('Use analogies.');
  });

  it('rejects text longer than 2000 characters', async () => {
    const res = await request(app).put('/api/settings').send({
      custom_instructions: 'x'.repeat(2001),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/2000/);

    // The over-long text was not stored.
    const get = await request(app).get('/api/settings');
    expect(get.body.custom_instructions).toBe('');
  });

  it('rejects non-string instructions and non-boolean toggles', async () => {
    expect((await request(app).put('/api/settings').send({ custom_instructions: 42 })).status).toBe(400);
    expect((await request(app).put('/api/settings').send({ custom_instructions_enabled: 'yes' })).status).toBe(400);
  });
});

describe('getLLMClient – provider switching', () => {
  it('returns an Ollama-pointed client when local is selected', async () => {
    await request(app).put('/api/settings').send({ llm_provider: 'ollama' });
    const { client, model, provider } = getLLMClient(db);
    expect(provider).toBe('ollama');
    expect(model).toBe('qwen3.5:9b');
    expect(client._opts.baseURL).toBe('http://localhost:11434/v1');
  });

  it('returns an OpenAI-pointed client when configured', async () => {
    await request(app).put('/api/settings').send({
      llm_provider: 'openai',
      openai_api_key: 'sk-test-123',
      openai_model: 'gpt-4o',
    });
    const { client, model, provider } = getLLMClient(db);
    expect(provider).toBe('openai');
    expect(model).toBe('gpt-4o');
    expect(client._opts.apiKey).toBe('sk-test-123');
    // No baseURL override → SDK uses the real OpenAI endpoint
    expect(client._opts.baseURL).toBeUndefined();
  });

  it('throws a friendly 400 error when OpenAI is selected without a key', async () => {
    await request(app).put('/api/settings').send({ llm_provider: 'openai' });
    expect(() => getLLMClient(db)).toThrow(/no API key/i);
  });
});

describe('PUT /api/settings – key validation', () => {
  it('rejects an invalid OpenAI key with a 400 and does not store it', async () => {
    // Override the default mock so models.list throws a 401 like the real SDK does.
    OpenAI.mockImplementation(() => ({
      models: {
        list: jest.fn().mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 })),
      },
    }));

    const res = await request(app).put('/api/settings').send({ openai_api_key: 'sk-totally-wrong' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid|revoked/i);

    // Check the bad key was NOT persisted.
    const get = await request(app).get('/api/settings');
    expect(get.body.openai_api_key_set).toBe(false);
  });

  it('accepts a valid key and persists it', async () => {
    // Default mock already resolves successfully — simulate a working key.
    const res = await request(app).put('/api/settings').send({ openai_api_key: 'sk-works' });
    expect(res.status).toBe(200);
    expect(res.body.openai_api_key_set).toBe(true);
  });

  it('skips validation when no key field is sent (changing only the model)', async () => {
    // Even though models.list would fail, no key was sent, so PUT should succeed.
    OpenAI.mockImplementation(() => ({
      models: { list: jest.fn().mockRejectedValue(new Error('should not be called')) },
    }));

    const res = await request(app).put('/api/settings').send({ openai_model: 'gpt-4o' });
    expect(res.status).toBe(200);
    expect(res.body.openai_model).toBe('gpt-4o');
  });
});

describe('GET /api/settings/ollama-models', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  // Fake Ollama daemon: /api/tags lists pulled models, /api/show answers
  // per-model capabilities — exactly the two endpoints the route talks to.
  function mockOllama(tags, capsByModel) {
    global.fetch = jest.fn(async (url, opts) => {
      if (String(url).endsWith('/api/tags')) {
        return { ok: true, json: async () => ({ models: tags }) };
      }
      if (String(url).endsWith('/api/show')) {
        const { model } = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ capabilities: capsByModel[model] || [] }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  it('lists only vision-capable models, flagging which can think', async () => {
    mockOllama(
      [
        { name: 'qwen3.5:9b', size: 6600000000, details: { parameter_size: '9B' } },
        { name: 'llama3.2-vision:11b', size: 7816589186, details: { parameter_size: '10.7B' } },
        { name: 'phi4:latest', size: 9053116391, details: { parameter_size: '14.7B' } },
      ],
      {
        'qwen3.5:9b': ['completion', 'vision', 'tools', 'thinking'],
        'llama3.2-vision:11b': ['completion', 'vision'],
        'phi4:latest': ['completion'],
      }
    );

    const res = await request(app).get('/api/settings/ollama-models');

    expect(res.status).toBe(200);
    expect(res.body.models.map((m) => m.name)).toEqual(['qwen3.5:9b', 'llama3.2-vision:11b']);
    expect(res.body.models[0]).toMatchObject({
      name: 'qwen3.5:9b',
      parameter_size: '9B',
      canThink: true,
    });
    expect(res.body.models[1].canThink).toBe(false);
  });

  it('returns 503 with a helpful message when Ollama is unreachable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await request(app).get('/api/settings/ollama-models');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/ollama/i);
  });
});

