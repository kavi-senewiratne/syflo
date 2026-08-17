/**
 * tools.js
 *
 * LLM tools the model can call during a chat completion call.
 * Currently: `web_search` via local SearXNG.
 *
 * Streaming tool-use flow (OpenAI-compatible, also works with Ollama
 * Llama 3.1+):
 *
 *   1. We send the `tools` definition along with the first completion call
 *   2. The LLM streams either text (normal case) or tool_call fragments
 *   3. On finish_reason === 'tool_calls': we merge the fragments, execute
 *      every tool function, append the results to the history and start a
 *      new stream call
 *   4. Loop until finish_reason === 'stop'
 */

// Port 8890 instead of SearXNG's usual 8888 — 8888 is often taken by
// Jupyter on developer Macs (exactly that silently killed the search here).
const SEARXNG_URL = process.env.SEARXNG_URL || 'http://localhost:8890';

// Tool definition in the OpenAI function-calling format. Ollama Llama 3.1+
// understands this schema too (via the OpenAI-compatible endpoint).
const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      'Search the public web for up-to-date information. Use this when the user asks about ' +
      'current events, recent developments, specific facts you are uncertain about, or anything ' +
      'after your training cutoff. Do NOT use for general knowledge, math, code reasoning, ' +
      'or questions you can already answer confidently.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query, in the language and phrasing most likely to return relevant results (usually English).',
        },
      },
      required: ['query'],
    },
  },
};

const ALL_TOOLS = [WEB_SEARCH_TOOL];

// Map tool name → implementation. Each impl receives the parsed args object
// and must return a string (which is what gets fed back to the LLM).
const TOOL_IMPLS = {
  web_search: async ({ query }) => {
    if (!query || typeof query !== 'string') {
      return JSON.stringify({ error: 'Missing required "query" argument' });
    }
    const url = new URL('/search', SEARXNG_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('safesearch', '0');
    try {
      const r = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) {
        return JSON.stringify({ error: `Search backend responded HTTP ${r.status}` });
      }
      const data = await r.json();
      // Top 6 results, trimmed to what's useful for an LLM. We want enough
      // diversity for synthesis but not so much that it blows the context window.
      const results = (data.results || []).slice(0, 6).map(r => ({
        title: r.title,
        url: r.url,
        snippet: (r.content || '').slice(0, 400),
      }));
      return JSON.stringify({ query, results });
    } catch (err) {
      const msg = err?.cause?.code === 'ECONNREFUSED'
        ? `Could not reach the search backend at ${SEARXNG_URL}. The SearXNG container may not be running.`
        : err.message || 'Search failed';
      return JSON.stringify({ error: msg });
    }
  },
};

/**
 * Streaming chunks from OpenAI carry tool_calls as fragments that must be
 * assembled by `index`. `accumulator` is a Map(index → {
 *   id, name, arguments (string, JSON-encoded) }).
 */
function mergeToolCallDeltas(accumulator, deltas) {
  for (const delta of deltas) {
    const idx = delta.index;
    if (!accumulator.has(idx)) {
      accumulator.set(idx, { id: '', name: '', arguments: '' });
    }
    const entry = accumulator.get(idx);
    if (delta.id) entry.id = delta.id;
    if (delta.function?.name) entry.name = delta.function.name;
    if (delta.function?.arguments) entry.arguments += delta.function.arguments;
    // Gemini 3 (gemini-flash-latest, 2026-07) attaches a thought_signature
    // to the fragment as extra_content — it MUST be echoed back on the
    // assistant tool_calls message, otherwise the follow-up request fails
    // with a 400 INVALID_ARGUMENT (thought-signatures doc).
    if (delta.extra_content) entry.extra_content = delta.extra_content;
  }
}

/**
 * Runs the streamed completion-with-tools loop. Calls `onText(delta)` for
 * every text chunk and `onToolEvent({ phase, ...meta })` so the caller can
 * forward both to the frontend (text streaming + "Searching the web…" UX).
 *
 * `phase` is 'call' (tool about to run, with args) or 'result' (tool finished,
 * with structured payload — currently the search results array so the UI can
 * cite sources).
 *
 * Returns the final assistant text once finish_reason becomes 'stop'.
 */
