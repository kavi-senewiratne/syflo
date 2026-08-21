/**
 * tests/overview-fulltext.test.js
 *
 * The Video overview never runs in retrieval mode (user decision 2026-08-20).
 *
 * Retrieval answers "where does he say X?" by fetching the chunks that match
 * the question. The overview asks for the WHOLE video in order, and no handful
 * of chunks matches that — worse, the video retrieval branch of the system
 * prompt carries no overview rule at all, so the answer comes back without the
 * `## Topic [m:ss - m:ss]` headings the chapter list is parsed from.
 *
 * Measured on 2026-08-20: makemore Part 4 (108 393 chars) was the first
 * transcript ever to exceed the budget (97 184 chars). Its overview arrived as
 * 4 694 chars with no time mark, and the chapter list stayed empty; every
 * shorter video had gone through full text and produced chapters.
 *
 * Same warmup-free route as messages.test.js: post a real message and read the
 * system prompt off the mocked completion call.
 */
process.env.OPENAI_API_KEY = 'test-key-for-unit-tests';
jest.mock('openai');
const OpenAI = require('openai');

const request = require('supertest');
const { createApp } = require('../server');
const { createDb } = require('../database');
const { setSetting } = require('../llm');
const { contextBudget } = require('../ancestor-context');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'overview-fulltext-test.db');

let db;
let mockCreate;
const realFetch = global.fetch;

/** A transcript comfortably past the budget, with a time mark every minute. */
function longSegments(minutes) {
  return Array.from({ length: minutes }, (_, i) => ({
    offsetMs: i * 60_000,
    text: `Minute ${i}: ` + 'the speaker keeps explaining backpropagation by hand. '.repeat(40),
  }));
}

beforeEach(() => {
  mockCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'x' } }] });
  OpenAI.mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });

  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
  setSetting(db, 'llm_provider', 'ollama');
});

afterEach(() => {
  global.fetch = realFetch;
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

function makeApp(segments) {
  const fetchTranscriptFn = jest.fn().mockResolvedValue({
    title: 'Building makemore Part 4: Becoming a Backprop Ninja',
    channel: 'Andrej Karpathy',
    durationSeconds: 6924,
    language: 'en',
    segments,
  });
  // Deterministic embeddings: retrieval mode must be reachable without Ollama.
  const embedTextsFn = jest.fn(async texts => texts.map((_, i) => [i + 1, 1, 0]));
  return createApp(db, { youtube: { fetchTranscriptFn }, messages: { embedTextsFn } });
}

async function videoChat(app) {
  const chat = await request(app).post('/api/chats').send({ title: 'New Chat' });
  const imp = await request(app)
    .post('/api/youtube/import')
    .send({ chat_id: chat.body.id, youtube_id: 'q8SA3rM6ckI' });
  expect(imp.status).toBe(201);
  return chat.body.id;
}

function systemPromptOfLastAnswer() {
  const call = mockCreate.mock.calls.find(c => (c[0].messages || []).some(m => m.role === 'system'));
  return call[0].messages.find(m => m.role === 'system').content;
}

describe('a transcript too long for the budget', () => {
  it('stays FULL TEXT when the question is the Video overview', async () => {
    const app = makeApp(longSegments(120));
    const chatId = await videoChat(app);
    // Precondition: this transcript really is over the budget, otherwise the
    // test would pass for the wrong reason.
    const video = db.prepare('SELECT transcript FROM videos LIMIT 1').get();
    expect(video.transcript.length).toBeGreaterThan(contextBudget(db).maxSystemContextChars);

    await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .send({ content: 'Break the whole video down into its sections.', overview: true })
      .buffer(true);

    const system = systemPromptOfLastAnswer();
    expect(system).toContain('--- VIDEO TRANSCRIPT START ---');
    expect(system).not.toContain('SKELETON');
    // The overview rule — the chapter list is parsed from the shape it asks for.
    expect(system).toContain('[m:ss - m:ss]');
    // Trimmed to the budget, and the model is told where the cut is, so
    // overviewStopsShort and the continue endpoint can carry on from there.
    expect(system).toContain('the transcript is truncated at');
  });

  it('still uses RETRIEVAL for an ordinary question about the same video', async () => {
    const app = makeApp(longSegments(120));
    const chatId = await videoChat(app);

    await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .send({ content: 'What does he say about batch norm?' })
      .buffer(true);

    const system = systemPromptOfLastAnswer();
    expect(system).toContain('SKELETON');
    expect(system).not.toContain('--- VIDEO TRANSCRIPT START ---');
  });
});

describe('a transcript that fits', () => {
  it('is full text either way — the flag changes nothing', async () => {
    const app = makeApp(longSegments(3));
    const chatId = await videoChat(app);

    await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .send({ content: 'What does he say about batch norm?' })
      .buffer(true);

    const system = systemPromptOfLastAnswer();
    expect(system).toContain('--- VIDEO TRANSCRIPT START ---');
    expect(system).not.toContain('SKELETON');
  });
});
