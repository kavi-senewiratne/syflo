#!/usr/bin/env node
/**
 * scripts/bench-local-models.js — the 16 GB rung bench (grill 2026-10-27,
 * decision 11): quality first, speed as the tie-breaker.
 *
 * For each candidate model, against the running backend and a real Ollama:
 *   1. a fresh chat with the SAME paper (uploaded from --pdf),
 *   2. a prefix warm-up (cold prefill of the paper → prefill tok/s),
 *   3. three probes:
 *      - OCR:    an image of a figure page (--figure) — "transcribe the labels"
 *      - second half: a question whose answer sits in the paper's back half
 *      - tool:   a web search request (runs only when a search key is set —
 *                without one the probe is reported as skipped, never faked)
 *   4. per answer: TTFT, decode tok/s, prompt tokens (from the perf event).
 *
 * Nothing here judges the answers — they are printed for the human to grade
 * against the expected facts (--expect lines). The model setting is restored
 * at the end; the bench chats stay in the sidebar for inspection.
 *
 * Usage:
 *   node scripts/bench-local-models.js --pdf attention.pdf --figure fig-03.png \
 *     --models qwen3.5:9b,gemma4:12b
 */

const fs = require('fs');
const path = require('path');

const BASE = process.env.SYFLO_API || 'http://localhost:3001/api';

function parseArgs(argv) {
  const args = { models: ['qwen3.5:9b', 'gemma4:12b'], pdf: null, figure: null, think: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--models') args.models = argv[++i].split(',');
    else if (a === '--pdf') args.pdf = argv[++i];
    else if (a === '--figure') args.figure = argv[++i];
    else if (a === '--think') args.think = true;
  }
  if (!args.pdf) throw new Error('--pdf <file> is required');
  return args;
}

const PROBES = [
  {
    id: 'ocr',
    needs: 'figure',
    prompt: 'Look only at the attached image. List the labeled boxes of the LEFT stack of the diagram, from bottom to top, exactly as written. One label per line, nothing else.',
    expect: 'Input Embedding, Multi-Head Attention, Add & Norm, Feed Forward, Add & Norm (Figure 1, encoder side)',
  },
  {
    id: 'second-half',
    prompt: 'According to Table 2 of the paper, which BLEU score does the big Transformer model reach on the WMT 2014 English-to-German task, and what is its training cost in FLOPs? Answer in one sentence with the numbers.',
    expect: '28.4 BLEU, 2.3e19 FLOPs',
  },
  {
    id: 'tool',
    needs: 'search',
    prompt: 'Search the web for the latest released version number of Ollama and reply with only that version number.',
    expect: 'a web_search tool event, then a version like 0.40.x',
  },
];

