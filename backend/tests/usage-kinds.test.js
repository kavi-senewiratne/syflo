/**
 * tests/usage-kinds.test.js
 *
 * Why this suite exists (measured 2026-08-11): the model window showed
 * "0/20" for Gemini Flash while the daily quota had long been exhausted.
 * Exactly ONE place wrote to usage_log — the successful chat answer in
 * routes/messages.js — so title generation, /btw, Explain and passage
 * titles spent the same quota invisibly, and a 429 (which is a spent call
 * too) left no trace at all. On 2026-08-10 four Flash answers were logged
 * and the limit was full.
 *
 * Second half of the lie: the summary grouped "today" by the UTC day, while
 * Google resets the daily quota at midnight PACIFIC time (the zone lives in
 * registry.json as `resetTimezone`, the same source quota.js reads).
 */

jest.mock('openai');
const OpenAI = require('openai');

const Database = require('better-sqlite3');
const request = require('supertest');
const path = require('path');
const fs = require('fs');

const { createApp } = require('../server');
const { createDb } = require('../database');
const { setSetting } = require('../llm');
const { recordUsage, providerDayStart } = require('../usage');

const TEST_DB_PATH = path.join(__dirname, 'usage_kinds_test.db');

function removeDb() {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const file = TEST_DB_PATH + suffix;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

beforeEach(removeDb);
afterEach(removeDb);

describe('usage_log migration', () => {
  it('adds kind and outcome to an existing log without losing rows', () => {
    // A database as it looked before this change: usage_log without the two
    // new columns, carrying one row from a real answer.
    const old = new Database(TEST_DB_PATH);
    old.exec(`
      CREATE TABLE usage_log (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        created_at TEXT NOT NULL
      );
    `);
    old.prepare(
      'INSERT INTO usage_log (id, provider, model, prompt_tokens, completion_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('old-row', 'gemini', 'gemini-flash-latest', 4000, 500, '2026-08-10T12:00:00.000Z');
    old.close();

    const db = createDb(TEST_DB_PATH);
    try {
      const rows = db.prepare('SELECT * FROM usage_log').all();
      expect(rows).toHaveLength(1);
      // Every pre-existing row was a successful chat answer — that is the
      // only thing the old write site could produce, so the defaults must
      // preserve exactly that meaning.
      expect(rows[0]).toMatchObject({
        id: 'old-row',
        provider: 'gemini',
        model: 'gemini-flash-latest',
        prompt_tokens: 4000,
        completion_tokens: 500,
        kind: 'chat',
        outcome: 'ok',
      });
    } finally {
      db.close();
    }
  });
});

describe('recordUsage', () => {
  let db;

  beforeEach(() => { db = createDb(TEST_DB_PATH); });
  afterEach(() => { db.close(); });

  it('writes one row with its origin and its result', () => {
    recordUsage(db, {
      provider: 'gemini',
      model: 'gemini-flash-latest',
      kind: 'title',
      outcome: 'quota',
      promptTokens: 120,
      completionTokens: 8,
    });

    const rows = db.prepare('SELECT * FROM usage_log').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'gemini',
      model: 'gemini-flash-latest',
      kind: 'title',
      outcome: 'quota',
      prompt_tokens: 120,
      completion_tokens: 8,
    });
    // One row per call means every row needs its own id — the column has no
    // default, and a NULL id would collide on the primary key from the
    // second call on.
    expect(rows[0].id).toEqual(expect.any(String));
    expect(rows[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

/** A finished stream with the usage chunk the providers send at the end. */
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

/** An error the way the provider's SDK raises it. */
function apiError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

describe('failed calls are logged too', () => {
  let app;
  let db;
  let mockCreate;

  beforeEach(() => {
    mockCreate = jest.fn();
    OpenAI.mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    }));
    db = createDb(TEST_DB_PATH);
    setSetting(db, 'llm_provider', 'gemini');
    setSetting(db, 'gemini_api_key', 'AIza-test');
    app = createApp(db);
  });

  afterEach(() => { db.close(); });

  async function ask() {
    const chat = await request(app).post('/api/chats').send({ title: 'U' });
    await request(app).post(`/api/chats/${chat.body.id}/messages`).send({ content: 'hello' });
  }

  it('stamps a 429 as quota and any other failure as failed', async () => {
    // A refused call is a SPENT call: the provider counted it, the meter did
    // not. That is half of why the model window said "0/20" on 2026-08-11
    // while Gemini Flash was long exhausted.
    mockCreate.mockRejectedValue(
      apiError(429, 'Quota exceeded for quota metric generate_requests_per_day, limit: 20')
    );
    await ask();

    let rows = db.prepare("SELECT * FROM usage_log WHERE outcome = 'quota'").all();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.kind === 'chat' && r.provider === 'gemini')).toBe(true);
    // Nothing came back, so there is nothing to bill — but the call happened.
    expect(rows[0].completion_tokens).toBeNull();

    db.prepare('DELETE FROM usage_log').run();
    mockCreate.mockReset();
    mockCreate.mockRejectedValue(apiError(500, 'Internal error'));
    await ask();

    rows = db.prepare('SELECT * FROM usage_log').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'chat', outcome: 'failed', provider: 'gemini' });
  });

  it('logs title generation as its own kind, not as an answer', async () => {
    // The side calls are the other half of the "0/20" lie: the title call
    // spends the same daily quota as the answer and used to leave no trace.
    mockCreate
      .mockResolvedValueOnce(
        makeStreamWithUsage(['Hi.'], { prompt_tokens: 4000, completion_tokens: 500 })
      )
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Batch norm' }, finish_reason: 'stop' }] });
    await ask();

    const kinds = db
      .prepare('SELECT kind, outcome FROM usage_log ORDER BY kind')
      .all();
    expect(kinds).toEqual([
      { kind: 'chat', outcome: 'ok' },
      { kind: 'title', outcome: 'ok' },
    ]);
  });

  it('logs a /btw aside under its own kind', async () => {
    mockCreate.mockResolvedValue(makeStreamWithUsage(['Because.'], undefined));
    await request(app).post('/api/btw').send({ question: 'why?' });

    const rows = db.prepare('SELECT * FROM usage_log').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'btw', outcome: 'ok', provider: 'gemini' });
  });

  it('logs an Explain definition under its own kind', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'A short definition.' }, finish_reason: 'stop' }],
    });
    await request(app).post('/api/explain').send({ word: 'variance' });

    const rows = db.prepare('SELECT * FROM usage_log').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'explain', outcome: 'ok', provider: 'gemini' });
  });
});

