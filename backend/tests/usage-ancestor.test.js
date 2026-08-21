/**
 * tests/usage-ancestor.test.js
 *
 * The branch-summary call was the last big hole in the quota counter, and the
 * worst-placed one: it fires EAGERLY on branch warm-up, so it spends a cloud
 * request before the user has asked anything. Every other cloud caller in the
 * backend logs its calls since 2026-08-21; this one did not, which is exactly
 * how "0/20" stayed on the screen while the allowance was gone.
 */

const fs = require('fs');
const path = require('path');
const { createDb } = require('../database');

const TEST_DB_PATH = path.join(__dirname, 'usage-ancestor-test.db');

let db;

const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = `${TEST_DB_PATH}${suffix}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
};

beforeEach(() => {
  cleanup();
  db = createDb(TEST_DB_PATH);
  db.prepare("INSERT INTO settings (key, value) VALUES ('llm_provider', 'gemini')").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('gemini_api_key', 'test-key')").run();
  db.prepare("INSERT INTO chats (id, title, created_at) VALUES ('c1', 'Chat', '2026-08-21T10:00:00.000Z')").run();
  db.prepare(
    "INSERT INTO messages (id, chat_id, role, content, created_at) VALUES ('m1', 'c1', 'user', 'Was ist Attention?', '2026-08-21T10:00:01.000Z')"
  ).run();
});

afterEach(() => {
  db.close();
  cleanup();
});

const rows = () =>
  db.prepare('SELECT provider, model, kind, outcome FROM usage_log ORDER BY created_at').all();

// The summary call goes out through an injected client, so no network and no
// real key are involved.
const clientFor = (create) => ({
  client: { chat: { completions: { create } } },
  model: 'gemini-flash-latest',
  provider: 'gemini',
});

describe('the branch summary call', () => {
  it('logs the request it spends on a summary', async () => {
    const { ensureChatSummary } = require('../ancestor-context');
    const create = jest.fn().mockResolvedValue({
      choices: [{ message: { content: '{"gist":"g","points":["a"],"summary":"s"}' } }],
      usage: { prompt_tokens: 120, completion_tokens: 40 },
    });

    await ensureChatSummary(db, 'c1', { getClient: () => clientFor(create) });

    expect(rows()).toEqual([
      { provider: 'gemini', model: 'gemini-flash-latest', kind: 'summary', outcome: 'ok' },
    ]);
  });

  it('logs a refused summary too — the allowance is spent either way', async () => {
    const { ensureChatSummary } = require('../ancestor-context');
    const create = jest.fn().mockRejectedValue(Object.assign(new Error('429 quota'), { status: 429 }));

    await expect(
      ensureChatSummary(db, 'c1', { getClient: () => clientFor(create) }),
    ).rejects.toThrow();

    expect(rows()).toEqual([
      { provider: 'gemini', model: 'gemini-flash-latest', kind: 'summary', outcome: 'quota' },
    ]);
  });

  it('writes nothing when the summary is already current — no call, no row', async () => {
    const { ensureChatSummary } = require('../ancestor-context');
    db.prepare("UPDATE chats SET summary = 'cached', summary_last_message_id = 'm1' WHERE id = 'c1'").run();
    const create = jest.fn();

    await ensureChatSummary(db, 'c1', { getClient: () => clientFor(create) });

    expect(create).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });
});
