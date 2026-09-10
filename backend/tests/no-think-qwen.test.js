/**
 * tests/no-think-qwen.test.js
 *
 * "Thinking off" has to mean off — and on Groq that is two different words.
 *
 * Measured against the live API on 2026-09-04:
 *   qwen/qwen3.8-27b + reasoning_effort 'none' → no `reasoning` field
 *   qwen/qwen3.8-27b + reasoning_effort 'low'  → 111 characters of reasoning
 *   openai/gpt-oss-120b + 'none' → 400 "`reasoning_effort` must be one of
 *                                  `low`, `medium`, or `high`"
 * One provider, two answers, so the MODEL decides — not the provider alone.
 */
const { noThinkExtras } = require('../llm');

describe('noThinkExtras', () => {
  it('turns thinking genuinely off for Groq Qwen', () => {
    expect(noThinkExtras('groq', 'qwen/qwen3.8-27b')).toEqual({ reasoning_effort: 'none' });
  });

  it('keeps the only value gpt-oss accepts', () => {
    expect(noThinkExtras('groq', 'openai/gpt-oss-120b')).toEqual({ reasoning_effort: 'low' });
  });

  it('falls back to the value every Groq model accepts when the caller has no model', () => {
    expect(noThinkExtras('groq')).toEqual({ reasoning_effort: 'low' });
    expect(noThinkExtras('groq', null)).toEqual({ reasoning_effort: 'low' });
  });

  it('leaves the other providers as they were', () => {
    expect(noThinkExtras('ollama')).toEqual({ reasoning_effort: 'none' });
    expect(noThinkExtras('gemini', 'gemini-flash-latest')).toEqual({ reasoning_effort: 'low' });
    expect(noThinkExtras('openai', 'gpt-4o-mini')).toEqual({});
  });
});
