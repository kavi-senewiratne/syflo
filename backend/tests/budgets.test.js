/**
 * tests/budgets.test.js
 *
 * ADR-0008 slice 4: context budgets and the full-text-vs-retrieval threshold
 * are derived from the ACTIVE model (registry: contextWindowTokens,
 * budgetCapTokens) instead of globally from OLLAMA_CONTEXT_LENGTH. The budget
 * cap protects free quotas despite huge windows (Gemini: 1M window, cap).
 */

const path = require('path');
const fs = require('fs');
const { createDb } = require('../database');
const { setSetting } = require('../llm');
const { contextBudget, RESERVED_TOKENS, CHARS_PER_TOKEN } = require('../ancestor-context');
const { getModelInfo } = require('../registry');

const TEST_DB_PATH = path.join(__dirname, 'budgets_test.db');

let db;

beforeEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

describe('contextBudget(db)', () => {
  it('derives the char budget from the active cloud model’s budget cap', () => {
    setSetting(db, 'llm_provider', 'gemini');
    setSetting(db, 'gemini_model', 'gemini-flash-latest');

    const info = getModelInfo(db, 'gemini', 'gemini-flash-latest');
    const budget = contextBudget(db);

    // The CAP is what counts, not the 1M window.
    expect(info.contextWindowTokens).toBeGreaterThan(info.budgetCapTokens);
    expect(budget.maxSystemContextChars).toBe(
      Math.floor((info.budgetCapTokens - RESERVED_TOKENS) * CHARS_PER_TOKEN)
    );
    // The real window stays visible for the window warning system.
    expect(budget.contextWindowTokens).toBe(info.contextWindowTokens);
  });

  it('keeps the env-derived window for the local provider', () => {
    setSetting(db, 'llm_provider', 'ollama');
    const windowTokens = parseInt(process.env.OLLAMA_CONTEXT_LENGTH, 10) || 16384;

    const budget = contextBudget(db);

    expect(budget.contextWindowTokens).toBe(windowTokens);
    expect(budget.maxSystemContextChars).toBe(
      Math.floor((windowTokens - RESERVED_TOKENS) * CHARS_PER_TOKEN)
    );
  });

  it('caps Groq at its free-tier 8k TPM despite the 131k window (413 incident 2026-07-25)', () => {
    setSetting(db, 'llm_provider', 'groq');
    setSetting(db, 'groq_model', 'openai/gpt-oss-120b');

    const groqBudget = contextBudget(db);
    const info = getModelInfo(db, 'groq', 'openai/gpt-oss-120b');

    // Groq's free tier rejects any request above ~8k tokens outright (413),
    // so the budget must stay under that — long papers go retrieval mode.
    expect(info.budgetCapTokens).toBe(8000);
    expect(groqBudget.maxSystemContextChars).toBe(
      Math.floor((8000 - RESERVED_TOKENS) * CHARS_PER_TOKEN)
    );

    setSetting(db, 'llm_provider', 'gemini');
    expect(contextBudget(db).maxSystemContextChars).toBeGreaterThan(groqBudget.maxSystemContextChars);
  });
});
