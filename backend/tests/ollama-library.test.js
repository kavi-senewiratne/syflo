/**
 * tests/ollama-library.test.js
 *
 * The settings library's downloads (grill 2026-10-27, decisions 7 and 9):
 * POST /api/settings/ollama-pull streams Ollama's progress lines through to
 * the client and, once the pull succeeds, bakes the 32k context window into
 * the model (decision 7: `/v1` ignores num_ctx and the daemon's own default
 * is 4096 on cards under 24 GB — a paper would be cut off silently). DELETE
 * /api/settings/ollama-models/:name removes a model. The daemon is a fake
 * that records what it was asked.
 */

jest.mock('openai');
const OpenAI = require('openai');

const request = require('supertest');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { createApp } = require('../server');
const { createDb } = require('../database');
const { getSetting } = require('../llm');
const { getModelInfo } = require('../registry');

const TEST_DB_PATH = path.join(__dirname, 'ollama_library_test.db');

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

// A fake Ollama daemon. `pullLines` are the NDJSON lines /api/pull streams;
// every call is recorded in `calls` as { path, body }.
function fakeOllama({ pullLines, createOk = true, deleteOk = true } = {}) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const p = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path: p, method: init.method || 'GET', body });
    if (p === '/api/pull') {
      // Like the real fetch body: Uint8Array chunks (NOT Buffers — a Buffer
      // hides the toString trap), split mid-line to prove the reader buffers.
      const bytes = new TextEncoder().encode(pullLines.map((l) => JSON.stringify(l) + '\n').join(''));
      const cut = Math.floor(bytes.length / 2);
      return { ok: true, status: 200, body: Readable.from([bytes.slice(0, cut), bytes.slice(cut)]) };
    }
    if (p === '/api/create') return { ok: createOk, status: createOk ? 200 : 500, json: async () => ({ status: 'success' }) };
    if (p === '/api/tags') return { ok: true, status: 200, json: async () => ({ models: [{ name: 'gemma4:12b', size: 8e9, details: { parameter_size: '12B' } }] }) };
    if (p === '/api/show') return { ok: true, status: 200, json: async () => ({ capabilities: ['vision', 'completion'] }) };
    if (p === '/api/delete') return { ok: deleteOk, status: deleteOk ? 200 : 404, json: async () => ({}) };
    return { ok: false, status: 404 };
  };
  return { fetchFn, calls };
}

const SUCCESSFUL_PULL = [
  { status: 'pulling manifest' },
  { status: 'pulling abc', digest: 'sha256:abc', total: 1000, completed: 500 },
  { status: 'pulling abc', digest: 'sha256:abc', total: 1000, completed: 1000 },
  { status: 'verifying sha256 digest' },
  { status: 'success' },
];

