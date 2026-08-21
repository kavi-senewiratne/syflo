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

/**
 * Everything the provider said about this failure, as one searchable string.
 *
 * `err.message` is only the prose line ("429 Quota exceeded for metric: …,
 * limit: 20"). WHICH quota bit is stated nowhere in it — Google puts that in
 * the structured `details` of the error body, as
 * `quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier'` plus a
 * `RetryInfo` (measured 2026-08-11 against the real key; the array-body
 * unwrapping in llm.js is what makes `err.error` exist at all). Classifying
 * on the message alone therefore turned every Gemini daily limit into a
 * 90 s minute limit — the false countdowns.
 */
const errorText = (e) => {
  let text = e?.message || '';
  const body = e?.error ?? e?.response?.data?.error;
  if (body && typeof body === 'object') {
    try {
      text += ' ' + JSON.stringify(body);
    } catch { /* circular / unserialisable — the message alone has to do */ }
  }
  return text;
};

// Daily limits fail until the provider's reset; classified from the 429 text
// (Google prose: 'per_day'; Google quotaId: 'PerDayPerProject' — no separator,
// hence the optional one; OpenAI: 'RPD/TPD').
const isDailyQuota = (e) => /per[_ ]?day|daily|RPD|TPD/i.test(errorText(e));

const isTooLarge = (e) => e?.status === 413 || /request too large/i.test(errorText(e));

// Zero-limit 429: the free tier of this model is literally 0 — a billing
// gate, not a quota that resets at midnight. Google encodes it as
// quotaValue/limit "0", in the prose AND in the 429 details. Must be checked
// BEFORE isDailyQuota: the same message usually also names a per-day metric.
const isBillingRequired = (e) =>
  isRateLimit(e) &&
  /(?:quota_?value|quota_limit_value|limit)["']?\s*[:=]\s*["']?0["']?(?![.\d])/i.test(errorText(e));

// Providers retire models under existing names (Google 2026-07: 2.5 models
// return 404 "no longer available to new users") — a failover reason, not a
// user-facing hard error.
// (Gemini's real 404, measured 2026-08-11: "models/gemini-2.5-flash is not
// found for API version v1main, or is not supported for generateContent.")
const isModelUnavailable = (e) =>
  e?.status === 404 && /model|not found|no longer available/i.test(errorText(e));

/**
 * The key itself is wrong — the user's configuration, not a quota.
 *
 * 401/403 is what most providers send. Gemini does NOT: with a wrong key its
 * OpenAI-compatible endpoint answers 400 "Invalid Auth key." (measured
 * 2026-08-11), which used to fall into the generic-error bucket and let the
 * ladder walk every remaining model to collect four identical 400s instead of
 * stopping at the one thing only the user can fix.
 */
const isBadKey = (e) => {
  const status = e?.status ?? e?.response?.status;
  if (status === 401 || status === 403) return true;
  return status === 400
    && /invalid auth|api[_ ]?key not valid|invalid api[_ ]?key|api key expired/i.test(errorText(e));
};

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
  /overloaded|high demand|UNAVAILABLE/i.test(errorText(e));

/**
 * How long to wait before retrying — the provider's own number, not a guess.
 *
 * Three places carry it, in decreasing authority:
 *   1. the `Retry-After` header (OpenAI, Groq);
 *   2. a `RetryInfo` detail in the error body, e.g. `retryDelay: "32s"` — the
 *      only place Gemini states it (measured 2026-08-11: no Retry-After
 *      header on its 429s at all);
 *   3. the prose, "Please retry in 32.07s".
 * Fractions round UP: retrying a hair too early buys a second 429.
 *
 * The 120 s cap stays: beyond that the queue's visible countdown stops being
 * a wait and becomes a hang. Without any of the three, 20 s as before.
 */
const RETRY_CAP_SECONDS = 120;

function retryAfterSeconds(e, { fallbackSeconds = 20, capSeconds = RETRY_CAP_SECONDS } = {}) {
  const capped = (n) => Math.min(Math.ceil(n), capSeconds);
  const header = e?.headers?.['retry-after'] ?? e?.response?.headers?.['retry-after'];
  const fromHeader = parseInt(header, 10);
  if (Number.isFinite(fromHeader)) return capped(fromHeader);

  const details = e?.error?.details ?? e?.response?.data?.error?.details;
  if (Array.isArray(details)) {
    for (const d of details) {
      const m = /^([\d.]+)s$/.exec(String(d?.retryDelay || ''));
      if (m) return capped(Number(m[1]));
    }
  }

  const prose = /retry in ([\d.]+)\s*s/i.exec(errorText(e));
  if (prose) return capped(Number(prose[1]));

  return fallbackSeconds;
}

/**
 * The same instant read as wall-clock time in `timeZone`, expressed as a UTC
 * timestamp. `Intl` is the only tool needed for that — no new dependency, and
 * it knows the DST rules.
 */
function wallClockUtc(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const f = {};
  for (const p of parts) f[p.type] = p.value;
  // 'en-US' renders midnight as hour 24 — normalised to 0.
  const hour = Number(f.hour) % 24;
  return Date.UTC(Number(f.year), Number(f.month) - 1, Number(f.day), hour, Number(f.minute), Number(f.second));
}

