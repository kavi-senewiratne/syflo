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

module.exports = {
  isRateLimit, isDailyQuota, isTooLarge, isModelUnavailable, isBillingRequired,
  msUntilUtcMidnight, cloudCandidates,
};
