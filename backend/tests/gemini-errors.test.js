/**
 * tests/gemini-errors.test.js
 *
 * Gemini's OpenAI-compatible endpoint answers EVERY error with a JSON *array*
 * as the body (measured 2026-08-11 against the real key):
 *
 *   [{"error":{"code":429,"message":"… limit: 0 … retry in 32.07s", …}}]
 *
 * The OpenAI SDK reads `body['error']` in APIError.generate, which is
 * `undefined` for an array — so every error arrived as
 * `"429 status code (no body)"` with `err.error === undefined`, and all the
 * regex classifiers in quota.js were blind against Gemini: a DAILY limit was
 * classified as a 90 s minute limit. These tests pin the unwrapping and the
 * classifiers that live on top of it.
 */

const OpenAI = require('openai');
const { unwrapProviderErrors } = require('../llm');
const { isDailyQuota, isBillingRequired, isModelUnavailable, isBadKey } = require('../quota');

// The 429 body as it came off the wire on 2026-08-11, shortened only in the
// prose of `message`.
const DAILY_429 = [{
  error: {
    code: 429,
    message:
      'You exceeded your current quota, please check your plan and billing details. '
      + '* Quota exceeded for metric: generativelanguage.googleapis.com/'
      + 'generate_content_free_tier_requests, limit: 20 '
      + 'Please retry in 32.07s.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{
          quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
          quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
          quotaValue: '20',
        }],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '32s' },
    ],
  },
}];

// The 429 a model without free quota returns (limit: 0) — a billing gate, not
// a quota that resets at midnight.
const BILLING_429 = [{
  error: {
    code: 429,
    message:
      'You exceeded your current quota, please check your plan and billing details. '
      + '* Quota exceeded for metric: generativelanguage.googleapis.com/'
      + 'generate_content_paid_tier_input_token_count, limit: 0 '
      + 'Please retry in 32.07s.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{
          quotaId: 'GenerateContentPaidTierInputTokensPerModelPerMinute',
          quotaValue: '0',
        }],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '32s' },
    ],
  },
}];

/** A fetch that always answers with the given status and JSON body. */
const stubFetch = (status, body) => async () => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

/** The error the SDK produces for a stubbed response, after unwrapping. */
async function errorFor(status, body) {
  const client = new OpenAI({
    apiKey: 'test-key',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    maxRetries: 0,
    fetch: unwrapProviderErrors(stubFetch(status, body)),
  });
  try {
    await client.chat.completions.create({
      model: 'gemini-flash-latest',
      messages: [{ role: 'user', content: 'hi' }],
    });
  } catch (err) {
    return err;
  }
  throw new Error('expected the stubbed response to reject');
}

describe('unwrapProviderErrors', () => {
  it('carries the real message of an array-body error into err.message', async () => {
    const err = await errorFor(429, DAILY_429);
    expect(err.message).toContain('Quota exceeded for metric');
    expect(err.status).toBe(429);
    // Not the "(no body)" placeholder the SDK produced before the unwrapping.
    expect(err.message).not.toContain('no body');
  });
});

describe('unwrapProviderErrors leaves everything else alone', () => {
  it('passes a successful answer and a non-JSON error through untouched', async () => {
    const wrapped = unwrapProviderErrors(stubFetch(200, {
      choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    }));
    const ok = await wrapped('https://example.test/v1/chat/completions', {});
    expect((await ok.json()).choices[0].message.content).toBe('hello');

    // An HTML error page (proxy, gateway) has nothing to unwrap — the SDK must
    // still see the original response.
    const html = unwrapProviderErrors(async () => new Response('<html>502</html>', { status: 502 }));
    const bad = await html('https://example.test/v1/chat/completions', {});
    expect(bad.status).toBe(502);
    expect(await bad.text()).toContain('502');
  });
});

describe('classifiers against the real Gemini errors', () => {
  it('reads a daily limit out of the quotaId, which lives in the details', async () => {
    // The prose message only names the metric and its limit; that the limit is
    // a PER-DAY one is stated solely by the quotaId
    // 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' in the QuotaFailure
    // detail — no space, no underscore, so the old /per[_ ]day/ never matched.
    expect(isDailyQuota(await errorFor(429, DAILY_429))).toBe(true);
  });

  it('tells the zero-quota billing gate apart from an exhausted daily limit', async () => {
    expect(isBillingRequired(await errorFor(429, BILLING_429))).toBe(true);
    // The daily error carries a limit of 20 and quotaValue "20" — reading the
    // details must not turn any non-zero limit into a billing gate.
    expect(isBillingRequired(await errorFor(429, DAILY_429))).toBe(false);
  });

  it('recognises a retired model from the real 404 wording', async () => {
    // Same array body, different status — before the unwrapping this arrived
    // as "404 status code (no body)" and matched no classifier at all, so a
    // retired model looked like an ordinary error instead of a failover reason.
    const err = await errorFor(404, [{
      error: {
        code: 404,
        message: 'models/gemini-2.5-flash is not found for API version v1main, '
          + 'or is not supported for generateContent.',
        status: 'NOT_FOUND',
      },
    }]);
    expect(isModelUnavailable(err)).toBe(true);
  });

  it('calls a rejected key a key problem even when it arrives as a 400', async () => {
    // Gemini answers a wrong key with 400 "Invalid Auth key.", not 401
    // (measured 2026-08-11) — so the ladder's 401/403 stop never triggered and
    // it collected the same 400 from every remaining model.
    const err = await errorFor(400, [{
      error: { code: 400, message: 'Invalid Auth key.', status: 'INVALID_ARGUMENT' },
    }]);
    expect(isBadKey(err)).toBe(true);
  });

  it('does not call an ordinary 400 a key problem', async () => {
    const err = await errorFor(400, [{
      error: {
        code: 400,
        message: '`reasoning_effort` is not supported with this model',
        status: 'INVALID_ARGUMENT',
      },
    }]);
    expect(isBadKey(err)).toBe(false);
  });
});
