/**
 * web-search.js
 *
 * One way into the web search, shared by everything that asks the web.
 *
 * It began as the body of routes/search.js (the LLM's search tool); the
 * citation card's silent full-text search became the second caller
 * (2026-08-10) and both must fail the same way — a 503 with a sentence the UI
 * can show, never a generic 500.
 *
 * Since 2026-08-15 there are two providers behind this door (see
 * search-providers.js): Tavily when the user has stored a key, SearXNG when
 * they have not, and a named state when neither exists. SearXNG stopped being
 * a prerequisite because the npm delivery (ADR-0009) cannot install a Python
 * service that only ships as Docker images.
 */

const {
  SEARXNG_URL,
  DEFAULT_MAX_RESULTS,
  getTavilyKey,
  searchTavily,
  searchSearxng,
  isSearchAvailable,
} = require('./search-providers');

// The page size routes/search.js uses when the caller names no limit. Larger
// than the LLM tool's budget because a human reading a hit list can use more
// than six lines; kept here so that route's behaviour is unchanged.
const MAX_RESULTS = 8;

/**
 * Normalises the second argument. It used to be a plain number (`max`) and
 * two callers still pass one — routes/search.js and fulltext-search.js via
 * references.js. Everything new passes `{ db, fetchImpl, max, snippetChars }`
 * so tests can inject both the key store and `fetch`.
 */
function normalizeDeps(deps) {
  if (typeof deps === 'number') return { max: deps };
  return deps || {};
}

/**
 * Ask the web. Resolves to `{ provider, results: [{ title, url, snippet }],
 * answer, suggestions, unresponsiveEngines }`.
 *
 * Failures come in two kinds, deliberately:
 *   - a state the user can fix — no provider configured, a wrong Tavily key,
 *     an exhausted allowance — is RETURNED as `{ error: '…', results: [] }`,
 *     so callers can tell "not set up" from "broken";
 *   - a provider that is set up but unreachable or answering rubbish THROWS,
 *     which is what routes/search.js and the citation card already expect.
 */
async function searchWeb(query, deps) {
  const { db, fetchImpl = fetch, max = DEFAULT_MAX_RESULTS, snippetChars } = normalizeDeps(deps);

  const apiKey = getTavilyKey(db);
  if (apiKey) {
    return searchTavily(query, { fetchImpl, apiKey, max, snippetChars });
  }

  try {
    return await searchSearxng(query, { fetchImpl, max, snippetChars });
  } catch (err) {
    // Nothing listening on the SearXNG port and no Tavily key: this install
    // has no web search at all. That is a setup state, not a failure — the
    // callers must be able to offer "add a key" instead of "search broke".
    // A SearXNG that DID answer (HTTP error, timeout) still throws: it is set
    // up and misbehaving, which is a different sentence to the user.
    if (isUnreachable(err)) {
      return { provider: null, error: 'no-search-provider', results: [], searxngUrl: SEARXNG_URL };
    }
    throw err;
  }
}

// Connection never established. ECONNRESET and timeouts are deliberately not
// here — something answered, so SearXNG exists and is having a bad day.
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'EAI_AGAIN']);

function isUnreachable(err) {
  return !err?.status && UNREACHABLE_CODES.has(err?.cause?.code);
}

/** The message to show when the search backend cannot be reached at all. */
function unreachableMessage(err) {
  return err?.cause?.code === 'ECONNREFUSED'
    ? `Could not reach SearXNG at ${SEARXNG_URL}. Is it running? See searxng/README.md.`
    : err?.message || 'Search request failed';
}

// isSearchAvailable is re-exported so a route needs only this one module to
// ask both questions: "can we search?" and "search this".
module.exports = { searchWeb, isSearchAvailable, unreachableMessage, SEARXNG_URL, MAX_RESULTS };
