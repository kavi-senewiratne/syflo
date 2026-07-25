/**
 * tests/explain.test.js
 *
 * Integration tests for POST /api/explain.
 * The Ollama client (OpenAI SDK) is mocked so these tests run without a
 * running Ollama server. Each test controls exactly what the mock returns.
 */

// Mock the openai module before anything else is required.
// jest.mock is hoisted so the mock is in place when routes/explain.js is loaded.
jest.mock('openai');
const OpenAI = require('openai');

const request = require('supertest');
const { createApp } = require('../server');
const { createDb } = require('../database');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'explain_test.db');

let app;
let db;
let mockCreate;

beforeEach(() => {
  // Create a fresh mock for `chat.completions.create` before each test so
  // tests don't share return values.
  mockCreate = jest.fn();
  OpenAI.mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));

  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
  app = createApp(db);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

// ─── Validation ─────────────────────────────────────────────────────────────

describe('POST /api/explain – validation', () => {
  it('returns 400 when word is missing', async () => {
    const res = await request(app).post('/api/explain').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns 400 when word is an empty string', async () => {
    const res = await request(app).post('/api/explain').send({ word: '' });
    expect(res.status).toBe(400);
  });
});

// ─── Successful responses ────────────────────────────────────────────────────

describe('POST /api/explain – success', () => {
  it('returns an explanation for a word', async () => {
    // Mock Ollama returning an explanation
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Quantum is the smallest discrete unit of energy.' } }],
    });

    const res = await request(app)
      .post('/api/explain')
      .send({ word: 'quantum' });

    expect(res.status).toBe(200);
    expect(res.body.explanation).toBe('Quantum is the smallest discrete unit of energy.');
    // Definitionen müssen sofort kommen — Denk-Modelle dürfen hier nie grübeln.
    expect(mockCreate.mock.calls[0][0].reasoning_effort).toBe('none');
  });

  it('passes context to the model when provided', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'In this context, entropy means disorder.' } }],
    });

    await request(app)
      .post('/api/explain')
      .send({ word: 'entropy', context: 'thermodynamics lecture' });

    // The model should have been called with a prompt that includes the context
    const calledWith = mockCreate.mock.calls[0][0];
    const userMessage = calledWith.messages.find(m => m.role === 'user');
    expect(userMessage.content).toContain('entropy');
    expect(userMessage.content).toContain('thermodynamics lecture');
  });

  it('works without context (word only)', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Serendipity means a happy accident.' } }],
    });

    const res = await request(app)
      .post('/api/explain')
      .send({ word: 'serendipity' });

    expect(res.status).toBe(200);
    expect(res.body.explanation).toBeDefined();
  });
});

// ─── App language (Grill-Entscheidung 2026-07-24) ────────────────────────────
// Explain ist ein Wörterbuch und erklärt in der Sprache des Lesers: das
// Frontend schickt die App language als `language` mit, der System-Prompt
// bekommt eine explizite Zielsprachen-Anweisung. Ohne (oder mit ungültigem)
// Parameter bleibt das bisherige implizite Verhalten unverändert.

describe('POST /api/explain – target language (App language)', () => {
  beforeEach(() => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Eine Erklärung.' } }],
    });
  });

  const systemPrompt = () =>
    mockCreate.mock.calls[0][0].messages.find(m => m.role === 'system').content;

  it('instructs the model to answer in German when language=de', async () => {
    await request(app).post('/api/explain').send({ word: 'entropy', language: 'de' });
    expect(systemPrompt()).toContain('Answer in German');
  });

  it('instructs the model to answer in English when language=en', async () => {
    await request(app).post('/api/explain').send({ word: 'Entropie', language: 'en' });
    expect(systemPrompt()).toContain('Answer in English');
  });

  it('adds no language instruction when the parameter is missing', async () => {
    await request(app).post('/api/explain').send({ word: 'entropy' });
    expect(systemPrompt()).not.toContain('Answer in');
  });

  it('ignores unknown language values', async () => {
    await request(app).post('/api/explain').send({ word: 'entropy', language: 'fr' });
    expect(systemPrompt()).not.toContain('Answer in');
  });
});

// ─── KV-Prefix-Sharing (2026-07-25) ──────────────────────────────────────────
// Mit chatId hängt explain die Define-Frage an den Gesprächskontext an
// (derselbe Builder wie Chat/Warm-up/Titel-Generierung, inkl. tools — sonst
// weicht der gerenderte Prefix ab). So trifft die Erklärung Ollamas KV-Cache,
// statt den einzigen Slot mit einem Standalone-Prompt zu verdrängen.

describe('POST /api/explain – shares the conversation prefix (chatId)', () => {
  const createChat = async () => {
    const res = await request(app).post('/api/chats').send({ title: 'Tree' });
    return res.body.id;
  };

  it('appends the define question to the chat context and passes tools', async () => {
    const chatId = await createChat();
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'A prefix is the shared beginning.' } }],
    });

    const res = await request(app)
      .post('/api/explain')
      .send({ word: 'prefix', chatId, language: 'de' });

    expect(res.status).toBe(200);
    const calledWith = mockCreate.mock.calls[0][0];
    // Chat-System-Prompt statt Standalone-Wörterbuch-Prompt
    expect(calledWith.messages[0].role).toBe('system');
    expect(calledWith.messages[0].content).toContain('You are a friendly and helpful assistant');
    // Define-Frage als LETZTE Nachricht, mit Stilregeln + Zielsprache
    const last = calledWith.messages[calledWith.messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toContain('Define "prefix"');
    expect(last.content).toContain('Answer in German');
    // tools wie im Gespräch — sonst rendert das Template einen anderen Prefix
    expect(calledWith.tools).toBeDefined();
  });

  it('falls back to the standalone prompt when the model returns no content', async () => {
    const chatId = await createChat();
    mockCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: '' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'A clean definition.' } }] });

    const res = await request(app)
      .post('/api/explain')
      .send({ word: 'prefix', chatId });

    expect(res.status).toBe(200);
    expect(res.body.explanation).toBe('A clean definition.');
    expect(mockCreate).toHaveBeenCalledTimes(2);
    // Zweiter Aufruf = Standalone-Wörterbuch (ohne Gesprächskontext/tools)
    const second = mockCreate.mock.calls[1][0];
    expect(second.messages[0].content).toContain('concise dictionary');
    expect(second.tools).toBeUndefined();
  });

  it('uses the standalone prompt for an unknown chatId', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Standalone definition.' } }],
    });

    const res = await request(app)
      .post('/api/explain')
      .send({ word: 'prefix', chatId: 'does-not-exist' });

    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].messages[0].content).toContain('concise dictionary');
  });
});

// ─── Error handling ──────────────────────────────────────────────────────────

describe('POST /api/explain – error handling', () => {
  it('returns 500 when Ollama is unavailable', async () => {
    mockCreate.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:11434'));

    const res = await request(app)
      .post('/api/explain')
      .send({ word: 'quantum' });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('ECONNREFUSED');
  });
});
