/**
 * quota.js
 *
 * Shared quota-error classifiers for every route that talks to a cloud
 * provider (messages, explain). The cooldown MEMORY stays in the messages
 * router (the picker badges read it there via GET /api/quota-cooldowns);
 * this module only answers "what kind of failure is this" so the chat's
 * failover ladder and the explain fallback never drift apart.
 */

const isRateLimit = (e) => e?.status === 429 || e?.response?.status === 429;

// Daily limits fail until the provider's reset; classified from the 429
// message (Google: 'per_day', OpenAI: 'RPD/TPD').
const isDailyQuota = (e) => /per[_ ]day|daily|RPD|TPD/i.test(e?.message || '');

const isTooLarge = (e) => e?.status === 413 || /request too large/i.test(e?.message || '');

// Zero-limit 429: the free tier of this model is literally 0 — a billing
// gate, not a quota that resets at midnight. Google encodes it as
// quotaValue/limit "0" in the 429 details. Must be checked BEFORE
// isDailyQuota: the same message usually also names a per-day metric.
const isBillingRequired = (e) =>
  isRateLimit(e) &&
  /(?:quota_?value|quota_limit_value|limit)["']?\s*[:=]\s*["']?0["']?(?![.\d])/i.test(e?.message || '');

// Providers retire models under existing names (Google 2026-07: 2.5 models
// return 404 "no longer available to new users") — a failover reason, not a
// user-facing hard error.
const isModelUnavailable = (e) =>
  e?.status === 404 && /model|not found|no longer available/i.test(e?.message || '');

// The provider's own servers are saturated (Google: 503 UNAVAILABLE "This
// model is currently experiencing high demand"). Neither a quota nor a key
// problem: the identical request succeeds seconds later — measured
// 2026-08-16, five 503s and one clean answer for the same prompt within
// four minutes. Therefore retried in place and NEVER given a cooldown:
// marking the model unusable would push the user down the failover ladder
// for a condition that passes on its own.
const isOverloaded = (e) =>
  e?.status === 503 ||
  e?.response?.status === 503 ||
  /overloaded|high demand|UNAVAILABLE/i.test(e?.message || '');

// Cooldown horizon for a daily limit: the free tiers reset at UTC midnight.
const msUntilUtcMidnight = () => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime();
};

/**
 * The failover ladder, shared by every cloud route (explain, passage titles).
 * Same candidate order as the chat's pickFallback (messages.js): the selected
 * model of each provider first, providers starting with the active one,
 * cloud-with-key only. No vision gate — these are text tasks.
 *
 * Cost-tier parity (2026-07-30): paid-only models are never fallback
 * material; only the active provider's deliberate selection may be one.
 */
function cloudCandidates(db, activeProvider) {
  const { getSetting } = require('./llm');
  const { getRegistry, getModelInfo } = require('./registry');
  const reg = getRegistry(db);
  const order = [activeProvider, ...Object.keys(reg.providers).filter((n) => n !== activeProvider)];
  const candidates = [];
  for (const name of order) {
    const p = reg.providers[name];
    if (!p || p.kind !== 'cloud') continue;
    if (!getSetting(db, `${name}_api_key`)) continue;
    const selected = getSetting(db, `${name}_model`);
    const models = [selected, ...p.models.map((m) => m.name).filter((n) => n !== selected)];
    for (const m of models) {
      if (!m) continue;
      const isActiveSelection = name === activeProvider && m === selected;
      if (!isActiveSelection && getModelInfo(db, name, m).free === false) continue;
      candidates.push({ provider: name, model: m });
    }
  }
  return candidates;
}

/**
 * How long a failure keeps a model out of the ladder — one table for every
 * route, so no ladder invents its own horizon (the drift this module exists to
 * prevent). null means "remember nothing":
 *   - a billing gate is deterministic, there is nothing to wait out, and a
 *     90 s countdown badge on a paid model is a lie the picker used to tell
 *     (user report 2026-08-06: "in 13 s" on Gemini Pro, which needs billing);
 *   - a 413 depends on the request size, not on a quota;
 *   - anything else (400, timeout, 500) says nothing about availability.
 */
function cooldownFor(err) {
  if (isBillingRequired(err)) return null;
  if (isModelUnavailable(err)) return { ms: 24 * 60 * 60 * 1000, kind: 'retired' };
  if (isTooLarge(err)) return null;
  if (isRateLimit(err)) {
    return isDailyQuota(err)
      ? { ms: msUntilUtcMidnight(), kind: 'daily' }
      : { ms: 90_000, kind: 'minute' };
  }
  return null;
}

// A server-side hiccup is worth one retry: Gemini answered 503 on the first of
// three live calls (measured 2026-08-02) and fine right after.
const isTransient = (err) => {
  const status = err?.status ?? err?.response?.status;
  return typeof status === 'number' && status >= 500;
};

