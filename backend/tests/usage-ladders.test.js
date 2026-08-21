/**
 * tests/usage-ladders.test.js
 *
 * The two shared-ladder callers that still spent quota invisibly after the
 * `kind`/`outcome` columns landed (2026-08-21): the passage title before a
 * branch (routes/chats.js) and the mindmap outcome line after a kept `/btw`
 * (outcome.js).
 *
 * Both walk callCloudLadder, so both can burn several candidates per request —
 * and every one of those calls spends the same daily quota as an answer. Until
 * these tests none of them reached usage_log, which is the same lie the meter
 * told on 2026-08-11 ("0/20" while Gemini Flash was long exhausted).
 *
 * The OpenAI SDK is mocked, so no provider is contacted, and the database is
 * this file's own — nothing here may touch ~/.syflo/syflo.db.
 */

jest.mock('openai');
const OpenAI = require('openai');

const request = require('supertest');
const path = require('path');
const fs = require('fs');

const { createApp } = require('../server');
const { createDb } = require('../database');
const { setSetting } = require('../llm');

const TEST_DB_PATH = path.join(__dirname, 'usage_ladders_test.db');

let app;
let db;
let mockCreate;

const reply = (content) => ({ choices: [{ message: { content } }] });

/** An error the way the provider's SDK raises it. */
function apiError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function removeDb() {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const file = TEST_DB_PATH + suffix;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

beforeEach(() => {
  mockCreate = jest.fn();
  OpenAI.mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));
  removeDb();
  db = createDb(TEST_DB_PATH);
  // A keyed cloud provider with an explicit model: the ladder then has a
  // known first candidate (gemini-flash-latest) and a known second one
  // (gemini-flash-lite-latest), so "who answered" is a checkable fact.
  setSetting(db, 'llm_provider', 'gemini');
  setSetting(db, 'gemini_api_key', 'AIza-test');
  setSetting(db, 'gemini_model', 'gemini-flash-latest');
  app = createApp(db);
});

afterEach(() => {
  db.close();
  removeDb();
});

const usageRows = () => db.prepare('SELECT * FROM usage_log ORDER BY rowid').all();

describe('passage title ladder (routes/chats.js)', () => {
  it('logs the model that answered, not the one tried first', async () => {
    // The first candidate is refused, the second delivers — the row has to
    // name the model whose quota actually produced the title.
    mockCreate
      .mockRejectedValueOnce(apiError(429, 'Quota exceeded, limit: 20'))
      .mockResolvedValueOnce(reply('Internal Covariate Shift'));

    const res = await request(app)
      .post('/api/chats/passage-title')
      .send({ passage: 'e parameters of the previous layers change' });

    expect(res.body.title).toBe('Internal Covariate Shift');
    const ok = usageRows().filter((r) => r.outcome === 'ok');
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({
      provider: 'gemini',
      model: 'gemini-flash-lite-latest',
      kind: 'passage_title',
      outcome: 'ok',
    });
  });

  it('logs one row per burnt candidate: a 429 as quota, anything else as failed', async () => {
    // A refused call is a SPENT call — the provider counted it, and before
    // this the meter did not see it at all. One call, one row, exactly like
    // the Explain ladder in routes/explain.js.
    setSetting(db, 'groq_api_key', 'gsk-test'); // a third candidate to walk to
    mockCreate
      .mockRejectedValueOnce(apiError(429, 'Quota exceeded, limit: 20'))
      .mockRejectedValueOnce(apiError(400, '`reasoning_effort` is not supported with this model'))
      .mockRejectedValueOnce(apiError(400, 'Bad request'))
      .mockResolvedValueOnce(reply('Layer Normalisation'));

    const res = await request(app)
      .post('/api/chats/passage-title')
      .send({ passage: 'we apply layer normalization' });

    expect(res.body.title).toBe('Layer Normalisation');
    // Three rows, in the order the ladder walked: the refused first
    // candidate, the second one's single logged failure (the plain retry is
    // the SAME candidate and the ladder reports it once), then the answer.
    expect(usageRows().map((r) => ({ model: r.model, kind: r.kind, outcome: r.outcome }))).toEqual([
      { model: 'gemini-flash-latest', kind: 'passage_title', outcome: 'quota' },
      { model: 'gemini-flash-lite-latest', kind: 'passage_title', outcome: 'failed' },
      { model: 'openai/gpt-oss-120b', kind: 'passage_title', outcome: 'ok' },
    ]);
  });
});

describe('logging never costs the answer', () => {
  it('still returns the title when the log itself is broken', async () => {
    // The statistic is worth less than what the user is waiting for. Proven
    // with a log that cannot be written at all rather than trusting
    // recordUsage's own try/catch — the guard is a promise in a comment, and
    // this is the test that holds it to it.
    db.exec('DROP TABLE usage_log');
    mockCreate
      .mockRejectedValueOnce(apiError(429, 'Quota exceeded, limit: 20'))
      .mockResolvedValueOnce(reply('Internal Covariate Shift'));

    const res = await request(app)
      .post('/api/chats/passage-title')
      .send({ passage: 'e parameters of the previous layers change' });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Internal Covariate Shift');
  });
});

describe('outcome line ladder (outcome.js)', () => {
  /** The background call is fire-and-forget — give it a beat to land. */
  const settle = () => new Promise((r) => setTimeout(r, 60));

  /** A branch chat, the only kind that carries an outcome line. */
  async function makeBranch() {
    const root = await request(app).post('/api/chats').send({ title: 'Attention Is All You Need' });
    const branch = await request(app).post('/api/chats').send({
      title: 'Hamming distance',
      parent_id: root.body.id,
      parent_word: 'what does hamming distance mean?',
    });
    return branch.body.id;
  }

  it('logs the answering model of a written outcome line', async () => {
    const { writeOutcomeInBackground } = require('../outcome');
    const chatId = await makeBranch();
    mockCreate.mockResolvedValueOnce(reply('OUTCOME: Counts the differing positions'));

    writeOutcomeInBackground(db, chatId, 'The Hamming distance counts differing positions.');
    await settle();

    expect(db.prepare('SELECT outcome FROM chats WHERE id = ?').get(chatId).outcome)
      .toBe('Counts the differing positions');
    expect(usageRows()).toHaveLength(1);
    expect(usageRows()[0]).toMatchObject({
      provider: 'gemini', model: 'gemini-flash-latest', kind: 'title', outcome: 'ok',
    });
  });

  it('logs every burnt candidate even when no line comes out of it', async () => {
    // The node keeps its "Ergebnis folgt …" placeholder, and the user sees
    // nothing at all — but the quota is gone either way, so the meter must
    // still show what it was spent on.
    const { writeOutcomeInBackground } = require('../outcome');
    const chatId = await makeBranch();
    mockCreate
      .mockRejectedValueOnce(apiError(429, 'Quota exceeded, limit: 20'))
      .mockRejectedValueOnce(apiError(400, 'Bad request'));

    writeOutcomeInBackground(db, chatId, 'The Hamming distance counts differing positions.');
    await settle();

    expect(db.prepare('SELECT outcome FROM chats WHERE id = ?').get(chatId).outcome).toBeNull();
    expect(usageRows().map((r) => ({ model: r.model, kind: r.kind, outcome: r.outcome }))).toEqual([
      { model: 'gemini-flash-latest', kind: 'title', outcome: 'quota' },
      { model: 'gemini-flash-lite-latest', kind: 'title', outcome: 'failed' },
    ]);
  });
});
