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
 * Hence a short-lived cache, and hence these tests.
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

  it('offers nothing when neither provider is there, so the model is not tempted', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await availableTools({ db: dbWithKey(() => ''), fetchImpl })).toEqual([]);
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

  it('checks again once the availability is invalidated', async () => {
    let key = 'tvly-abc';
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const db = dbWithKey(() => key);
    expect(await availableTools({ db, fetchImpl })).toHaveLength(1);

    key = '';
    invalidateToolAvailability();

    expect(await availableTools({ db, fetchImpl })).toEqual([]);
  });

  it('does not probe SearXNG again for a cached answer', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const db = dbWithKey(() => '');
    await availableTools({ db, fetchImpl });
    const callsAfterFirst = fetchImpl.mock.calls.length;
    await availableTools({ db, fetchImpl });
    expect(fetchImpl.mock.calls.length).toBe(callsAfterFirst);
  });
});
