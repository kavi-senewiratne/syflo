/**
 * tools.js
 *
 * LLM tools the model can call during a chat completion call.
 * Currently: `web_search`, via Tavily under the user's own key (see
 * search-providers.js). It is offered to the model ONLY when a key is stored;
 * a tool that can only fail is worse than no tool.
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

// The search itself lives in web-search.js / search-providers.js — shared
// with the /api/search route and the citation card's silent full-text search.
// This file used to carry its own copy of the search call, against a different
// port than the other copy (8890 here, 8888 there); one door now.
const { searchWeb } = require('./web-search');
const { isSearchAvailable, DEFAULT_MAX_RESULTS, SNIPPET_CHARS } = require('./search-providers');

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

/**
 * The tools this install offers. `web_search` always — key or no key.
 *
 * The history is worth keeping, because this rule has now been both ways.
 * Originally the search was offered unconditionally; with none configured the
 * model called it, got an error string, and explained to the reader that its
 * search backend was unreachable — a dead end nobody could act on. So the tool
 * was hidden, and the model answered from what it knew.
 *
 * That fixed the apology and created a worse problem: a question that WANTED
 * the web ("what is the weather today") came back confidently stale, and the
 * reader never learned that a search would have helped. The model cannot tell
 * them, because it was never told the search exists.
 *
 * W2 (design/mockup-onboarding-flow.html §06, built 2026-08-25) offers the
 * tool again — but the failure no longer travels into the answer. The tool
 * result tells the model to answer from its own knowledge without apologising,
 * and the SAME result reaches the frontend as a tool event, which turns it
 * into a card naming the query and asking for a key. The error goes to the
 * person who can fix it instead of to the model that cannot.
 *
 * `deps` are the search dependencies — `{ db }` for the Tavily key, plus an
 * injectable `fetchImpl` for tests. Kept in the signature: the answer is a
 * constant today, and the cache below exists for the next tool that needs to
 * ask something.
 */
// The answer is cached for a moment, and that is a correctness requirement,
// not an optimisation. Warm-up, answer and title are three separate requests
// in two route handlers, so they cannot share one array — they each call this.
// The tool definitions are part of the prompt prefix Ollama caches (see the
// comment at the warm-up call in routes/messages.js), so if the answer
// flickered between those calls the prefix would diverge and a warm cache
// would be thrown away: about a minute of prefill on a 20k-token paper
// (ADR-0007's benchmark). Fifteen seconds covers one answer comfortably;
// a settings write invalidates it immediately, so a freshly pasted key is
// never hidden behind the window.
const AVAILABILITY_TTL_MS = 15_000;
let availabilityCache = null; // { at: epoch ms, tools: readonly array }

function invalidateToolAvailability() {
  availabilityCache = null;
}

async function availableTools(deps = {}) {
  if (availabilityCache && Date.now() - availabilityCache.at < AVAILABILITY_TTL_MS) {
    return availabilityCache.tools;
  }
  const tools = [WEB_SEARCH_TOOL];
  availabilityCache = { at: Date.now(), tools };
  return tools;
}

/**
 * The `tools` field for a completion call, as a spreadable object.
 *
 * An EMPTY list must be omitted, not sent as `tools: []`. The two are the same
 * request to a provider but not the same rendered prompt for Ollama, and the
 * warm-up, the answer and the title share one KV slot — a `tools: []` on one
 * side and no field on the other diverges the prefix and costs the whole
 * prefill (~40 s measured, 2026-07-21). It stayed invisible while SearXNG ran
 * on every developer machine and the list was never empty; with Tavily as the
 * only search (ADR-0012) "no search configured" is the DEFAULT state.
 */
function toolsField(tools) {
  return tools && tools.length ? { tools } : {};
}

// Map tool name → implementation, bound to the search dependencies. Each impl
// receives the parsed args object and must return a string (which is what gets
// fed back to the LLM).
function toolImpls(deps = {}) {
  return {
    web_search: async ({ query }) => {
      if (!query || typeof query !== 'string') {
        return JSON.stringify({ error: 'Missing required "query" argument' });
      }
      try {
        // Six results with 400-character snippets: enough diversity for
        // synthesis, not enough to blow the context window.
        const found = await searchWeb(query, {
          ...deps,
          max: DEFAULT_MAX_RESULTS,
          snippetChars: SNIPPET_CHARS,
        });
        // A named state (no provider, bad key, allowance spent) travels as-is
        // so the frontend's tool-result event can say which one it was
        // instead of parsing a sentence.
        //
        // `query` and `instruction` are for the two different readers of this
        // one result (W2, 2026-08-25). The query lets the card name what would
        // have been searched — the fact that makes "is a key worth getting?"
        // answerable. The instruction keeps the model from starting the setup
        // conversation the card is already having: it must answer from what it
        // knows, not apologise, and never mention keys or settings, or the
        // reader meets the same dead end twice in one screen.
        if (found.error) {
          return JSON.stringify({
            error: found.error,
            query,
            message: searchStateMessage(found.error),
            instruction: SEARCH_UNAVAILABLE_INSTRUCTION,
          });
        }
        // Exactly the three fields the model has always been given — a hit may
        // carry more (an engine name, a score), and that is for the UI, not for
        // the context window.
        const results = (found.results || []).map((hit) => ({
          title: hit.title,
          url: hit.url,
          snippet: hit.snippet,
        }));
        return JSON.stringify({ query, results });
      } catch (err) {
        return JSON.stringify({ error: 'search-failed', message: err.message || 'Search failed' });
      }
    },
  };
}