async function json(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${body.error || ''}`);
  return body;
}

async function createChatWithPaper(pdfPath, title) {
  const chat = await json(await fetch(`${BASE}/chats`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
  }));
  const form = new FormData();
  form.append('chat_id', chat.id);
  form.append('pdf', new Blob([fs.readFileSync(pdfPath)], { type: 'application/pdf' }), path.basename(pdfPath));
  await json(await fetch(`${BASE}/papers`, { method: 'POST', body: form }));
  return chat.id;
}

async function warmup(chatId) {
  const t = Date.now();
  const body = await json(await fetch(`${BASE}/chats/${chatId}/messages/warmup`, { method: 'POST' }));
  return { ms: Date.now() - t, ...body };
}

// Sends one probe (multipart when an image rides along) and reads the SSE
// stream: first token time, tool events, perf event, the answer text.
async function ask(chatId, prompt, { think, imagePath } = {}) {
  const started = Date.now();
  let res;
  if (imagePath) {
    const form = new FormData();
    form.append('content', prompt);
    form.append('think', String(Boolean(think)));
    form.append('files', new Blob([fs.readFileSync(imagePath)], { type: 'image/png' }), path.basename(imagePath));
    res = await fetch(`${BASE}/chats/${chatId}/messages`, { method: 'POST', body: form });
  } else {
    res = await fetch(`${BASE}/chats/${chatId}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: prompt, think }),
    });
  }
  if (!res.ok) throw new Error(`send failed: HTTP ${res.status} ${await res.text()}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ttftMs = null;
  let perf = null;
  let text = '';
  const tools = [];
  let error = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      let data;
      try { data = JSON.parse(line.slice(6)); } catch { continue; }
      if (data.error) error = data.error;
      if ((data.delta || data.reasoning) && ttftMs === null) ttftMs = Date.now() - started;
      if (data.delta) text += data.delta;
      if (data.tool) tools.push(data.tool);
      if (data.perf) perf = data.perf;
    }
  }
  return { ttftMs, totalMs: Date.now() - started, text: text.trim(), tools, perf, error };
}

function fmt(v, suffix = '') {
  return v === null || v === undefined ? '—' : `${v}${suffix}`;
}

async function main() {
  const args = parseArgs(process.argv);
  const settings = await json(await fetch(`${BASE}/settings`));
  const searchKey = Boolean(settings.tavily_api_key_set);
  const original = { llm_provider: settings.llm_provider, ollama_model: settings.ollama_model };
  console.log(`Backend ${BASE} · models ${args.models.join(', ')} · thinking ${args.think ? 'on' : 'off'} · search key ${searchKey ? 'set' : 'NOT set (tool probe skipped)'}\n`);

  const results = [];
  try {
    for (const model of args.models) {
      await json(await fetch(`${BASE}/settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ llm_provider: 'ollama', ollama_model: model }),
      }));
      const chatId = await createChatWithPaper(args.pdf, `Bench ${model}`);
      console.log(`=== ${model} · chat ${chatId}`);
      const w = await warmup(chatId);
      console.log(`warm-up (cold prefill of the paper): ${w.ms} ms · warmed=${w.warmed}${w.reason ? ` (${w.reason})` : ''}`);
      const row = { model, warmupMs: w.ms, probes: {} };
      for (const probe of PROBES) {
        if (probe.needs === 'figure' && !args.figure) { row.probes[probe.id] = { skipped: 'no --figure' }; continue; }
        if (probe.needs === 'search' && !searchKey) { row.probes[probe.id] = { skipped: 'no search key' }; continue; }
        const r = await ask(chatId, probe.prompt, { think: args.think, imagePath: probe.needs === 'figure' ? args.figure : undefined });
        row.probes[probe.id] = r;
        console.log(`\n--- ${probe.id} · expect: ${probe.expect}`);
        console.log(`ttft ${fmt(r.ttftMs, ' ms')} · total ${r.totalMs} ms · prompt ${fmt(r.perf && r.perf.promptTokens)} tok · gen ${fmt(r.perf && r.perf.completionTokens)} tok · ${fmt(r.perf && r.perf.tokensPerSecond, ' tok/s')}${r.tools.length ? ` · tools: ${r.tools.map((t) => t.name || t.status || JSON.stringify(t)).join(', ')}` : ''}`);
        if (r.error) console.log(`ERROR: ${r.error}`);
        console.log(r.text.split('\n').slice(0, 12).map((l) => `  | ${l}`).join('\n'));
      }
      results.push(row);
      console.log('');
    }
  } finally {
    await fetch(`${BASE}/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(original),
    }).catch(() => {});
  }

  console.log('=== summary (speed; quality is graded by hand above)');
  console.log('model            warm-up   ocr ttft/tok·s     second-half ttft/tok·s');
  for (const r of results) {
    const p = (id) => {
      const x = r.probes[id];
      if (!x || x.skipped) return 'skipped'.padEnd(18);
      return `${fmt(x.ttftMs)} ms / ${fmt(x.perf && x.perf.tokensPerSecond)}`.padEnd(18);
    };
    console.log(`${r.model.padEnd(16)} ${String(r.warmupMs).padStart(6)} ms  ${p('ocr')} ${p('second-half')}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
