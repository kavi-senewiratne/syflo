/**
 * tests/btw.test.js
 *
 * Integration tests for POST /api/btw — the throwaway side question
 * (design/mockup-btw-composer-fold.html).
 *
 * The defining property is what does NOT happen: the answer streams back to
 * the caller and the chat's message list is untouched. Everything else the
 * route does (context, ladder failover) is shared with existing routes.
 */

jest.mock('openai');
const OpenAI = require('openai');

const request = require('supertest');
const { createApp } = require('../server');
const { createDb } = require('../database');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'btw_test.db');

let app;
let db;
let mockCreate;

/**
 * A finished stream: text, then the provider's verdict that it ended cleanly.
 * The final chunk carries finish_reason 'stop' because that is what the real
 * providers send (gemini-flash-latest measured 2026-08-19) — and the route
 * reads exactly that to decide whether an answer may be shown as complete.
 */
function makeStream(words, finishReason = 'stop') {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const word of words) {
        yield { choices: [{ delta: { content: word } }] };
      }
      yield { choices: [{ delta: {}, finish_reason: finishReason }] };
    },
  };
}

/** A stream that hands out a few words and then dies mid-answer. */
function makeDyingStream(words, err) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const word of words) {
        yield { choices: [{ delta: { content: word } }] };
      }
      throw err;
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
  // Local path — bypasses the cloud default (ADR-0008).
  require('../llm').setSetting(db, 'llm_provider', 'ollama');
  app = createApp(db);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

