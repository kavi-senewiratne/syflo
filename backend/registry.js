/**
 * registry.js
 *
 * Model registry (ADR-0008): the single source of truth for which providers
 * and models Syflo offers and what they can do — vision, thinking,
 * context window, budget cap, prices, free quotas.
 *
 * The registry ships bundled in registry.json and can be updated via
 * refreshRegistry() against the remote copy in the repo (stored in the
 * settings table). No user data flows in the process — it is a GET on
 * public data; if it fails, the bundled copy simply applies, including
 * its as-of date (`asOf`).
 */

const fs = require('fs');
const path = require('path');

const BUNDLED = JSON.parse(fs.readFileSync(path.join(__dirname, 'registry.json'), 'utf8'));

// How long a fetched remote registry counts as fresh.
const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

function readStored(db) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'registry_json'").get();
    if (!row) return null;
    const parsed = JSON.parse(row.value);
    // Never fall behind the bundled version.
    if (parsed.asOf && parsed.asOf >= BUNDLED.asOf) return parsed;
    return null;
  } catch {
    return null;
  }
}

/** Current registry: remote copy (if newer) otherwise the bundled state. */
function getRegistry(db) {
  return (db && readStored(db)) || BUNDLED;
}

/**
 * Properties of a model. For cloud providers from the curated list; for
 * Ollama: installed models are vision-capable (the dropdown is vision-only)
 * and the window comes from the environment as before.
 */
function getModelInfo(db, provider, modelName) {
  const reg = getRegistry(db);
  if (provider === 'ollama') {
    const windowTokens = parseInt(process.env.OLLAMA_CONTEXT_LENGTH, 10) || 16384;
    return {
      name: modelName,
      vision: true,
      canThink: true,
      contextWindowTokens: windowTokens,
      budgetCapTokens: windowTokens,
      free: true,
      pricing: null,
    };
  }
  const p = reg.providers[provider];
  const m = p && p.models.find((x) => x.name === modelName);
  if (m) return m;
  // Unknown cloud model (e.g. entered manually): conservative assumptions.
  return {
    name: modelName,
    vision: false,
    canThink: false,
    contextWindowTokens: 32768,
    budgetCapTokens: 32768,
    free: false,
    pricing: null,
  };
}

/**
 * Fetches the remote registry and stores it in the settings table.
 * Errors are never fatal — the last state then remains valid.
 */
async function refreshRegistry(db, { force = false } = {}) {
  try {
    const last = db.prepare("SELECT value FROM settings WHERE key = 'registry_fetched_at'").get();
    if (!force && last && Date.now() - Number(last.value) < REFRESH_INTERVAL_MS) {
      return { refreshed: false, reason: 'fresh' };
    }
    const url = getRegistry(db).sourceUrl;
    const r = await fetch(url);
    if (!r.ok) return { refreshed: false, reason: `http ${r.status}` };
    const json = await r.json();
    if (!json || !json.providers || !json.asOf) return { refreshed: false, reason: 'malformed' };
    const upsert = db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );
    upsert.run('registry_json', JSON.stringify(json));
    upsert.run('registry_fetched_at', String(Date.now()));
    return { refreshed: true, asOf: json.asOf };
  } catch (err) {
    return { refreshed: false, reason: err.message };
  }
}

const CLOUD_PROVIDERS = Object.entries(BUNDLED.providers)
  .filter(([, p]) => p.kind === 'cloud')
  .map(([name]) => name);

module.exports = { getRegistry, getModelInfo, refreshRegistry, CLOUD_PROVIDERS };
