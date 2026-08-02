#!/usr/bin/env node
/**
 * scripts/benchmark.js — latency benchmark against the running backend.
 *
 * Measures per run what the user actually feels:
 *   - warmup_ms:  duration of the prefix warm-up (prefill of the paper context)
 *   - ttft_ms:    time to the first visible token (client view)
 *   - perf event: prompt_tokens / gen_tokens / tok_s from the backend
 *
 * The first run after an Ollama (re)start is the cold case; all further
 * runs hit the warm KV cache. For true cold measurements, restart Ollama
 * between runs.
 *
 * Usage:
 *   node scripts/benchmark.js                       # fresh throwaway chat
 *   node scripts/benchmark.js --chat <id>           # existing chat (e.g. with a paper)
 *   node scripts/benchmark.js --runs 5 --think      # 5 runs, thinking on
 *   node scripts/benchmark.js --prompt "Summarize the paper"
 */

const BASE = process.env.SYFLO_API || 'http://localhost:3001/api';

function parseArgs(argv) {
  const args = { runs: 3, think: false, chat: null, prompt: 'Reply with one short sentence about the main topic of this conversation.' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs') args.runs = parseInt(argv[++i], 10) || 3;
    else if (a === '--think') args.think = true;
    else if (a === '--chat') args.chat = argv[++i];
    else if (a === '--prompt') args.prompt = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/benchmark.js [--chat <id>] [--runs N] [--think] [--prompt "..."]');
      process.exit(0);
    }
  }
  return args;
}

// An SSE stream as delivered by POST /chats/:id/messages: measures the time
// to the first delta/reasoning event and collects the perf event.
async function sendAndMeasure(chatId, prompt, think) {
  const startedAt = Date.now();
  const res = await fetch(`${BASE}/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: prompt, think }),
  });
  if (!res.ok) throw new Error(`send failed: HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ttftMs = null;
  let perf = null;
  let chars = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = JSON.parse(line.slice(6));
      if (data.error) throw new Error(data.error);
      if ((data.delta || data.reasoning) && ttftMs === null) ttftMs = Date.now() - startedAt;
      if (data.delta) chars += data.delta.length;
      if (data.perf) perf = data.perf;
    }
  }
  return { ttftMs, totalMs: Date.now() - startedAt, chars, perf };
}

async function warmup(chatId) {
  const startedAt = Date.now();
  const res = await fetch(`${BASE}/chats/${chatId}/messages/warmup`, { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  return { ms: Date.now() - startedAt, ...body };
}

function fmt(v, suffix = '') {
  return v === null || v === undefined ? '—' : `${v}${suffix}`;
}

async function main() {
  const args = parseArgs(process.argv);

  let chatId = args.chat;
  let createdChat = false;
  if (!chatId) {
    const res = await fetch(`${BASE}/chats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Benchmark' }),
    });
    if (!res.ok) throw new Error(`could not create chat: HTTP ${res.status}`);
    chatId = (await res.json()).id;
    createdChat = true;
    console.log(`Throwaway chat created: ${chatId} (tip: --chat <id> for a real paper chat)`);
  }

  console.log(`Backend: ${BASE} | Chat: ${chatId} | Runs: ${args.runs} | Thinking: ${args.think ? 'on' : 'off'}`);
  console.log('Note: run 1 pays the prefill (cold), from run 2 on the KV cache should kick in.\n');

  const rows = [];
  try {
    for (let run = 1; run <= args.runs; run++) {
      const w = await warmup(chatId);
      if (w.gpu && w.gpu.vramPercent < 100) {
        console.warn(`WARNING: model only ${w.gpu.vramPercent}% in GPU memory — CPU offloading!`);
      }
      const m = await sendAndMeasure(chatId, args.prompt, args.think);
      rows.push({
        run,
        'warmup_ms': w.ms,
        'ttft_ms': m.ttftMs,
        'total_ms': m.totalMs,
        'prompt_tokens': m.perf ? fmt(m.perf.promptTokens) : '—',
        'gen_tokens': m.perf ? fmt(m.perf.completionTokens) : '—',
        'tok_s': m.perf ? fmt(m.perf.tokensPerSecond) : '—',
      });
      console.log(`Run ${run}: warmup ${w.ms} ms | TTFT ${fmt(m.ttftMs, ' ms')} | total ${m.totalMs} ms`);
    }
  } finally {
    if (createdChat) {
      await fetch(`${BASE}/chats/${chatId}`, { method: 'DELETE' }).catch(() => {});
    }
  }

  console.log('');
  console.table(rows);

  const ttfts = rows.map(r => r.ttft_ms).filter(v => typeof v === 'number');
  if (ttfts.length > 1) {
    const cold = ttfts[0];
    const warm = Math.round(ttfts.slice(1).reduce((a, b) => a + b, 0) / (ttfts.length - 1));
    console.log(`TTFT cold (run 1): ${cold} ms | TTFT warm (avg run 2+): ${warm} ms`);
    if (warm > cold * 0.8) {
      console.log('Warm barely faster than cold? Then the KV cache is not kicking in — check [perf] warnings in the backend log.');
    }
  }
}

main().catch(err => {
  console.error(`Benchmark failed: ${err.message}`);
  process.exit(1);
});