/**
 * What the model must DO when the search could not run (W2).
 *
 * Deliberately silent about keys, Tavily and settings: the UI is already
 * showing a card about exactly that, and an answer repeating it would be the
 * second dead end on the same screen. "Say plainly" rather than "apologise"
 * because the honest half of the old behaviour was worth keeping — a stale
 * answer presented as current is the failure this whole feature exists to fix.
 */
const SEARCH_UNAVAILABLE_INSTRUCTION =
  'Answer the question from your own knowledge. Do not apologise and do not '
  + 'discuss the search or how to set one up — the app is handling that '
  + 'separately. If your knowledge may be out of date for this question, say '
  + 'so plainly in one short sentence.';

/** One sentence per named search state — this is what the model gets to read. */
function searchStateMessage(error) {
  switch (error) {
    case 'no-search-provider':
      return 'No web search is configured on this installation (no Tavily key stored).';
    case 'tavily-invalid-key':
      return 'The stored Tavily API key was rejected.';
    case 'tavily-quota-exhausted':
      return 'The Tavily monthly request allowance is used up.';
    default:
      return 'The web search failed.';
  }
}

// Default binding for callers that have no db to hand (and for the tests that
// predate the injection).
const TOOL_IMPLS = toolImpls();

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

async function streamWithTools({ client, model, messages, onText, onToolEvent, onThinking, onReasoning, onPerf, extras = {}, signal, searchDeps, tools }) {
  // Defensive: keep messages in a local array we can append to across rounds.
  const convo = [...messages];

  // Three ways to arrive at the tool list, in order of precedence:
  //   1. `tools` — the caller already decided. Preferred, because the Ollama
  //      warm-up, the title call and this answer MUST send a byte-identical
  //      tools array; a second availability check could disagree with the
  //      first and the chat template would render a different prefix, losing
  //      the KV cache.
  //   2. `searchDeps` — decide here from what this install can search.
  //   3. neither — the old unconditional list, so existing call sites work.
  // The web_search impl always reads its key from searchDeps.db when given.
  const toolList = tools || (searchDeps ? await availableTools(searchDeps) : ALL_TOOLS);
  const impls = searchDeps ? toolImpls(searchDeps) : TOOL_IMPLS;
  // Most realistic queries should resolve in 1-2 tool calls. Bail at 5 to
  // guarantee we never get stuck in an infinite tool-calling loop if the
  // model goes haywire.
  const MAX_ROUNDS = 5;
  // How often a round that ends abnormally WITHOUT writing a single character
  // is simply asked again. Two, because that is a transport failure — the
  // provider took a ~19 000-token prompt and returned nothing (measured
  // 2026-08-18) — and a third identical failure is a state, not a hiccup.
  const EMPTY_ROUND_RETRIES = 2;

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
  // An empty tool list means there is nothing this install can perform —
  // treat it exactly like a model that cannot do tools at all.
  let toolsDisabled = /search-preview/i.test(model) || toolList.length === 0;
  // Some OpenAI-compatible gateways don't know stream_options — after the
  // first error, continue permanently without the field (then only the
  // token statistics are missing, never the response).
  let usageSupported = true;
  let extrasEnabled = Object.keys(extras).length > 0;
  // How many dead lines in a row this answer forgives (see below).
  let emptyRounds = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const makeBody = () => ({
      model,
      messages: convo,
      ...(toolsDisabled ? {} : toolsField(toolList)),
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

    // A round that ended abnormally AND wrote nothing at all is a dead line,
    // not an answer: the prompt was paid for (~19 000 tokens on the day this
    // was measured, 2026-08-18) and nothing came back. Ask again.
    //
    // Only while the round is still EMPTY — text or reasoning already at the
    // reader cannot be unsaid, and a second attempt would write it twice. That
    // case belongs to the continuation machinery, which appends instead of
    // repeating.
    if (
      toolCalls.size === 0 &&
      roundText.length === 0 &&
      roundReasoningChars === 0 &&
      isTruncatedFinish(roundFinishReason) &&
      emptyRounds < EMPTY_ROUND_RETRIES
    ) {
      emptyRounds++;
      console.warn(`[tools] Empty round, retrying (${emptyRounds}/${EMPTY_ROUND_RETRIES}).`);
      continue;
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
      const impl = impls[tc.function.name];
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

module.exports = { ALL_TOOLS, availableTools, toolsField, invalidateToolAvailability, toolImpls, streamWithTools, isTruncatedFinish, isAbortError };
