/**
 * perf-log.js
 *
 * Latency instrumentation per response (2026-07-24). Two outputs, both
 * pure metrics — NEVER conversation content, nothing in the database:
 *   - formatPerfLine: the extended [perf] line for backend.log (always)
 *   - appendPerfJsonl: one JSON line per response in logs/perf.jsonl,
 *     only when SYFLO_PERF_LOG is set (analyzable with `jq`)
 *
 * The privacy guarantee lives in buildPerfRecord: the record is built from
 * a FIXED field list, never via spread — so no question/answer text can
 * leak through, no matter what the caller passes in.
 */

const fs = require('fs');
const path = require('path');

// Pull exactly the allowed metric fields out of the raw (potentially
// content-bearing) input object. Everything else is dropped.
function buildPerfRecord(input = {}) {
  const num = (v) => (typeof v === 'number' ? v : null);
  const str = (v) => (typeof v === 'string' && v ? v : null);
  return {
    ts: str(input.now),
    chatId: str(input.chatId),
    model: str(input.model),
    mode: str(input.mode), // 'fulltext' | 'retrieval' | 'none'
    cache: str(input.cache), // 'cold' | 'warm'
    sourceTokens: num(input.sourceTokens),
    chunkCount: num(input.chunkCount),
    promptTokens: num(input.promptTokens),
    ttftMs: num(input.ttftMs),
    genTokens: num(input.completionTokens),
    tokS: num(input.tokensPerSecond),
    totalMs: num(input.totalMs),
    // Provider's finish_reason for the final answer round: 'stop' is clean,
    // 'length'/'content_filter'/null flag a truncated answer (2026-07-26).
    finish: str(input.finishReason),
  };
}

function formatPerfLine(r) {
  const v = (x) => (x === null || x === undefined ? '?' : x);
  return (
    `[perf] model=${v(r.model)} mode=${v(r.mode)} cache=${v(r.cache)} ` +
    `source_tokens=${v(r.sourceTokens)} chunks=${v(r.chunkCount)} ` +
    `prompt_tokens=${v(r.promptTokens)} ttft_ms=${v(r.ttftMs)} ` +
    `gen_tokens=${v(r.genTokens)} tok_s=${v(r.tokS)} total_ms=${v(r.totalMs)} ` +
    `finish=${v(r.finish)}`
  );
}

// One JSON line via the injected writer (default: append to
// logs/perf.jsonl). writeFn is injectable for tests.
function appendPerfJsonl(record, writeFn) {
  const line = `${JSON.stringify(record)}\n`;
  if (writeFn) {
    writeFn(line);
    return;
  }
  const file = path.join(__dirname, 'logs', 'perf.jsonl');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line);
  } catch (_) {
    /* Logging must never endanger the response */
  }
}

// Switch: the JSON file only runs when explicitly enabled
// (it grows per message). '0'/'false'/'' count as off.
function isPerfJsonlEnabled(env = process.env) {
  const v = (env.SYFLO_PERF_LOG || '').toString().trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false';
}

module.exports = { buildPerfRecord, formatPerfLine, appendPerfJsonl, isPerfJsonlEnabled };
