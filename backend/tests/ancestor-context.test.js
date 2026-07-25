/**
 * tests/ancestor-context.test.js
 *
 * Integration tests for the ancestor-context module: the per-chat summary
 * cache (chats.summary + chats.summary_last_message_id) and the hybrid
 * ancestor context that child chats inherit (parent verbatim, grandparents+
 * as cached summaries, parent_word chain).
 *
 * The LLM is mocked at the OpenAI-SDK boundary, same as messages.test.js.
 */

jest.mock('openai');
const OpenAI = require('openai');

const path = require('path');
const fs = require('fs');
const { createDb } = require('../database');

const TEST_DB_PATH = path.join(__dirname, 'ancestor_context_test.db');

let db;
let mockCreate;

beforeEach(() => {
  mockCreate = jest.fn();
  OpenAI.mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));

  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

// Helper: insert a chat row directly (no HTTP needed for module-level tests).
function insertChat({ id, title = 'Chat', parentId = null, parentWord = null }) {
  db.prepare(
    'INSERT INTO chats (id, title, parent_id, parent_word, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, title, parentId, parentWord, new Date().toISOString());
}

// Helper: insert a message with a controlled created_at so ordering is stable.
let msgCounter = 0;
function insertMessage(chatId, role, content) {
  msgCounter += 1;
  const id = `msg-${msgCounter}`;
  const ts = new Date(2026, 0, 1, 0, 0, msgCounter).toISOString();
  db.prepare(
    'INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, chatId, role, content, ts);
  return id;
}

function mockSummaryReply(text) {
  mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: text } }] });
}

// ─── Schema migration ────────────────────────────────────────────────────────

describe('summary cache schema', () => {
  it('adds summary and summary_last_message_id columns to chats', () => {
    const cols = db.prepare('PRAGMA table_info(chats)').all().map(c => c.name);
    expect(cols).toContain('summary');
    expect(cols).toContain('summary_last_message_id');
  });
});

// ─── ensureChatSummary ───────────────────────────────────────────────────────