function isAbortError(err) {
  return err?.name === 'AbortError' || err?.name === 'APIUserAbortError' || /abort/i.test(err?.message || '');
}

/**
 * How many characters at the end of `s` are a possible BEGINNING of `tag`.
 * Needed because streaming chunks can cut a tag right through the middle
 * ("<thi" + "nk>"): the suspected remainder stays in the buffer until the
 * next chunk confirms or refutes it.
 */
function partialSuffixLen(s, tag) {
  const max = Math.min(s.length, tag.length - 1);
  for (let k = max; k > 0; k--) {
    if (s.endsWith(tag.slice(0, k))) return k;
  }
  return 0;
}

/**
 * Stateful filter for inline thinking tags (ADR-0008 slice 2): some cloud
 * models (e.g. Qwen via Groq) stream their chain of thought as
 * `<think>…</think>` directly in the content instead of as reasoning
 * deltas. The filter separates the two — thoughts NEVER reach the response
 * text or the DB.
 */
class ThinkTagFilter {
  constructor() {
    this.buf = '';
    this.inThink = false;
  }

  /** Processes a content delta → { content, reasoning }. */
  feed(s) {
    this.buf += s;
    let content = '';
    let reasoning = '';
    while (this.buf.length > 0) {
      if (this.inThink) {
        const end = this.buf.indexOf('</think>');
        if (end !== -1) {
          reasoning += this.buf.slice(0, end);
          this.buf = this.buf.slice(end + '</think>'.length);
          this.inThink = false;
          continue;
        }
        const keep = partialSuffixLen(this.buf, '</think>');
        reasoning += this.buf.slice(0, this.buf.length - keep);
        this.buf = this.buf.slice(this.buf.length - keep);
        break;
      }
      const start = this.buf.indexOf('<think>');
      if (start !== -1) {
        content += this.buf.slice(0, start);
        this.buf = this.buf.slice(start + '<think>'.length);
        this.inThink = true;
        continue;
      }
      const keep = partialSuffixLen(this.buf, '<think>');
      content += this.buf.slice(0, this.buf.length - keep);
      this.buf = this.buf.slice(this.buf.length - keep);
      break;
    }
    return { content, reasoning };
  }

  /** End of stream: whatever is left in the buffer belongs to the active channel. */
  flush() {
    const rest = this.buf;
    this.buf = '';
    return this.inThink ? { content: '', reasoning: rest } : { content: rest, reasoning: '' };
  }
}

