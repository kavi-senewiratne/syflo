/**
 * tests/quota-unknown.test.js
 *
 * The state an expired wait falls into (design/mockup-onboarding-flow.html
 * §02, step 11, chosen 2026-08-15).
 *
 * Measured complaint: the picker turned a cooling row GREEN again the moment
 * its countdown reached zero — "Countdown vorbei, Limit trotzdem erschöpft".
 * Nothing had been checked at that point; the app had only watched a clock
 * run out. So an expired entry no longer vanishes from the snapshot: it stays
 * as kind 'unknown' until a real call settles it. Only a successful answer
 * deletes it — success is the single piece of evidence the app ever gets.
 *
 * Every test drives the clock through an injected timestamp, never the system
 * clock: a wait that ends "in 90 s" is not testable against Date.now().
 */

jest.mock('openai');
const OpenAI = require('openai');

const express = require('express');
const path = require('path');
const fs = require('fs');
const request = require('supertest');
const { createDb } = require('../database');

const TEST_DB_PATH = path.join(__dirname, 'quota_unknown_test.db');
const UPLOADS_DIR = path.join(__dirname, 'quota_unknown_uploads');

let db;
let router;
let app;
let mockCreate;

// A stream shaped like a finished answer — text chunks, then a clean stop.
function makeStream(words) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const word of words) {
        yield { choices: [{ delta: { content: word } }] };
      }
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    },
  };
}

// The messages router owns the quota memory (server.js reads it through
// GET /api/quota-cooldowns), so the tests mount it exactly as server.js does
// instead of reaching into a private map.
function mountRouter() {
  router = require('../routes/messages')(db, UPLOADS_DIR);
  app = express();
  app.use(express.json());
  app.use('/api/chats/:chatId/messages', router);
}

beforeEach(() => {
  mockCreate = jest.fn();
  OpenAI.mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
  require('../llm').setSetting(db, 'llm_provider', 'ollama');
  mountRouter();
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  if (fs.existsSync(UPLOADS_DIR)) fs.rmSync(UPLOADS_DIR, { recursive: true, force: true });
});

const entryFor = (list, model) => list.find((c) => c.model === model);

function createChat(id = 'c1') {
  db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
    .run(id, 'Quota', new Date().toISOString());
  return id;
}

describe('an expired wait becomes "status unknown"', () => {
  it('keeps a run-out minute cooldown in the snapshot as kind "unknown"', () => {
    router.markQuotaCooldown('gemini', 'gemini-flash-latest', 90_000, 'minute');
    const until = Date.now() + 90_000;

    // While the wait runs, the row is honestly "cooling down".
    const cooling = entryFor(router.getQuotaCooldowns(until - 1_000), 'gemini-flash-latest');
    expect(cooling.kind).toBe('minute');

    // One second past the wait: the clock is out, nothing was measured. The
    // entry must NOT disappear (that is what made the row green again).
    const after = entryFor(router.getQuotaCooldowns(until + 1_000), 'gemini-flash-latest');
    expect(after).toBeDefined();
    expect(after.kind).toBe('unknown');
    expect(after.provider).toBe('gemini');
    expect(new Date(after.until).getTime()).toBe(until);
  });
});

describe('a retired model never becomes a question mark', () => {
  it('keeps kind "retired" once its 24 h are up', () => {
    router.markQuotaCooldown('gemini', 'gemini-1.0-pro', 24 * 60 * 60 * 1000, 'retired');
    const until = Date.now() + 24 * 60 * 60 * 1000;

    // A switched-off model is not waiting for anything: the provider answered
    // 404 and will keep doing so. "Status unknown" would invite a pointless
    // try, so the word stays "no longer available".
    const after = entryFor(router.getQuotaCooldowns(until + 60_000), 'gemini-1.0-pro');
    expect(after.kind).toBe('retired');
  });
});

describe('only a successful answer clears the memory', () => {
  it('deletes the entry of the model that just answered', async () => {
    const chatId = createChat();
    // The local model is the one that answers here (llm_provider = ollama),
    // and it carries a stale entry from an earlier wall.
    router.markQuotaCooldown('ollama', 'qwen3.5:9b', 90_000, 'minute');
    expect(entryFor(router.getQuotaCooldowns(), 'qwen3.5:9b')).toBeDefined();

    mockCreate
      .mockResolvedValueOnce(makeStream(['Attention ', 'is all you need.']))
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Titel' } }] });
    await request(app).post(`/api/chats/${chatId}/messages`).send({ content: 'Was ist Attention?' });
    // The title/outcome side task runs after res.end() and still writes to
    // this db — let it finish before afterEach closes the connection.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // A real answer is the only evidence the app ever gets that a model
    // works — it removes the entry outright, no 'unknown' left behind.
    expect(router.getQuotaCooldowns()).toEqual([]);
  });
});
