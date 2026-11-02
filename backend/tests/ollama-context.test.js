/**
 * tests/ollama-context.test.js
 *
 * Decision 7 (grill 2026-10-27), second half: the window Syflo budgets with is
 * the one the daemon REALLY loaded, read from /api/ps after a model is in
 * memory — never an environment variable nobody set. A model pulled in the
 * terminal (no baking) gets its true window this way too.
 */

const path = require('path');
const fs = require('fs');
const { createDb } = require('../database');
const { recordOllamaContextLength } = require('../llm');
const { getModelInfo } = require('../registry');

const TEST_DB_PATH = path.join(__dirname, 'ollama_context_test.db');
let db;

beforeEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
});
afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

function psAnswering(models) {
  return async (url) => {
    if (!url.endsWith('/api/ps')) return { ok: false, status: 404 };
    return { ok: true, json: async () => ({ models }) };
  };
}

describe('recordOllamaContextLength', () => {
  it('stores the window the daemon loaded the model with, and the budget follows it', async () => {
    const fetchFn = psAnswering([{ name: 'qwen3.5:9b', model: 'qwen3.5:9b', context_length: 4096 }]);

    const n = await recordOllamaContextLength(db, 'qwen3.5:9b', fetchFn);

    expect(n).toBe(4096);
    expect(getModelInfo(db, 'ollama', 'qwen3.5:9b').contextWindowTokens).toBe(4096);
  });

  it('matches a bare tag against the daemon\'s :latest spelling', async () => {
    const fetchFn = psAnswering([{ name: 'gemma4:latest', model: 'gemma4:latest', context_length: 32768 }]);
    expect(await recordOllamaContextLength(db, 'gemma4', fetchFn)).toBe(32768);
  });

  it('leaves the stored value alone when the model is not loaded or the daemon is down', async () => {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('ollama_context_length:qwen3.5:9b', '32768');

    expect(await recordOllamaContextLength(db, 'qwen3.5:9b', psAnswering([]))).toBeNull();
    expect(await recordOllamaContextLength(db, 'qwen3.5:9b', async () => { throw new Error('down'); })).toBeNull();
    expect(getModelInfo(db, 'ollama', 'qwen3.5:9b').contextWindowTokens).toBe(32768);
  });
});
