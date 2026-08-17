#!/usr/bin/env node
/**
 * backfill-outcomes.js
 *
 * Fills `chats.outcome` for branches that never got one. Three groups need it:
 *
 *   1. Branches created before 2026-08-02 — the column did not exist yet.
 *   2. Branches whose title call failed (quota, timeout) or came back without
 *      the OUTCOME line. Since 2026-08-03 the next answer in such a branch
 *      catches the line up by itself, but a branch nobody revisits stays empty
 *      forever — and its mindmap node keeps showing "Ergebnis folgt …".
 *   3. Branches answered by a model that ignored the label format.
 *
 * Only branches with a REAL answer are touched: where the only answer is a
 * '*Failed*'/'*Interrupted*' marker there is nothing to state, and the node
 * correctly shows no second line at all.
 *
 * Usage (from the repo root, with the backend's dependencies available):
 *
 *   node scripts/backfill-outcomes.js --dry-run      # list what would be asked
 *   node scripts/backfill-outcomes.js                # write them
 *   node scripts/backfill-outcomes.js --limit 5      # first five only
 *   node scripts/backfill-outcomes.js --rpm 4        # slower, for a tight key
 *   SYFLO_DATA_DIR=~/Library/Application\ Support/syflo-desktop \
 *     node scripts/backfill-outcomes.js              # the desktop app's DB
 *
 * The active provider from Settings is used, one call per branch, sequentially
 * — a free-tier key hits its per-minute limit otherwise. The default pace is
 * `--rpm 8`: measured on Gemini's free tier (2026-08-03), 1.5 s between calls
 * ran into 429s from the tenth branch on and six were left empty. The script is
 * safe to run repeatedly — it only ever looks at branches that still have no
 * outcome, so a second run picks up exactly what the first one missed.
 */

const path = require('path');

const BACKEND = path.join(__dirname, '..', 'backend');
const { createDb } = require(path.join(BACKEND, 'database'));
const { getLLMClient, noThinkExtras } = require(path.join(BACKEND, 'llm'));
const { outcomeInstruction, parseOutcomeReply, MAX_PASSAGE_CHARS } = require(path.join(BACKEND, 'title'));
const { isRateLimit, isDailyQuota } = require(path.join(BACKEND, 'quota'));

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const DRY_RUN = args.includes('--dry-run');
const LIMIT = flag('limit', Infinity);
const RPM = Math.max(1, flag('rpm', 8));
const PACE_MS = Math.ceil(60_000 / RPM);
// A 429 means the window is full — waiting less than the window is pointless.
const COOLDOWN_MS = 45_000;
const ATTEMPTS = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Branches missing an outcome, together with the passage they were opened from
// and their newest real answer. LENGTH(...) > 0 also catches the empty strings
// an early version could store.
const PENDING_SQL = `
  SELECT c.id, c.title, c.parent_word,
    (SELECT m.content FROM messages m
      WHERE m.chat_id = c.id AND m.role = 'assistant'
        AND TRIM(m.content) NOT IN ('*Failed*', '*Interrupted*')
      ORDER BY m.created_at DESC LIMIT 1) AS answer
  FROM chats c
  WHERE c.parent_id IS NOT NULL
    AND (c.outcome IS NULL OR LENGTH(TRIM(c.outcome)) = 0)
  ORDER BY c.created_at DESC
`;

async function main() {
  const db = createDb();
  const rows = db.prepare(PENDING_SQL).all()
    .filter((r) => r.answer && r.answer.trim())
    .slice(0, LIMIT);

  if (rows.length === 0) {
    console.log('Nothing to backfill — every branch with an answer has an outcome.');
    return;
  }
  console.log(`${rows.length} branch(es) without an outcome.`);

  if (DRY_RUN) {
    rows.forEach((r) => console.log(`  ${r.id.slice(0, 8)}  ${r.title}`));
    console.log('\nDry run — nothing written.');
    return;
  }

  const { client, model, provider } = getLLMClient(db);
  console.log(`Provider: ${provider} / ${model}  (${RPM} calls per minute)\n`);

  const errored = [];   // the call never succeeded — worth a second run
  const empty = [];     // the model answered: nothing was established
  let written = 0;
  // Google's free tier answers an exhausted DAY limit with a bare 429 and no
  // body, so isDailyQuota cannot see it — the first run ground through eight
  // branches, four attempts each, and wrote nothing (2026-08-03). Two branches
  // in a row that never get an answer end the run instead.
  let deadInARow = 0;

  for (const [i, row] of rows.entries()) {
    const label = `[${i + 1}/${rows.length}] ${row.title}`;
    // A topic branch (`/branch`) has no parent_word — its subject is the
    // title, which is the topic the user typed (2026-08-08).
    const passage = String(row.parent_word || row.title).trim().slice(0, MAX_PASSAGE_CHARS);
    let outcome = null;
    let answered = false;   // the difference between "empty" and "failed"

    for (let attempt = 1; attempt <= ATTEMPTS && !answered; attempt += 1) {
      try {
        const completion = await client.chat.completions.create({
          model,
          ...noThinkExtras(provider),
          messages: [outcomeInstruction(passage, row.answer)],
        });
        answered = true;
        outcome = parseOutcomeReply(completion.choices[0]?.message?.content || '');
      } catch (err) {
        if (isDailyQuota(err)) {
          console.error(`${label}: daily quota reached — stopping here.`);
          errored.push(row.title);
          printSummary(written, empty, errored, rows.length);
          return;
        }
        const retriable = isRateLimit(err) || err?.status >= 500;
        if (retriable && attempt < ATTEMPTS) {
          console.log(`${label}: ${err.status ?? 'error'}, waiting ${COOLDOWN_MS / 1000} s …`);
          await sleep(COOLDOWN_MS);
          continue;
        }
        console.error(`${label}: ${err.message}`);
        break;
      }
    }

    if (outcome) {
      db.prepare('UPDATE chats SET outcome = ? WHERE id = ?').run(outcome, row.id);
      written += 1;
      deadInARow = 0;
      console.log(`${label}\n    → ${outcome}`);
    } else if (answered) {
      empty.push(row.title);
      deadInARow = 0;
      console.log(`${label}\n    → (the model states nothing was established)`);
    } else {
      errored.push(row.title);
      deadInARow += 1;
      console.log(`${label}\n    → (call failed — run the script again)`);
      if (deadInARow >= 2) {
        console.error('\nTwo branches in a row got no answer at all — the key looks exhausted.');
        console.error('Stopping. Try again later, with a lower --rpm, or switch provider in Settings.');
        rows.slice(i + 1).forEach((r) => errored.push(r.title));
        break;
      }
    }

    if (i < rows.length - 1) await sleep(PACE_MS);
  }

  printSummary(written, empty, errored, rows.length);
}

function printSummary(written, empty, errored, total) {
  console.log(`\nWritten: ${written}/${total}`);
  if (empty.length) console.log(`Nothing established (left empty): ${empty.length}`);
  if (errored.length) {
    console.log(`Failed, still open: ${errored.length} — re-run the script, or lower --rpm.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