describe('POST /api/btw', () => {
  it('streams an answer without writing anything to the chat', async () => {
    const chatId = 1;
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
      .run(chatId, 'Attention', new Date().toISOString());
    mockCreate.mockResolvedValue(makeStream(['A logit ', 'is a raw score.']));

    const res = await request(app)
      .post('/api/btw')
      .send({ chatId, question: 'what does logit mean again?' });

    expect(res.status).toBe(200);
    const events = parseSSE(res.text);
    const answer = events.filter((e) => e.delta).map((e) => e.delta).join('');
    expect(answer).toBe('A logit is a raw score.');
    expect(events.some((e) => e.done)).toBe(true);

    const stored = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?').get(chatId);
    expect(stored.n).toBe(0);
  });

  // The traffic is one-way: the aside reads the conversation so that "what
  // does this mean?" lands in context, but nothing it says ever reaches the
  // conversation (decision 2026-08-08).
  it('sends the conversation so far along with the question', async () => {
    const chatId = 1;
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
      .run(chatId, 'Attention', new Date().toISOString());
    const insert = db.prepare(
      'INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    insert.run('m1', chatId, 'user', 'Why divide by the square root of d_k?', new Date().toISOString());
    insert.run('m2', chatId, 'assistant', 'Because the dot products grow with dimension.', new Date().toISOString());
    mockCreate.mockResolvedValue(makeStream(['ok']));

    await request(app).post('/api/btw').send({ chatId, question: 'what does logit mean again?' });

    const sent = mockCreate.mock.calls[0][0].messages;
    expect(sent.some((m) => m.content?.includes('dot products grow with dimension'))).toBe(true);
    expect(sent[sent.length - 1].role).toBe('user');
    expect(sent[sent.length - 1].content).toContain('what does logit mean again?');
  });
});

// ─── Keeping an aside (mockup §03) ──────────────────────────────────────────
// The one path where an aside becomes permanent. Both buttons of the panel
// end up here: "Keep in chat" writes the pair into the current thread,
// "Make a branch" writes only the answer into the freshly created branch —
// its question already lives in the branch header as the parent quote.

describe('POST /api/btw/keep', () => {
  it('appends the question and the answer as two ordinary messages', async () => {
    const chatId = 1;
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
      .run(chatId, 'Attention', new Date().toISOString());
    db.prepare('INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('m1', chatId, 'user', 'first question', new Date().toISOString());

    const res = await request(app)
      .post('/api/btw/keep')
      .send({ chatId, question: 'what does logit mean again?', answer: 'A raw score.' });

    expect(res.status).toBe(200);
    const rows = db.prepare('SELECT role, content FROM messages WHERE chat_id = ? ORDER BY rowid').all(chatId);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual({ role: 'user', content: 'what does logit mean again?' });
    expect(rows[2]).toEqual({ role: 'assistant', content: 'A raw score.' });
  });

  it('writes only the answer when there is no question to keep', async () => {
    const chatId = 2;
    db.prepare('INSERT INTO chats (id, title, parent_word, created_at) VALUES (?, ?, ?, ?)')
      .run(chatId, 'About logit', 'what does logit mean again?', new Date().toISOString());

    const res = await request(app).post('/api/btw/keep').send({ chatId, answer: 'A raw score.' });

    expect(res.status).toBe(200);
    const rows = db.prepare('SELECT role, content FROM messages WHERE chat_id = ? ORDER BY rowid').all(chatId);
    expect(rows).toEqual([{ role: 'assistant', content: 'A raw score.' }]);
  });

  // Caught in the running app, not by any of the tests above: without an
  // explicit id the rows land with id NULL, React renders two children with
  // the same key and the kept messages never appear (2026-08-08).
  it('gives every kept message an id', async () => {
    const chatId = 3;
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
      .run(chatId, 'Attention', new Date().toISOString());

    const res = await request(app)
      .post('/api/btw/keep')
      .send({ chatId, question: 'q', answer: 'a' });

    expect(res.body.messages).toHaveLength(2);
    for (const m of res.body.messages) expect(typeof m.id).toBe('string');
    expect(res.body.messages[0].id).not.toBe(res.body.messages[1].id);
  });

  it('rejects an answer for a chat that does not exist', async () => {
    const res = await request(app).post('/api/btw/keep').send({ chatId: 999, answer: 'x' });
    expect(res.status).toBe(404);
  });
});

// ─── Automatic model switch (mockup §05) ────────────────────────────────────
// A side question is not worth a decision: when the chat's model is out of
// quota the route walks the shared ladder by itself and only says WHO
// answered instead.

describe('POST /api/btw – exhausted models switch themselves', () => {
  const quotaError = () =>
    Object.assign(new Error('Quota exceeded for metric generate_requests_per_model_per_day'), { status: 429 });

  function useGeminiAndGroq() {
    const { setSetting } = require('../llm');
    setSetting(db, 'llm_provider', 'gemini');
    setSetting(db, 'gemini_api_key', 'AIza-test');
    setSetting(db, 'gemini_model', 'gemini-pro-latest');
    setSetting(db, 'groq_api_key', 'gsk-test');
  }

  it('answers from the next model on the ladder and names the switch', async () => {
    useGeminiAndGroq();
    const chatId = 1;
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
      .run(chatId, 'Attention', new Date().toISOString());
    mockCreate
      .mockRejectedValueOnce(quotaError())
      .mockResolvedValueOnce(makeStream(['A raw score.']));

    const res = await request(app).post('/api/btw').send({ chatId, question: 'what does logit mean?' });

    const events = parseSSE(res.text);
    expect(events.filter((e) => e.delta).map((e) => e.delta).join('')).toBe('A raw score.');
    const done = events.find((e) => e.done);
    expect(done.model).toBe('gemini-flash-latest');
    expect(done.switchedFrom).toBe('gemini-pro-latest');
    expect(done.switchedFromProvider).toBe('gemini');
    expect(done.provider).toBe('gemini');
  });

  // Nutzer-Report 2026-08-19 (mit Bild): das Panel stand fertig da — mit
  // beiden Knöpfen — und die Antwort endete mitten im Wort ("… oder int").
  // Ein Panel, das "Im Chat behalten" auf einer halben Antwort anbietet,
  // behauptet etwas Falsches.
  it('writes the rest itself when the model broke off mid-sentence', async () => {
    useGeminiAndGroq();
    const chatId = 1;
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
      .run(chatId, 'Demut', new Date().toISOString());
    mockCreate
      // Der Abbruch: die Antwort hört mitten im Wort auf, und der Anbieter
      // sagt es über finish_reason.
      .mockResolvedValueOnce(makeStream(['Demut heißt humility. Im wissenschaftlichen oder int'], 'length'))
      // Die Fortsetzung wiederholt die letzten Worte — das ist die Naht, an
      // der die beiden Hälften zusammenfinden ("… oder int" + "oder inter…").
      .mockResolvedValueOnce(makeStream(['oder internationalen Kontext ist humility üblich.']));

    const res = await request(app).post('/api/btw').send({ chatId, question: 'Bedeutet Demut humbleness?' });

    const events = parseSSE(res.text);
    const answer = events.filter((e) => e.delta).map((e) => e.delta).join('');
    expect(answer).toBe(
      'Demut heißt humility. Im wissenschaftlichen oder internationalen Kontext ist humility üblich.',
    );
    expect(events.some((e) => e.done)).toBe(true);
    expect(events.some((e) => e.error)).toBe(false);
    // Die zweite Runde geht an dasselbe Modell und trägt die alte Antwort mit.
    const second = mockCreate.mock.calls[1][0];
    expect(second.model).toBe('gemini-pro-latest');
    expect(second.messages.some((m) => m.role === 'assistant' && m.content.includes('oder int'))).toBe(true);
  });

  // Gemessen 2026-08-20: die Fortsetzung kam nach 9 Sekunden Stille als EIN
  // Block von 221 Zeichen („es kommt alles auf einmal"). Sie muss strömen wie
  // die erste Runde — zurückgehalten wird nur das Nahtfenster, hinter dem sich
  // keine Wiederholung mehr verstecken kann.
  it('streams the continuation instead of dropping it in as one block', async () => {
    useGeminiAndGroq();
    const chatId = 1;
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
      .run(chatId, 'Mech interp', new Date().toISOString());
    // Die Fortsetzung ist deutlich länger als das Nahtfenster (240 Zeichen),
    // also gibt es hinter der Naht echten Text, der live durchlaufen kann.
    const tail = Array.from({ length: 12 }, (_, i) => `Satz Nummer ${i} über Schaltkreise im Netz. `);
    mockCreate
      .mockResolvedValueOnce(makeStream(['Mech interp untersucht, wie ein Netz'], null))
      .mockResolvedValueOnce(makeStream(['wie ein Netz ', ...tail]));

    const res = await request(app).post('/api/btw').send({ chatId, question: 'was bedeutet mech interp' });

    const events = parseSSE(res.text);
    const deltas = events.filter((e) => e.delta).map((e) => e.delta);
    // Die erste Runde ist ein Delta; alles Weitere gehört der Fortsetzung.
    expect(deltas.length).toBeGreaterThan(2);
    const answer = deltas.join('');
    expect(answer.startsWith('Mech interp untersucht, wie ein Netz ')).toBe(true);
    // Die Naht ist geschnitten: „wie ein Netz" steht genau einmal.
    expect(answer.match(/wie ein Netz/g)).toHaveLength(1);
    expect(answer.endsWith('Satz Nummer 11 über Schaltkreise im Netz. ')).toBe(true);
  });

  // Nutzer-Report 2026-08-20 14:13 (mit Bild), dazu das Log:
  //   [btw] cut off (finish_reason=MISSING, len=40) — writing on
  //   [btw] continuation failed: 429 status code (no body)
  // Die Fortsetzung fragte nur DASSELBE Modell — ausgerechnet das, dessen
  // Kontingent gerade zu Ende ist. Genau dafür gibt es die Leiter.
  it('lets another model finish the sentence when the first one is out of quota', async () => {
    useGeminiAndGroq();
    const chatId = 1;
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
      .run(chatId, 'Mech interp', new Date().toISOString());
    mockCreate
      .mockResolvedValueOnce(makeStream(['Mechanistic Interpretability (kurz: Mech'], null))
      .mockRejectedValueOnce(quotaError())            // dasselbe Modell: erschöpft
      .mockResolvedValueOnce(makeStream(['(kurz: Mech interp) zerlegt Netze.'])); // das nächste springt ein

    const res = await request(app).post('/api/btw').send({ chatId, question: 'was ist mech interp' });

    const events = parseSSE(res.text);
    const answer = events.filter((e) => e.delta).map((e) => e.delta).join('');
    expect(answer).toBe('Mechanistic Interpretability (kurz: Mech interp) zerlegt Netze.');
    expect(events.find((e) => e.done).truncated).toBeFalsy();
  });

  // Und wenn wirklich niemand mehr kann: dann sagt das Panel es, statt eine
  // halbe Antwort mit beiden Knöpfen als fertig auszugeben.
  it('marks the answer as cut when no model could finish it', async () => {
    useGeminiAndGroq();
    const chatId = 1;
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
      .run(chatId, 'Mech interp', new Date().toISOString());
    mockCreate
      .mockResolvedValueOnce(makeStream(['Mechanistic Interpretability (kurz: Mech'], null))
      .mockRejectedValue(quotaError());

    const res = await request(app).post('/api/btw').send({ chatId, question: 'was ist mech interp' });

    const events = parseSSE(res.text);
    expect(events.filter((e) => e.delta).map((e) => e.delta).join(''))
      .toBe('Mechanistic Interpretability (kurz: Mech');
    expect(events.find((e) => e.done).truncated).toBe(true);
  });

  // Aus dem Log der laufenden App, 2026-08-20 10:12:
  //   [btw] cut off (finish_reason=MISSING, len=221) — writing on
  //   [btw] continuation failed: 503 status code (no body)
  // Der Abbruch wurde erkannt, das Weiterschreiben scheiterte an einem 503 —
  // und ein 503 ist Wetter, kein Zustand (siehe isOverloaded in quota.js).
  it('retries the continuation when the provider is momentarily overloaded', async () => {
    useGeminiAndGroq();
    const chatId = 1;
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
      .run(chatId, 'Demut', new Date().toISOString());
    const overloaded = () => Object.assign(new Error('503 status code (no body)'), { status: 503 });
    mockCreate
      .mockResolvedValueOnce(makeStream(['Mech interp untersucht, wie ein Netz'], null))
      .mockRejectedValueOnce(overloaded())
      .mockResolvedValueOnce(makeStream(['wie ein Netz intern rechnet.']));

    const res = await request(app).post('/api/btw').send({ chatId, question: 'was bedeutet mech interp' });

    const events = parseSSE(res.text);
    expect(events.filter((e) => e.delta).map((e) => e.delta).join('')).toBe(
      'Mech interp untersucht, wie ein Netz intern rechnet.',
    );
    expect(events.some((e) => e.error)).toBe(false);
  });

  // Nutzer-Report 2026-08-20 (mit Bild): im Panel stand "Request was aborted."
  // Das ist der interne Satz des SDK, kein Satz für einen Menschen — und er
  // sagt nicht, was zu tun ist.
  it('names a timeout as a timeout instead of leaking the SDK sentence', async () => {
    useGeminiAndGroq();
    const chatId = 1;
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
      .run(chatId, 'Demut', new Date().toISOString());
    mockCreate.mockRejectedValue(
      Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' }),
    );

    const res = await request(app).post('/api/btw').send({ chatId, question: 'q' });

    const failed = parseSSE(res.text).find((e) => e.error);
    expect(failed.reason).toBe('timeout');
  });

  // Live gestreamt heißt: die halbe Antwort steht schon auf dem Schirm, bevor
  // irgendwer weiß, dass der Aufruf stirbt. Das nächste Modell schriebe seine
  // Antwort dann UNTER die Bruchstücke des vorigen.
  it('takes back the fragment of a candidate that died mid-answer', async () => {
    useGeminiAndGroq();
    const chatId = 1;
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
      .run(chatId, 'Demut', new Date().toISOString());
    mockCreate
      .mockResolvedValueOnce(makeDyingStream(['Ja, genau. Demut'], quotaError()))
      .mockResolvedValueOnce(makeStream(['Demut heißt humility.']));

    const res = await request(app).post('/api/btw').send({ chatId, question: 'q' });

    const events = parseSSE(res.text);
    expect(events.some((e) => e.reset)).toBe(true);
    // Alles VOR dem reset gehört dem toten Kandidaten, alles danach der
    // Antwort, die wirklich kam.
    const afterReset = events.slice(events.findIndex((e) => e.reset) + 1);
    expect(afterReset.filter((e) => e.delta).map((e) => e.delta).join('')).toBe('Demut heißt humility.');
  });

  // Ein Modell, das erfolgreich nichts sagt, ist keine Antwort — der nächste
  // Kandidat bekommt die Frage (dieselbe Regel wie bei den Chat-Runden).
  it('does not accept an empty answer as the answer', async () => {
    useGeminiAndGroq();
    const chatId = 1;
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
      .run(chatId, 'Demut', new Date().toISOString());
    mockCreate
      .mockResolvedValueOnce(makeStream([]))
      .mockResolvedValueOnce(makeStream(['Demut heißt humility.']));

    const res = await request(app).post('/api/btw').send({ chatId, question: 'q' });

    const events = parseSSE(res.text);
    expect(events.filter((e) => e.delta).map((e) => e.delta).join('')).toBe('Demut heißt humility.');
    expect(events.find((e) => e.done).model).toBe('gemini-flash-latest');
  });

  it('says nothing about models when the chat’s own model answered', async () => {
    useGeminiAndGroq();
    const chatId = 1;
    db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)')
      .run(chatId, 'Attention', new Date().toISOString());
    mockCreate.mockResolvedValueOnce(makeStream(['A raw score.']));

    const res = await request(app).post('/api/btw').send({ chatId, question: 'q' });

    const done = parseSSE(res.text).find((e) => e.done);
    expect(done.switchedFrom).toBeUndefined();
  });
});
