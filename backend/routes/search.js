/**
 * routes/search.js
 *
 * Web search: frontend (or tool call from the LLM) → POST /api/search →
 * the configured provider (Tavily, ADR-0012).
 *
 * The asking itself lives in web-search.js, shared with the citation card's
 * silent full-text search. When the provider cannot be reached we respond with
 * 503 and a clear message, so the LLM can tell the user: "I can't reach my
 * search backend". No key at all is not an error here — it comes back as the
 * named state `no-search-provider` in a 200.
 */

const express = require('express');
const { searchWeb, unreachableMessage, MAX_RESULTS } = require('../web-search');

// Takes db since 2026-08-21: the search provider is read from the stored
// settings (the Tavily key), so a route without db could not search at all.
module.exports = (db) => {
  const router = express.Router();

  // POST /api/search  body: { query: string, max?: number }
  // We use POST (not GET) because the query may include special chars and
  // because semantically this is "do an action", not "fetch a resource".
  router.post('/', async (req, res) => {
    const query = (req.body?.query || '').trim();
    if (!query) {
      return res.status(400).json({ error: 'Missing "query" in request body' });
    }
    const max = Math.min(Number(req.body?.max) || MAX_RESULTS, 20);

    try {
      const found = await searchWeb(query, { db, max });
      res.json({ query, ...found });
    } catch (err) {
      // A bad response from the provider is a gateway problem; not reaching it
      // at all (no network) gets its own message.
      if (err.status) return res.status(502).json({ error: err.message });
      res.status(503).json({ error: unreachableMessage(err) });
    }
  });

  return router;
};
