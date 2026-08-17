/**
 * web-search.js
 *
 * One way into the local SearXNG, shared by everything that asks the web.
 *
 * It began as the body of routes/search.js (the LLM's search tool); the
 * citation card's silent full-text search became the second caller
 * (2026-08-10) and both must fail the same way — a 503 with a sentence the UI
 * can show, never a generic 500.
 *
 * SEARXNG_URL is configurable; the default matches searxng/README.md.
 */

const SEARXNG_URL = process.env.SEARXNG_URL || 'http://localhost:8888';

// SearXNG returns more; each result costs LLM context, and the top hits are
// almost always the relevant ones.
const MAX_RESULTS = 8;

/**
 * Ask SearXNG. Resolves to `{ results: [{ title, url, snippet, engines }],
 * answer, suggestions }`, or throws — the caller decides what a failure means.
 * For the citation card it means "the search is down", which is emphatically
 * NOT the same as "no PDF exists".
 */
async function searchWeb(query, max = MAX_RESULTS) {
  const url = new URL('/search', SEARXNG_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('safesearch', '0');

  const r = await fetch(url.toString(), {
    // SearXNG sometimes takes a few seconds when it queries many engines.
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) {
    const err = new Error(`SearXNG responded with HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  const data = await r.json();

  return {
    results: (data.results || []).slice(0, Math.min(max, 20)).map((hit) => ({
      title: hit.title,
      url: hit.url,
      snippet: hit.content || '',
      // Which underlying engine returned this hit — useful for attribution.
      engines: hit.engines || [],
    })),
    answer: data.answers?.[0] || null,
    suggestions: data.suggestions || [],
    // Which engines refused to answer, and why. SearXNG replies 200 with an
    // empty list when they all shut us out — telling that apart from "there
    // is nothing" is the caller's business (fulltext-search.js).
    unresponsiveEngines: data.unresponsive_engines || [],
  };
}

/** The message to show when the search backend cannot be reached at all. */
function unreachableMessage(err) {
  return err?.cause?.code === 'ECONNREFUSED'
    ? `Could not reach SearXNG at ${SEARXNG_URL}. Is it running? See searxng/README.md.`
    : err?.message || 'Search request failed';
}

module.exports = { searchWeb, unreachableMessage, SEARXNG_URL, MAX_RESULTS };
