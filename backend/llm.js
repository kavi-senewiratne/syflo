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
  // Web search key (2026-08-21): Tavily is the search provider (ADR-0012).
  // Listed here only so getSetting has a default; it
  // is never included in the settings response (see buildResponse).
  tavily_api_key: '',
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
 * Only ONE system message survives the trip to a provider — everything else
 * becomes a labelled user turn (bug found live 2026-08-10).
 *
 * Gemini's OpenAI-compatibility layer maps `role: 'system'` onto Gemini's
 * single `systemInstruction` field. With several system messages in the array
 * the LAST one WINS and every earlier one is silently discarded — measured
 * against gemini-flash-lite-latest:
 *
 *   [systemA, question]            → knows A          (prompt_tokens 32)
 *   [systemA, question, systemB]   → knows only B     (prompt_tokens 32)
 *
 * No error, no warning, identical token count. Syflo puts the paper full text
 * and the inherited branch context in the FIRST system message, and since the
 * branch focus (2026-08-08) and the instruction sandwich (2026-08-09) it
 * appends further system messages behind the history. On Gemini those
 * trailing blocks therefore deleted the source and the whole ancestor context:
 * a 71,881-character prompt arrived as 885 tokens and the model answered "I
 * have no access to the PDF" — exactly the user's report.
 *
 * The trailing blocks must keep their position (that is the whole point of
 * both fixes: what must be obeyed belongs next to the question), so they are
 * not merged into the front. They become user turns with a short prefix that
 * keeps them readable as instructions rather than as something the user said.
 * The first system message stays untouched, so Ollama's shared KV prefix is
 * unaffected.
 */
const LATE_INSTRUCTION_PREFIX =
  '[System instruction — treat this with the same authority as the system prompt]\n';

function normalizeSystemMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  let systemSeen = false;
  return messages.map((m) => {
    if (!m || m.role !== 'system') return m;
    if (!systemSeen) {
      systemSeen = true;
      return m;
    }
    // Only plain text blocks are ever pushed as late system messages; anything
    // else (multimodal arrays) is left alone rather than mangled.
    if (typeof m.content !== 'string') return { ...m, role: 'user' };
    return { ...m, role: 'user', content: LATE_INSTRUCTION_PREFIX + m.content };
  });
}

/**
 * Wraps `fetch` so an error body that arrives as a JSON ARRAY is unpacked to
 * its first element before the SDK ever sees it.
 *
 * Why (measured 2026-08-11 against the real Gemini key): the
 * OpenAI-compatible Gemini endpoint answers every error with
 *
 *   [{"error":{"code":429,"message":"… limit: 0 … Please retry in 32.07s",
 *              "status":"RESOURCE_EXHAUSTED","details":[…QuotaFailure…]}}]
 *
 * while `APIError.generate` in the SDK reads `body['error']` — `undefined` for
 * an array. The result was `err.message === '429 status code (no body)'` and
 * `err.error === undefined`, which made EVERY regex classifier in quota.js
 * blind against Gemini: a daily limit was counted as a 90 s minute limit (the
 * false countdowns). Repairing the body here fixes all of them at once
 * instead of teaching each classifier a second, array-shaped input.
 *
 * Only failures are touched — a successful (or streaming) response is passed
 * through untouched, so nothing on the happy path changes.
 */
function unwrapProviderErrors(baseFetch) {
  const impl = baseFetch || ((...args) => fetch(...args));
  return async (url, init) => {
    const res = await impl(url, init);
    if (res.ok) return res;
    let text;
    try {
      text = await res.clone().text();
    } catch {
      return res; // body already consumed or not readable — leave it alone
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return res; // HTML error page, empty body — nothing to unwrap
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return res;
    const headers = new Headers(res.headers);
    // The re-serialised body has a different length; a stale content-length
    // would make the SDK's reader hang or truncate.
    headers.delete('content-length');
    return new Response(JSON.stringify(parsed[0]), {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };
}

/**
 * Wraps a client so EVERY chat completion goes through
 * normalizeSystemMessages. Done here rather than at the call sites because
 * there are many (chat answers, /btw, /explain, titles, outcome lines, the
 * cloud ladder) and forgetting one reintroduces a silent, invisible bug.
 */
function withMessageNormalization(client) {
  const create = client.chat.completions.create.bind(client.chat.completions);
  client.chat.completions.create = (body, opts) =>
    create(
      body && Array.isArray(body.messages)
        ? { ...body, messages: normalizeSystemMessages(body.messages) }
        : body,
      opts
    );
  return client;
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
      client: withMessageNormalization(new OpenAI({
        baseURL: 'http://localhost:11434/v1',
        apiKey: 'ollama',
      })),
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
  // Array-shaped error bodies are unpacked before the SDK builds its error
  // (see unwrapProviderErrors): Gemini sends them, and a well-formed body
  // passes through untouched, so every cloud provider can share the wrapper.
  const opts = { apiKey, maxRetries: 0, fetch: unwrapProviderErrors() };
  if (p.baseURL) opts.baseURL = p.baseURL;
  return {
    client: withMessageNormalization(new OpenAI(opts)),
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
  // Same unwrapping as the chat clients: Gemini rejects a wrong key with a
  // 400 whose body is an array, which the SDK would report as
  // "400 status code (no body)" instead of "Invalid Auth key."
  const opts = { apiKey, fetch: unwrapProviderErrors() };
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
function noThinkExtras(provider, model = null) {
  // Ollama /v1 understands 'none' (thinking off). Gemini's NEW alias models
  // (gemini-flash-latest, 2026-07) reject 'none' with a bare 400 — 'low' is
  // the minimum they accept; same for Groq's gpt-oss. If a provider fails on
  // the flag anyway, the degradation ladder in tools.js takes over.
  if (provider === 'ollama') return { reasoning_effort: 'none' };
  // Groq's Qwen models are the exception on their own provider (measured
  // 2026-09-04, when qwen3.8-27b replaced the retired Llama): they accept
  // 'none' and then genuinely do not think, whereas 'low' makes them fill a
  // `reasoning` field — thinking, on a request whose whole point was to turn
  // thinking off. gpt-oss is the mirror image: 'none' comes back as
  // "`reasoning_effort` must be one of `low`, `medium`, or `high`". One
  // provider, two answers, so the model has to decide it.
  // The model is optional: callers that do not know it keep 'low', which
  // every Groq model accepts.
  if (provider === 'groq') {
    return { reasoning_effort: /^qwen\//i.test(model || '') ? 'none' : 'low' };
  }
  if (provider === 'gemini') return { reasoning_effort: 'low' };
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

module.exports = { getLLMClient, getLLMClientFor, normalizeSystemMessages, withMessageNormalization, unwrapProviderErrors, getSetting, setSetting, getAllSettings, testOpenAIKey, testProviderKey, noThinkExtras, extendOllamaKeepAlive, DEFAULTS, CLOUD_PROVIDERS };