async function streamWithTools({ client, model, messages, onText, onToolEvent, onThinking, onReasoning, onPerf, extras = {}, signal }) {
  // Defensive: keep messages in a local array we can append to across rounds.
  const convo = [...messages];
  // Most realistic queries should resolve in 1-2 tool calls. Bail at 5 to
  // guarantee we never get stuck in an infinite tool-calling loop if the
  // model goes haywire.
  const MAX_ROUNDS = 5;

  // Latency measurement across all rounds: time to first token
  // (= prefill/prompt processing, the expensive part with large papers) and
  // token counters from the usage chunks (stream_options.include_usage).
  const startedAt = Date.now();
  let firstTokenAt = null;
  let promptTokens = null;
  let completionTokens = 0;
  // Some dialects (Gemini) attach usage to EVERY chunk as a running total,
  // others (Ollama, OpenAI) only to the final chunk. Within a round the
  // maximum is therefore the truth — summing running totals overcounted by
  // orders of magnitude (bug found live 2026-07-25). Across tool rounds the
  // per-round finals add up; endUsageRound() folds a round into the total.
  let roundCompletionTokens = 0;

  const trackUsage = (chunk) => {
    if (!chunk.usage) return;
    if (typeof chunk.usage.prompt_tokens === 'number') {
      promptTokens = Math.max(promptTokens ?? 0, chunk.usage.prompt_tokens);
    }
    if (typeof chunk.usage.completion_tokens === 'number') {
      roundCompletionTokens = Math.max(roundCompletionTokens, chunk.usage.completion_tokens);
    }
  };
  const endUsageRound = () => {
    completionTokens += roundCompletionTokens;
    roundCompletionTokens = 0;
  };

  const reportPerf = (finishReason) => {
    if (!onPerf) return;
    const now = Date.now();
    const ttftMs = firstTokenAt ? firstTokenAt - startedAt : null;
    const decodeMs = firstTokenAt ? now - firstTokenAt : null;
    onPerf({
      ttftMs,
      totalMs: now - startedAt,
      promptTokens,
      completionTokens: completionTokens || null,
      tokensPerSecond:
        completionTokens && decodeMs > 0
          ? Math.round((completionTokens / decodeMs) * 10_000) / 10
          : null,
      // 'stop' is a clean end; 'length'/'content_filter'/null flag a
      // provider-side truncation of the final answer round.
      finishReason: finishReason ?? null,
    });
  };

  let finalText = '';
  // Once we discover the model can't handle tools at all, stay in plain-stream
  // mode for the rest of the loop. Vision-tuned Ollama models throw on the
  // create() call itself with "does not support tools" — handled below.
  // OpenAI's search-preview models already have built-in web search; passing
  // our `tools` definition alongside causes API errors. Detect them by name
  // and skip our tool wiring from the start.
  let toolsDisabled = /search-preview/i.test(model);
  // Some OpenAI-compatible gateways don't know stream_options — after the
  // first error, continue permanently without the field (then only the
  // token statistics are missing, never the response).
  let usageSupported = true;
  let extrasEnabled = Object.keys(extras).length > 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const makeBody = () => ({
      model,
      messages: convo,
      ...(toolsDisabled ? {} : { tools: ALL_TOOLS }),
      ...(extrasEnabled ? extras : {}),
      stream: true,
      // usage chunk at the end of the stream: prompt/response tokens for
      // the latency diagnosis ([perf] log line and SSE perf event).
      ...(usageSupported ? { stream_options: { include_usage: true } } : {}),
    });

    let stream;
    // Up to three degradations (tools, extras, stream_options) — each is
    // disabled at most once; after that the error really propagates.
    for (let attempt = 0; ; attempt++) {
      try {
        stream = await client.chat.completions.create(makeBody(), { signal });
        break;
      } catch (err) {
        if (isAbortError(err)) return finalText;
        const msg = err?.message || '';
        // Ollama: "<model> does not support tools" for tool-incompatible
        // models → continue without tools (web search is dropped).
        // Some gateways answer an unclassifiable 400 ("invalid argument",
        // or no body at all — Gemini alias models 2026-07) — degrade
        // blindly, one feature per attempt: extras, then tools, then
        // stream_options. Real errors keep failing once the ladder is done.
        const blind400 = err?.status === 400 &&
          !/does not support tools|think|reasoning|stream_options/i.test(msg);
        if (!toolsDisabled && /does not support tools/i.test(msg)) {
          toolsDisabled = true;
        } else if (extrasEnabled && (/think|reasoning/i.test(msg) || blind400)) {
          // Models without thinking capability fail on reasoning_effort —
          // better to answer without the flag than not at all.
          extrasEnabled = false;
        } else if (usageSupported && /stream_options/i.test(msg)) {
          usageSupported = false;
        } else if (blind400 && !toolsDisabled) {
          toolsDisabled = true;
        } else if (blind400 && usageSupported) {
          usageSupported = false;
        } else {
          throw err;
        }
        if (attempt >= 3) throw err;
      }
    }

    let roundText = '';
    let roundFinishReason = null;
    let roundReasoningChars = 0;
    const toolCalls = new Map();
    let thinkingSeen = false;
    // A fresh tag filter per round (cloud models that stream <think> tags
    // into the content do so at the start of every response round).
    const thinkFilter = new ThinkTagFilter();

    const emitReasoning = (r) => {
      if (!r) return;
      roundReasoningChars += r.length;
      if (!firstTokenAt) firstTokenAt = Date.now();
      if (!thinkingSeen) {
        thinkingSeen = true;
        if (onThinking) onThinking();
      }
      if (onReasoning) onReasoning(r);
    };
    const emitContent = (c) => {
      if (!c) return;
      if (!firstTokenAt) firstTokenAt = Date.now();
      roundText += c;
      onText(c);
    };

    try {
      for await (const chunk of stream) {
        trackUsage(chunk);
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) roundFinishReason = choice.finish_reason;
        const delta = choice.delta || {};
        // Thinking models stream the chain of thought as `reasoning` deltas
        // (Ollama /v1, Groq gpt-oss) or `reasoning_content` (other
        // OpenAI-compatible gateways). It is passed live to the client
        // (onReasoning) so the UI can show it in a collapsible panel — but
        // it never ends up in the response text or in the database.
        emitReasoning(delta.reasoning || delta.reasoning_content);
        if (delta.content) {
          const { content, reasoning } = thinkFilter.feed(delta.content);
          emitReasoning(reasoning);
          emitContent(content);
        }
        if (delta.tool_calls) {
          mergeToolCallDeltas(toolCalls, delta.tool_calls);
        }
      }
      // Remainder in the filter buffer still belongs to the round (e.g. an incomplete tag).
      const tail = thinkFilter.flush();
      emitReasoning(tail.reasoning);
      emitContent(tail.content);
    } catch (err) {
      // Abort (stop button): the already-streamed text remains valid —
      // return it instead of throwing so the route can save it.
      if (isAbortError(err)) return roundText;
      throw err;
    }

    endUsageRound();

    // A truncated answer looks exactly like a normal one from here — the
    // only witness is the provider's finish_reason. 'length' /
    // 'content_filter' (Gemini: MAX_TOKENS / RECITATION / safety) or a
    // missing finish chunk (connection cut) mean the text ended mid-answer
    // (live incident 2026-07-26: Gemini stopped mid-sentence). Warn loudly;
    // the reason also travels in the [perf] line via onPerf below.
    if (isTruncatedFinish(roundFinishReason)) {
      console.warn(
        `[tools] Abnormal stream end: finish_reason=${roundFinishReason ?? 'MISSING'} ` +
        `round=${round} textLen=${roundText.length} tail=${JSON.stringify(roundText.slice(-40))}`
      );
    }

    // Plain answer — we're done. Deliberately NOT keyed on finish_reason:
    // Gemini 3's OpenAI layer streams tool calls with finish_reason 'stop'
    // (not 'tool_calls'), which used to end the loop here with an empty
    // answer (live incident 2026-07-26). Accumulated tool calls always mean
    // a tool round, whatever the finish_reason says.
    if (toolCalls.size === 0) {
      finalText = roundText;
      reportPerf(roundFinishReason);
      break;
    }

    // Tool calls requested. Persist the assistant message that contained them
    // (text + tool_calls go together in the same assistant message).
    // extra_content carries Gemini 3's thought_signature — required on echo.
    const assistantToolCalls = [...toolCalls.values()].map(tc => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.arguments || '{}' },
      ...(tc.extra_content ? { extra_content: tc.extra_content } : {}),
    }));
    convo.push({
      role: 'assistant',
      content: roundText || null,
      tool_calls: assistantToolCalls,
    });

    // Execute every requested tool and append a `tool` message per call. The
    // model needs a `tool` message for every `tool_call` it produced — missing
    // one would make the next request fail.
    for (const tc of assistantToolCalls) {
      const impl = TOOL_IMPLS[tc.function.name];
      let parsedArgs = {};
      try { parsedArgs = JSON.parse(tc.function.arguments || '{}'); } catch (_) { /* invalid JSON → empty args */ }

      onToolEvent({ phase: 'call', name: tc.function.name, args: parsedArgs });

      let result;
      if (!impl) {
        result = JSON.stringify({ error: `Unknown tool: ${tc.function.name}` });
      } else {
        result = await impl(parsedArgs);
      }

      // Surface a structured event so the frontend can display sources.
      let parsedResult = null;
      try { parsedResult = JSON.parse(result); } catch (_) { /* tool returned non-JSON; keep raw */ }
      onToolEvent({ phase: 'result', name: tc.function.name, result: parsedResult });

      convo.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: result,
      });
    }
  }

  return finalText;
}

/**
 * Did the provider end this round mid-thought? 'stop' and 'tool_calls' are the
 * clean endings; 'length' / 'content_filter' (Gemini: MAX_TOKENS, RECITATION)
 * and a MISSING finish chunk (connection cut) are not.
 *
 * One rule, two readers: the warning above and the truncated flag the messages
 * route persists on the answer. Split in two, they would drift and the UI
 * would promise "continue writing" on answers that were never cut.
 */
function isTruncatedFinish(finishReason) {
  return finishReason !== 'stop' && finishReason !== 'tool_calls';
}

module.exports = { ALL_TOOLS, streamWithTools, isTruncatedFinish };
