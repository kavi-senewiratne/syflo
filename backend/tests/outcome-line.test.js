/**
 * tests/outcome-line.test.js
 *
 * The mindmap node's second line (chats.outcome) for branches whose answer
 * never travelled through POST /messages.
 *
 * `/btw` → "Make a branch" writes the kept answer straight into the branch
 * (routes/btw.js). That branch therefore has a real answer from its first
 * second — and used to keep the "Ergebnis folgt …" placeholder forever,
 * because only the message route ever asked for an outcome (live report
 * 2026-08-08).
 */

jest.mock('openai');
const OpenAI = require('openai');

const request = require('supertest');
const path = require('path');
const fs = require('fs');
const { createDb } = require('../database');
const { createApp } = require('../server');

const TEST_DB_PATH = path.join(__dirname, 'outcome_line_test.db');

let db;
let app;
let mockCreate;

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

/** The background outcome call is fire-and-forget — give it a beat to land. */
const settle = () => new Promise((r) => setTimeout(r, 40));

describe('outcome line for a kept aside', () => {
  it('writes the outcome of a branch whose only answer was kept from /btw', async () => {
    const root = await request(app).post('/api/chats').send({ title: 'Attention Is All You Need' });
    const branch = await request(app).post('/api/chats').send({
      title: 'Hamming distance',
      parent_id: root.body.id,
      parent_word: 'what does hamming distance mean?',
    });

    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content:
      'OUTCOME: Zählt die Stellen, an denen sich zwei Wörter unterscheiden',
    } }] });

    await request(app).post('/api/btw/keep').send({
      chatId: branch.body.id,
      answer: 'Die Hamming-Distanz zählt die Positionen, an denen sich zwei gleich lange Wörter unterscheiden.',
    });
    await settle();

    const after = await request(app).get(`/api/chats/${branch.body.id}`);
    expect(after.body.outcome).toBe('Zählt die Stellen, an denen sich zwei Wörter unterscheiden');
  });

  it('leaves the root chat alone — only branches carry an outcome line', async () => {
    const root = await request(app).post('/api/chats').send({ title: 'Attention Is All You Need' });

    await request(app).post('/api/btw/keep').send({
      chatId: root.body.id,
      question: 'what does logit mean?',
      answer: 'A raw, unnormalised score.',
    });
    await settle();

    const after = await request(app).get(`/api/chats/${root.body.id}`);
    expect(after.body.outcome).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('does not ask again when the branch already has an outcome', async () => {
    const root = await request(app).post('/api/chats').send({ title: 'Attention Is All You Need' });
    const branch = await request(app).post('/api/chats').send({
      title: 'Hamming distance',
      parent_id: root.body.id,
      parent_word: 'what does hamming distance mean?',
    });
    db.prepare('UPDATE chats SET outcome = ? WHERE id = ?').run('Steht schon da', branch.body.id);

    await request(app).post('/api/btw/keep').send({
      chatId: branch.body.id,
      answer: 'Noch eine Antwort.',
    });
    await settle();

    expect(mockCreate).not.toHaveBeenCalled();
    const after = await request(app).get(`/api/chats/${branch.body.id}`);
    expect(after.body.outcome).toBe('Steht schon da');
  });
});
