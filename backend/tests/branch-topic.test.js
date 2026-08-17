/**
 * tests/branch-topic.test.js
 *
 * A TOPIC BRANCH is a branch created by the `/branch <topic>` composer
 * command (design/mockup-branch-command.html): no passage was selected, so
 * the chat row has a parent_id but NO parent_word.
 *
 * Everything a branch normally gets from its parent must still arrive — the
 * absence of a quote may not cost the branch its inherited context. These
 * tests pin that guarantee at the two places that read parent_word.
 */

jest.mock('openai');
const OpenAI = require('openai');

const request = require('supertest');
const path = require('path');
const fs = require('fs');
const { createDb } = require('../database');
const { createApp } = require('../server');
const { buildAncestorContext } = require('../ancestor-context');

const TEST_DB_PATH = path.join(__dirname, 'branch_topic_test.db');

let db;
let app;
let mockCreate;

// Streaming answer, same shape the provider SDKs yield.
function makeStream(words) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const word of words) yield { choices: [{ delta: { content: word } }] };
      yield { choices: [{ delta: {} }] };
    },
  };
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

let msgCounter = 0;
function insertMessage(chatId, role, content) {
  msgCounter += 1;
  const ts = new Date(2026, 0, 1, 0, 0, msgCounter).toISOString();
  db.prepare(
    'INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(`msg-${msgCounter}`, chatId, role, content, ts);
}

describe('topic branch', () => {
  it('creates a branch under the chosen parent without a parent word', async () => {
    const root = await request(app).post('/api/chats').send({ title: 'Attention Is All You Need' });

    const branch = await request(app)
      .post('/api/chats')
      .send({ title: 'Positional encodings', parent_id: root.body.id });

    expect(branch.status).toBe(201);
    expect(branch.body.parent_id).toBe(root.body.id);
    expect(branch.body.parent_word).toBeNull();
  });

  it('inherits the parent transcript verbatim even without a parent word', async () => {
    const root = await request(app).post('/api/chats').send({ title: 'Attention Is All You Need' });
    insertMessage(root.body.id, 'user', 'Why divide by the square root of d_k?');
    insertMessage(root.body.id, 'assistant', 'Because the dot products grow with dimension.');

    const branch = await request(app)
      .post('/api/chats')
      .send({ title: 'Positional encodings', parent_id: root.body.id });

    const context = await buildAncestorContext(db, branch.body.id);
    expect(context.parentTranscript).toContain('Why divide by the square root of d_k?');
    expect(context.parentTranscript).toContain('Because the dot products grow with dimension.');
  });

  it('names the branch by its title in the chain, where a quote would stand', async () => {
    const root = await request(app).post('/api/chats').send({ title: 'Attention Is All You Need' });
    const quoted = await request(app)
      .post('/api/chats')
      .send({ title: 'Scaled dot-product', parent_id: root.body.id, parent_word: 'we scale the dot products' });
    insertMessage(quoted.body.id, 'user', 'Why?');

    // The topic branch hangs under the quoted one — so the chain has to
    // survive a level that has a word and one that has none.
    const topic = await request(app)
      .post('/api/chats')
      .send({ title: 'Positional encodings', parent_id: quoted.body.id });

    const context = await buildAncestorContext(db, topic.body.id);
    expect(context.chain).toBe('Attention Is All You Need → we scale the dot products');
    expect(context.chain).not.toContain('undefined');
  });

  // Live report 2026-08-08: every /branch node stayed on "Ergebnis folgt …".
  // The outcome gate asked for a parent_word, which a topic branch does not
  // have — so the call that writes the mindmap's second line never ran.
  it('writes the outcome line for a branch that has no parent word', async () => {
    const root = await request(app).post('/api/chats').send({ title: 'Attention Is All You Need' });
    const topic = await request(app)
      .post('/api/chats')
      .send({ title: 'Positional encodings', parent_id: root.body.id });

    mockCreate.mockResolvedValueOnce(makeStream(['Die Reihenfolge kommt über ein festes Sinus-Signal herein.']));
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content:
      'OUTCOME: Reihenfolge kommt über ein festes Sinus-Signal',
    } }] });

    await request(app)
      .post(`/api/chats/${topic.body.id}/messages`)
      .send({ content: 'positional encodings' })
      .buffer(true);

    const after = await request(app).get(`/api/chats/${topic.body.id}`);
    expect(after.body.outcome).toBe('Reihenfolge kommt über ein festes Sinus-Signal');
    // The topic itself is what the line is about — the branch has no quote to
    // stand in for it.
    const call = mockCreate.mock.calls.find(c =>
      c[0].messages.some((m) => typeof m.content === 'string' && m.content.includes('OUTCOME:'))
    );
    expect(call[0].messages.at(-1).content).toContain('Positional encodings');
  });
});
