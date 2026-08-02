/**
 * usage.js
 *
 * GET /api/usage/summary — aggregates usage_log into an honest monthly
 * cost estimate per provider (ADR-0008 slice 7):
 *   tokens × registry price table, reported as an estimate with the
 *   table's as-of date. The free-tier-relevant number is the daily
 *   request counter (requestsToday); local always costs 0.
 */

const express = require('express');
const { getRegistry } = require('../registry');

module.exports = (db) => {
  const router = express.Router();

  router.get('/summary', (_req, res) => {
    const reg = getRegistry(db);
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();

    const monthRows = db
      .prepare(
        `SELECT provider, model,
                COUNT(*) AS requests,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens
         FROM usage_log WHERE created_at >= ? GROUP BY provider, model`
      )
      .all(monthStart);
    const todayRows = db
      .prepare(
        'SELECT provider, COUNT(*) AS requests FROM usage_log WHERE created_at >= ? GROUP BY provider'
      )
      .all(dayStart);
    // Per-model counters for the quota meters (cost tiers 2026-07-30):
    // the free tiers reset at UTC midnight, so "today" is the UTC day.
    const modelTodayRows = db
      .prepare(
        'SELECT provider, model, COUNT(*) AS requests FROM usage_log WHERE created_at >= ? GROUP BY provider, model'
      )
      .all(dayStart);

    const providers = {};
    for (const row of monthRows) {
      const p = (providers[row.provider] ??= {
        requests: 0,
        requestsToday: 0,
        promptTokens: 0,
        completionTokens: 0,
        estimatedUsd: 0,
      });
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
    for (const row of todayRows) {
      if (providers[row.provider]) providers[row.provider].requestsToday = row.requests;
    }
    for (const p of Object.values(providers)) {
      p.estimatedUsd = Math.round(p.estimatedUsd * 10000) / 10000;
    }

    const modelsToday = {};
    for (const row of modelTodayRows) {
      modelsToday[`${row.provider}/${row.model}`] = row.requests;
    }

    res.json({
      month: monthStart.slice(0, 7),
      providers,
      modelsToday,
      // Honesty of the estimate: price as-of date visible; the truth is
      // in the provider's billing dashboard.
      pricesAsOf: reg.asOf,
    });
  });

  return router;
};
