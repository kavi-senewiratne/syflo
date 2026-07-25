#!/usr/bin/env node
// Phase A benchmark: Ollama reference vs llama-server with slot save/restore.
// Usage: node phaseA.mjs ollama | llama | tools-check
import { readFileSync, writeFileSync, appendFileSync, statSync, mkdirSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';

const SP = '/private/tmp/claude-502/-Users-kavisenewiratne/bba4c5e2-3ecc-46a5-bc8b-3df586448067/scratchpad';
const SLOT_DIR = `${SP}/slots`;
const RESULTS = `${SP}/results.jsonl`;
// Ollama's blob is NOT loadable by vanilla llama.cpp (qwen35.rope.dimension_sections: 3 vs 4)
// -> standard-conformant GGUF from unsloth, same Q4_K_M quant, language part only (no mmproj).
const BLOB = `${'/private/tmp/claude-502/-Users-kavisenewiratne/bba4c5e2-3ecc-46a5-bc8b-3df586448067/scratchpad'}/Qwen3.5-9B-Q4_K_M.gguf`;
const LLAMA_PORT = 8091;
const LLAMA_BASE = `http://127.0.0.1:${LLAMA_PORT}`;
const OLLAMA_BASE = 'http://127.0.0.1:11434';
const MODEL_OLLAMA = 'qwen3.5:9b';
const MAX_TOKENS = 512; // safety net only; "answer briefly" prompts + EOS end answers naturally

const paper = readFileSync(`${SP}/bengio.txt`, 'utf8');
const SYS = `You are a helpful research assistant. Answer questions about the provided paper accurately and concisely, based only on the paper text.\n\n--- PAPER TEXT START ---\n${paper}\n--- PAPER TEXT END ---`;

const Q = {
  A1: 'What is the core idea of this paper, and what problem does it try to solve? Answer in 3-4 sentences.',
  A2: 'Explain how the model fights the curse of dimensionality. Answer briefly.',
  A3: 'How does the proposed model share statistical strength between similar words? Answer briefly.',
  A4: 'According to the experiments, by how much did the neural model improve test perplexity over the best n-gram baseline? Include the actual numbers.',
  B1: 'Describe the parallel implementation the authors used to speed up training. Which hardware was used and how was the work partitioned?',
  B2: 'What were the main results on the Brown corpus? Include perplexity numbers from the tables.',
  B3: 'What future research directions do the authors propose in the conclusion? Answer briefly.',
};

function log(rec) {
  const line = JSON.stringify(rec);
  appendFileSync(RESULTS, line + '\n');
  const { text, ...rest } = rec;
  console.log(JSON.stringify(rest));
}

async function ask(base, model, messages, opts = {}) {
  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: MAX_TOKENS,
    temperature: 0,
    reasoning_effort: 'none',
    ...opts.extra,
  };
  if (opts.cachePrompt === false) body.cache_prompt = false;
  if (opts.noThink) body.chat_template_kwargs = { enable_thinking: false };
  const t0 = performance.now();
  let firstTok = null;
  let firstAny = null;
  let reasoningChars = 0;
  let text = '';
  let usage = null;
  let timings = null;
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6);
      if (payload === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      const delta = obj.choices?.[0]?.delta;
      const rc = delta?.reasoning_content ?? delta?.reasoning;
      if (rc) {
        if (firstAny === null) firstAny = performance.now();
        reasoningChars += rc.length;
      }
      if (delta?.content) {
        if (firstTok === null) firstTok = performance.now();
        if (firstAny === null) firstAny = performance.now();
        text += delta.content;
      }
      if (obj.usage) usage = obj.usage;
      if (obj.timings) timings = obj.timings;
    }
  }
  const t1 = performance.now();
  return {
    ttft_s: firstTok ? +((firstTok - t0) / 1000).toFixed(2) : null,
    ttft_any_s: firstAny ? +((firstAny - t0) / 1000).toFixed(2) : null,
    reasoning_chars: reasoningChars,
    total_s: +((t1 - t0) / 1000).toFixed(2),
    prompt_tokens: usage?.prompt_tokens ?? null,
    completion_tokens: usage?.completion_tokens ?? null,
    cache_n: timings?.cache_n ?? null,
    prompt_ms: timings?.prompt_ms ?? null,
    text,
  };
}

