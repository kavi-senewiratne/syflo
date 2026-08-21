/**
 * usage.js
 *
 * GET /api/usage/summary — aggregates usage_log into an honest monthly
 * cost estimate per provider (ADR-0008 slice 7):
 *   tokens × registry price table, reported as an estimate with the
 *   table's as-of date. The free-tier-relevant number is the daily
 *   request counter (requestsToday); local always costs 0.
 *
 * "Today" is the PROVIDER's day, not the UTC day (2026-08-11). Google resets
 * the daily quota at midnight Pacific; grouped by UTC, a call made at 20:00
 * in Austin counted into tomorrow while Google still counted it into today.
 * The arithmetic and the registry's `resetTimezone` live in ../usage.js, the
 * same module every write site uses — one source for the day boundary.
 *
 * The counters cover EVERY call now, not just the answers that arrived: title
 * generation, /btw, Explain and passage titles spend the same quota, and a
 * 429 is a spent call too. That is why the model window could say "0/20" for
 * a Gemini Flash whose daily limit was long gone (four logged answers on
 * 2026-08-10, full limit).
 */

const express = require('express');
const { getRegistry } = require('../registry');
const { providerDayStart } = require('../usage');

module.exports = (db) => {
  const router = express.Router();

  router.get('/summary', (req, res) => {
    const reg = getRegistry(db);
    // The day boundary is a function of time, so the time is an input: with
    // `?now=<iso>` the window is reproducible instead of depending on the
    // machine clock. Read-only either way.
    const asked = req.query.now ? Date.parse(req.query.now) : NaN;
    const now = Number.isNaN(asked) ? new Date() : new Date(asked);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

    const monthRows = db
      .prepare(
        `SELECT provider, model,
                COUNT(*) AS requests,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens
         FROM usage_log WHERE created_at >= ? GROUP BY provider, model`
      )
      .all(monthStart);

    const providers = {};
    const emptyProvider = () => ({
      requests: 0,
      requestsToday: 0,
      promptTokens: 0,
      completionTokens: 0,
      estimatedUsd: 0,
    });
    for (const row of monthRows) {
      const p = (providers[row.provider] ??= emptyProvider());
      p.requests += row.requests;
      p.promptTokens += row.prompt_tokens;
      p.completionTokens += row.completion_tokens;
      const pricing =
        row.provider === 'ollama'
          ? null
          : reg.providers[row.provider]?.models.find((m) => m.name === row.model)?.pricing;
      if (pricing) {
        p.estimatedUsd +=
          (row.prompt_tokens / 1e6) * pricing.inputPerMTok +
          (row.completion_tokens / 1e6) * pricing.outputPerMTok;
      }
    }
    for (const p of Object.values(providers)) {
      p.estimatedUsd = Math.round(p.estimatedUsd * 10000) / 10000;
    }

    // Per-model counters for the quota meters (cost tiers 2026-07-30), one
    // query per provider because each provider's day starts at its own
    // midnight. Which providers to ask is read from the log itself — the
    // window may reach back into last month (a pacific day that began before
    // UTC month start), so this list is not simply the month's providers.
    const logged = db
      .prepare('SELECT DISTINCT provider FROM usage_log WHERE created_at >= ?')
      .all(new Date(now.getTime() - 32 * 24 * 60 * 60 * 1000).toISOString())
      .map((r) => r.provider);

    const todayByModelKind = db.prepare(
      `SELECT model, kind, COUNT(*) AS requests
       FROM usage_log WHERE provider = ? AND created_at >= ? GROUP BY model, kind`
    );

    const modelsToday = {};
    // Same key shape as modelsToday, one level deeper: what the day's calls
    // were FOR, so the card can say "12 answers, 6 titles, 2 asides" instead
    // of one number that hides four kinds of call.
    const kindsToday = {};
    for (const provider of logged) {
      const dayStart = providerDayStart(provider, now);
      for (const row of todayByModelKind.all(provider, dayStart)) {
        const key = `${provider}/${row.model}`;
        modelsToday[key] = (modelsToday[key] || 0) + row.requests;
        (kindsToday[key] ??= {})[row.kind] = (kindsToday[key][row.kind] || 0) + row.requests;
        // A provider whose only rows sit in the current provider-day but
        // before UTC month start still needs its entry.
        const p = (providers[provider] ??= emptyProvider());
        p.requestsToday += row.requests;
      }
    }

    res.json({
      month: monthStart.slice(0, 7),
      providers,
      modelsToday,
      kindsToday,
      // Honesty of the estimate: price as-of date visible; the truth is
      // in the provider's billing dashboard.
      pricesAsOf: reg.asOf,
    });
  });

  return router;
};
