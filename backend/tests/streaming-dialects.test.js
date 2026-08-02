/**
 * tests/streaming-dialects.test.js
 *
 * ADR-0008 slice 2: cloud providers stream reasoning in three dialects:
 *   1. `delta.reasoning`          (Ollama /v1, Groq gpt-oss)
 *   2. `delta.reasoning_content`  (some OpenAI-compatible gateways)
 *   3. inline `<think>…</think>`  in the content (e.g. Qwen via Groq)
 * All three must land in the reasoning channel and must NEVER show up in the
 * answer text or in the DB. Also: gateways without stream_options support
 * get a retry without the field.
 */

const { streamWithTools } = require('../tools');

/** Builds a fake OpenAI client that streams the given chunks. */
function fakeClient(chunkSets, { rejectStreamOptions = false } = {}) {
  let call = 0;
  const create = jest.fn(async (body) => {
    if (rejectStreamOptions && body.stream_options) {
      const err = new Error("Unknown parameter: 'stream_options'.");
      err.status = 400;
      throw err;
    }
    const chunks = chunkSets[Math.min(call, chunkSets.length - 1)];
    call++;
    return (async function* () {
      for (const c of chunks) yield c;
    })();
  });
  return { chat: { completions: { create } }, _create: create };
}

const text = (s) => ({ choices: [{ delta: { content: s } }] });
const done = () => ({ choices: [{ delta: {}, finish_reason: 'stop' }] });

async function run(client, opts = {}) {
  const out = { text: '', reasoning: '' };
  const final = await streamWithTools({
    client,
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
    onText: (t) => { out.text += t; },
    onReasoning: (r) => { out.reasoning += r; },
    ...opts,
  });
  return { ...out, final };
}

describe('reasoning dialects', () => {
  it('routes delta.reasoning_content to the reasoning channel', async () => {
    const client = fakeClient([[
      { choices: [{ delta: { reasoning_content: 'thinking…' } }] },
      text('Answer.'),
      done(),
    ]]);
    const r = await run(client);
    expect(r.reasoning).toBe('thinking…');
    expect(r.final).toBe('Answer.');
    expect(r.final).not.toMatch(/thinking/);
  });

  it('extracts inline <think> tags even when split across chunks', async () => {
    const client = fakeClient([[
      text('<thi'),
      text('nk>let me pon'),
      text('der</th'),
      text('ink>The answer is 42.'),
      done(),
    ]]);
    const r = await run(client);
    expect(r.reasoning).toBe('let me ponder');
    expect(r.final).toBe('The answer is 42.');
    expect(r.text).not.toMatch(/<think|ponder/);
  });

  it('leaves normal answers untouched when no think tags appear', async () => {
    const client = fakeClient([[text('Plain '), text('answer < 42.'), done()]]);
    const r = await run(client);
    expect(r.final).toBe('Plain answer < 42.');
    expect(r.reasoning).toBe('');
  });
});

describe('stream_options compatibility', () => {
  it('retries without stream_options when the gateway rejects it', async () => {
    const client = fakeClient([[text('OK.'), done()]], { rejectStreamOptions: true });
    const r = await run(client);
    expect(r.final).toBe('OK.');
    // First attempt with stream_options, second without.
    expect(client._create.mock.calls.length).toBe(2);
    expect(client._create.mock.calls[0][0].stream_options).toBeDefined();
    expect(client._create.mock.calls[1][0].stream_options).toBeUndefined();
  });
});

describe('blind 400 degradation (gemini alias models, 2026-07)', () => {
  it('retries without extras on an unclassifiable 400', async () => {
    let call = 0;
    const create = jest.fn(async (body) => {
      call++;
      if (body.reasoning_effort) {
        const err = new Error('Request contains an invalid argument.');
        err.status = 400;
        throw err;
      }
      return (async function* () {
        yield { choices: [{ delta: { content: 'OK.' } }] };
        yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
      })();
    });
    const client = { chat: { completions: { create } } };

    let out = '';
    const final = await streamWithTools({
      client, model: 'gemini-flash-latest',
      messages: [{ role: 'user', content: 'hi' }],
      extras: { reasoning_effort: 'none' },
      onText: (t) => { out += t; },
    });
    expect(final).toBe('OK.');
    expect(create.mock.calls[0][0].reasoning_effort).toBe('none');
    expect(create.mock.calls[1][0].reasoning_effort).toBeUndefined();
  });
});

