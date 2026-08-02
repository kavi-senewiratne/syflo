/**
 * tests/usage.test.js
 *
 * ADR-0008 slice 7: every answer logs its token counts (usage_log).
 * GET /api/usage/summary aggregates from that, per provider, an honest
 * monthly cost estimate (tokens × registry price table, with an as-of date);
 * free-tier providers additionally get a daily request counter.
 */

jest.mock('openai');
const OpenAI = require('openai');

const request = require('supertest');
const path = require('path');
const fs = require('fs');
const { createApp } = require('../server');
const { createDb } = require('../database');

const TEST_DB_PATH = path.join(__dirname, 'usage_test.db');

let app;
let db;
let mockCreate;

// Stream with a usage chunk at the end (stream_options.include_usage).
function makeStreamWithUsage(words, usage) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const word of words) {
        yield { choices: [{ delta: { content: word } }] };
      }
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
      yield { choices: [], usage };
    },
  };
}

function parseSSE(text) {
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.slice(6)));
}

beforeEach(() => {
  mockCreate = jest.fn();
  OpenAI.mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
  const { setSetting } = require('../llm');
  setSetting(db, 'llm_provider', 'gemini');
  setSetting(db, 'gemini_api_key', 'AIza-test');
  app = createApp(db);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

async function sendOne() {
  mockCreate
    .mockResolvedValueOnce(
      makeStreamWithUsage(['Hi.'], { prompt_tokens: 4000, completion_tokens: 500 })
    )
    .mockResolvedValueOnce({ choices: [{ message: { content: 'Title' } }] });
  const chat = await request(app).post('/api/chats').send({ title: 'U' });
  const res = await request(app)
    .post(`/api/chats/${chat.body.id}/messages`)
    .send({ content: 'hello' });
  expect(parseSSE(res.text).find((e) => e.done)).toBeDefined();
}

describe('usage log + summary', () => {
  it('records provider, model and token counts for every answer', async () => {
    await sendOne();
    const rows = db.prepare('SELECT * FROM usage_log').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'gemini',
      model: 'gemini-flash-latest',
      prompt_tokens: 4000,
      completion_tokens: 500,
    });
  });

  it('aggregates a monthly cost estimate from the registry price table', async () => {
    await sendOne();
    await sendOne();

    const res = await request(app).get('/api/usage/summary');
    expect(res.status).toBe(200);

    const gem = res.body.providers.gemini;
    expect(gem.promptTokens).toBe(8000);
    expect(gem.completionTokens).toBe(1000);
    // 8000/1M × $0.30 + 1000/1M × $2.50 = $0.0024 + $0.0025 = $0.0049
    expect(gem.estimatedUsd).toBeCloseTo(0.0049, 4);
    expect(gem.requestsToday).toBe(2);
    // Honesty: the estimate carries the as-of date of the price table.
    expect(res.body.pricesAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('counts today’s requests per model for the quota meters', async () => {
    await sendOne();
    await sendOne();
    // A row from before UTC midnight must not count into today.
    const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    db.prepare(
      'INSERT INTO usage_log (id, provider, model, prompt_tokens, completion_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('old-row', 'gemini', 'gemini-flash-latest', 100, 10, yesterday);

    const res = await request(app).get('/api/usage/summary');
    expect(res.status).toBe(200);
    // Flat provider/model keys — one fetch serves settings list AND picker.
    expect(res.body.modelsToday['gemini/gemini-flash-latest']).toBe(2);
    expect(res.body.modelsToday['gemini/gemini-pro-latest']).toBeUndefined();
  });

  it('reports zero cost for the local provider', async () => {
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'ollama');
    await sendOne();

    const res = await request(app).get('/api/usage/summary');
    const local = res.body.providers.ollama;
    expect(local.requestsToday).toBe(1);
    expect(local.estimatedUsd).toBe(0);
  });
});
