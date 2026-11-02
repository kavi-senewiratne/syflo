/**
 * routes/system.js — the machine and the local model that fits it.
 *
 * GET /api/system/recommendation (grill 2026-10-27, decisions 2–6 and 10):
 * hardware facts from hardware.js, the recommended Ollama model from the
 * registry, whether Ollama has already pulled it, and whether Ollama answers
 * at all. The recommendation does NOT depend on Ollama being up — the
 * library shows it with an "Install Ollama" door instead of a download door.
 *
 * options: { system, ollamaFetch } — the hardware probes and the daemon are
 * injected so tests never touch either.
 */

const express = require('express');
const { detectHardware, recommendModel } = require('../hardware');
const { getRegistry } = require('../registry');

const OLLAMA_URL = 'http://localhost:11434';

// Installed model names as Ollama reports them, or null when it is down.
async function installedModels(ollamaFetch) {
  try {
    const r = await ollamaFetch(`${OLLAMA_URL}/api/tags`);
    if (!r.ok) return null;
    const data = await r.json();
    return (data.models || []).map((m) => m.name);
  } catch {
    return null;
  }
}

module.exports = (db, options = {}) => {
  const router = express.Router();
  const ollamaFetch = options.ollamaFetch || ((...args) => fetch(...args));

  router.get('/recommendation', async (_req, res) => {
    const hardware = detectHardware(options.system);
    const models = getRegistry(db).providers.ollama.models;
    const { model, fits, alsoFits } = recommendModel(hardware.usableGb, models);
    const installed = await installedModels(ollamaFetch);
    const isInstalled = (name) => Boolean(installed && installed.includes(name));
    res.json({
      hardware,
      ollamaReachable: installed !== null,
      recommended: model ? { ...model, fits, installed: isInstalled(model.name) } : null,
      alsoFits: alsoFits.map((m) => ({ ...m, installed: isInstalled(m.name) })),
    });
  });

  return router;
};
