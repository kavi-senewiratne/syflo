/**
 * tests/quota-cooldown.test.js
 *
 * One cooldown table for every ladder (quota.js). The rule under test is the
 * one the picker got wrong (user report 2026-08-06: "in 13 s" on Gemini Pro,
 * which needs billing): a deterministic failure must never turn into a
 * countdown badge.
 */

const { cooldownFor, msUntilQuotaReset, retryAfterSeconds } = require('../quota');

const err = (message, status) => Object.assign(new Error(message), { status });

describe('cooldownFor', () => {
  it('gives a billing gate no cooldown at all', () => {
    // Google encodes the zero free quota as limit "0" in the 429 details.
    expect(cooldownFor(err('429 quota_limit_value: "0" per_day', 429))).toBeNull();
  });

  it('remembers a daily limit until the midnight of that provider', () => {
    const out = cooldownFor(err('429 quota exceeded: generate_requests_per_day', 429), 'gemini');
    expect(out.kind).toBe('daily');
    // Within a second of the shared horizon — same clock, same arithmetic.
    expect(Math.abs(out.ms - msUntilQuotaReset('gemini'))).toBeLessThan(1000);
    // And the provider really reaches the horizon: Gemini resets on Pacific
    // time, Groq on UTC, so the two can never be the same distance away.
    const groq = cooldownFor(err('429 quota exceeded: generate_requests_per_day', 429), 'groq');
    expect(groq.ms).not.toBe(out.ms);
  });

  it('remembers a per-minute limit for 90 s', () => {
    expect(cooldownFor(err('429 too many requests', 429))).toEqual({ ms: 90_000, kind: 'minute' });
  });

  it('remembers a retired model for a day', () => {
    const out = cooldownFor(err('404 model no longer available to new users', 404));
    expect(out).toEqual({ ms: 24 * 60 * 60 * 1000, kind: 'retired' });
  });

  it('gives a too-large request no cooldown — that is the request, not a quota', () => {
    expect(cooldownFor(err('413 request too large', 413))).toBeNull();
  });

  it('gives an ordinary failure no cooldown', () => {
    expect(cooldownFor(err('400 reasoning_effort is not supported', 400))).toBeNull();
    expect(cooldownFor(err('500 internal', 500))).toBeNull();
    expect(cooldownFor(new Error('socket hang up'))).toBeNull();
  });
});

describe('retryAfterSeconds', () => {
  it('waits as long as the provider asked in its RetryInfo detail', () => {
    // Gemini names the wait only in the structured details of the error body
    // (measured 2026-08-11) — no Retry-After header at all, so the old
    // header-only reader always fell back to a made-up 20 s.
    const e = Object.assign(new Error('429 Quota exceeded for metric: x, limit: 20'), {
      status: 429,
      error: {
        code: 429,
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '32s' }],
      },
    });
    expect(retryAfterSeconds(e)).toBe(32);
  });

  it('falls back to the prose, keeps the 120 s cap and the 20 s default', () => {
    // "Please retry in 32.07s" — rounded UP, or the retry buys a second 429.
    expect(retryAfterSeconds(err('429 Please retry in 32.07s.', 429))).toBe(33);
    const long = Object.assign(new Error('429 slow down'), {
      status: 429,
      headers: { 'retry-after': '3600' },
    });
    expect(retryAfterSeconds(long)).toBe(120);
    expect(retryAfterSeconds(err('429 too many requests', 429))).toBe(20);
  });
});

describe('msUntilQuotaReset', () => {
  // A fixed instant, so the test never depends on the machine clock:
  // 2026-08-21 04:30 UTC is still 2026-08-20 21:30 in Los Angeles (PDT).
  const NOW = new Date('2026-08-21T04:30:00Z');
  const HOUR = 60 * 60 * 1000;

  it('counts to midnight in the provider timezone, not to UTC midnight', () => {
    // Google resets the daily quota at midnight PACIFIC time
    // (ai.google.dev/gemini-api/docs/rate-limits) — 2.5 h away here, while UTC
    // midnight is 19.5 h away. The UTC horizon ended the countdown 7 h early.
    expect(msUntilQuotaReset('gemini', NOW)).toBe(2.5 * HOUR);
    expect(msUntilQuotaReset('groq', NOW)).toBe(19.5 * HOUR);
  });
});