async function slot(action, filename) {
  const t0 = performance.now();
  const res = await fetch(`${LLAMA_BASE}/slots/0?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename }),
    signal: AbortSignal.timeout(120000),
  });
  const bodyText = await res.text();
  const dur = +((performance.now() - t0) / 1000).toFixed(2);
  if (!res.ok) throw new Error(`slot ${action} HTTP ${res.status}: ${bodyText}`);
  return { dur_s: dur, resp: JSON.parse(bodyText) };
}

function msgs(history, q) {
  return [{ role: 'system', content: SYS }, ...history, { role: 'user', content: q }];
}

async function runQ(base, model, backend, scenario, history, qKey, opts = {}) {
  process.stderr.write(`[${backend}] ${scenario} ${qKey} ...\n`);
  if (backend === 'llama') opts = { noThink: true, ...opts };
  const r = await ask(base, model, msgs(history, Q[qKey]), opts);
  log({ backend, scenario, q: qKey, ...r });
  history.push({ role: 'user', content: Q[qKey] }, { role: 'assistant', content: r.text });
  return r;
}

// ---------- llama-server lifecycle ----------
let serverProc = null;
async function startServer() {
  mkdirSync(SLOT_DIR, { recursive: true });
  const args = ['-m', BLOB, '--alias', 'qwen3.5-9b', '-c', '32768', '-ngl', '99',
    '-b', '2048', '-ub', '1024', '--parallel', '1', '--slots',
    '--slot-save-path', SLOT_DIR, '--jinja', '--reasoning-budget', '0',
    '--port', String(LLAMA_PORT), '--host', '127.0.0.1'];
  const t0 = performance.now();
  serverProc = spawn('llama-server', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const logStream = [];
  serverProc.stdout.on('data', d => logStream.push(d));
  serverProc.stderr.on('data', d => logStream.push(d));
  serverProc.on('exit', code => {
    writeFileSync(`${SP}/llama-server.log`, Buffer.concat(logStream));
    if (code !== null && code !== 0) console.error(`llama-server exited with ${code}`);
  });
  for (let i = 0; i < 360; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const res = await fetch(`${LLAMA_BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const load_s = +((performance.now() - t0) / 1000).toFixed(2);
        writeFileSync(`${SP}/llama-server.log`, Buffer.concat(logStream));
        return load_s;
      }
    } catch { /* not up yet */ }
    if (serverProc.exitCode !== null) throw new Error('llama-server died during startup — see llama-server.log');
  }
  throw new Error('llama-server health timeout');
}
async function stopServer() {
  if (!serverProc) return;
  const p = serverProc;
  serverProc = null;
  p.kill('SIGTERM');
  await new Promise(r => { p.on('exit', r); setTimeout(r, 10000); });
}

