/**
 * perf-log.js
 *
 * Latenz-Instrumentierung pro Antwort (2026-07-24). Zwei Ausgaben, beide
 * reine Metriken — NIE Gesprächsinhalte, nichts in der Datenbank:
 *   - formatPerfLine: die erweiterte [perf]-Zeile fürs backend.log (immer)
 *   - appendPerfJsonl: eine JSON-Zeile pro Antwort in logs/perf.jsonl,
 *     nur wenn SYFLO_PERF_LOG gesetzt ist (mit `jq` auswertbar)
 *
 * Die Datenschutz-Garantie lebt in buildPerfRecord: der Datensatz wird aus
 * einer FESTEN Feldliste gebaut, nie per Spread — so kann kein Frage-/
 * Antworttext durchsickern, egal was der Aufrufer mitgibt.
 */

const fs = require('fs');
const path = require('path');

// Aus dem rohen (potenziell inhaltshaltigen) Eingabeobjekt exakt die
// erlaubten Metrik-Felder herausziehen. Alles andere fällt weg.
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
  };
}

function formatPerfLine(r) {
  const v = (x) => (x === null || x === undefined ? '?' : x);
  return (
    `[perf] model=${v(r.model)} mode=${v(r.mode)} cache=${v(r.cache)} ` +
    `source_tokens=${v(r.sourceTokens)} chunks=${v(r.chunkCount)} ` +
    `prompt_tokens=${v(r.promptTokens)} ttft_ms=${v(r.ttftMs)} ` +
    `gen_tokens=${v(r.genTokens)} tok_s=${v(r.tokS)} total_ms=${v(r.totalMs)}`
  );
}

// Eine JSON-Zeile über den injizierten Writer (Default: an logs/perf.jsonl
// anhängen). writeFn injizierbar für Tests.
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
    /* Logging darf die Antwort nie gefährden */
  }
}

// Schalter: die JSON-Datei läuft nur, wenn ausdrücklich eingeschaltet
// (sie wächst pro Nachricht). '0'/'false'/'' zählen als aus.
function isPerfJsonlEnabled(env = process.env) {
  const v = (env.SYFLO_PERF_LOG || '').toString().trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false';
}

module.exports = { buildPerfRecord, formatPerfLine, appendPerfJsonl, isPerfJsonlEnabled };
