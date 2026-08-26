/**
 * tests/tools.test.js
 *
 * The `web_search` tool is only OFFERED to the model when a search actually
 * exists — that is, when a Tavily key is stored (ADR-0012). It used to sit in
 * the tools array unconditionally, so on an install without a search the model
 * would call it, get an error string back, and apologise to the user about its
 * search backend — a failure nobody could act on.
 *
 * Nothing here touches the network: `fetch` is injected, and the Tavily key
 * comes from a fake settings table.
 */

const { availableTools, streamWithTools, toolImpls, invalidateToolAvailability } = require('../tools');

// availableTools caches its answer for 15 s (module state, on purpose — see
// tests/tool-list-stability.test.js). Each test here uses its own stubs, so the
// cache has to be cleared between them.
beforeEach(() => invalidateToolAvailability());
afterEach(() => invalidateToolAvailability());

/** Fake OpenAI client that streams the given chunk sets, one per round. */
function fakeClient(chunkSets) {
  let call = 0;
  const create = jest.fn(async () => {
    const chunks = chunkSets[Math.min(call, chunkSets.length - 1)];
    call++;
    return (async function* () {
      for (const c of chunks) yield c;
    })();
  });
  return { chat: { completions: { create } }, _create: create };
}

const text = (s) => ({ choices: [{ delta: { content: s } }] });
const done = () => ({ choices: [{ delta: {}, finish_reason: 'stop' }] });

/** A fetch that never connects — nothing is listening. */
function refusedFetch() {
  return jest.fn(async () => {
    const err = new TypeError('fetch failed');
    err.cause = { code: 'ECONNREFUSED' };
    throw err;
  });
}

/** Minimal stand-in for the settings table (key-value, see database.js). */
function fakeDb(settings = {}) {
  return {
    prepare: () => ({
      get: (key) => (key in settings ? { value: settings[key] } : undefined),
    }),
  };
}

describe('availableTools', () => {
  it('offers web_search when a Tavily key is stored, without probing anything', async () => {
    const fetchImpl = jest.fn();

    const tools = await availableTools({ db: fakeDb({ tavily_api_key: 'tvly-test-key' }), fetchImpl });

    expect(tools.map((t) => t.function.name)).toEqual(['web_search']);
    // A stored key is proof enough — no round-trip before every answer.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('offers web_search with no key too — the call is how the wish gets seen', async () => {
    // W2 (2026-08-25) reversed the old rule. Hiding the tool stopped the model
    // apologising, but it also meant a question that wanted the web came back
    // confidently stale with nobody the wiser. Now the tool is offered, the
    // model calls it, and the failure is routed to the UI (which asks for a
    // key) instead of into the answer.
    const tools = await availableTools({ db: fakeDb(), fetchImpl: refusedFetch() });

    expect(tools.map((t) => t.function.name)).toEqual(['web_search']);
  });
});

describe('streamWithTools and the search', () => {
  it('sends the search even with no key stored (W2)', async () => {
    const client = fakeClient([[text('From what I know.'), done()]]);

    const final = await streamWithTools({
      client,
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      onText: () => {},
      searchDeps: { db: fakeDb(), fetchImpl: refusedFetch() },
    });

    expect(final).toBe('From what I know.');
    const sent = client._create.mock.calls[0][0].tools;
    expect(sent.map((t) => t.function.name)).toEqual(['web_search']);
  });

  it('offers web_search when searchDeps carry a Tavily key', async () => {
    const client = fakeClient([[text('Sure.'), done()]]);

    await streamWithTools({
      client,
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      onText: () => {},
      searchDeps: { db: fakeDb({ tavily_api_key: 'tvly-test-key' }), fetchImpl: jest.fn() },
    });

    const sent = client._create.mock.calls[0][0].tools;
    expect(sent.map((t) => t.function.name)).toEqual(['web_search']);
  });

  it('accepts a precomputed tool list, so warm-up and title calls can send the same one', async () => {
    const client = fakeClient([[text('Sure.'), done()]]);
    // The route decides ONCE what this install can do and reuses the array:
    // the Ollama warm-up, the title call and the answer must send an
    // identical tools array or the chat template renders a different prefix
    // and the KV cache misses.
    const decidedOnce = [];

    await streamWithTools({
      client,
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      onText: () => {},
      tools: decidedOnce,
      // Deliberately contradicts the list: the explicit array wins, so no
      // second availability probe can disagree with the first.
      searchDeps: { db: fakeDb({ tavily_api_key: 'tvly-test-key' }), fetchImpl: jest.fn() },
    });

    expect(client._create.mock.calls[0][0].tools).toBeUndefined();
  });
});

describe('the web_search implementation', () => {
  it('runs through the shared search, not a copy of its own', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ results: [{ title: 'T', url: 'https://e.org/t', content: 'c' }] }),
    }));

    const out = await toolImpls({
      db: fakeDb({ tavily_api_key: 'tvly-test-key' }),
      fetchImpl,
    }).web_search({ query: 'kv cache' });

    // tools.js no longer owns a copy of the search — one door, one address.
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.tavily.com/search');
    expect(JSON.parse(out)).toEqual({
      query: 'kv cache',
      results: [{ title: 'T', url: 'https://e.org/t', snippet: 'c' }],
    });
  });

  it('hands the model a named state instead of a sentence when nothing is set up', async () => {
    const out = await toolImpls({ db: fakeDb(), fetchImpl: refusedFetch() }).web_search({ query: 'kv cache' });

    expect(JSON.parse(out).error).toBe('no-search-provider');
  });

  // W2 (2026-08-25): the tool is offered with no key, so this result is now a
  // NORMAL outcome rather than a misconfiguration. What the model does with it
  // decides whether the reader gets an answer or an apology, so the result
  // says so outright.
  it('tells the model to answer anyway, and not to apologise', async () => {
    const out = await toolImpls({ db: fakeDb(), fetchImpl: refusedFetch() }).web_search({ query: 'weather today' });
    const parsed = JSON.parse(out);

    // The UI owns the "add a key" conversation — the model must not start it,
    // or the reader gets the same dead end twice.
    expect(parsed.instruction).toMatch(/answer/i);
    expect(parsed.instruction).toMatch(/do not (apologise|apologize)|without apolog/i);
    expect(parsed.instruction).not.toMatch(/tavily|api key|settings/i);
  });

  // The card names the query the model formulated, and this is where that
  // query comes from — the tool call itself. Without it the card could only
  // say "the model wanted to search", which tells the reader nothing about
  // whether a key would be worth getting.
  it('echoes the query back, so the UI can name what would have been searched', async () => {
    const out = await toolImpls({ db: fakeDb(), fetchImpl: refusedFetch() }).web_search({ query: 'qwen3.5 release date' });

    expect(JSON.parse(out).query).toBe('qwen3.5 release date');
  });
});
