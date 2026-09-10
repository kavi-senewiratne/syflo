/**
 * ancestor-context.js
 *
 * Inherited conversation context for branch chats (design session 2026-07-20):
 * A child node inherits the whole path up to the root — the direct parent
 * chat verbatim, grandparents and higher as a cached summary, plus the
 * parent_word chain as the connecting thread. Sibling branches never.
 *
 * The per-chat summary is a pure cache (chats.summary), kept live via the
 * id of the last covered message (summary_last_message_id): if it matches
 * the currently last message, the cache is fresh.
 */

const { getLLMClient, noThinkExtras } = require('./llm');
const { recordUsage } = require('./usage');

// Target length of a node summary (prompt instruction, not a hard cap).
const SUMMARY_WORD_TARGET = 120;

// Character budget for the verbatim parent transcript. Above it the same
// hybrid trick is applied recursively: summary of the chat + verbatim tail.
const MAX_PARENT_CHARS = 8000;
const PARENT_VERBATIM_TAIL = 10;

// Budget for the origin excerpt — the paragraph the selection was taken
// from, repeated next to the selection at the very end of the prompt.
const ORIGIN_MAX_CHARS = 1500;

// How much of the selection is used to locate it. A long selection can
// straddle markdown the renderer hid; a distinctive prefix still pins down
// the right paragraph.
const ORIGIN_PROBE_CHARS = 60;
const ORIGIN_MIN_PROBE_CHARS = 8;

// Last message of a chat — basis of the staleness check.
function lastMessageId(db, chatId) {
  const row = db
    .prepare(
      'SELECT id FROM messages WHERE chat_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
    )
    .get(chatId);
  return row ? row.id : null;
}

function getTranscript(db, chatId) {
  // Prompt hygiene (mockup-model-flow §07/§10): failure markers are UI
  // state, and pending rows are questions still waiting in the send queue —
  // neither belongs in an inherited branch transcript.
  return db
    .prepare(
      'SELECT role, content FROM messages WHERE chat_id = ? AND IFNULL(pending, 0) = 0 ORDER BY created_at ASC'
    )
    .all(chatId)
    .filter((m) => {
      const t = (m.content || '').trim();
      return !(m.role === 'assistant' && (t === '*Failed*' || t === '*Interrupted*'));
    });
}

function renderTranscript(messages) {
  return messages.map((m) => `${m.role}: ${m.content}`).join('\n');
}

// Chats whose summary is currently being refreshed in the background —
// prevents every further message during generation from triggering another.
const summaryRefreshInFlight = new Set();

// Kicks off the refresh of a stale summary in the background. Errors are
// never fatal — the stale cache then simply stays in place.
function refreshChatSummaryInBackground(db, chatId) {
  if (summaryRefreshInFlight.has(chatId)) return;
  summaryRefreshInFlight.add(chatId);
  setImmediate(async () => {
    try {
      await ensureChatSummary(db, chatId);
    } catch (_) { /* stale summary stays */ } finally {
      summaryRefreshInFlight.delete(chatId);
    }
  });
}

/**
 * Returns the current summary of a chat — from the cache if no message was
 * added since the last generation, otherwise fresh from the configured chat
 * model. Empty chats yield null (nothing to summarize).
 *
 * `allowStale` (latency-critical paths, e.g. sending a message): an
 * outdated summary is returned immediately and refreshed in the background —
 * no blocking LLM call before the actual response, and the prompt prefix
 * stays identical to the last warm-up (KV cache kicks in).
 */
async function ensureChatSummary(db, chatId, { allowStale = false, getClient = getLLMClient } = {}) {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  if (!chat) return null;

  const lastId = lastMessageId(db, chatId);
  if (!lastId) return null;
  if (chat.summary && chat.summary_last_message_id === lastId) return chat.summary;

  if (allowStale && chat.summary) {
    refreshChatSummaryInBackground(db, chatId);
    return chat.summary;
  }

  const transcript = renderTranscript(getTranscript(db, chatId));
  const { client, model, provider } = getClient(db);
  // This call is logged like every other cloud call (2026-08-21). It is the
  // one that matters most: branch warm-up fires it eagerly, so it spends a
  // request before the user has asked anything — invisible consumption was
  // how "0/20" stayed on screen while the allowance was gone.
  let completion;
  try {
    completion = await client.chat.completions.create({
    model,
    ...noThinkExtras(provider),
    messages: [
      {
        role: 'system',
        content:
          'Summarize the following conversation. Respond with ONLY a JSON object ' +
          '(no code fences, no preamble) of this exact shape:\n' +
          '{"gist": "<one sentence capturing the core insight>", ' +
          '"points": ["<key point>", "<key point>", "<key point>"], ' +
          `"summary": "<about ${SUMMARY_WORD_TARGET} words of flowing prose>"}\n` +
          'In "summary", keep key terms, definitions and conclusions verbatim where ' +
          'possible. Use Markdown and inline LaTeX ($...$) inside the strings ' +
          'wherever the conversation does. Write all strings in the language of the ' +
          'conversation you are summarizing (a German conversation gets a German summary).',
      },
      { role: 'user', content: transcript },
      ],
    });
  } catch (err) {
    // A refused call spends the allowance just like a served one.
    recordUsage(db, {
      provider,
      model,
      kind: 'summary',
      outcome: err?.status === 429 ? 'quota' : 'failed',
    });
    throw err;
  }
  recordUsage(db, {
    provider,
    model,
    kind: 'summary',
    outcome: 'ok',
    promptTokens: completion.usage?.prompt_tokens ?? null,
    completionTokens: completion.usage?.completion_tokens ?? null,
  });

  const raw = (completion.choices[0]?.message?.content || '').trim();
  if (!raw) return null;
  const { summary, display } = parseSummaryResponse(raw);

  db.prepare(
    'UPDATE chats SET summary = ?, summary_display = ?, summary_last_message_id = ? WHERE id = ?'
  ).run(summary, display ? JSON.stringify(display) : null, lastId, chatId);
  return summary;
}

