/**
 * settings.js
 *
 * Global Syflo settings: which LLM provider is used, which model,
 * and (for OpenAI) the API key.
 *
 * Important: the API key never leaves the backend. GET only returns
 * `openai_api_key_set: true|false` so the frontend can show a status
 * without having to see the key.
 */

const express = require('express');
const { invalidateToolAvailability } = require('../tools');
const { getAllSettings, getSetting, setSetting, testProviderKey, CLOUD_PROVIDERS } = require('../llm');
const { getRegistry, refreshRegistry } = require('../registry');

const ALLOWED_PROVIDERS = new Set(['ollama', ...CLOUD_PROVIDERS]);

const OLLAMA_URL = 'http://localhost:11434';

// The context window Syflo bakes into every model it pulls (grill
// 2026-10-27, decision 7). Ollama's OpenAI-compatible /v1 ignores num_ctx and
// the daemon's own default is 4096 on cards under 24 GB — a paper prompt
// would be cut off at the front without a word. Baking the window into the
// model makes it hold for every client and every platform; the backend's
// budget then derives from this stored value (registry.getModelInfo).
const BAKED_CONTEXT_LENGTH = 32768;

// The settings key under which the known window of a local model is kept:
// written here after baking, and by the /api/ps measurement after a load.
function contextLengthKey(model) {
  return `ollama_context_length:${model}`;
}

function knownContextLengthIn(db, model) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(contextLengthKey(model));
  const n = row && parseInt(row.value, 10);
  return n > 0 ? n : null;
}

// Cap for the custom instructions: they eat into the RESERVED_TOKENS buffer
// (ancestor-context.js) — ~570 tokens at 2000 characters leave enough room
// for tool definitions, history and the answer itself. Since the instruction
// sandwich (2026-08-09) the block is sent TWICE per request (front of the
// system prompt + reminder behind the history), so budget for ~1140 tokens
// at the cap.
const MAX_CUSTOM_INSTRUCTIONS_CHARS = 2000;

function buildResponse(db) {
  const s = getAllSettings(db);
  const out = {
    llm_provider: s.llm_provider,
    ollama_model: s.ollama_model,
    custom_instructions: s.custom_instructions,
    custom_instructions_enabled: s.custom_instructions_enabled === 'true',
  };
  // Web search (2026-08-15, sole provider since ADR-0012): Tavily is the
  // search an npm install can reach on every platform. Same rule as the LLM
  // keys: the frontend learns THAT there is a key, never which.
  out.tavily_api_key_set = Boolean(getSetting(db, 'tavily_api_key'));
  // Plus a fingerprint — first five and last four characters — so the
  // settings can prove "YOUR key made it" after a save from the chat card
  // (user report 2026-09-12: an empty input read as "no key stored"). Nine
  // characters of a low-blast-radius key, never the middle; keys too short
  // to keep the middle secret get no hint at all.
  const tavilyKey = getSetting(db, 'tavily_api_key');
  out.tavily_api_key_hint =
    tavilyKey && tavilyKey.length >= 14
      ? `${tavilyKey.slice(0, 5)}…${tavilyKey.slice(-4)}`
      : null;
  // Per cloud provider: model choice + whether a key is stored. The
  // plaintext key never leaves the backend.
  for (const p of CLOUD_PROVIDERS) {
    out[`${p}_model`] = s[`${p}_model`];
    out[`${p}_api_key_set`] = Boolean(s[`${p}_api_key`]);
  }
  return out;
}