// ---------- suites ----------
async function ollamaSuite() {
  const A = [];
  // S1 cold: model may be loaded, but this prompt is new -> full prefill
  await runQ(OLLAMA_BASE, MODEL_OLLAMA, 'ollama', 'S1-cold', A, 'A1');
  // S2 warm follow-ups
  await runQ(OLLAMA_BASE, MODEL_OLLAMA, 'ollama', 'S2-warm', A, 'A2');
  // S3 branch switch: B shares system+paper+A1 exchange as prefix
  const B = A.slice(0, 2); // copy of [A1 q, A1 answer]
  const Bhist = [...B];
  await runQ(OLLAMA_BASE, MODEL_OLLAMA, 'ollama', 'S3-branchB', Bhist, 'B1');
  await runQ(OLLAMA_BASE, MODEL_OLLAMA, 'ollama', 'S3-branchB-warm', Bhist, 'B2');
  // back to branch A
  await runQ(OLLAMA_BASE, MODEL_OLLAMA, 'ollama', 'S3-backToA', A, 'A3');
  // S4 restart equivalent: unload model, ask again on A
  process.stderr.write('[ollama] stopping model (restart simulation)...\n');
  execSync(`ollama stop ${MODEL_OLLAMA}`, { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 3000));
  await runQ(OLLAMA_BASE, MODEL_OLLAMA, 'ollama', 'S4-restart', A, 'A4');
  execSync(`ollama stop ${MODEL_OLLAMA}`, { stdio: 'ignore' });
  console.error('ollama suite done; model unloaded.');
}

async function llamaSuite() {
  try { execSync(`ollama stop ${MODEL_OLLAMA}`, { stdio: 'ignore' }); } catch {}
  let load_s = await startServer();
  log({ backend: 'llama', scenario: 'server-load', load_s });
  const A = [];
  // S1 cold (first request ever)
  await runQ(LLAMA_BASE, 'qwen3.5-9b', 'llama', 'S1-cold', A, 'A1');
  // S1 repeats: force full re-prefill without restart
  const coldHist = [];
  for (const n of [2]) {
    const r = await ask(LLAMA_BASE, 'qwen3.5-9b', msgs(coldHist, Q.A1), { cachePrompt: false, noThink: true });
    log({ backend: 'llama', scenario: `S1-cold-r${n}`, q: 'A1', ...r });
  }
  // Re-warm the A path (cache now holds sys+paper+A1 from the cache_prompt:false run too)
  // S2 warm follow-up
  await runQ(LLAMA_BASE, 'qwen3.5-9b', 'llama', 'S2-warm', A, 'A2');
  // save branch A state
  const saveA = await slot('save', 'slotA.bin');
  log({ backend: 'llama', scenario: 'saveA', ...saveA.resp, dur_s: saveA.dur_s });
  // S3 branch B (shares sys+paper+A1 prefix)
  const Bhist = A.slice(0, 2);
  await runQ(LLAMA_BASE, 'qwen3.5-9b', 'llama', 'S3-branchB', Bhist, 'B1');
  await runQ(LLAMA_BASE, 'qwen3.5-9b', 'llama', 'S3-branchB-warm', Bhist, 'B2');
  const saveB = await slot('save', 'slotB.bin');
  log({ backend: 'llama', scenario: 'saveB', ...saveB.resp, dur_s: saveB.dur_s });
  // back to A via restore
  const restA = await slot('restore', 'slotA.bin');
  log({ backend: 'llama', scenario: 'restoreA', ...restA.resp, dur_s: restA.dur_s });
  await runQ(LLAMA_BASE, 'qwen3.5-9b', 'llama', 'S3-backToA-restored', A, 'A3');
  // S4 full server restart + restore
  process.stderr.write('[llama] killing server (restart simulation)...\n');
  await stopServer();
  load_s = await startServer();
  log({ backend: 'llama', scenario: 'server-reload', load_s });
  const restA2 = await slot('restore', 'slotA.bin');
  log({ backend: 'llama', scenario: 'S4-restoreA-afterRestart', ...restA2.resp, dur_s: restA2.dur_s });
  await runQ(LLAMA_BASE, 'qwen3.5-9b', 'llama', 'S4-restart', A, 'A4');
  // S5 eviction equivalent: switch to B via restore
  const restB = await slot('restore', 'slotB.bin');
  log({ backend: 'llama', scenario: 'S5-restoreB', ...restB.resp, dur_s: restB.dur_s });
  await runQ(LLAMA_BASE, 'qwen3.5-9b', 'llama', 'S5-afterRestoreB', Bhist, 'B3');
  // slot file sizes
  for (const f of ['slotA.bin', 'slotB.bin']) {
    try { log({ backend: 'llama', scenario: 'slot-file', file: f, mb: +(statSync(`${SLOT_DIR}/${f}`).size / 1e6).toFixed(1) }); } catch {}
  }
  await stopServer();
  console.error('llama suite done; server stopped.');
}