/**
 * Splits the summarizer response into { summary, display }.
 * summary = flowing prose for the inherited prompt (its role unchanged),
 * display = {gist, points[]} for the context banner. Small local models do
 * not reliably deliver JSON — every parse error degrades gently: the whole
 * raw response becomes the summary, display stays null.
 */
function parseSummaryResponse(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(raw.slice(start, end + 1));
      const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
      const gist = typeof obj.gist === 'string' ? obj.gist.trim() : '';
      const points = Array.isArray(obj.points)
        ? obj.points.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim())
        : [];
      if (summary) return { summary, display: gist ? { gist, points } : null };
    } catch (_) {
      /* no JSON — raw text as the summary */
    }
  }
  return { summary: raw, display: null };
}

// Tolerant form for locating a selection inside a stored message: collapse
// whitespace and drop the markdown emphasis characters. A passage selected
// in a rendered chat bubble never carries them, the stored markdown does.
function normalizeForMatch(text) {
  return (text || '').replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The paragraph of the parent conversation the selection was taken from.
 *
 * Nearness beats volume (bug 2026-08-09): the parent transcript sits in the
 * system block, far above — behind up to ~58k characters of source text. A
 * weak model (Flash Lite) then reads the selected sentence as a free-floating
 * quote: "imaginär" in a passage about word embeddings became a term of
 * language philosophy although the parent chat had just explained imaginary
 * NUMBERS two messages earlier. Returning the origin separately lets the
 * caller repeat it directly next to the selection, at the end of the prompt.
 *
 * Returns null when the selection cannot be located (PDF branches, selections
 * spanning several messages, edited parents) — the block is then simply
 * omitted rather than guessed at.
 */
function findSelectionOrigin(messages, selection) {
  const needle = normalizeForMatch(selection);
  if (needle.length < ORIGIN_MIN_PROBE_CHARS) return null;
  const probes = [...new Set([needle, needle.slice(0, ORIGIN_PROBE_CHARS)])]
    .filter((p) => p.length >= ORIGIN_MIN_PROBE_CHARS);

  for (const probe of probes) {
    // Newest first: a term the user selects is usually from the last answer.
    for (let i = messages.length - 1; i >= 0; i--) {
      const excerpt = paragraphAround(messages[i].content, probe);
      if (excerpt) return { role: messages[i].role, excerpt };
    }
  }
  return null;
}

// The matching paragraph plus its predecessor — the preceding paragraph is
// what the terms inside the selection usually refer back to. Paragraphs
// instead of a character window: no index arithmetic between the raw and the
// normalized text, and the unit matches how the answer is written.
function paragraphAround(content, probe) {
  const paragraphs = (content || '').split(/\n{2,}/);
  const hit = paragraphs.findIndex((p) => normalizeForMatch(p).includes(probe));
  if (hit === -1) return null;
  const excerpt = paragraphs.slice(Math.max(0, hit - 1), hit + 1).join('\n\n').trim();
  return excerpt.length > ORIGIN_MAX_CHARS ? excerpt.slice(-ORIGIN_MAX_CHARS) : excerpt;
}

/**
 * Ancestor path of a chat: [root, …, direct parent chat].
 * Empty for root chats.
 */
function getAncestorPath(db, chatId) {
  const getChat = db.prepare('SELECT * FROM chats WHERE id = ?');
  const path = [];
  let chat = getChat.get(chatId);
  while (chat && chat.parent_id) {
    chat = getChat.get(chat.parent_id);
    if (chat) path.unshift(chat);
  }
  return path;
}

/**
 * Builds the inherited conversation context for a branch chat:
 *   - parent_word chain (root title → word → … → current branch word)
 *   - grandparents and higher: cached summaries (root first)
 *   - direct parent chat: verbatim transcript
 * Returns null for root chats. `text` is the finished prompt block.
 */
async function buildAncestorContext(db, chatId, opts = {}) {
  const maxParentChars = opts.maxParentChars ?? MAX_PARENT_CHARS;
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  if (!chat || !chat.parent_id) return null;

  const ancestorPath = getAncestorPath(db, chatId);
  const parent = ancestorPath[ancestorPath.length - 1];
  const olderAncestors = ancestorPath.slice(0, -1);

  // Chain: root title, then per level the word it was branched from.
  const chainParts = [
    ancestorPath[0].title,
    ...ancestorPath.slice(1).map((c) => c.parent_word || c.title),
  ];
  if (chat.parent_word) chainParts.push(chat.parent_word);
  const chain = chainParts.join(' → ');

  // allowStale: the message path must never wait for summary generation —
  // outdated summaries are used and refreshed in the background.
  const summaries = [];
  for (const ancestor of olderAncestors) {
    const summary = await ensureChatSummary(db, ancestor.id, { allowStale: true });
    if (summary) summaries.push({ id: ancestor.id, title: ancestor.title, summary });
  }

  // Parent chat verbatim — unless it blows the budget: then the chat's
  // summary as a stand-in for the older part + the last messages verbatim.
  const parentMessages = getTranscript(db, parent.id);
  let parentTranscript = renderTranscript(parentMessages);
  if (parentTranscript.length > maxParentChars) {
    const parentSummary = await ensureChatSummary(db, parent.id, { allowStale: true });
    const tail = renderTranscript(parentMessages.slice(-PARENT_VERBATIM_TAIL));
    parentTranscript =
      `[Summary of the earlier part of this conversation]\n${parentSummary || '(none)'}\n\n` +
      `[Most recent messages, verbatim]\n${tail}`;
  }

  // The paragraph the selection came from — from the FULL parent messages,
  // not from the possibly summarized transcript above: the origin must
  // survive even when the parent chat outgrew MAX_PARENT_CHARS.
  const origin = findSelectionOrigin(parentMessages, chat.parent_word);

  const result = { chain, summaries, parentTranscript, parent, origin };
  return { ...result, text: renderAncestorText(result) };
}

/**
 * Renders the context parts (after applyContextBudget if applicable) into the prompt block.
 */
function renderAncestorText({ chain, summaries, parentTranscript }) {
  const parts = [`Path through the conversation tree: ${chain}`];
  if (summaries.length > 0) {
    parts.push(
      'Earlier conversations on this path, summarized (oldest first):\n' +
        summaries.map((s) => `- "${s.title}": ${s.summary}`).join('\n')
    );
  }
  if (parentTranscript) {
    // The "not your own earlier answers" clause is load-bearing (bug
    // 2026-08-08): without it the model reads the last inherited assistant
    // turn as its own and answers "I didn't understand this" with an apology
    // plus a repeat of THAT answer — the parent's whole-paper explanation —
    // instead of explaining the passage the branch was opened from.
    parts.push(
      'The conversation this branch grew out of, verbatim — background from a ' +
      'DIFFERENT chat, not your own earlier answers in this one:\n' +
      parentTranscript
    );
  }
  return parts.join('\n\n');
}

/**
 * Sacrifice order when the total context blows the budget:
 * first drop ancestor summaries from the root down (oldest first), only
 * then trim the source text (keep the beginning), as a last resort cut it
 * entirely. The verbatim parent transcript is never touched — the immediate
 * conversational proximity is the most valuable thing when going deeper.
 *
 * Order flipped on 2026-07-25 (before: source first): The source is the
 * most expensive prompt part and shared byte-identically across the whole
 * tree — any trimming in the child makes the KV cache of the parent prefill
 * worthless (measured: full re-prefill ~60 s). Summaries are small and sit
 * BEHIND the source in the prompt anyway; sacrificing them preserves the
 * shared prefix.
 */
function applyContextBudget({ paperText, summaries, parentTranscript }, maxTotalChars) {
  const parentLen = parentTranscript ? parentTranscript.length : 0;
  let trimmedSummaries = [...summaries];
  let trimmedPaper = paperText;

  const paperLen = () => (trimmedPaper ? trimmedPaper.length : 0);
  const summariesLen = () => trimmedSummaries.reduce((n, s) => n + s.summary.length, 0);

  // 1. Sacrifice summaries oldest first until everything fits together.
  while (trimmedSummaries.length > 0 && paperLen() + parentLen + summariesLen() > maxTotalChars) {
    trimmedSummaries.shift();
  }

  // 2. If that is not enough: trim the source to the remaining room (keep
  //    the beginning — title/abstract live there), cut entirely if needed.
  if (trimmedPaper) {
    const room = maxTotalChars - parentLen - summariesLen();
    if (trimmedPaper.length > room) {
      trimmedPaper = room > 0 ? trimmedPaper.slice(0, room) : null;
    }
  }

  return { paperText: trimmedPaper, summaries: trimmedSummaries, parentTranscript };
}

/**
 * Warm-up when creating a branch: generates/refreshes the summaries of the
 * new chat's whole ancestor chain in the background so they are already
 * cached at the first question. Errors of individual summaries are
 * swallowed — the lazy path in buildAncestorContext remains the safety net.
 */
async function warmUpAncestorSummaries(db, chatId) {
  for (const ancestor of getAncestorPath(db, chatId)) {
    try {
      await ensureChatSummary(db, ancestor.id);
    } catch (_) { /* next ancestor */ }
  }
}

// Ollama's context window in tokens — must match the value that
// start.command exports (OLLAMA_CONTEXT_LENGTH). If the backend runs from
// the same shell, it inherits the variable; the fallback is the same value.
const CONTEXT_WINDOW_TOKENS = parseInt(process.env.OLLAMA_CONTEXT_LENGTH || '', 10) || 16384;

// Reserve in the window for everything outside the system context: base
// system prompt, tool definitions, message history and the response itself.
const RESERVED_TOKENS = 5_000;

// Conservative estimate for scientific text (formulas, citations and
// technical terms tokenize worse than the usual ~4 chars/token).
const CHARS_PER_TOKEN = 3.5;

// Total budget for the variable context blocks (paper + summaries +
// parent transcript) in the system prompt — derived from the window instead
// of hard-wired: a budget above the window would mean silent context
// shifting in Ollama, and thus a KV cache that never kicks in.
const MAX_SYSTEM_CONTEXT_CHARS = Math.floor(
  (CONTEXT_WINDOW_TOKENS - RESERVED_TOKENS) * CHARS_PER_TOKEN
);

/**
 * Budget of the model that will ANSWER (ADR-0008 slice 4): window and
 * character budget come from the registry instead of globally from
 * OLLAMA_CONTEXT_LENGTH. For cloud models the budget cap (budgetCapTokens)
 * counts — it protects the free quotas even though e.g. Gemini would have a
 * 1M window. For Ollama everything stays with the env-derived window (KV
 * cache contract). Defaults to the active settings model; pass `forModel`
 * ({provider, model}) when a different model answers — failover candidates
 * and the one-off local regenerate must get a prompt sized to THEIR budget
 * (fix 2026-07-29), never the active model's.
 *
 * `overview: true` lifts the cap for the Video overview (user decision
 * 2026-09-04). The cap is there so an ordinary question does not drag a whole
 * paper through the window turn after turn — but the overview is asked ONCE
 * per video and is the one question that genuinely wants the whole source.
 * Lifting it costs nothing when the source is smaller than the ceiling: a cap
 * only ever TRUNCATES, it never pads. What replaces it is what the model can
 * really take — its context window, and on a free tier that meters tokens per
 * MINUTE, that limit, because a prompt above it comes back as a 429 rather
 * than as a longer answer (Groq's free gpt-oss-120b: 8 000 TPM, so its
 * overview budget is unchanged and only more rounds help there).
 */
function contextBudget(db, forModel = null, { overview = false } = {}) {
  const { getSetting } = require('./llm');
  const { getModelInfo } = require('./registry');
  const provider = forModel ? forModel.provider : getSetting(db, 'llm_provider');
  const model = forModel
    ? forModel.model
    : getSetting(db, provider === 'ollama' ? 'ollama_model' : `${provider}_model`);
  const info = getModelInfo(db, provider, model);
  const perMinuteTokens = info.freeQuota && info.freeQuota.tokensPerMinute;
  const capTokens = overview
    ? (perMinuteTokens || info.contextWindowTokens)
    : (info.budgetCapTokens || info.contextWindowTokens);
  const budgetTokens = Math.min(info.contextWindowTokens, capTokens);
  return {
    provider,
    model,
    contextWindowTokens: info.contextWindowTokens,
    maxSystemContextChars: Math.floor((budgetTokens - RESERVED_TOKENS) * CHARS_PER_TOKEN),
  };
}

module.exports = {
  contextBudget,
  ensureChatSummary,
  parseSummaryResponse,
  buildAncestorContext,
  findSelectionOrigin,
  renderAncestorText,
  applyContextBudget,
  warmUpAncestorSummaries,
  getAncestorPath,
  MAX_SYSTEM_CONTEXT_CHARS,
  CONTEXT_WINDOW_TOKENS,
  RESERVED_TOKENS,
  CHARS_PER_TOKEN,
};
