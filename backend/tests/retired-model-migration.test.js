/**
 * tests/retired-model-migration.test.js
 *
 * A model the provider switched off must not stay selected.
 *
 * Groq retired `llama-3.3-70b-versatile` for free and developer keys in August
 * 2026 (announced 2026-06-17). Measured in the running app on 2026-09-04: the
 * picker still had it selected, every request came back
 * `404 model_not_found`, the ladder moved on to the next candidate, and the
 * only sign was a "no longer available" badge — which vanished on the next
 * backend restart, because that state lives in memory. Taking the model out of
 * the registry does not move the stored setting; this does.
 */
const path = require('path');
const fs = require('fs');
const { createDb } = require('../database');
const { getSetting } = require('../llm');
const { getModelInfo } = require('../registry');

const TEST_DB_PATH = path.join(__dirname, 'retired-model-test.db');

function freshDb() {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  return createDb(TEST_DB_PATH);
}

afterEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

describe('a retired Groq model in the settings', () => {
  it('is switched to its replacement on the next start', () => {
    let db = freshDb();
    db.prepare("INSERT INTO settings (key, value) VALUES ('groq_model', 'llama-3.3-70b-versatile')").run();
    db.close();

    db = createDb(TEST_DB_PATH);
    expect(getSetting(db, 'groq_model')).toBe('qwen/qwen3.8-27b');
    db.close();
  });

  it('leaves a model that still exists alone', () => {
    let db = freshDb();
    db.prepare("INSERT INTO settings (key, value) VALUES ('groq_model', 'openai/gpt-oss-120b')").run();
    db.close();

    db = createDb(TEST_DB_PATH);
    expect(getSetting(db, 'groq_model')).toBe('openai/gpt-oss-120b');
    db.close();
  });

  it('is idempotent — a second start changes nothing', () => {
    let db = freshDb();
    db.prepare("INSERT INTO settings (key, value) VALUES ('groq_model', 'llama-3.3-70b-versatile')").run();
    db.close();
    db = createDb(TEST_DB_PATH); db.close();
    db = createDb(TEST_DB_PATH);
    expect(getSetting(db, 'groq_model')).toBe('qwen/qwen3.8-27b');
    db.close();
  });
});

describe('the registry after the swap', () => {
  it('knows the replacement with the numbers the free tier really allows', () => {
    const db = freshDb();
    const info = getModelInfo(db, 'groq', 'qwen/qwen3.8-27b');
    expect(info.label).toBe('Qwen 3.8 27B');
    expect(info.contextWindowTokens).toBe(131072);
    // 8 000 tokens per minute is Groq's free ceiling — a bigger prompt is a
    // 413, not a longer answer.
    expect(info.budgetCapTokens).toBe(8000);
    expect(info.freeQuota.tokensPerMinute).toBe(8000);
    db.close();
  });

  it('no longer offers the retired model', () => {
    const db = freshDb();
    const { getRegistry } = require('../registry');
    const groq = getRegistry(db).providers.groq.models.map((m) => m.name);
    expect(groq).not.toContain('llama-3.3-70b-versatile');
    expect(groq).toContain('qwen/qwen3.8-27b');
    db.close();
  });
});
