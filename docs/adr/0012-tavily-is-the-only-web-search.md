# Tavily is the only web search — SearXNG removed

Status: accepted (2026-08-23)

Web search reached Syflo through a local [SearXNG](https://docs.searxng.org/)
container: a compose file in `searxng/`, port 8890, no key, nothing handed to a
third party. On 2026-08-15 Tavily joined it as a key-based provider because the
npm delivery (ADR-0009) cannot install SearXNG — it is a Python service that
only ships as Docker images. For a week both paths existed side by side, Tavily
preferred when a key was stored, SearXNG probed otherwise.

That middle state does not hold up. `npm install -g syflo` has to work the same
way on Linux, macOS and Windows, and a search path that exists on a developer's
Mac with Colima and nowhere else is not a feature — it is a second behaviour to
keep alive, test and explain. It also hid its own bugs: with the container
running on every machine we develop on, "no search configured" was never the
state under test (see Consequences).

## Decision

- **Tavily is the web search**, under the user's own key — the same BYO-key
  shape ADR-0008 uses for the LLM providers. 1000 requests/month free, no
  credit card.
- **SearXNG is removed**: the `searxng/` folder, the container start in
  `start.command`, `searchSearxng`/`searxngReachable` in
  `backend/search-providers.js` and the fallback in `backend/web-search.js`.
  `SEARXNG_URL` is no longer read anywhere.
- **No key is a state, not a failure.** `searchWeb` returns
  `{ error: 'no-search-provider', results: [] }` without asking anyone, and
  `isSearchAvailable` is a settings lookup with no round-trip. The `web_search`
  tool is then not offered to the model at all — a tool that can only fail is
  worse than no tool.
- The YouTube search is unaffected: it moved from SearXNG's YouTube engine to
  InnerTube (`backend/youtube.js`) on 2026-08-15 and needs no key either.

## Consequences

- An install without a Tavily key cannot search the web. Two features go quiet:
  `web_search` in the chat, and the citation card's silent full-text search for
  references whose PDF OpenAlex does not know (the card then shows the doors it
  always showed).
- **The UI to enter the key does not exist yet.** The backend accepts
  `tavily_api_key` on `PUT /api/settings`, but no field, no card and no string
  in `frontend/src/strings.ts` offers it — so for a new user the web search is
  currently unreachable, not just unconfigured. The designs are drafted in
  `design/mockup-onboarding-flow.html` §06 (W1 card at the point of need, W2
  card in the chat, W3 row in Settings) and await a variant decision. W3's
  "Eigenes SearXNG" row is obsolete with this ADR.
- A bug this removal exposed on the spot: the Ollama warm-up sent `tools: []`
  while the answer omitted the field entirely. Identical requests, different
  rendered prompts — so the prefix diverged and the KV cache missed (~40 s
  prefill, measured 2026-07-21). Invisible while the list was never empty.
  `toolsField()` in `backend/tools.js` is now the single spelling of "no
  tools", used by the warm-up, the answer and the title call.
- The path that hands nothing to a third party is gone. Anyone who wants it can
  still point a local metasearch at Syflo — but through the same door as any
  other provider, not as a second built-in code path. Recovering the old
  container config means reading it out of git history
  (`git show <rev>:searxng/docker-compose.yml`).