describe('ensureChatSummary', () => {
  const { ensureChatSummary } = require('../ancestor-context');

  it('generates a summary from the chat transcript and caches it', async () => {
    insertChat({ id: 'c1', title: 'Transformers' });
    insertMessage('c1', 'user', 'What is attention?');
    const lastId = insertMessage('c1', 'assistant', 'Attention weighs token relevance.');

    mockSummaryReply('Chat about attention weighing token relevance.');

    const summary = await ensureChatSummary(db, 'c1');
    expect(summary).toBe('Chat about attention weighing token relevance.');

    // The LLM saw the transcript
    const llmMessages = mockCreate.mock.calls[0][0].messages;
    const userMsg = llmMessages.find(m => m.role === 'user');
    expect(userMsg.content).toContain('What is attention?');
    expect(userMsg.content).toContain('Attention weighs token relevance.');

    // Cache row persisted with the last covered message id
    const row = db.prepare('SELECT summary, summary_last_message_id FROM chats WHERE id = ?').get('c1');
    expect(row.summary).toBe('Chat about attention weighing token relevance.');
    expect(row.summary_last_message_id).toBe(lastId);

    // Hintergrund-Summaries dürfen nie eine Denk-Phase auslösen.
    expect(mockCreate.mock.calls[0][0].reasoning_effort).toBe('none');
  });

  it('instructs the summarizer to write in the language of the summarized chat', async () => {
    // Sprachspiegelung (Grill 2026-07-23): Summaries sind UI-sichtbar
    // (Ahnenketten-Karten, „Display = Prompt", ADR-0003) — eine englische
    // Zusammenfassung eines deutschen Chats stünde befremdlich in der UI.
    insertChat({ id: 'c1', title: 'Transformer' });
    insertMessage('c1', 'user', 'Was ist Attention?');
    insertMessage('c1', 'assistant', 'Attention gewichtet Token-Relevanz.');

    mockSummaryReply('Chat über Attention.');
    await ensureChatSummary(db, 'c1');

    const systemMsg = mockCreate.mock.calls[0][0].messages.find(m => m.role === 'system');
    expect(systemMsg.content).toMatch(/language of the conversation/i);
  });

  it('returns the cached summary without calling the LLM when nothing changed', async () => {
    insertChat({ id: 'c1' });
    insertMessage('c1', 'user', 'Hello');
    mockSummaryReply('First summary.');

    await ensureChatSummary(db, 'c1');
    const again = await ensureChatSummary(db, 'c1');

    expect(again).toBe('First summary.');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('regenerates the summary when new messages arrived (staleness check)', async () => {
    insertChat({ id: 'c1' });
    insertMessage('c1', 'user', 'Hello');
    mockSummaryReply('Old summary.');
    await ensureChatSummary(db, 'c1');

    insertMessage('c1', 'assistant', 'New fact appeared.');
    mockSummaryReply('Updated summary with new fact.');

    const summary = await ensureChatSummary(db, 'c1');
    expect(summary).toBe('Updated summary with new fact.');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('returns null for an empty chat without calling the LLM', async () => {
    insertChat({ id: 'empty' });
    const summary = await ensureChatSummary(db, 'empty');
    expect(summary).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('allowStale: returns the stale summary immediately and refreshes it in the background', async () => {
    // Latenzkritischer Pfad (Nachricht senden): nie auf die Summary-
    // Generierung warten — der stale Cache antwortet sofort, und die
    // Erneuerung läuft im Hintergrund für die nächste Anfrage.
    insertChat({ id: 'c1' });
    insertMessage('c1', 'user', 'Hello');
    mockSummaryReply('Old summary.');
    await ensureChatSummary(db, 'c1');

    insertMessage('c1', 'assistant', 'New fact appeared.');
    mockSummaryReply('Fresh summary with new fact.');

    const stale = await ensureChatSummary(db, 'c1', { allowStale: true });
    expect(stale).toBe('Old summary.');
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // Hintergrund-Erneuerung ausrollen lassen, dann ist der Cache frisch.
    await new Promise(r => setTimeout(r, 25));
    const row = db.prepare('SELECT summary FROM chats WHERE id = ?').get('c1');
    expect(row.summary).toBe('Fresh summary with new fact.');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});

// ─── buildAncestorContext ────────────────────────────────────────────────────

describe('buildAncestorContext', () => {
  const { buildAncestorContext } = require('../ancestor-context');

  // Tree: root "Transformers" → child "Attention" (word: attention)
  //       → grandchild "Softmax" (word: softmax)
  function buildDepth3Tree() {
    insertChat({ id: 'root', title: 'Transformers' });
    insertMessage('root', 'user', 'Explain transformers.');
    insertMessage('root', 'assistant', 'Transformers use self-attention.');

    insertChat({ id: 'mid', title: 'Attention', parentId: 'root', parentWord: 'attention' });
    insertMessage('mid', 'user', 'What is attention exactly?');
    insertMessage('mid', 'assistant', 'A weighted average controlled by softmax.');

    insertChat({ id: 'leaf', title: 'Softmax', parentId: 'mid', parentWord: 'softmax' });
  }

  it('returns null for a root chat (nothing to inherit)', async () => {
    insertChat({ id: 'root', title: 'Solo' });
    insertMessage('root', 'user', 'Hi');
    expect(await buildAncestorContext(db, 'root')).toBeNull();
  });

  it('includes parent verbatim, grandparent as summary, and the parent_word chain', async () => {
    buildDepth3Tree();
    mockSummaryReply('Root summary: transformers use self-attention.');

    const ctx = await buildAncestorContext(db, 'leaf');

    // Parent chat ("mid") verbatim
    expect(ctx.text).toContain('What is attention exactly?');
    expect(ctx.text).toContain('A weighted average controlled by softmax.');
    // Grandparent ("root") only as summary, not verbatim
    expect(ctx.text).toContain('Root summary: transformers use self-attention.');
    expect(ctx.text).not.toContain('Explain transformers.');
    // parent_word chain from root to the current branch word
    expect(ctx.text).toContain('Transformers → attention → softmax');
  });

  it('reuses cached ancestor summaries (one LLM call per stale ancestor only)', async () => {
    buildDepth3Tree();
    mockSummaryReply('Root summary.');

    await buildAncestorContext(db, 'leaf');
    await buildAncestorContext(db, 'leaf');

    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

// ─── Over-long parent chat: recursive hybrid ─────────────────────────────────

describe('buildAncestorContext – over-long parent chat', () => {
  const { buildAncestorContext } = require('../ancestor-context');

  it('replaces an over-budget parent transcript with summary + verbatim tail', async () => {
    insertChat({ id: 'parent', title: 'Long Parent' });
    // 30 messages ~ 40 chars each; budget forced tiny via option below
    for (let i = 1; i <= 30; i++) {
      insertMessage('parent', i % 2 ? 'user' : 'assistant', `Message number ${i} with some padding text.`);
    }
    insertChat({ id: 'child', title: 'Child', parentId: 'parent', parentWord: 'padding' });

    mockSummaryReply('Condensed parent summary.');

    const ctx = await buildAncestorContext(db, 'child', { maxParentChars: 500 });

    // Older messages are gone, the tail (last 10) is verbatim
    expect(ctx.text).not.toContain('Message number 1 ');
    expect(ctx.text).not.toContain('Message number 20 ');
    expect(ctx.text).toContain('Message number 21 ');
    expect(ctx.text).toContain('Message number 30 ');
    // The condensed summary stands in for the older part
    expect(ctx.text).toContain('Condensed parent summary.');
  });

  it('keeps a short parent transcript fully verbatim without any LLM call', async () => {
    insertChat({ id: 'parent', title: 'Short Parent' });
    insertMessage('parent', 'user', 'Only one short message.');
    insertChat({ id: 'child', title: 'Child', parentId: 'parent', parentWord: 'short' });

    const ctx = await buildAncestorContext(db, 'child');

    expect(ctx.text).toContain('Only one short message.');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// ─── applyContextBudget: sacrifice order ─────────────────────────────────────

describe('applyContextBudget', () => {
  const { applyContextBudget } = require('../ancestor-context');

  const blocks = () => ({
    paperText: 'P'.repeat(1000),
    summaries: [
      { id: 'root', title: 'Root', summary: 'S'.repeat(200) },
      { id: 'mid', title: 'Mid', summary: 'T'.repeat(200) },
    ],
    parentTranscript: 'V'.repeat(500),
  });

  it('leaves everything untouched when the total fits', () => {
    const out = applyContextBudget(blocks(), 5000);
    expect(out.paperText).toHaveLength(1000);
    expect(out.summaries).toHaveLength(2);
    expect(out.parentTranscript).toHaveLength(500);
  });

  // Reihenfolge gedreht 2026-07-25 (vorher: Quelle zuerst gekürzt): Die
  // Quelle ist der teuerste, im ganzen Baum byte-identisch geteilte
  // Prompt-Präfix — sie wird zuletzt angetastet, damit der KV-Cache des
  // Eltern-Prefills beim Branchen weiterverwendet werden kann.
  it('drops ancestor summaries oldest-first before touching the source', () => {
    const out = applyContextBudget(blocks(), 1700);
    // Root (oldest) sacrificed first, the nearer ancestor survives —
    // and the source stays byte-identical.
    expect(out.paperText).toHaveLength(1000);
    expect(out.summaries.map(s => s.id)).toEqual(['mid']);
    expect(out.parentTranscript).toHaveLength(500);
  });

  it('shrinks the source only after all summaries are gone', () => {
    const out = applyContextBudget(blocks(), 750);
    expect(out.summaries).toEqual([]);
    // 750 budget − 500 transcript → the source keeps its head
    expect(out.paperText).toHaveLength(250);
    expect(out.parentTranscript).toHaveLength(500);
  });

  it('never touches the parent transcript', () => {
    const out = applyContextBudget(blocks(), 100);
    expect(out.parentTranscript).toHaveLength(500);
    expect(out.paperText).toBeNull();
    expect(out.summaries).toEqual([]);
  });
});

// ─── Kontext-Budget vs. Ollama-Kontextfenster ────────────────────────────────
// Das Zeichen-Budget ist aus dem Fenster abgeleitet — ein Budget über dem
// Fenster hieße stilles Context-Shifting und einen KV-Cache, der nie greift.

describe('context budget vs. context window', () => {
  const {
    applyContextBudget,
    MAX_SYSTEM_CONTEXT_CHARS,
    CONTEXT_WINDOW_TOKENS,
    RESERVED_TOKENS,
    CHARS_PER_TOKEN,
  } = require('../ancestor-context');
  it('system-context budget plus reserve fits into the context window', () => {
    const budgetTokens = Math.ceil(MAX_SYSTEM_CONTEXT_CHARS / CHARS_PER_TOKEN);
    expect(budgetTokens + RESERVED_TOKENS).toBeLessThanOrEqual(CONTEXT_WINDOW_TOKENS);
  });

  it('trims an oversized paper down to the budget instead of overflowing', () => {
    const out = applyContextBudget(
      { paperText: 'P'.repeat(60_000), summaries: [], parentTranscript: null },
      MAX_SYSTEM_CONTEXT_CHARS
    );
    expect(out.paperText.length).toBeLessThanOrEqual(MAX_SYSTEM_CONTEXT_CHARS);
  });
});

// ─── parseSummaryResponse: strukturierte Summaries fürs Kontext-Banner ──────
// Der Summarizer soll JSON {gist, points, summary} liefern (Variante 3a);
// kleine lokale Modelle schaffen das nicht immer — jeder Parse-Fehler muss
// sanft zum Rohtext-Fallback degradieren (summary = Rohantwort, display null).

describe('parseSummaryResponse', () => {
  const { parseSummaryResponse } = require('../ancestor-context');

  it('parses a clean JSON response into summary + display', () => {
    const raw = JSON.stringify({
      gist: 'One sentence.',
      points: ['First point', 'Second point'],
      summary: 'Flowing prose summary.',
    });
    const out = parseSummaryResponse(raw);
    expect(out.summary).toBe('Flowing prose summary.');
    expect(out.display).toEqual({ gist: 'One sentence.', points: ['First point', 'Second point'] });
  });

  it('tolerates prose around the JSON object (greedy brace match)', () => {
    const raw = 'Here you go:\n{"gist":"G","points":["P"],"summary":"S"}\nHope that helps!';
    const out = parseSummaryResponse(raw);
    expect(out.summary).toBe('S');
    expect(out.display).toEqual({ gist: 'G', points: ['P'] });
  });

  it('falls back to raw text as summary when the response is not JSON', () => {
    const out = parseSummaryResponse('Just a plain old prose summary.');
    expect(out.summary).toBe('Just a plain old prose summary.');
    expect(out.display).toBeNull();
  });

  it('falls back when JSON lacks a usable summary; drops non-string points', () => {
    expect(parseSummaryResponse('{"gist":"only a gist"}').display).toBeNull();
    const out = parseSummaryResponse('{"gist":"G","points":["ok", 42, "  "],"summary":"S"}');
    expect(out.display.points).toEqual(['ok']);
  });
});