module.exports = (db, options = {}) => {
  const router = express.Router();
  // The daemon is injected for tests; resolved per call so a test that mocks
  // the global fetch keeps working too.
  const ollamaFetch = (...args) => (options.ollamaFetch || fetch)(...args);
  const knownContextLength = (model) => knownContextLengthIn(db, model);

  // GET /api/settings — current settings (never the plaintext API keys)
  router.get('/', (_req, res) => {
    res.json(buildResponse(db));
  });

  // GET /api/settings/registry — curated provider/model lists including
  // capabilities, prices and as-of date (ADR-0008). In the background the
  // remote copy is fetched occasionally (no user data, never fatal).
  router.get('/registry', (_req, res) => {
    refreshRegistry(db).catch(() => {});
    res.json(getRegistry(db));
  });

  // GET /api/settings/ollama-models — proxy to the local Ollama daemon to list
  // models the user has actually pulled. Only vision-capable models are
  // returned (Syflo sends image attachments — a text-only model would fail
  // silently); `canThink` tells the frontend whether to offer the Thinking
  // toggle. Capabilities come from POST /api/show per model.
  router.get('/ollama-models', async (_req, res) => {
    try {
      const r = await ollamaFetch(`${OLLAMA_URL}/api/tags`);
      if (!r.ok) {
        return res.status(502).json({ error: `Ollama responded with status ${r.status}` });
      }
      const data = await r.json();
      const withCaps = await Promise.all(
        (data.models || []).map(async (m) => {
          let capabilities = [];
          try {
            const s = await ollamaFetch(`${OLLAMA_URL}/api/show`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: m.name }),
            });
            if (s.ok) capabilities = (await s.json()).capabilities || [];
          } catch {
            // A single broken model doesn't block the whole list.
          }
          return { model: m, capabilities };
        })
      );
      const models = withCaps
        .filter(({ capabilities }) => capabilities.includes('vision'))
        .map(({ model: m, capabilities }) => ({
          name: m.name,
          size: m.size,
          parameter_size: m.details?.parameter_size,
          canThink: capabilities.includes('thinking'),
          // The window Syflo baked or measured for this model (decision 7);
          // null until the model has been loaded once. A model pulled in the
          // terminal sits at the daemon's default (4096 on cards under
          // 24 GB) — the library shows that and offers the 32k door.
          contextLength: knownContextLength(m.name),
        }));
      res.json({ models });
    } catch (err) {
      // Most common case: Ollama isn't running. Surface that distinctly so the
      // frontend can fall back to a free-text input.
      res.status(503).json({ error: 'Could not reach Ollama at localhost:11434. Is it running?' });
    }
  });

  // POST /api/settings/ollama-pull — downloads a model through the local
  // daemon and streams its progress lines (NDJSON) through 1:1, so the
  // library can draw a bar. After a successful pull the 32k window is baked
  // into the model (decision 7); the final line `{status:'ready', model,
  // contextLength}` tells the library the model is usable — contextLength is
  // null when baking failed, never a guess.
  router.post('/ollama-pull', async (req, res) => {
    const { model } = req.body;
    if (!model || typeof model !== 'string') {
      return res.status(400).json({ error: 'model is required' });
    }
    let r;
    try {
      r = await ollamaFetch(`${OLLAMA_URL}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: true }),
      });
    } catch {
      return res.status(503).json({ error: 'Could not reach Ollama at localhost:11434. Is it running?' });
    }
    if (!r.ok) {
      return res.status(502).json({ error: `Ollama responded with status ${r.status}` });
    }
    res.setHeader('Content-Type', 'application/x-ndjson');
    let succeeded = false;
    let failed = false;
    let buffer = '';
    // fetch's body yields Uint8Array chunks — `chunk.toString()` on those is
    // a comma-separated byte list, not text (seen live 2026-10-27: no line
    // ever parsed, so nothing was baked). Decode properly, across chunks.
    const decoder = new TextDecoder();
    const handleLine = (line) => {
      if (!line.trim()) return;
      res.write(line + '\n');
      try {
        const parsed = JSON.parse(line);
        if (parsed.error) failed = true;
        else if (parsed.status === 'success') succeeded = true;
      } catch { /* a non-JSON line is forwarded but not interpreted */ }
    };
    try {
      for await (const chunk of r.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) handleLine(line);
      }
      if (buffer) handleLine(buffer);
    } catch {
      res.write(JSON.stringify({ error: 'The download was interrupted.' }) + '\n');
      return res.end();
    }
    if (succeeded && !failed) {
      const contextLength = await bakeContextLength(model);
      res.write(JSON.stringify({ status: 'ready', model, contextLength }) + '\n');
    }
    res.end();
  });

  // Writes num_ctx into the pulled model via Ollama's create API (from = the
  // model itself, no second download). Returns the window on success, null
  // when the daemon refused — the caller reports that rather than a number
  // nobody verified.
  async function bakeContextLength(model) {
    try {
      const c = await ollamaFetch(`${OLLAMA_URL}/api/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, from: model, parameters: { num_ctx: BAKED_CONTEXT_LENGTH }, stream: false }),
      });
      if (!c.ok) return null;
      setSetting(db, contextLengthKey(model), String(BAKED_CONTEXT_LENGTH));
      return BAKED_CONTEXT_LENGTH;
    } catch {
      return null;
    }
  }

  // POST /api/settings/ollama-models/:name/context — bakes the 32k window
  // into a model that is already installed (pulled in the terminal, or
  // before this feature existed). Same call the download path makes.
  router.post('/ollama-models/:name/context', async (req, res) => {
    const model = req.params.name;
    const contextLength = await bakeContextLength(model);
    if (!contextLength) {
      return res.status(502).json({ error: 'Ollama could not set the context window on this model.' });
    }
    res.json({ model, contextLength });
  });

  // DELETE /api/settings/ollama-models/:name — removes a model from the
  // daemon (the library's Remove door).
  router.delete('/ollama-models/:name', async (req, res) => {
    const model = req.params.name;
    try {
      const r = await ollamaFetch(`${OLLAMA_URL}/api/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      if (!r.ok) {
        return res.status(502).json({ error: `Ollama responded with status ${r.status}` });
      }
      // The stored window belonged to the blob that is gone — a later pull
      // of the same name starts from zero knowledge, not from a stale 32k.
      db.prepare('DELETE FROM settings WHERE key = ?').run(contextLengthKey(model));
      res.json({ removed: model });
    } catch {
      res.status(503).json({ error: 'Could not reach Ollama at localhost:11434. Is it running?' });
    }
  });

  // PUT /api/settings — partial update. Fields not present in the body
  // remain unchanged. An empty string for the API key deletes it.
  // When a new OpenAI key is set (non-empty string), it is validated
  // against the OpenAI API before it is stored — so the frontend knows
  // immediately whether the key actually works.
  router.put('/', async (req, res) => {
    const { llm_provider, ollama_model, custom_instructions, custom_instructions_enabled } = req.body;

    if (llm_provider !== undefined && !ALLOWED_PROVIDERS.has(llm_provider)) {
      return res.status(400).json({ error: `llm_provider must be one of: ${[...ALLOWED_PROVIDERS].join(', ')}` });
    }

    if (custom_instructions !== undefined) {
      if (typeof custom_instructions !== 'string') {
        return res.status(400).json({ error: 'custom_instructions must be a string' });
      }
      if (custom_instructions.length > MAX_CUSTOM_INSTRUCTIONS_CHARS) {
        return res.status(400).json({ error: `custom_instructions must be at most ${MAX_CUSTOM_INSTRUCTIONS_CHARS} characters` });
      }
    }
    if (custom_instructions_enabled !== undefined && typeof custom_instructions_enabled !== 'boolean') {
      return res.status(400).json({ error: 'custom_instructions_enabled must be a boolean' });
    }

    // Keys are validated BEFORE they are stored — an invalid key never
    // lands in the DB. An empty string deletes the key.
    for (const p of CLOUD_PROVIDERS) {
      const key = req.body[`${p}_api_key`];
      if (typeof key === 'string' && key.length > 0) {
        try {
          await testProviderKey(db, p, key);
        } catch (err) {
          return res.status(400).json({ error: err.message });
        }
      }
    }

    // The search key is stored unvalidated: Tavily has no free "is this key
    // good?" endpoint, and every check would spend one of the 1000 monthly
    // requests. A wrong key surfaces as `tavily-invalid-key` on first use.
    const tavilyKey = req.body.tavily_api_key;
    if (tavilyKey !== undefined) {
      if (typeof tavilyKey !== 'string') {
        return res.status(400).json({ error: 'tavily_api_key must be a string' });
      }
      // An empty string deletes the key, same convention as the LLM keys.
      setSetting(db, 'tavily_api_key', tavilyKey.trim());
      // availableTools caches "is a search configured?" for 15 s so one answer
      // sends a stable tool list; a key written here must not sit behind that
      // window.
      invalidateToolAvailability();
    }

    if (llm_provider !== undefined) setSetting(db, 'llm_provider', llm_provider);
    if (custom_instructions !== undefined) setSetting(db, 'custom_instructions', custom_instructions);
    if (custom_instructions_enabled !== undefined) {
      // TEXT column — store the boolean as a 'true'/'false' string.
      setSetting(db, 'custom_instructions_enabled', custom_instructions_enabled ? 'true' : 'false');
    }
    for (const p of CLOUD_PROVIDERS) {
      const key = req.body[`${p}_api_key`];
      const model = req.body[`${p}_model`];
      if (key !== undefined) setSetting(db, `${p}_api_key`, key);
      if (model !== undefined) setSetting(db, `${p}_model`, model);
    }
    if (ollama_model !== undefined) setSetting(db, 'ollama_model', ollama_model);

    // Provider/model switches affect the send queue (mockup-model-flow §07):
    // waiting local questions whose provider is now cloud start immediately.
    options.onLLMSettingsChanged?.();

    res.json(buildResponse(db));
  });

  return router;
};

module.exports.BAKED_CONTEXT_LENGTH = BAKED_CONTEXT_LENGTH;
module.exports.contextLengthKey = contextLengthKey;
