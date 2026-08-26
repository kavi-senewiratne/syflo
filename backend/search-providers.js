/**
 * search-providers.js
 *
 * The one way Syflo asks the web: Tavily, under the user's own key
 * (1000 requests/month free) — the BYO-key shape ADR-0008 already uses for the
 * LLM providers.
 *
 * SearXNG was the original search and, until 2026-08-15, a prerequisite: no
 * container, no web search. It was kept as an optional second path for a week
 * and removed on 2026-08-23 (ADR-0012): Syflo installs with `npm install -g`
 * on Linux, macOS and Windows, and SearXNG is a Python service that only ships
 * as Docker images. A search path that exists on a developer's Mac and nowhere
 * else is not a feature, it is a second behaviour to keep alive — so Tavily is
 * the whole of it.
 *
 * No key is a legitimate state, not a crash: the search reports
 * `no-search-provider` and the caller decides what to show.
 */

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

// A search can take a few seconds; longer than this and the answer it feeds is
// no longer worth waiting for.
const SEARCH_TIMEOUT_MS = 15_000;

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
 * Ask Tavily. Resolves to `{ provider, results }`, or to `{ error }` for the two failures a user can act on — a
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
 * Can this install search the web at all? One stored key settles it, with no
 * round-trip — which is why the answer is cheap enough to ask before deciding
 * whether to offer the model a search tool at all (tools.js). Still async: the
 * callers await it, and a future provider may need a probe.
 */
async function isSearchAvailable({ db } = {}) {
  return Boolean(getTavilyKey(db));
}

module.exports = {
  TAVILY_URL,
  DEFAULT_MAX_RESULTS,
  SNIPPET_CHARS,
  getTavilyKey,
  searchTavily,
  isSearchAvailable,
};
