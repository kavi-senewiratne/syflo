/**
 * tests/recommendation.test.js
 *
 * GET /api/system/recommendation — what the settings library shows above the
 * installed models (grill 2026-10-27, decisions 6, 9 and 10): the machine's
 * facts, the registry model that fits them, whether it is already pulled, and
 * whether Ollama answers at all. The hardware probes and the Ollama daemon are
 * injected; the registry is the bundled one.
 */

jest.mock('openai');
const OpenAI = require('openai');

const request = require('supertest');
const path = require('path');
const fs = require('fs');
const { createApp } = require('../server');
const { createDb } = require('../database');
const { getRegistry } = require('../registry');

const TEST_DB_PATH = path.join(__dirname, 'recommendation_test.db');
const GB = 1024 * 1024 * 1024;

let db;

beforeEach(() => {
  OpenAI.mockImplementation((opts) => ({ _opts: opts, chat: { completions: { create: jest.fn() } } }));
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

const rtx5080 = {
  platform: 'linux',
  totalmem: () => 62 * GB,
  exec: (cmd) => (cmd === 'nvidia-smi'
    ? { status: 0, stdout: 'NVIDIA GeForce RTX 5080 Laptop GPU, 16303\n' }
    : { status: 127, stdout: '' }),
};

// An Ollama daemon that has pulled exactly `installed`; `null` = unreachable.
function fakeOllama(installed) {
  return async (url) => {
    if (installed === null) throw new Error('ECONNREFUSED');
    if (url.endsWith('/api/tags')) {
      return { ok: true, json: async () => ({ models: installed.map((name) => ({ name })) }) };
    }
    return { ok: false, status: 404 };
  };
}

function appWith(system, ollamaFetch) {
  return createApp(db, { system, ollamaFetch });
}

describe('the registry carries the local models with their memory needs (decision 6)', () => {
  it('lists Ollama models with minMemoryGb and fitsGb, smallest first', () => {
    const models = getRegistry(db).providers.ollama.models;
    expect(models.length).toBeGreaterThanOrEqual(4);
    for (const m of models) {
      expect(typeof m.minMemoryGb).toBe('number');
      expect(m.fitsGb).toBeGreaterThan(m.downloadGb);
      expect(m.vision).toBe(true);
      expect(typeof m.measured).toBe('boolean');
    }
    expect(models[0].name).toBe('qwen3.5:4b');
  });
});

describe('GET /api/system/recommendation', () => {
  it('names the machine and the model that fits it, and whether it is installed', async () => {
    const res = await request(appWith(rtx5080, fakeOllama([]))).get('/api/system/recommendation');
    expect(res.status).toBe(200);
    expect(res.body.hardware).toMatchObject({ basis: 'vram', usableGb: 15.9, gpu: { name: 'NVIDIA GeForce RTX 5080 Laptop GPU' } });
    expect(res.body.recommended).toMatchObject({ name: 'qwen3.5:9b', fits: true, installed: false });
    expect(res.body.ollamaReachable).toBe(true);
    // The library's secondary list: what else would fit this card.
    expect(res.body.alsoFits.map((m) => m.name)).toContain('gemma4:12b');
  });

  it('reports the recommended model as installed once Ollama has it', async () => {
    const res = await request(appWith(rtx5080, fakeOllama(['qwen3.5:9b', 'nomic-embed-text']))).get('/api/system/recommendation');
    expect(res.body.recommended.installed).toBe(true);
  });

  it('still recommends when Ollama is not reachable (decision 10)', async () => {
    const res = await request(appWith(rtx5080, fakeOllama(null))).get('/api/system/recommendation');
    expect(res.status).toBe(200);
    expect(res.body.ollamaReachable).toBe(false);
    expect(res.body.recommended).toMatchObject({ name: 'qwen3.5:9b', installed: false });
  });

  it('offers the smallest model as a CPU fallback on a machine without a GPU', async () => {
    const noGpu = { platform: 'linux', totalmem: () => 16 * GB, exec: () => ({ status: 127, stdout: '' }) };
    const res = await request(appWith(noGpu, fakeOllama([]))).get('/api/system/recommendation');
    expect(res.body.hardware.basis).toBe('cpu');
    expect(res.body.recommended).toMatchObject({ name: 'qwen3.5:4b', fits: false });
  });
});
