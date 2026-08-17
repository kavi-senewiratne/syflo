/**
 * tests/quota-cooldown.test.js
 *
 * One cooldown table for every ladder (quota.js). The rule under test is the
 * one the picker got wrong (user report 2026-08-06: "in 13 s" on Gemini Pro,
 * which needs billing): a deterministic failure must never turn into a
 * countdown badge.
 */

const { cooldownFor, msUntilUtcMidnight } = require('../quota');

const err = (message, status) => Object.assign(new Error(message), { status });

describe('cooldownFor', () => {
  it('gives a billing gate no cooldown at all', () => {
    // Google encodes the zero free quota as limit "0" in the 429 details.
    expect(cooldownFor(err('429 quota_limit_value: "0" per_day', 429))).toBeNull();
  });

  it('remembers a daily limit until UTC midnight', () => {
    const out = cooldownFor(err('429 quota exceeded: generate_requests_per_day', 429));
    expect(out.kind).toBe('daily');
    // Within a second of the shared horizon — same clock, same arithmetic.
    expect(Math.abs(out.ms - msUntilUtcMidnight())).toBeLessThan(1000);
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
