/**
 * tests/tool-list-stability.test.js
 *
 * The tool list has to be STABLE within a request, not just correct.
 *
 * Ollama reuses a cached prompt prefix across calls, and the tool definitions
 * are part of that prefix (there is a comment saying exactly this at the
 * warm-up call in routes/messages.js). The warm-up, the answer and the title
 * call are three separate requests in two different route handlers, so they
 * cannot pass one array around — they each ask availableTools(). If the answer
 * to "is a web search configured?" flickers between those calls, the prefix
 * diverges and a warm cache is thrown away, which on a 20k-token paper costs
 * roughly a minute of prefill (ADR-0007's benchmark).
 *
 * Since W2 (2026-08-25) the list no longer depends on the key at all, which
 * makes it stable by construction — but the cache and these tests stay, both
 * as the guard for whatever tool comes next and because the stability is the
 * property worth stating out loud.
 */

const { availableTools, invalidateToolAvailability } = require('../tools');

beforeEach(() => invalidateToolAvailability());
afterEach(() => invalidateToolAvailability());

// A db stub whose stored Tavily key can change between calls.
const dbWithKey = (getKey) => ({
  prepare: () => ({ get: () => ({ value: getKey() }) }),
});

describe('availableTools', () => {
  it('offers the web search when a key is stored', async () => {
    const tools = await availableTools({ db: dbWithKey(() => 'tvly-abc') });
    expect(tools.map(t => t.function.name)).toEqual(['web_search']);
  });

  // W2 (design/mockup-onboarding-flow.html §06): the search is offered even
  // with no key, so the model CALLS it — and the call is the only way anyone
  // learns that this question wanted the web. Hiding the tool meant the reader
  // got a confidently stale answer and never found out why.
  //
  // The old rule (hide it, or the model apologises for its unreachable search
  // backend) is kept by routing the failure to the UI instead of into the
  // answer: the tool result tells the model to answer anyway, and the frontend
  // turns the same result into a card asking for a key.
  it('offers the web search with no key too, so the wish becomes visible', async () => {
    const tools = await availableTools({ db: dbWithKey(() => '') });
    expect(tools.map(t => t.function.name)).toEqual(['web_search']);
  });

  it('answers the same within the cache window, even if the key changes underneath', async () => {
    // The point of the cache: three calls of one answer must agree.
    let key = 'tvly-abc';
    const db = dbWithKey(() => key);
    const first = await availableTools({ db });
    key = '';
    const second = await availableTools({ db });
    expect(second).toBe(first); // the very same array, not just equal
  });

  it('asks nothing over the network to decide, cached or not', async () => {
    // Since ADR-0012 the answer is a settings lookup; since W2 it is not even
    // that — but a probe creeping back in would break the cache's promise.
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const db = dbWithKey(() => '');
    await availableTools({ db, fetchImpl });
    await availableTools({ db, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