/**
 * Run ONE short cloud call along the failover ladder and return the first
 * answer. Shared by every side-task that talks to a cloud model — the passage
 * title before a branch and the title/outcome line after an answer (user
 * request 2026-08-06: an exhausted quota must not leave a mindmap node saying
 * "Ergebnis folgt …" forever when another keyed provider is sitting right
 * there).
 *
 * Not for the chat answer itself: that one streams, reports its failover to
 * the UI and must surface hard errors. A side task is a nicety — it walks
 * every candidate and returns null when none delivers.
 *
 * @returns {Promise<{raw: string, provider: string, model: string}|null>}
 */
async function callCloudLadder(db, {
  activeProvider,
  messages,
  budgetMs,
  callMs,
  isCoolingDown,
  markCooldown,
  extraBody = () => ({}),
  label = 'side task',
  onError = () => {},
  // Optional streaming (added for /btw, 2026-08-08): with an onDelta the call
  // asks for `stream: true` and forwards every chunk as it arrives, still
  // returning the assembled text as `raw`. Without it the behaviour is
  // unchanged — one request, one complete answer — so no existing caller is
  // affected. Deltas are only forwarded once a candidate has actually started
  // producing them, so a candidate that dies mid-ladder cannot leak a half
  // sentence in front of the next candidate's answer.
  onDelta = null,
}) {
  const { getLLMClientFor, noThinkExtras } = require('./llm');
  const cooling = isCoolingDown || (() => false);
  const all = cloudCandidates(db, activeProvider);
  // Known-cold models are skipped; if EVERY candidate is cold we still try —
  // a cooldown is a guess, and one 429 costs less than a missing line.
  let candidates = all.filter((c) => !cooling(c.provider, c.model));
  if (candidates.length === 0) candidates = all;

  const deadline = Date.now() + budgetMs;
  const remaining = () => deadline - Date.now();

  // A rejected key (401/403) ends the ladder on the spot instead of walking
  // every remaining model: the key is the user's configuration, repeating the
  // same 401 four times hides that from them (decision kept from the explain
  // route, tests/explain.test.js). Every OTHER error moves to the next
  // candidate — that is the difference to the old private loops, where a 400
  // like "`reasoning_effort` is not supported with this model" killed the whole
  // request (user report 2026-08-06).
  let authFailure = false;

  for (const cand of candidates) {
    if (remaining() <= 0 || authFailure) break;
    let client;
    try {
      ({ client } = getLLMClientFor(db, cand.provider));
    } catch {
      continue; // no key / unknown provider — next candidate
    }
    let plain = false; // set when the model rejects the no-thinking flag
    for (let attempt = 0; attempt < 2; attempt++) {
      if (remaining() <= 0) break;
      try {
        const completion = await client.chat.completions.create({
          model: cand.model,
          ...(plain ? {} : noThinkExtras(cand.provider)),
          messages,
          ...(onDelta ? { stream: true } : {}),
          ...extraBody(cand),
        }, { signal: AbortSignal.timeout(Math.min(callMs, remaining())) });
        if (onDelta) {
          let raw = '';
          for await (const chunk of completion) {
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              raw += delta;
              onDelta(delta);
            }
          }
          return { raw, provider: cand.provider, model: cand.model };
        }
        return {
          raw: completion.choices[0]?.message?.content || '',
          provider: cand.provider,
          model: cand.model,
        };
      } catch (err) {
        if (attempt === 0 && isTransient(err)) {
          await new Promise((resolve) => setTimeout(resolve, 400));
          continue;
        }
        // Some models reject the no-thinking flag outright (Groq's llama-3.3:
        // "400 `reasoning_effort` is not supported with this model", measured
        // 2026-08-02) — one plain retry makes them usable.
        if (attempt === 0 && /reasoning_effort/i.test(err?.message || '')) {
          plain = true;
          continue;
        }
        const cooldown = cooldownFor(err);
        if (cooldown && markCooldown) {
          markCooldown(cand.provider, cand.model, cooldown.ms, cooldown.kind);
        }
        onError(err, cand);
        const status = err?.status ?? err?.response?.status;
        if (status === 401 || status === 403) authFailure = true;
        // EVERY failure moves on to the next candidate — a timeout or a 400
        // used to end the whole ladder even though the very next model would
        // have answered in 0.5 s (measured 2026-08-02).
        if (!isRateLimit(err) && !isModelUnavailable(err) && !isBillingRequired(err)) {
          console.error(`[quota] ${label} via ${cand.provider}/${cand.model}: ${err.message}`);
        }
        break; // next candidate
      }
    }
  }
  return null;
}

module.exports = {
  isRateLimit, isDailyQuota, isTooLarge, isModelUnavailable, isBillingRequired,
  isOverloaded,
  msUntilUtcMidnight, cloudCandidates, cooldownFor, callCloudLadder,
};
