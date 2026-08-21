/**
 * search-providers.js
 *
 * The two ways Syflo can ask the web, behind one door.
 *
 * SearXNG came first and was, until 2026-08-15, a prerequisite: no container,
 * no web search. That does not survive the npm delivery (ADR-0009) — SearXNG
 * is a Python service that only ships as Docker images, and npm cannot install
 * it. So Tavily joins it: a hosted search API the user reaches with their own
 * key (1000 requests/month free), exactly the BYO-key shape ADR-0008 already
 * uses for the LLM providers.
 *
 * SearXNG is NOT retired — searxng/docker-compose.yml stays, so the path that
 * hands nothing to a third party stays open. It is now optional rather than
 * required. A stored Tavily key wins over it: the key is the user's explicit
 * choice, and preferring SearXNG would mean probing localhost before every
 * single search.
 *
 * Neither configured is a legitimate state, not a crash: the search reports
 * `no-search-provider` and the caller decides what to show.
 */

// The ONE SearXNG address in the codebase. It used to be written twice and
// the two copies disagreed — 8890 in tools.js, 8888 in web-search.js, so the
// LLM's search and the citation card's search asked different ports. 8890
// wins: SearXNG's usual 8888 is often taken by Jupyter on developer Macs, and
// exactly that silently killed the search once.
const SEARXNG_URL = process.env.SEARXNG_URL || 'http://localhost:8890';

const TAVILY_URL = 'https://api.tavily.com/search';

// Default number of hits: six, because the LLM tool is the dominant caller
// and that is the budget it has always fed the model (enough diversity for
// synthesis, not enough to blow the context window). Callers that page for a
// human — routes/search.js — pass their own larger number.
const DEFAULT_MAX_RESULTS = 6;

// Hard ceiling for any caller's `max` — nothing downstream can use more.
const RESULT_CEILING = 20;

// How much of a snippet an LLM can usefully read. Longer ones only eat the
// context window.
const SNIPPET_CHARS = 400;

// SearXNG sometimes takes a few seconds when it queries many engines.
const SEARCH_TIMEOUT_MS = 15_000;

// A reachability probe must not make the user wait: if SearXNG does not
// answer in two seconds it is not the thing we build a tool offer on.
const PROBE_TIMEOUT_MS = 2_000;

const SETTINGS_KEY = 'tavily_api_key';

/**
 * The user's Tavily key from the settings table (same store as the LLM
 * provider keys). Missing table, missing row, no db at all — all mean the
 * same thing: no Tavily.
 */
function getTavilyKey(db) {
  if (!db) return '';
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY);
    return (row?.value || '').trim();
  } catch {
    return '';
  }
}

/** Cuts a snippet down to what an LLM can use. */
function trimSnippet(text, chars) {
  return String(text || '').slice(0, chars);
}

/**
 * Ask Tavily. Resolves to `{ provider, results }` in the same shape SearXNG
 * produces, or to `{ error }` for the two failures a user can act on — a
 * wrong key and an exhausted monthly allowance. Network failures throw,
 * because "the internet is broken" is not a state anyone can fix in settings.
 */
async function searchTavily(query, { fetchImpl = fetch, apiKey, max = DEFAULT_MAX_RESULTS, snippetChars = SNIPPET_CHARS } = {}) {
  const r = await fetchImpl(TAVILY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: Math.min(max, RESULT_CEILING),
    }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });

  if (!r.ok) {
    return { provider: 'tavily', ...tavilyError(r.status), results: [] };
  }

  const data = await r.json();
  return {
    provider: 'tavily',
    results: (data.results || []).slice(0, Math.min(max, RESULT_CEILING)).map((hit) => ({
      title: hit.title,
      url: hit.url,
      snippet: trimSnippet(hit.content, snippetChars),
    })),
    answer: data.answer || null,
    suggestions: [],
    unresponsiveEngines: [],
  };
}

/**
 * Named states instead of "HTTP 401" — the two Tavily failures a user can
 * actually do something about deserve their own words, so the UI can offer
 * the right next step (fix the key / wait for the monthly reset).
 */
function tavilyError(status) {
  if (status === 401 || status === 403) return { error: 'tavily-invalid-key', status };
  if (status === 429) return { error: 'tavily-quota-exhausted', status };
  return { error: 'tavily-failed', status };
}

/**
 * Ask SearXNG. Resolves to `{ results: [{ title, url, snippet, engines }],
 * answer, suggestions, unresponsiveEngines }`, or throws — the caller decides
 * what a failure means. For the citation card it means "the search is down",
 * which is emphatically NOT the same as "no PDF exists".
 */
async function searchSearxng(query, { fetchImpl = fetch, max = DEFAULT_MAX_RESULTS, snippetChars = SNIPPET_CHARS } = {}) {
  const url = new URL('/search', SEARXNG_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('safesearch', '0');

  const r = await fetchImpl(url.toString(), {
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!r.ok) {
    const err = new Error(`SearXNG responded with HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  const data = await r.json();

  return {
    provider: 'searxng',
    results: (data.results || []).slice(0, Math.min(max, RESULT_CEILING)).map((hit) => ({
      title: hit.title,
      url: hit.url,
      snippet: trimSnippet(hit.content, snippetChars),
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

/**
 * Is SearXNG serving on the configured port? Any answer counts, even a 404:
 * the question is whether something is listening, and /healthz exists only in
 * newer builds. Cheap enough to ask before an answer — it is localhost, and a
 * refused connection comes back immediately.
 */
async function searxngReachable({ fetchImpl = fetch } = {}) {
  try {
    await fetchImpl(new URL('/healthz', SEARXNG_URL).toString(), {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Can this install search the web at all? A stored Tavily key settles it
 * without a round-trip; otherwise we ask whether SearXNG is up.
 */
async function isSearchAvailable({ db, fetchImpl = fetch } = {}) {
  if (getTavilyKey(db)) return true;
  return searxngReachable({ fetchImpl });
}

module.exports = {
  SEARXNG_URL,
  TAVILY_URL,
  DEFAULT_MAX_RESULTS,
  SNIPPET_CHARS,
  PROBE_TIMEOUT_MS,
  getTavilyKey,
  searchTavily,
  searchSearxng,
  searxngReachable,
  isSearchAvailable,
};
