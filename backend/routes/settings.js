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
  // Web search (step 9, 2026-08-15): Tavily is the search provider an npm
  // install can reach — SearXNG needs Docker and is optional. Same rule as
  // the LLM keys: the frontend learns THAT there is a key, never which.
  out.tavily_api_key_set = Boolean(getSetting(db, 'tavily_api_key'));
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
      const r = await fetch('http://localhost:11434/api/tags');
      if (!r.ok) {
        return res.status(502).json({ error: `Ollama responded with status ${r.status}` });
      }
      const data = await r.json();
      const withCaps = await Promise.all(
        (data.models || []).map(async (m) => {
          let capabilities = [];
          try {
            const s = await fetch('http://localhost:11434/api/show', {
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
        }));
      res.json({ models });
    } catch (err) {
      // Most common case: Ollama isn't running. Surface that distinctly so the
      // frontend can fall back to a free-text input.
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
