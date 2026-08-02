/**
 * tests/registry.test.js
 *
 * ADR-0008: model registry + cloud providers under user-owned keys.
 * The registry is the single source of truth for which providers/models exist,
 * what they can do (vision/thinking), how big their context window and budget
 * cap are, and what they cost. Settings grow per-provider keys; getLLMClient
 * resolves every provider to an OpenAI-compatible client.
 */

jest.mock('openai');
const OpenAI = require('openai');

const request = require('supertest');
const path = require('path');
const fs = require('fs');
const { createApp } = require('../server');
const { createDb } = require('../database');
const { getLLMClient } = require('../llm');
const { getRegistry, getModelInfo } = require('../registry');

const TEST_DB_PATH = path.join(__dirname, 'registry_test.db');

let app;
let db;

beforeEach(() => {
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

describe('model registry', () => {
  it('knows all five providers with their kind and base URL', () => {
    const reg = getRegistry(db);
    expect(Object.keys(reg.providers).sort()).toEqual(
      ['anthropic', 'gemini', 'groq', 'ollama', 'openai'].sort()
    );
    expect(reg.providers.ollama.kind).toBe('local');
    expect(reg.providers.gemini.kind).toBe('cloud');
    expect(reg.providers.groq.baseURL).toMatch(/groq/);
    expect(reg.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('describes every curated cloud model with capability flags and budgets', () => {
    const reg = getRegistry(db);
    for (const key of ['gemini', 'groq', 'openai', 'anthropic']) {
      const models = reg.providers[key].models;
      expect(models.length).toBeGreaterThan(0);
      for (const m of models) {
        expect(typeof m.vision).toBe('boolean');
        expect(typeof m.canThink).toBe('boolean');
        expect(m.contextWindowTokens).toBeGreaterThan(0);
        expect(m.budgetCapTokens).toBeGreaterThan(0);
        expect(m.budgetCapTokens).toBeLessThanOrEqual(m.contextWindowTokens);
      }
    }
  });

  it('marks Groq gpt-oss-120b as text-only and Gemini Flash as vision-capable', () => {
    const oss = getModelInfo(db, 'groq', 'openai/gpt-oss-120b');
    expect(oss.vision).toBe(false);
    const flash = getModelInfo(db, 'gemini', 'gemini-flash-latest');
    expect(flash.vision).toBe(true);
    expect(flash.contextWindowTokens).toBeGreaterThanOrEqual(1000000);
  });

  it('treats installed Ollama models as vision-capable with the env window', () => {
    const info = getModelInfo(db, 'ollama', 'qwen3.5:9b');
    expect(info.vision).toBe(true);
    expect(info.contextWindowTokens).toBeGreaterThan(0);
  });

  it('is served to the frontend via GET /api/settings/registry', async () => {
    const res = await request(app).get('/api/settings/registry');
    expect(res.status).toBe(200);
    expect(res.body.providers.gemini.models.map((m) => m.name)).toContain('gemini-flash-latest');
    // Prices are the basis for estimates — the as-of date must be visible.
    expect(res.body.asOf).toBeDefined();
  });
});

describe('cost tiers (mockup-model-cost-tiers, decisions 2026-07-30)', () => {
  it('marks Gemini Pro as paid-only with no free quota', () => {
    const pro = getModelInfo(db, 'gemini', 'gemini-pro-latest');
    expect(pro.free).toBe(false);
    expect(pro.freeQuota).toBeUndefined();
  });

  it('carries the real Gemini Flash free quota (5 RPM / 20 RPD)', () => {
    const flash = getModelInfo(db, 'gemini', 'gemini-flash-latest');
    expect(flash.free).toBe(true);
    expect(flash.freeQuota.requestsPerMinute).toBe(5);
    expect(flash.freeQuota.requestsPerDay).toBe(20);
  });

  it('offers Gemini Flash Lite as a free model with a 500/day quota', () => {
    const lite = getModelInfo(db, 'gemini', 'gemini-flash-lite-latest');
    expect(lite.free).toBe(true);
    expect(lite.freeQuota.requestsPerDay).toBe(500);
    expect(lite.vision).toBe(true);
    expect(lite.pricing.inputPerMTok).toBeGreaterThan(0);
  });
});

describe('cloud defaults (ADR-0008: cloud is the default)', () => {
  it('starts a fresh install on Gemini 2.5 Flash', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.body.llm_provider).toBe('gemini');
    expect(res.body.gemini_model).toBe('gemini-flash-latest');
    expect(res.body.gemini_api_key_set).toBe(false);
  });
});

describe('per-provider keys', () => {
  it('accepts and validates a Gemini key, never returning it raw', async () => {
    const res = await request(app).put('/api/settings').send({ gemini_api_key: 'AIza-secret' });
    expect(res.status).toBe(200);
    expect(res.body.gemini_api_key_set).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('AIza-secret');
  });

  it('rejects an invalid Groq key with 400 and does not store it', async () => {
    OpenAI.mockImplementation(() => ({
      models: {
        list: jest.fn().mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 })),
      },
    }));
    const res = await request(app).put('/api/settings').send({ groq_api_key: 'gsk-wrong' });
    expect(res.status).toBe(400);
    const get = await request(app).get('/api/settings');
    expect(get.body.groq_api_key_set).toBe(false);
  });

  it('accepts anthropic as provider and stores its model choice', async () => {
    const res = await request(app).put('/api/settings').send({
      llm_provider: 'anthropic',
      anthropic_api_key: 'sk-ant-test',
      anthropic_model: 'claude-haiku-4-5',
    });
    expect(res.status).toBe(200);
    expect(res.body.llm_provider).toBe('anthropic');
    expect(res.body.anthropic_model).toBe('claude-haiku-4-5');
  });

  it('still rejects unknown providers', async () => {
    const res = await request(app).put('/api/settings').send({ llm_provider: 'skynet' });
    expect(res.status).toBe(400);
  });
});

describe('getLLMClient – cloud providers', () => {
  it('resolves gemini to its OpenAI-compatible endpoint with the stored key', async () => {
    await request(app).put('/api/settings').send({
      llm_provider: 'gemini',
      gemini_api_key: 'AIza-123',
    });
    const { client, model, provider } = getLLMClient(db);
    expect(provider).toBe('gemini');
    expect(model).toBe('gemini-flash-latest');
    expect(client._opts.baseURL).toMatch(/generativelanguage/);
    expect(client._opts.apiKey).toBe('AIza-123');
  });

  it('resolves groq with its default model', async () => {
    await request(app).put('/api/settings').send({
      llm_provider: 'groq',
      groq_api_key: 'gsk-123',
    });
    const { client, model, provider } = getLLMClient(db);
    expect(provider).toBe('groq');
    expect(model).toBe('openai/gpt-oss-120b');
    expect(client._opts.baseURL).toMatch(/api\.groq\.com/);
  });

  it('throws a friendly error when a cloud provider has no key yet', async () => {
    // Fresh state: default is gemini, but without a key.
    expect(() => getLLMClient(db)).toThrow(/key/i);
  });

  it('still resolves ollama locally without any key', async () => {
    await request(app).put('/api/settings').send({ llm_provider: 'ollama' });
    const { client, provider } = getLLMClient(db);
    expect(provider).toBe('ollama');
    expect(client._opts.baseURL).toBe('http://localhost:11434/v1');
  });
});
