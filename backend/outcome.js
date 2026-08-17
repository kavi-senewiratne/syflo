/**
 * outcome.js
 *
 * The mindmap node's second line (chats.outcome) for answers that never pass
 * through POST /messages.
 *
 * Normally the outcome is a by-product of the title call that runs right after
 * an answer (routes/messages.js). Two branches never reach that call with
 * their first answer:
 *
 *   - a `/btw` branch, whose kept answer is written straight into the chat
 *     (routes/btw.js) — it has a real answer from its first second;
 *   - any future path that persists an answer without streaming it.
 *
 * Both used to sit on the "Ergebnis folgt …" placeholder until the user
 * happened to ask something else in that branch (live report 2026-08-08).
 */

const { getLLMClient, noThinkExtras } = require('./llm');
const { callCloudLadder } = require('./quota');
const { MAX_PASSAGE_CHARS, outcomeInstruction, parseOutcomeReply } = require('./title');

// One short line is never worth a long wait: the whole ladder gets a budget,
// each single call a shorter one — same shape as the passage-title endpoint.
const OUTCOME_BUDGET_MS = 12000;
const OUTCOME_CALL_MS = 6000;

/**
 * What the line is ABOUT: the passage the branch was cut from — or, for a
 * topic branch (`/branch`), the topic itself, which lives in the title.
 * Root chats have no outcome line at all: the map draws it on branches.
 */
function outcomeSubject(chat) {
  if (!chat || !chat.parent_id) return null;
  const quote = chat.parent_word ? String(chat.parent_word).trim().slice(0, MAX_PASSAGE_CHARS) : '';
  return quote || String(chat.title || '').trim() || null;
}

/**
 * Ask for the outcome line of `chatId` from `answer` and store it. Returns the
 * stored line, or null when there was nothing to do (root chat, outcome
 * already there, empty answer) or the model produced no usable line.
 */
async function writeOutcome(db, chatId, answer, { isQuotaCoolingDown, markQuotaCooldown } = {}) {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  const subject = outcomeSubject(chat);
  if (!subject) return null;
  // Already answered once — the line is written exactly once and then left
  // alone, same rule as the catch-up in routes/messages.js.
  if (String(chat.outcome || '').trim()) return null;
  if (!String(answer || '').trim()) return null;

  const instruction = outcomeInstruction(subject, answer);
  const { client, model, provider } = getLLMClient(db);
  let raw = '';
  if (provider === 'ollama') {
    // Local: one standalone call on the configured model. It costs the KV
    // prefix of the tree's source — accepted here because the alternative is
    // a node that never says anything, and this runs once per branch.
    const completion = await client.chat.completions.create({
      model,
      ...noThinkExtras(provider),
      messages: [instruction],
    });
    raw = completion.choices[0]?.message?.content || '';
  } else {
    const ladder = await callCloudLadder(db, {
      activeProvider: provider,
      messages: [instruction],
      budgetMs: OUTCOME_BUDGET_MS,
      callMs: OUTCOME_CALL_MS,
      isCoolingDown: isQuotaCoolingDown,
      markCooldown: markQuotaCooldown,
      label: 'outcome line',
    });
    raw = ladder?.raw || '';
  }

  const outcome = parseOutcomeReply(raw);
  if (!outcome) return null;
  db.prepare('UPDATE chats SET outcome = ? WHERE id = ?').run(outcome, chatId);
  return outcome;
}

/**
 * Fire-and-forget variant: the caller has already answered the client, and an
 * outcome line is never worth holding a response open for. Failures are
 * silent — the next answer in that branch asks again.
 */
function writeOutcomeInBackground(db, chatId, answer, hooks) {
  setImmediate(() => {
    writeOutcome(db, chatId, answer, hooks).catch(() => { /* the node keeps its placeholder */ });
  });
}

module.exports = { outcomeSubject, writeOutcome, writeOutcomeInBackground };