function lines(text) {
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('POST /api/settings/ollama-pull', () => {
  it('streams the daemon\'s progress and ends with the model ready at a 32k window', async () => {
    const ollama = fakeOllama({ pullLines: SUCCESSFUL_PULL });
    const app = createApp(db, { ollamaFetch: ollama.fetchFn });

    const res = await request(app).post('/api/settings/ollama-pull').send({ model: 'qwen3.5:9b' });

    expect(res.status).toBe(200);
    const out = lines(res.text);
    // Progress lines pass through untouched — the bar is driven by them.
    expect(out[1]).toMatchObject({ total: 1000, completed: 500 });
    // The window is baked in with Ollama's create API (from = the pulled model).
    const create = ollama.calls.find((c) => c.path === '/api/create');
    expect(create.body).toMatchObject({ model: 'qwen3.5:9b', from: 'qwen3.5:9b', parameters: { num_ctx: 32768 } });
    // And the last line says so, so the library can show "ready".
    expect(out[out.length - 1]).toEqual({ status: 'ready', model: 'qwen3.5:9b', contextLength: 32768 });
    // From now on the budget for this model is derived from the baked window.
    expect(getModelInfo(db, 'ollama', 'qwen3.5:9b').contextWindowTokens).toBe(32768);
  });

  it('does not bake anything when the pull fails', async () => {
    const ollama = fakeOllama({ pullLines: [{ status: 'pulling manifest' }, { error: 'pull model manifest: file does not exist' }] });
    const app = createApp(db, { ollamaFetch: ollama.fetchFn });

    const res = await request(app).post('/api/settings/ollama-pull').send({ model: 'nope:1b' });

    expect(res.status).toBe(200);
    expect(ollama.calls.some((c) => c.path === '/api/create')).toBe(false);
    expect(lines(res.text).pop()).toMatchObject({ error: expect.stringContaining('does not exist') });
    expect(getSetting(db, 'ollama_context_length:nope:1b')).toBeUndefined();
  });

  it('reports the pulled model without a baked window when create fails, instead of lying', async () => {
    const ollama = fakeOllama({ pullLines: SUCCESSFUL_PULL, createOk: false });
    const app = createApp(db, { ollamaFetch: ollama.fetchFn });

    const res = await request(app).post('/api/settings/ollama-pull').send({ model: 'qwen3.5:9b' });

    expect(lines(res.text).pop()).toEqual({ status: 'ready', model: 'qwen3.5:9b', contextLength: null });
  });

  it('rejects a missing model name and a daemon that is down', async () => {
    const ollama = fakeOllama({ pullLines: SUCCESSFUL_PULL });
    const app = createApp(db, { ollamaFetch: ollama.fetchFn });
    expect((await request(app).post('/api/settings/ollama-pull').send({})).status).toBe(400);

    const down = createApp(db, { ollamaFetch: async () => { throw new Error('ECONNREFUSED'); } });
    expect((await request(down).post('/api/settings/ollama-pull').send({ model: 'qwen3.5:9b' })).status).toBe(503);
  });
});

describe('DELETE /api/settings/ollama-models/:name', () => {
  it('asks the daemon to delete the model', async () => {
    const ollama = fakeOllama({});
    const app = createApp(db, { ollamaFetch: ollama.fetchFn });

    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('ollama_context_length:qwen3.5:9b', '32768');
    const res = await request(app).delete('/api/settings/ollama-models/qwen3.5:9b');

    expect(res.status).toBe(200);
    expect(ollama.calls.find((c) => c.path === '/api/delete')).toMatchObject({ method: 'DELETE', body: { model: 'qwen3.5:9b' } });
    // The window Syflo knew about that blob goes with it.
    expect(getSetting(db, 'ollama_context_length:qwen3.5:9b')).toBeUndefined();
  });

  it('passes the daemon\'s refusal on', async () => {
    const ollama = fakeOllama({ deleteOk: false });
    const app = createApp(db, { ollamaFetch: ollama.fetchFn });
    const res = await request(app).delete('/api/settings/ollama-models/ghost:1b');
    expect(res.status).toBe(502);
  });
});

describe('installed models and their window (decision 7 for models pulled outside Syflo)', () => {
  it('lists the known window per installed model — null until measured or baked', async () => {
    const ollama = fakeOllama({});
    const app = createApp(db, { ollamaFetch: ollama.fetchFn });

    let res = await request(app).get('/api/settings/ollama-models');
    expect(res.body.models[0]).toMatchObject({ name: 'gemma4:12b', contextLength: null });

    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('ollama_context_length:gemma4:12b', '4096');
    res = await request(app).get('/api/settings/ollama-models');
    expect(res.body.models[0].contextLength).toBe(4096);
  });

  it('bakes the 32k window into an already installed model on request', async () => {
    const ollama = fakeOllama({});
    const app = createApp(db, { ollamaFetch: ollama.fetchFn });
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('ollama_context_length:gemma4:12b', '4096');

    const res = await request(app).post('/api/settings/ollama-models/gemma4:12b/context');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ model: 'gemma4:12b', contextLength: 32768 });
    expect(ollama.calls.find((c) => c.path === '/api/create').body).toMatchObject({ model: 'gemma4:12b', from: 'gemma4:12b', parameters: { num_ctx: 32768 } });
    expect(getModelInfo(db, 'ollama', 'gemma4:12b').contextWindowTokens).toBe(32768);
  });

  it('says so when the daemon refuses to set the window', async () => {
    const ollama = fakeOllama({ createOk: false });
    const app = createApp(db, { ollamaFetch: ollama.fetchFn });
    const res = await request(app).post('/api/settings/ollama-models/gemma4:12b/context');
    expect(res.status).toBe(502);
  });
});

