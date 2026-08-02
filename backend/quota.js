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

// Cooldown horizon for a daily limit: the free tiers reset at UTC midnight.
const msUntilUtcMidnight = () => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime();
};

module.exports = { isRateLimit, isDailyQuota, isTooLarge, isModelUnavailable, isBillingRequired, msUntilUtcMidnight };
