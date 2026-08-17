/**
 * routes/search.js
 *
 * Web search via local SearXNG. The backend is a thin proxy:
 * frontend (or tool call from the LLM) → POST /api/search → SearXNG JSON API.
 *
 * The asking itself lives in web-search.js, shared with the citation card's
 * silent full-text search. When SearXNG is not running, we respond with 503
 * and a clear message, so the LLM can tell the user: "I can't reach my search
 * backend".
 */

const express = require('express');
const { searchWeb, unreachableMessage, MAX_RESULTS } = require('../web-search');

module.exports = () => {
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
      const found = await searchWeb(query, max);
      res.json({ query, ...found });
    } catch (err) {
      // A bad response from SearXNG is a gateway problem; not reaching it at
      // all (docker not started) is the common case and gets its own message.
      if (err.status) return res.status(502).json({ error: err.message });
      res.status(503).json({ error: unreachableMessage(err) });
    }
  });

  return router;
};
