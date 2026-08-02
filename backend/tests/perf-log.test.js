/**
 * tests/perf-log.test.js
 *
 * Latency instrumentation (2026-07-24): per answer one extended [perf]
 * line plus — behind a switch — an analyzable perf.jsonl. Pure
 * metrics, NEVER conversation content; nothing lands in the database.
 */

const {
  buildPerfRecord,
  formatPerfLine,
  appendPerfJsonl,
  isPerfJsonlEnabled,
} = require('../perf-log');

const SAMPLE = {
  now: '2026-07-24T12:00:00.000Z',
  chatId: 'chat-1',
  model: 'qwen3.5:9b',
  mode: 'retrieval',
  cache: 'warm',
  sourceTokens: 15212,
  chunkCount: 8,
  promptTokens: 4460,
  ttftMs: 13789,
  completionTokens: 49,
  tokensPerSecond: 23.4,
  totalMs: 14535,
  finishReason: 'stop',
};

describe('buildPerfRecord', () => {
  it('keeps only allow-listed metric fields, in a stable shape', () => {
    const rec = buildPerfRecord(SAMPLE);
    expect(rec).toEqual({
      ts: '2026-07-24T12:00:00.000Z',
      chatId: 'chat-1',
      model: 'qwen3.5:9b',
      mode: 'retrieval',
      cache: 'warm',
      sourceTokens: 15212,
      chunkCount: 8,
      promptTokens: 4460,
      ttftMs: 13789,
      genTokens: 49,
      tokS: 23.4,
      totalMs: 14535,
      finish: 'stop',
    });
  });

  it('NEVER copies conversation content, even if handed some', () => {
    // Privacy guarantee: the function builds the record from a fixed field
    // list — arbitrary extra fields (question, answer) must never leak through.
    const rec = buildPerfRecord({
      ...SAMPLE,
      question: 'What is the secret in section 7?',
      answer: 'The secret is 42.',
      content: 'raw user text',
    });
    const serialized = JSON.stringify(rec);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('42');
    expect(serialized).not.toContain('raw user text');
    expect(rec.question).toBeUndefined();
    expect(rec.answer).toBeUndefined();
    expect(rec.content).toBeUndefined();
  });

  it('tolerates missing optional fields (null, not undefined/crash)', () => {
    const rec = buildPerfRecord({ now: 'T', model: 'm', mode: 'fulltext', cache: 'cold' });
    expect(rec.promptTokens).toBeNull();
    expect(rec.sourceTokens).toBeNull();
    expect(rec.chunkCount).toBeNull();
    expect(rec.chatId).toBeNull();
  });
});

describe('formatPerfLine', () => {
  it('renders a greppable single line with mode and cache state', () => {
    const line = formatPerfLine(buildPerfRecord(SAMPLE));
    expect(line.startsWith('[perf]')).toBe(true);
    expect(line).toContain('model=qwen3.5:9b');
    expect(line).toContain('mode=retrieval');
    expect(line).toContain('cache=warm');
    expect(line).toContain('source_tokens=15212');
    expect(line).toContain('prompt_tokens=4460');
    expect(line).toContain('ttft_ms=13789');
    expect(line).toContain('total_ms=14535');
    expect(line).not.toContain('\n');
  });

  it('shows a placeholder for unknown numbers instead of null/undefined', () => {
    const line = formatPerfLine(buildPerfRecord({ now: 'T', model: 'm', mode: 'fulltext', cache: 'cold' }));
    expect(line).toContain('prompt_tokens=?');
    expect(line).not.toContain('null');
    expect(line).not.toContain('undefined');
  });
});

describe('appendPerfJsonl', () => {
  it('writes exactly one JSON line terminated by a newline via the injected writer', () => {
    const writes = [];
    appendPerfJsonl(buildPerfRecord(SAMPLE), (chunk) => writes.push(chunk));
    expect(writes).toHaveLength(1);
    expect(writes[0].endsWith('\n')).toBe(true);
    const parsed = JSON.parse(writes[0]);
    expect(parsed.mode).toBe('retrieval');
    expect(parsed.ttftMs).toBe(13789);
  });
});

describe('isPerfJsonlEnabled', () => {
  it('is off by default and on only for a truthy switch', () => {
    expect(isPerfJsonlEnabled({})).toBe(false);
    expect(isPerfJsonlEnabled({ SYFLO_PERF_LOG: '' })).toBe(false);
    expect(isPerfJsonlEnabled({ SYFLO_PERF_LOG: '0' })).toBe(false);
    expect(isPerfJsonlEnabled({ SYFLO_PERF_LOG: 'false' })).toBe(false);
    expect(isPerfJsonlEnabled({ SYFLO_PERF_LOG: '1' })).toBe(true);
    expect(isPerfJsonlEnabled({ SYFLO_PERF_LOG: 'true' })).toBe(true);
  });
});