/**
 * Cooldown horizon for a daily limit: the time left until the provider's own
 * midnight.
 *
 * NOT UTC midnight, which is what this used to compute: Google resets the
 * daily quota at midnight PACIFIC time ("RPD quotas reset at midnight Pacific
 * time", ai.google.dev/gemini-api/docs/rate-limits), so in Europe the
 * countdown promised the quota back 7–8 h too early and every retry after it
 * ran into the same 429. The zone per provider lives in registry.json
 * (`resetTimezone`) — the registry is the source of truth for provider facts;
 * providers that do not state one keep UTC.
 *
 * `now` is a parameter so tests do not depend on the machine clock.
 */
function msUntilQuotaReset(provider, now = new Date()) {
  const { getRegistry } = require('./registry');
  // No db: the bundled registry is enough for a provider constant — this is
  // called from error paths that have no handle on the database.
  const zone = getRegistry().providers?.[provider]?.resetTimezone || 'UTC';
  const DAY = 86_400_000;
  const nowMs = now.getTime();
  // How far the zone's wall clock is ahead of UTC at a given instant.
  // wallClockUtc has second resolution, so the instant is floored to match.
  const offsetAt = (instant) => {
    try {
      return wallClockUtc(new Date(instant), zone) - Math.floor(instant / 1000) * 1000;
    } catch {
      return 0; // unknown zone name from a refreshed registry — fall back to UTC
    }
  };
  const offset = offsetAt(nowMs);
  const localNow = nowMs + offset;
  const nextMidnightLocal = localNow - (localNow % DAY) + DAY;
  // Second pass with the offset that will be in force AT the reset: a DST
  // change between now and midnight would otherwise shift the horizon by 1 h.
  const instant = nextMidnightLocal - offsetAt(nextMidnightLocal - offset);
  return instant - nowMs;
}

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
function cooldownFor(err, provider) {
  if (isBillingRequired(err)) return null;
  if (isModelUnavailable(err)) return { ms: 24 * 60 * 60 * 1000, kind: 'retired' };
  if (isTooLarge(err)) return null;
  if (isRateLimit(err)) {
    // The daily horizon is the PROVIDER's midnight (see msUntilQuotaReset);
    // without the provider name it stays UTC, as it was before.
    return isDailyQuota(err)
      ? { ms: msUntilQuotaReset(provider), kind: 'daily' }
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
 * @returns {Promise<{raw: string, finishReason: string|null, provider: string, model: string}|null>}
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
  // affected.
  onDelta = null,
  // Called when a candidate that ALREADY streamed text then failed. Live
  // streaming means its half sentence is on the reader's screen before anyone
  // knows the call will die; the next candidate then writes a second answer
  // under it. The caller uses this to take the fragment back — see the
  // `reset` event in routes/btw.js (user report 2026-08-19: an aside that
  // stood there cut off mid-word).
  onDiscard = null,
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
      // What this attempt has already handed to the reader. Only a non-empty
      // one has to be taken back when the attempt then fails.
      let streamed = '';
      try {
        const completion = await client.chat.completions.create({
          model: cand.model,
          ...(plain ? {} : noThinkExtras(cand.provider)),
          messages,
          ...(onDelta ? { stream: true } : {}),
          ...extraBody(cand),
        }, { signal: AbortSignal.timeout(Math.min(callMs, remaining())) });
        if (onDelta) {
          // The provider's own verdict on how the answer ended. 'stop' is
          // clean; 'length'/'content_filter' (Gemini: MAX_TOKENS, RECITATION)
          // and a MISSING final chunk mean the text broke off — the caller
          // needs that to know whether it may present the answer as finished.
          // Measured 2026-08-19: gemini-flash-latest sends "stop" on a clean
          // end, so a missing reason really is a signal here.
          let finishReason = null;
          for await (const chunk of completion) {
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              streamed += delta;
              onDelta(delta);
            }
            const reason = chunk.choices?.[0]?.finish_reason;
            if (reason) finishReason = reason;
          }
          // A call that returns nothing at all is a dead line, not an answer
          // (same rule as the chat rounds in tools.js): the next candidate
          // gets the question instead of the reader getting an empty panel.
          if (!streamed.trim()) {
            console.error(`[quota] ${label} via ${cand.provider}/${cand.model}: empty answer`);
            break; // next candidate
          }
          return { raw: streamed, finishReason, provider: cand.provider, model: cand.model };
        }
        return {
          raw: completion.choices[0]?.message?.content || '',
          finishReason: completion.choices[0]?.finish_reason ?? null,
          provider: cand.provider,
          model: cand.model,
        };
      } catch (err) {
        // Whatever comes next, what this candidate already wrote is void.
        if (streamed) onDiscard?.();
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
        const cooldown = cooldownFor(err, cand.provider);
        if (cooldown && markCooldown) {
          markCooldown(cand.provider, cand.model, cooldown.ms, cooldown.kind);
        }
        onError(err, cand);
        // isBadKey, not a bare 401/403 check: Gemini rejects a wrong key with
        // a 400 (measured 2026-08-11), which used to look like an ordinary
        // per-model failure.
        if (isBadKey(err)) authFailure = true;
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
  isOverloaded, isBadKey, errorText, retryAfterSeconds,
  msUntilQuotaReset, cloudCandidates, cooldownFor, callCloudLadder,
};