async function toolsCheck() {
  try { execSync(`ollama stop ${MODEL_OLLAMA}`, { stdio: 'ignore' }); } catch {}
  await startServer();
  const tools = [{
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for up-to-date information.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  }];
  const r = await ask(LLAMA_BASE, 'qwen3.5-9b', msgs([], 'What is the title of this paper? Do not use tools.'), { extra: { tools } });
  log({ backend: 'llama', scenario: 'tools-check', q: 'title', ...r });
  await stopServer();
  console.error('tools check done.');
}

async function rawAsk(prompt, label) {
  const t0 = performance.now();
  const res = await fetch(`${LLAMA_BASE}/completion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, cache_prompt: true, n_predict: 120, temperature: 0 }),
    signal: AbortSignal.timeout(600000),
  });
  if (!res.ok) throw new Error(`raw HTTP ${res.status}: ${await res.text()}`);
  const j = await res.json();
  const total_s = +((performance.now() - t0) / 1000).toFixed(2);
  log({ backend: 'llama', scenario: label, total_s, cache_n: j.timings?.cache_n ?? j.tokens_cached ?? null,
    prompt_ms: j.timings?.prompt_ms, prompt_n: j.timings?.prompt_n, text: (j.content || '').slice(0, 200) });
  return j;
}

async function applyTemplate(messages) {
  const res = await fetch(`${LLAMA_BASE}/apply-template`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, chat_template_kwargs: { enable_thinking: false } }),
  });
  if (!res.ok) throw new Error(`apply-template HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()).prompt;
}

async function probe() {
  try { execSync(`ollama stop ${MODEL_OLLAMA}`, { stdio: 'ignore' }); } catch {}
  await startServer();
  const H = [];
  // cold prefill A1
  await runQ(LLAMA_BASE, 'qwen3.5-9b', 'llama', 'probe-cold', H, 'A1');
  const s = await slot('save', 'slotP.bin');
  log({ backend: 'llama', scenario: 'probe-save', ...s.resp, dur_s: s.dur_s });
  // T1: restore immediately (server still running, state identical) -> chat API
  const r1 = await slot('restore', 'slotP.bin');
  log({ backend: 'llama', scenario: 'probe-restore-immediate', dur_s: r1.dur_s });
  await runQ(LLAMA_BASE, 'qwen3.5-9b', 'llama', 'T1-chat-after-immediate-restore', [...H], 'A2');
  // T2: live control (no restore) — should be warm
  await runQ(LLAMA_BASE, 'qwen3.5-9b', 'llama', 'T2-chat-live-control', [...H], 'A3');
  // T3: raw completion, byte-exact continuation, after restore + server RESTART
  await stopServer();
  await startServer();
  const r2 = await slot('restore', 'slotP.bin');
  log({ backend: 'llama', scenario: 'probe-restore-after-restart', dur_s: r2.dur_s });
  const rawPrompt = await applyTemplate(msgs(H, Q.A4));
  await rawAsk(rawPrompt, 'T3-raw-after-restart-restore');
  // T4: chat API right after (state now = end of T3) — control
  await runQ(LLAMA_BASE, 'qwen3.5-9b', 'llama', 'T4-chat-after-raw', [...H], 'A4');
  await stopServer();
  console.error('probe done.');
}

const mode = process.argv[2];
const main = { ollama: ollamaSuite, llama: llamaSuite, 'tools-check': toolsCheck, probe }[mode];
if (!main) { console.error('usage: node phaseA.mjs ollama|llama|tools-check'); process.exit(1); }
main().catch(async e => { console.error('FATAL:', e.message); await stopServer(); process.exit(1); });
