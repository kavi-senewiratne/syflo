/**
 * tests/web-search.test.js
 *
 * The web search runs on Tavily (user-owned key, 1000 requests/month free) —
 * the only provider an npm install can reach on Linux, macOS and Windows. The
 * local SearXNG path was removed on 2026-08-23 (ADR-0012); a search that only
 * exists where Docker does was a second behaviour to keep alive, not a
 * feature.
 *
 * No test talks to the network: `fetch` is injected, and the Tavily key is
 * read from the settings table like every LLM provider key, so a fake db is
 * all it takes.
 */

const path = require('path');
const fs = require('fs');
const request = require('supertest');

const { searchWeb } = require('../web-search');
const { createApp } = require('../server');
const { createDb } = require('../database');

/** Minimal stand-in for the settings table (key-value, see database.js). */
function fakeDb(settings = {}) {
  return {
    prepare: () => ({
      get: (key) => (key in settings ? { value: settings[key] } : undefined),
    }),
  };
}

function tavilyHit(n) {
  return {
    title: `Hit ${n}`,
    url: `https://example.com/${n}`,
    content: `content ${n}`,
  };
}

describe('searchWeb via Tavily', () => {
  it('asks Tavily when a key is stored and keeps the {title,url,snippet} shape', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            title: 'Attention Is All You Need',
            url: 'https://arxiv.org/abs/1706.03762',
            // Longer than the 400-character budget an LLM context can spare.
            content: 'x'.repeat(900),
          },
          ...[2, 3, 4, 5, 6, 7].map(tavilyHit),
        ],
      }),
    }));

    const found = await searchWeb('attention is all you need', {
      db: fakeDb({ tavily_api_key: 'tvly-test-key' }),
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.tavily.com/search');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.api_key).toBe('tvly-test-key');
    expect(body.query).toBe('attention is all you need');
    expect(body.max_results).toBe(6);

    expect(found.provider).toBe('tavily');
    // Six hits at most, snippets capped at 400 characters — the shape
    // tools.js already fed the model, so nothing upstream has to change.
    expect(found.results).toHaveLength(6);
    expect(found.results[0]).toEqual({
      title: 'Attention Is All You Need',
      url: 'https://arxiv.org/abs/1706.03762',
      snippet: 'x'.repeat(400),
    });
  });
});

describe('searchWeb with nothing set up', () => {
  it('reports no-search-provider without asking anyone when no key is stored', async () => {
    // A fresh npm install is in this state: "not set up", not "broken".
    const fetchImpl = jest.fn();

    const found = await searchWeb('anything', { db: fakeDb(), fetchImpl });

    expect(found.error).toBe('no-search-provider');
    expect(found.results).toEqual([]);
    // Nothing is probed any more — there is no localhost service left to ask,
    // and a missing key is answered from the settings table alone.
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Tavily failures', () => {
  // The two failures a user can act on get their own names — one means "fix
  // the key", the other "wait for the monthly reset". A generic sentence
  // would leave the UI guessing which.
  const cases = [
    [401, 'tavily-invalid-key'],
    [429, 'tavily-quota-exhausted'],
  ];

  it.each(cases)('turns HTTP %i into %s', async (status, expected) => {
    const fetchImpl = jest.fn(async () => ({ ok: false, status, json: async () => ({}) }));

    const found = await searchWeb('anything', {
      db: fakeDb({ tavily_api_key: 'tvly-test-key' }),
      fetchImpl,
    });

    expect(found.error).toBe(expected);
    expect(found.status).toBe(status);
    expect(found.results).toEqual([]);
  });
});

describe('the Tavily key in the settings table', () => {
  const TEST_DB_PATH = path.join(__dirname, 'web_search_test.db');
  let db;
  let app;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    db = createDb(TEST_DB_PATH);
    app = createApp(db);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  it('is stored, never handed back, and is what the search then uses', async () => {
    const before = await request(app).get('/api/settings');
    expect(before.body.tavily_api_key_set).toBe(false);

    await request(app).put('/api/settings').send({ tavily_api_key: 'tvly-stored-key' }).expect(200);

    const after = await request(app).get('/api/settings');
    // Same rule as the LLM keys: the backend confirms it has one, never
    // shows it.
    expect(after.body.tavily_api_key_set).toBe(true);
    expect(JSON.stringify(after.body)).not.toContain('tvly-stored-key');

    // And the search picks it up from the real settings table.
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) }));
    const found = await searchWeb('anything', { db, fetchImpl });
    expect(found.provider).toBe('tavily');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).api_key).toBe('tvly-stored-key');
  });
});
