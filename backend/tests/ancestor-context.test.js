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
  // This suite tests the local path — bypass the cloud default (ADR-0008).
  require('../llm').setSetting(db, 'llm_provider', 'ollama');
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

    // Background summaries must never trigger a thinking phase.
    expect(mockCreate.mock.calls[0][0].reasoning_effort).toBe('none');
  });

  it('instructs the summarizer to write in the language of the summarized chat', async () => {
    // Language mirroring (grill 2026-07-23): summaries are UI-visible
    // (ancestor-chain cards, "Display = Prompt", ADR-0003) — an English
    // summary of a German chat would look out of place in the UI.
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
    // Latency-critical path (sending a message): never wait for summary
    // generation — the stale cache answers immediately, and the refresh
    // runs in the background for the next request.
    insertChat({ id: 'c1' });
    insertMessage('c1', 'user', 'Hello');
    mockSummaryReply('Old summary.');
    await ensureChatSummary(db, 'c1');

    insertMessage('c1', 'assistant', 'New fact appeared.');
    mockSummaryReply('Fresh summary with new fact.');

    const stale = await ensureChatSummary(db, 'c1', { allowStale: true });
    expect(stale).toBe('Old summary.');
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // Let the background refresh play out, then the cache is fresh.
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

// ─── Selection origin: the paragraph the branch was opened from ──────────────
//
// Bug 2026-08-09: the parent transcript sits in the system message behind up
// to ~58k characters of source text. A weak model read the selected sentence
// as a free-floating quote — "imaginär" in a passage about word embeddings
// became language philosophy, although the parent chat had just explained
// imaginary NUMBERS. buildAncestorContext returns the origin separately so
// the caller can repeat it right next to the selection.

describe('findSelectionOrigin', () => {
  const { findSelectionOrigin, buildAncestorContext } = require('../ancestor-context');

  const reply = {
    role: 'assistant',
    content:
      'Reelle Zahlen sind die ganz normalen Dezimalzahlen.\n\n' +
      'Daneben gibt es die **imaginäre Einheit** $i$ mit $i^2 = -1$.\n\n' +
      'Man braucht keine komplexen Zahlen, weil die Bedeutung eines Wortes ' +
      'keinen imaginären Anteil braucht.',
  };
  const messages = [{ role: 'user', content: 'Was sind reelle Zahlen?' }, reply];

  it('returns the matching paragraph together with its predecessor', () => {
    const origin = findSelectionOrigin(messages, 'keinen imaginären Anteil braucht');
    expect(origin.role).toBe('assistant');
    // The predecessor carries what the selected term refers to — without it
    // "imaginär" is ambiguous.
    expect(origin.excerpt).toContain('imaginäre Einheit');
    expect(origin.excerpt).toContain('keinen imaginären Anteil braucht');
    // Not the whole message: the first paragraph stays out.
    expect(origin.excerpt).not.toContain('ganz normalen Dezimalzahlen');
  });

  it('finds a passage selected in the rendered bubble, without its markdown', () => {
    // The user selects "die imaginäre Einheit $i$" — the asterisks the
    // renderer swallowed are not part of what the browser hands over.
    const origin = findSelectionOrigin(messages, 'die imaginäre Einheit $i$ mit');
    expect(origin.excerpt).toContain('imaginäre Einheit');
  });

  it('matches the newest occurrence when a term repeats', () => {
    const older = { role: 'assistant', content: 'Erste Erwähnung von Perplexity hier.' };
    const newer = { role: 'assistant', content: 'Zweite Erwähnung von Perplexity hier.' };
    const origin = findSelectionOrigin([older, newer], 'Erwähnung von Perplexity');
    expect(origin.excerpt).toContain('Zweite');
  });

  it('returns null instead of guessing when the selection is not found', () => {
    expect(findSelectionOrigin(messages, 'ein Satz aus einem PDF')).toBeNull();
    // Too short to locate reliably — a two-letter match would hit anywhere.
    expect(findSelectionOrigin(messages, 'i')).toBeNull();
    expect(findSelectionOrigin(messages, null)).toBeNull();
  });

  it('is exposed on buildAncestorContext for chat branches', async () => {
    insertChat({ id: 'parent', title: 'Zahlen' });
    insertMessage('parent', 'user', 'Was sind reelle Zahlen?');
    insertMessage('parent', 'assistant', reply.content);
    insertChat({
      id: 'child', title: 'Child', parentId: 'parent',
      parentWord: 'keinen imaginären Anteil braucht',
    });

    const ctx = await buildAncestorContext(db, 'child');

    expect(ctx.origin.excerpt).toContain('imaginäre Einheit');
    // The rendered ancestor text is unchanged — the origin travels separately
    // so the caller can place it at the END of the prompt.
    expect(ctx.text).not.toContain('this is what its terms refer to');
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

  // Order flipped 2026-07-25 (previously: source trimmed first): the
  // source is the most expensive prompt prefix, shared byte-identically
  // across the whole tree — it is touched last so the KV cache of the
  // parent prefill can be reused when branching.
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

// ─── Context budget vs. Ollama context window ────────────────────────────────
// The character budget is derived from the window — a budget above the
// window would mean silent context shifting and a KV cache that never hits.

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

// ─── parseSummaryResponse: structured summaries for the context banner ──────
// The summarizer is supposed to return JSON {gist, points, summary}
// (variant 3a); small local models don't always manage that — every parse
// error must degrade gracefully to the raw-text fallback (summary = raw
// reply, display null).

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
