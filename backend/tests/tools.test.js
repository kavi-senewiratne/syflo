/**
 * tests/tools.test.js
 *
 * Step 9, second half: the `web_search` tool is only OFFERED to the model when
 * a search actually exists. Until now it sat in the tools array
 * unconditionally, so on an install without SearXNG the model would call it,
 * get an error string back, and apologise to the user about its search
 * backend — a failure nobody could act on.
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

  it('offers web_search when SearXNG answers on its port', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200 }));

    const tools = await availableTools({ db: fakeDb(), fetchImpl });

    expect(tools.map((t) => t.function.name)).toEqual(['web_search']);
    expect(fetchImpl.mock.calls[0][0]).toContain('http://localhost:8890/');
  });

  it('offers no tools at all when neither provider is set up', async () => {
    const tools = await availableTools({ db: fakeDb(), fetchImpl: refusedFetch() });

    // Nothing to offer, so nothing is promised — the model answers from what
    // it knows instead of calling a tool that can only fail.
    expect(tools).toEqual([]);
  });
});

describe('streamWithTools and the search', () => {
  it('sends no tools field when searchDeps report no search', async () => {
    const client = fakeClient([[text('From what I know.'), done()]]);

    const final = await streamWithTools({
      client,
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      onText: () => {},
      searchDeps: { db: fakeDb(), fetchImpl: refusedFetch() },
    });

    expect(final).toBe('From what I know.');
    expect(client._create.mock.calls[0][0].tools).toBeUndefined();
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
  it('runs through the shared search, on the one SearXNG address', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ results: [{ title: 'T', url: 'https://e.org/t', content: 'c' }] }),
    }));

    const out = await toolImpls({ db: fakeDb(), fetchImpl }).web_search({ query: 'kv cache' });

    // tools.js no longer owns a copy of the search — no second port to drift.
    expect(fetchImpl.mock.calls[0][0]).toContain('http://localhost:8890/search');
    expect(JSON.parse(out)).toEqual({
      query: 'kv cache',
      results: [{ title: 'T', url: 'https://e.org/t', snippet: 'c' }],
    });
  });

  it('hands the model a named state instead of a sentence when nothing is set up', async () => {
    const out = await toolImpls({ db: fakeDb(), fetchImpl: refusedFetch() }).web_search({ query: 'kv cache' });

    expect(JSON.parse(out).error).toBe('no-search-provider');
  });
});
