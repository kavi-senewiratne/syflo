/**
 * tests/perf-log.test.js
 *
 * Latenz-Instrumentierung (2026-07-24): pro Antwort eine erweiterte [perf]-
 * Zeile plus — hinter einem Schalter — eine auswertbare perf.jsonl. Reine
 * Metriken, NIE Gesprächsinhalte; nichts landet in der Datenbank.
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
    });
  });

  it('NEVER copies conversation content, even if handed some', () => {
    // Datenschutz-Garantie: die Funktion baut den Datensatz aus einer festen
    // Feldliste — beliebige Zusatzfelder (Frage, Antwort) dürfen nie durchsickern.
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