// A fixed instant instead of the machine clock: 2026-08-21 01:30 UTC is
// 20:30 the previous evening in Austin, 18:30 in California. Google resets
// the daily quota at midnight PACIFIC, Groq at midnight UTC — so the same
// evening call belongs to two different days depending on who is counting.
const NOW = '2026-08-21T01:30:00.000Z';
// 20:00 in Austin — the pacific day is still 2026-08-20, the UTC day is
// already 2026-08-21.
const AUSTIN_EVENING = '2026-08-21T01:00:00.000Z';
// 17:00 in Austin — before UTC midnight, same pacific day as the call above.
const AUSTIN_AFTERNOON = '2026-08-20T22:00:00.000Z';

describe('the day belongs to the provider, not to UTC', () => {
  it('starts the day at the provider’s own midnight', () => {
    // Pacific midnight, i.e. 07:00 UTC on the 20th — not 00:00 UTC on the
    // 21st, which is what the summary used to group by (2026-08-11).
    expect(providerDayStart('gemini', new Date(NOW))).toBe('2026-08-20T07:00:00.000Z');
    expect(providerDayStart('groq', new Date(NOW))).toBe('2026-08-21T00:00:00.000Z');
    // A provider that states no zone keeps UTC.
    expect(providerDayStart('openai', new Date(NOW))).toBe('2026-08-21T00:00:00.000Z');
  });

  it('counts the Austin evening into today for Gemini and into tomorrow for Groq', async () => {
    const db = createDb(TEST_DB_PATH);
    try {
      const app = createApp(db);
      const insert = db.prepare(
        `INSERT INTO usage_log (id, provider, model, kind, outcome, prompt_tokens, completion_tokens, created_at)
         VALUES (?, ?, ?, 'chat', 'ok', 100, 10, ?)`
      );
      let n = 0;
      for (const at of [AUSTIN_AFTERNOON, AUSTIN_EVENING]) {
        insert.run(`g${n++}`, 'gemini', 'gemini-flash-latest', at);
        insert.run(`q${n++}`, 'groq', 'openai/gpt-oss-120b', at);
      }

      const res = await request(app).get(`/api/usage/summary?now=${encodeURIComponent(NOW)}`);
      expect(res.status).toBe(200);
      // Pacific day: both calls are on 2026-08-20 for Google.
      expect(res.body.modelsToday['gemini/gemini-flash-latest']).toBe(2);
      expect(res.body.providers.gemini.requestsToday).toBe(2);
      // UTC day: only the 01:00 call is on 2026-08-21 for Groq.
      expect(res.body.modelsToday['groq/openai/gpt-oss-120b']).toBe(1);
      expect(res.body.providers.groq.requestsToday).toBe(1);
    } finally {
      db.close();
    }
  });

  it('breaks today’s calls down by kind, keyed like modelsToday', async () => {
    const db = createDb(TEST_DB_PATH);
    try {
      const app = createApp(db);
      for (let i = 0; i < 3; i++) {
        recordUsage(db, { provider: 'gemini', model: 'gemini-flash-latest', kind: 'chat' });
      }
      recordUsage(db, { provider: 'gemini', model: 'gemini-flash-latest', kind: 'title' });
      recordUsage(db, { provider: 'gemini', model: 'gemini-flash-latest', kind: 'btw', outcome: 'quota' });
      recordUsage(db, { provider: 'gemini', model: 'gemini-flash-lite-latest', kind: 'explain' });

      const res = await request(app).get('/api/usage/summary');
      expect(res.status).toBe(200);
      // What the day's quota actually went on — the card can now say
      // "3 answers, 1 title, 1 aside" instead of a single opaque 5.
      expect(res.body.kindsToday['gemini/gemini-flash-latest']).toEqual({
        chat: 3, title: 1, btw: 1,
      });
      expect(res.body.kindsToday['gemini/gemini-flash-lite-latest']).toEqual({ explain: 1 });
      // The totals stay the sum of the breakdown — including the refused call.
      expect(res.body.modelsToday['gemini/gemini-flash-latest']).toBe(5);
    } finally {
      db.close();
    }
  });
});