describe('cumulative usage chunks (Gemini dialect)', () => {
  it('does not overcount completion tokens when every chunk carries running totals', async () => {
    const chunks = [
      { choices: [{ delta: { content: 'a' } }], usage: { prompt_tokens: 100, completion_tokens: 1 } },
      { choices: [{ delta: { content: 'b' } }], usage: { prompt_tokens: 100, completion_tokens: 2 } },
      { choices: [{ delta: { content: 'c' } }], usage: { prompt_tokens: 100, completion_tokens: 3 } },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 3 } },
    ];
    const client = { chat: { completions: { create: jest.fn(async () => (async function* () {
      for (const c of chunks) yield c;
    })()) } } };

    let perf = null;
    await streamWithTools({
      client, model: 'gemini-flash-latest',
      messages: [{ role: 'user', content: 'hi' }],
      onText: () => {},
      onPerf: (p) => { perf = p; },
    });
    // Kumulativ gemeldete Zwischenstände dürfen nicht aufsummiert werden:
    // 1+2+3+3=9 wäre falsch — die Antwort hat 3 Tokens.
    expect(perf.completionTokens).toBe(3);
    expect(perf.promptTokens).toBe(100);
  });
});

describe('gemini 3 tool-call dialect (live incident 2026-07-26)', () => {
  // Gemini 3's OpenAI layer streams tool calls with finish_reason 'stop'
  // (not 'tool_calls') and attaches a thought_signature as extra_content
  // that MUST be echoed back — otherwise round 2 fails with a 400.
  const geminiToolCallChunk = () => ({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'tc1',
          type: 'function',
          function: { name: 'bogus_tool', arguments: '{"query":"x"}' },
          extra_content: { google: { thought_signature: 'sig123' } },
        }],
      },
      finish_reason: 'stop',
    }],
  });

  it('runs the tool round despite finish_reason "stop" and echoes the thought_signature', async () => {
    const client = fakeClient([
      [geminiToolCallChunk()],
      [text('Final answer.'), done()],
    ]);
    const r = await run(client, { onToolEvent: () => {} });

    // The old finish_reason gate ended the loop here with an empty answer.
    expect(r.final).toBe('Final answer.');
    expect(client._create.mock.calls.length).toBe(2);

    const round2 = client._create.mock.calls[1][0].messages;
    const assistantMsg = round2.find((m) => m.tool_calls);
    expect(assistantMsg.tool_calls[0].extra_content).toEqual({ google: { thought_signature: 'sig123' } });
    // Unknown tool → error payload as tool message; the loop must still
    // answer one tool message per tool_call.
    const toolMsg = round2.find((m) => m.role === 'tool');
    expect(toolMsg.tool_call_id).toBe('tc1');
  });
});

describe('finish_reason telemetry (truncated answer, live incident 2026-07-26)', () => {
  // A provider-side truncation (Gemini: MAX_TOKENS / RECITATION / safety)
  // ends the stream cleanly from the client's point of view — the only
  // witness is finish_reason. It must reach onPerf so the [perf] line and
  // the SSE perf event can flag the answer as cut off.
  const finishWith = (reason) => ({ choices: [{ delta: {}, finish_reason: reason }] });

  async function perfOf(chunks) {
    let perf = null;
    const client = fakeClient([chunks]);
    await run(client, { onPerf: (p) => { perf = p; } });
    return perf;
  }

  it('reports finishReason "stop" for a clean end', async () => {
    const perf = await perfOf([text('Complete answer.'), finishWith('stop')]);
    expect(perf.finishReason).toBe('stop');
  });

  it('reports finishReason "length" when the provider cuts the answer', async () => {
    const perf = await perfOf([text('Truncated ans'), finishWith('length')]);
    expect(perf.finishReason).toBe('length');
  });

  it('reports finishReason null when the stream ends without a finish chunk', async () => {
    const perf = await perfOf([text('Cut by the network')]);
    expect(perf.finishReason).toBeNull();
  });
});
