/**
 * tests/youtube-context.test.js
 *
 * The tree's YouTube transcript must reach the chat model: it is injected
 * into the system prompt (same budget slot as paper text, ADR-0005), with
 * the restructure rule and — when the budget trims it — an explicit note
 * telling the model from which minute the transcript is cut off.
 *
 * Verified through the warmup endpoint, which builds the exact same prompt
 * prefix as a real message (messages.test.js pattern).
 */
process.env.OPENAI_API_KEY = 'test-key-for-unit-tests';
jest.mock('openai');
const OpenAI = require('openai');

const request = require('supertest');
const { createApp } = require('../server');
const { createDb } = require('../database');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'youtube-context-test.db');

let db;
let mockCreate;
const realFetch = global.fetch;

beforeEach(() => {
  mockCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'x' } }] });
  OpenAI.mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));
  // extendOllamaKeepAlive spricht die native Ollama-API — hier gemockt.
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });

  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
});

afterEach(() => {
  global.fetch = realFetch;
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

function makeApp(segments, meta = {}) {
  const fetchTranscriptFn = jest.fn().mockResolvedValue({
    title: 'Intro to Large Language Models',
    channel: 'Andrej Karpathy',
    durationSeconds: 3587,
    language: 'en',
    segments,
    ...meta,
  });
  return createApp(db, { youtube: { fetchTranscriptFn } });
}

async function chatWithVideo(app, segments) {
  const chat = await request(app).post('/api/chats').send({ title: 'New Chat' });
  const imp = await request(app)
    .post('/api/youtube/import')
    .send({ chat_id: chat.body.id, youtube_id: 'zjkBMFhNj_g' });
  expect(imp.status).toBe(201);
  return chat.body;
}

async function warmupSystemPrompt(app, chatId) {
  const res = await request(app).post(`/api/chats/${chatId}/messages/warmup`);
  expect(res.status).toBe(200);
  expect(res.body.warmed).toBe(true);
  const call = mockCreate.mock.calls[0][0];
  expect(call.messages[0].role).toBe('system');
  return call.messages[0].content;
}

describe('chat title in a video tree', () => {
  // Simuliert die Streaming-Antwort des Modells (Muster aus messages.test.js).
  function makeStream(words) {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const word of words) {
          yield { choices: [{ delta: { content: word } }] };
        }
        yield { choices: [{ delta: {} }] };
      },
    };
  }

  it('keeps the video title on the root — no LLM re-titling (tree is named after its source)', async () => {
    const app = makeApp([{ startMs: 0, text: 'Hi everyone.' }]);
    const chat = await chatWithVideo(app);

    mockCreate.mockResolvedValue(makeStream(['Overview.']));
    const res = await request(app)
      .post(`/api/chats/${chat.id}/messages`)
      .send({ content: 'Structure the information in this video.' });
    expect(res.status).toBe(200);

    const detail = await request(app).get(`/api/chats/${chat.id}`);
    expect(detail.body.title).toBe('Intro to Large Language Models');
  });
});

describe('YouTube transcript in the chat context', () => {
  it('injects title, channel, transcript and the restructure rule into the system prompt', async () => {
    const app = makeApp([
      { startMs: 0, text: 'Hi everyone.' },
      { startMs: 90_000, text: 'So what is a large language model really?' },
    ]);
    const chat = await chatWithVideo(app);

    const system = await warmupSystemPrompt(app, chat.id);

    expect(system).toContain('"Intro to Large Language Models"');
    expect(system).toContain('Andrej Karpathy');
    expect(system).toContain('--- VIDEO TRANSCRIPT START ---');
    expect(system).toContain('[00:00] Hi everyone.');
    expect(system).toContain('[01:30] So what is a large language model really?');
    expect(system).toContain('--- VIDEO TRANSCRIPT END ---');
    // Video overview rule: restructure, never summarize (user decision 2026-07-23).
    expect(system).toMatch(/do NOT summarize/i);
    // Untrimmed transcript → no truncation note.
    expect(system).not.toMatch(/truncated at/i);
  });

  it('appends an explicit truncation note when the budget trims the transcript', async () => {
    // ~64k chars of transcript — far over MAX_SYSTEM_CONTEXT_CHARS (~40k).
    const segments = [];
    for (let i = 0; i < 3200; i++) {
      segments.push({ startMs: i * 15_000, text: `Segment number ${i} padding`.padEnd(20, 'x') });
    }
    const app = makeApp(segments);
    const chat = await chatWithVideo(app);

    const system = await warmupSystemPrompt(app, chat.id);

    // The tail is gone…
    expect(system).not.toContain('Segment number 3199');
    // …and the model is told so, with the minute where the cut happened.
    expect(system).toMatch(/transcript is truncated at \[\d+:\d{2}(?::\d{2})?\] of 59:47/i);
  });
});
