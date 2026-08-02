/**
 * llm.js
 *
 * Central place that returns the right OpenAI client and model name based
 * on the user settings. With this, no route has to decide directly anymore
 * whether Ollama or OpenAI is used.
 *
 * Settings table (see database.js):
 *   llm_provider:     'ollama' | 'openai'
 *   openai_api_key:   raw secret (never leaves the backend)
 *   openai_model:     e.g. 'gpt-4o' or 'gpt-4o-mini'
 *   ollama_model:     e.g. 'llama3.2-vision:11b'
 */

const OpenAI = require('openai');
const { getRegistry, CLOUD_PROVIDERS } = require('./registry');

const DEFAULTS = {
  // ADR-0008: Cloud is the default — a fresh install starts on Gemini 2.5
  // Flash with a guided empty state (get a key OR switch to local).
  llm_provider: 'gemini',
  openai_api_key: '',
  openai_model: 'gpt-4o-mini',
  gemini_api_key: '',
  gemini_model: 'gemini-flash-latest',
  groq_api_key: '',
  groq_model: 'openai/gpt-oss-120b',
  anthropic_api_key: '',
  anthropic_model: 'claude-sonnet-4-5',
  ollama_model: 'qwen3.5:9b',
  // Custom instructions (CONTEXT.md): free text from the user that is
  // passed along with every chat system prompt. The toggle is stored as a
  // 'true'/'false' string in the TEXT column of the settings table.
  custom_instructions: '',
  custom_instructions_enabled: 'true',
};

function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : DEFAULTS[key];
}

function setSetting(db, key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

function getAllSettings(db) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) out[key] = getSetting(db, key);
  return out;
}

/**
 * Returns `{ client, model }` based on current settings. Throws if the
 * configured provider isn't usable (e.g. OpenAI selected but no API key).
 */
function getLLMClient(db) {
  return getLLMClientFor(db, getSetting(db, 'llm_provider'));
}

/**
 * Resolves a SPECIFIC provider to a client, regardless of which provider is
 * globally active — the automatic quota failover (user request 2026-07-25)
 * answers a single request via a fallback provider without touching the
 * stored settings.
 */
function getLLMClientFor(db, provider) {
  if (provider === 'ollama') {
    return {
      client: new OpenAI({
        baseURL: 'http://localhost:11434/v1',
        apiKey: 'ollama',
      }),
      model: getSetting(db, 'ollama_model'),
      provider: 'ollama',
    };
  }

  // Cloud providers (ADR-0008): all speak OpenAI-compatible, only baseURL
  // and key differ. The key is always the user's own.
  const reg = getRegistry(db);
  const p = reg.providers[provider];
  if (!p) {
    const err = new Error(`Unknown provider '${provider}'.`);
    err.status = 400;
    throw err;
  }
  const apiKey = getSetting(db, `${provider}_api_key`);
  if (!apiKey) {
    const err = new Error(
      `${p.label} is selected but no API key is configured yet. Add your own key in Settings — or switch to the local model.`
    );
    err.status = 400;
    // Machine-readable cause for the UI card (mockup-model-flow §05) —
    // the prose above stays backend-internal.
    err.failReason = 'no_key';
    err.failProvider = provider;
    throw err;
  }
  // maxRetries 0: the SDK's built-in 429 retry (default 2×) sleeps out the
  // provider's Retry-After INVISIBLY before our route's retry/failover loop
  // even sees the error — with Google's ~35 s retryDelay that stacked up to
  // minutes of silent waiting (live incident 2026-07-26). The messages
  // route owns the retry policy: visible countdown, cooldown memory,
  // failover ladder.
  const opts = { apiKey, maxRetries: 0 };
  if (p.baseURL) opts.baseURL = p.baseURL;
  return {
    client: new OpenAI(opts),
    model: getSetting(db, `${provider}_model`),
    provider,
  };
}

/**
 * Verifies that an OpenAI API key actually works by hitting the cheapest
 * auth-required endpoint (`/v1/models`, which only lists model IDs, no tokens
 * consumed). Resolves on success, rejects with a human-readable Error on failure.
 */
async function testProviderKey(db, provider, apiKey) {
  const p = getRegistry(db).providers[provider];
  const opts = { apiKey };
  if (p && p.baseURL) opts.baseURL = p.baseURL;
  const client = new OpenAI(opts);
  try {
    await client.models.list();
  } catch (err) {
    // OpenAI SDK errors expose status + message; surface a clean message.
    const status = err?.status || err?.response?.status;
    if (status === 401) throw new Error('The API key is invalid or has been revoked.');
    if (status === 429) throw new Error('Rate limited — try again in a moment.');
    throw new Error(err?.message || `Could not reach ${p ? p.label : provider} to verify the key.`);
  }
}

/** Backwards-compatible wrapper (old callers/tests). */
async function testOpenAIKey(apiKey) {
  return testProviderKey(null, 'openai', apiKey);
}

/**
 * Extra parameters for LLM calls that must answer immediately (definitions,
 * titles, summaries): suppresses the thinking phase of reasoning models on
 * Ollama (/v1 translates reasoning_effort 'none' → think off).
 */
function noThinkExtras(provider) {
  // Ollama /v1 understands 'none' (thinking off). Gemini's NEW alias models
  // (gemini-flash-latest, 2026-07) reject 'none' with a bare 400 — 'low' is
  // the minimum they accept; same for Groq's gpt-oss. If a provider fails on
  // the flag anyway, the degradation ladder in tools.js takes over.
  if (provider === 'ollama') return { reasoning_effort: 'none' };
  if (provider === 'gemini' || provider === 'groq') return { reasoning_effort: 'low' };
  return {};
}

/**
 * Keeps the Ollama model (and thus the KV prefix cache with the ingested
 * paper) in memory for 1 h. The OpenAI-compatible endpoint ignores
 * keep_alive — only the native API sets the TTL; an empty prompt loads
 * without generating (done_reason 'load'). Errors are never fatal.
 */
async function extendOllamaKeepAlive(model) {
  try {
    await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', keep_alive: '1h' }),
    });
  } catch { /* Ollama unreachable — the TTL simply stays at the default */ }
}

module.exports = { getLLMClient, getLLMClientFor, getSetting, setSetting, getAllSettings, testOpenAIKey, testProviderKey, noThinkExtras, extendOllamaKeepAlive, DEFAULTS, CLOUD_PROVIDERS };
