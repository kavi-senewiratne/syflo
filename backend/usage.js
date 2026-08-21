/**
 * usage.js
 *
 * The ONE place that writes usage_log, and the ONE place that decides which
 * day a call belongs to.
 *
 * Why it exists (measured 2026-08-11): the model window said "0/20" for
 * Gemini Flash while the daily quota was long gone. The log had a single
 * writer — the successful chat answer in routes/messages.js — so every other
 * cloud call spent the same quota invisibly: title generation, /btw, Explain,
 * passage titles. On 2026-08-10 four Flash answers were logged and the limit
 * was full. A 429 was invisible too, although it is a call that was made.
 *
 * So: every cloud call is logged, with WHERE it came from (`kind`) and HOW it
 * ended (`outcome`). Six write sites, one function — a copied INSERT is how
 * the columns would start disagreeing.
 *
 * The log holds metrics only, NEVER conversation content.
 */

const crypto = require('crypto');

/** Where a call came from. The set the `kind` column may hold. */
const USAGE_KINDS = ['chat', 'title', 'btw', 'explain', 'passage_title'];

/**
 * How a call ended:
 *   ok     — the provider answered
 *   quota  — the provider refused it (429): the call was made, the quota
 *            counter moved, and nothing came back
 *   failed — anything else that went wrong after the request went out
 */
const USAGE_OUTCOMES = ['ok', 'failed', 'quota'];

/**
 * Log one cloud (or local) call.
 *
 * Never throws: statistics must not cost an answer. That rule comes from the
 * original write site, which wrapped its INSERT in a bare try/catch for
 * exactly this reason — the number in the settings card is worth less than
 * the answer the user is waiting for.
 *
 * Unknown token counts are stored as NULL rather than 0: the side calls go
 * through the shared ladder (quota.js), which reports who answered but not
 * how many tokens it spent. A NULL says "not measured", a 0 would lie about
 * the cost estimate.
 */
function recordUsage(db, {
  provider,
  model,
  kind = 'chat',
  outcome = 'ok',
  promptTokens = null,
  completionTokens = null,
} = {}) {
  try {
    if (!provider || !model) return;
    db.prepare(
      `INSERT INTO usage_log
         (id, provider, model, kind, outcome, prompt_tokens, completion_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      crypto.randomUUID(),
      provider,
      model,
      USAGE_KINDS.includes(kind) ? kind : 'chat',
      USAGE_OUTCOMES.includes(outcome) ? outcome : 'ok',
      promptTokens ?? null,
      completionTokens ?? null,
      new Date().toISOString()
    );
  } catch (_) { /* statistics must never cost an answer */ }
}

/**
 * The wall clock of `zone` at `instant`, expressed as a UTC timestamp — the
 * building block for "which local day is it there". Same technique as
 * quota.js: Intl is the only timezone database in Node, and no dependency is
 * worth adding for one lookup.
 */
function wallClockUtc(instant, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const f = {};
  for (const p of parts) f[p.type] = p.value;
  return Date.UTC(+f.year, +f.month - 1, +f.day, +f.hour, +f.minute, +f.second);
}

/**
 * When the provider's current day began, as an ISO instant.
 *
 * NOT the UTC day, which is what the summary used to group by: Google resets
 * the daily quota at midnight PACIFIC time ("RPD quotas reset at midnight
 * Pacific time", ai.google.dev/gemini-api/docs/rate-limits). Grouped by UTC,
 * a call made at 20:00 in Austin counted into tomorrow while Google still
 * counted it into today — so the meter and the provider disagreed for the
 * seven hours where it matters most.
 *
 * The zone comes from registry.json (`resetTimezone`), the same field
 * quota.js reads for its countdown — one source of truth for a provider fact,
 * and providers that state none keep UTC.
 *
 * `now` is a parameter so tests do not depend on the machine clock.
 */
function providerDayStart(provider, now = new Date()) {
  const { getRegistry } = require('./registry');
  // No db handle: a provider constant needs nothing but the bundled registry.
  const zone = getRegistry().providers?.[provider]?.resetTimezone || 'UTC';
  const DAY = 86_400_000;
  const nowMs = now.getTime();
  // How far the zone's wall clock is ahead of UTC at a given instant.
  // wallClockUtc has second resolution, so the instant is floored to match.
  const offsetAt = (instant) => {
    try {
      return wallClockUtc(instant, zone) - Math.floor(instant / 1000) * 1000;
    } catch {
      return 0; // unknown zone name from a refreshed registry — fall back to UTC
    }
  };
  const offset = offsetAt(nowMs);
  const localNow = nowMs + offset;
  const midnightLocal = localNow - (localNow % DAY);
  // Second pass with the offset that was in force AT midnight: a DST change
  // during the day would otherwise move the boundary by an hour.
  return new Date(midnightLocal - offsetAt(midnightLocal - offset)).toISOString();
}

module.exports = { recordUsage, providerDayStart, USAGE_KINDS, USAGE_OUTCOMES };