// ─── Der Zähler des Modell-Menüs zählt nur beantwortete Aufrufe ─────────────
// Nutzerbericht mit Bild 2026-09-04: „28/20" bei Gemini Flash — eine Zahl, die
// ein Limit von zwanzig nicht hergeben kann. Die Zeilen des Tages: 20 ok,
// 4 quota, 4 failed. Die zwanzig SIND das Limit; die vier 429er sind die
// Absage, weil es erreicht war — eine Absage verbraucht keine Anfrage.
describe('answeredToday', () => {
  const TEST_DB_PATH2 = path.join(__dirname, 'usage-answered-test.db');
  afterEach(() => {
    if (fs.existsSync(TEST_DB_PATH2)) fs.unlinkSync(TEST_DB_PATH2);
  });

  it('zählt abgelehnte und fehlgeschlagene Aufrufe NICHT mit', async () => {
    if (fs.existsSync(TEST_DB_PATH2)) fs.unlinkSync(TEST_DB_PATH2);
    const db = createDb(TEST_DB_PATH2);
    try {
      const app = createApp(db);
      for (let i = 0; i < 20; i++) {
        recordUsage(db, { provider: 'gemini', model: 'gemini-flash-latest', kind: 'chat' });
      }
      for (let i = 0; i < 4; i++) {
        recordUsage(db, { provider: 'gemini', model: 'gemini-flash-latest', kind: 'chat', outcome: 'quota' });
      }
      for (let i = 0; i < 4; i++) {
        recordUsage(db, { provider: 'gemini', model: 'gemini-flash-latest', kind: 'chat', outcome: 'failed' });
      }

      const res = await request(app).get('/api/usage/summary');
      expect(res.status).toBe(200);
      // Der Zähler des Menüs: genau am Limit, nicht darüber.
      expect(res.body.answeredToday['gemini/gemini-flash-latest']).toBe(20);
      // Die Aktivitäts-Zahl bleibt, was sie war — alle Versuche.
      expect(res.body.modelsToday['gemini/gemini-flash-latest']).toBe(28);
    } finally {
      db.close();
    }
  });
});
