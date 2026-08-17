/**
 * tests/truncated-answer.test.js
 *
 * Eine Antwort, die der Anbieter mitten im Satz beendet
 * (design/mockup-truncated-answer.html §01). Gemessen am 2026-08-16: eine
 * Video overview endete nach 340 Tokens mit "während die Aktivierungen dem",
 * und nichts in der App sagte, dass etwas fehlt — die Kappung sah aus wie
 * eine fertige Antwort.
 *
 * Der einzige Zeuge ist der finish_reason des Anbieters. Er wird deshalb an
 * der Nachricht persistiert (nicht nur ins Log geschrieben) und mit
 * "Weiterschreiben" fortgesetzt: der bisherige Text bleibt stehen, die
 * Fortsetzung wächst in DIESELBE Nachricht — sonst sähe die Kapitelliste
 * zwei Übersichten statt einer.
 */

jest.mock('openai');
const OpenAI = require('openai');

const request = require('supertest');
const { createApp } = require('../server');
const { createDb } = require('../database');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'truncated_test.db');

let app;
let db;
let mockCreate;

// A stream that ends the way a cut-off answer ends: text, then a final chunk
// carrying a finish_reason that is NOT 'stop'.
function makeCutStream(words, finishReason = 'length') {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const word of words) {
        yield { choices: [{ delta: { content: word } }] };
      }
      yield { choices: [{ delta: {}, finish_reason: finishReason }] };
    },
  };
}

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
  require('../llm').setSetting(db, 'llm_provider', 'ollama');
  app = createApp(db);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

async function ask(chatId, content = 'Gliedere das Video') {
  const res = await request(app)
    .post(`/api/chats/${chatId}/messages`)
    .send({ content });
  return parseSSE(res.text);
}

describe('an answer the provider cut short', () => {
  it('marks the message as truncated and says so in the stream', async () => {
    mockCreate
      .mockResolvedValueOnce(makeCutStream(['## Teil eins [0:03 - 5:12]\n', 'während die Aktivierungen dem']))
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Titel' } }] });
    const chat = await request(app).post('/api/chats').send({ title: 'T' });

    const events = await ask(chat.body.id);

    // The stream announces it, so the live bubble can show the card without
    // a reload.
    expect(events.find((e) => e.truncated)).toBeDefined();
    // And it survives a reload — the cause is persisted, not just logged.
    const detail = await request(app).get(`/api/chats/${chat.body.id}`);
    const answer = detail.body.messages.find((m) => m.role === 'assistant');
    expect(answer.truncated).toBe(1);
    // The text that DID arrive is kept — it is worth reading.
    expect(answer.content).toContain('während die Aktivierungen dem');
  });

  it('grows the SAME message when the reader asks to continue', async () => {
    mockCreate
      .mockResolvedValueOnce(makeCutStream(['## Teil eins [0:03 - 5:12]\n\nDie Gewichte entsprechen dem']))
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Titel' } }] });
    const chat = await request(app).post('/api/chats').send({ title: 'T' });
    await ask(chat.body.id);
    const before = await request(app).get(`/api/chats/${chat.body.id}`);
    const cut = before.body.messages.find((m) => m.role === 'assistant');

    mockCreate.mockResolvedValueOnce(makeStream([' Binärcode.\n\n## Teil zwei [5:12 - 11:40]\n\nWeiter geht es.']));
    const res = await request(app)
      .post(`/api/chats/${chat.body.id}/messages/continue`)
      .send({ messageId: cut.id });
    expect(res.status).toBe(200);

    const after = await request(app).get(`/api/chats/${chat.body.id}`);
    const answers = after.body.messages.filter((m) => m.role === 'assistant');
    // ONE message, not two: the chapter list must see a single overview.
    expect(answers).toHaveLength(1);
    expect(answers[0].id).toBe(cut.id);
    expect(answers[0].content).toContain('Die Gewichte entsprechen dem Binärcode.');
    expect(answers[0].content).toContain('## Teil zwei');
    // Finished this time — the card is gone.
    expect(answers[0].truncated).toBeFalsy();
  });

  it('heals the seam the model leaves — no "demArbeitsspeicher"', async () => {
    // The live failure of 2026-08-16: providers drop the leading space, so the
    // continuation repeats its first words and the join cuts the repetition.
    mockCreate
      .mockResolvedValueOnce(makeCutStream(['Die Aktivierungen entsprechen dem']))
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Titel' } }] });
    const chat = await request(app).post('/api/chats').send({ title: 'T' });
    await ask(chat.body.id);
    const detail = await request(app).get(`/api/chats/${chat.body.id}`);
    const cut = detail.body.messages.find((m) => m.role === 'assistant');

    mockCreate.mockResolvedValueOnce(makeStream(['entsprechen dem Arbeitsspeicher zur Laufzeit.']));
    await request(app)
      .post(`/api/chats/${chat.body.id}/messages/continue`)
      .send({ messageId: cut.id });

    const after = await request(app).get(`/api/chats/${chat.body.id}`);
    const answer = after.body.messages.find((m) => m.role === 'assistant');
    expect(answer.content).toBe('Die Aktivierungen entsprechen dem Arbeitsspeicher zur Laufzeit.');
  });

  it('refuses to continue an answer that was never cut short', async () => {
    mockCreate
      .mockResolvedValueOnce(makeStream(['Fertige Antwort.']))
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Titel' } }] });
    const chat = await request(app).post('/api/chats').send({ title: 'T' });
    await ask(chat.body.id);
    const detail = await request(app).get(`/api/chats/${chat.body.id}`);
    const done = detail.body.messages.find((m) => m.role === 'assistant');

    const res = await request(app)
      .post(`/api/chats/${chat.body.id}/messages/continue`)
      .send({ messageId: done.id });

    expect(res.status).toBe(409);
  });

  it('tells the model where it stopped so it resumes instead of restarting', async () => {
    mockCreate
      .mockResolvedValueOnce(makeCutStream(['## Teil eins [0:03 - 5:12]\n\nEin Satz, der abbricht']))
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Titel' } }] });
    const chat = await request(app).post('/api/chats').send({ title: 'T' });
    await ask(chat.body.id);
    const detail = await request(app).get(`/api/chats/${chat.body.id}`);
    const cut = detail.body.messages.find((m) => m.role === 'assistant');

    mockCreate.mockResolvedValueOnce(makeStream([' und weitergeht.']));
    await request(app)
      .post(`/api/chats/${chat.body.id}/messages/continue`)
      .send({ messageId: cut.id });

    // The last STREAMING call — the title/outcome side call runs after it and
    // is not the answer.
    const call = mockCreate.mock.calls.map((c) => c[0]).filter((c) => c.stream).pop();
    const last = call.messages[call.messages.length - 1];
    // The cut text is in the conversation as the assistant's own words, and
    // the instruction says: pick it up mid-sentence, repeat nothing.
    expect(JSON.stringify(call.messages)).toContain('Ein Satz, der abbricht');
    expect(last.content).toMatch(/continue|fortfahr|weiter/i);
  });

  it('leaves a normal answer untouched', async () => {
    mockCreate
      .mockResolvedValueOnce(makeStream(['Fertige Antwort.']))
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Titel' } }] });
    const chat = await request(app).post('/api/chats').send({ title: 'T' });

    const events = await ask(chat.body.id);

    expect(events.find((e) => e.truncated)).toBeUndefined();
    const detail = await request(app).get(`/api/chats/${chat.body.id}`);
    const answer = detail.body.messages.find((m) => m.role === 'assistant');
    expect(answer.truncated).toBeFalsy();
  });
});
