/**
 * routes/search.js
 *
 * Web search via local SearXNG. The backend is a thin proxy:
 * frontend (or tool call from the LLM) → POST /api/search → SearXNG JSON API.
 *
 * The SearXNG URL is configurable via SEARXNG_URL (default: localhost:8888).
 * When SearXNG is not running, we respond with 503 and a clear message,
 * so the LLM can tell the user: "I can't reach my search backend".
 */

const express = require('express');

const SEARXNG_URL = process.env.SEARXNG_URL || 'http://localhost:8888';

// Number of results we forward to the caller. SearXNG itself returns more —
// we trim because each result eats LLM context tokens, and the top hits are
// almost always the relevant ones.
const MAX_RESULTS = 8;

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

    const url = new URL('/search', SEARXNG_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('safesearch', '0');

    try {
      const r = await fetch(url.toString(), {
        // SearXNG sometimes takes a few seconds when it queries many engines.
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) {
        return res.status(502).json({ error: `SearXNG responded with HTTP ${r.status}` });
      }
      const data = await r.json();

      // Trim each result to what's actually useful for an LLM. Full SearXNG
      // response carries engine-specific cruft that just wastes tokens.
      const results = (data.results || []).slice(0, max).map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.content || '',
        // Which underlying engine returned this hit — useful for source
        // attribution in the UI.
        engines: r.engines || [],
      }));

      res.json({
        query,
        results,
        answer: data.answers?.[0] || null,
        suggestions: data.suggestions || [],
      });
    } catch (err) {
      // Most common case: SearXNG isn't running (docker not started).
      // Surface it distinctly so the frontend (or the LLM tool-call wrapper)
      // can show a helpful message instead of a generic 500.
      const msg = err?.cause?.code === 'ECONNREFUSED'
        ? `Could not reach SearXNG at ${SEARXNG_URL}. Is it running? See searxng/README.md.`
        : err.message || 'Search request failed';
      res.status(503).json({ error: msg });
    }
  });

  return router;
};
