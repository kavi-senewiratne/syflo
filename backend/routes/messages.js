/**
 * messages.js
 *
 * Accepts user messages (text + optional file attachments via multipart),
 * stores the files, builds multimodal requests for llama3.2-vision and
 * streams the response back via SSE.
 *
 * File handling:
 *   - Images (image/*): as data URL via image_url to the vision model
 *   - Text files (text/*, application/json): read content and embed it in the prompt
 *   - Other files: only mention name/mimetype (model cannot read binary)
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getLLMClient, getLLMClientFor, getSetting, noThinkExtras, extendOllamaKeepAlive } = require('../llm');
const { getModelInfo, getRegistry } = require('../registry');
const { streamWithTools, ALL_TOOLS } = require('../tools');
const {
  MAX_PASSAGE_CHARS, capTitleWords, sanitizeTitle,
  branchTitleInstruction, chatTitleInstruction,
} = require('../title');
const { getTreePaperContext } = require('../pdf-text');
const { getTreeVideoContext, transcriptTruncationNote } = require('../youtube');
const {
  ensureSourceChunks,
  retrieveChunks,
  buildSkeleton,
  RETRIEVE_K,
} = require('../retrieval');
const { buildPerfRecord, formatPerfLine, appendPerfJsonl, isPerfJsonlEnabled } = require('../perf-log');
const { isRateLimit, isDailyQuota, isTooLarge, isModelUnavailable, isBillingRequired, msUntilUtcMidnight } = require('../quota');
const {
  buildAncestorContext,
  renderAncestorText,
  applyContextBudget,
  CONTEXT_WINDOW_TOKENS,
  contextBudget,
} = require('../ancestor-context');

const MAX_TEXT_FILE_BYTES = 64 * 1024;

module.exports = (db, UPLOADS_DIR, options = {}) => {
  // Injectable for tests: (pdfPath) => Promise<string>.
  const extractPdfTextFn = options.extractPdfTextFn;
  // Injectable for tests: (texts) => Promise<number[][]> (retrieval.js).
  const embedTextsFn = options.embedTextsFn;
  const router = express.Router({ mergeParams: true });

  // Place attachments in the chat-specific directory so cleanup can happen
  // per chat and no filename collisions occur.
  const storage = multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(UPLOADS_DIR, req.params.chatId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      // Filename: <id>-<originalname> — id for uniqueness, originalname for readability
      const id = crypto.randomUUID();
      // Sanitize the original name (no paths)
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
      file.attachmentId = id;
      cb(null, `${id}-${safe}`);
    },
  });
  const upload = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB per file
  });

  // Helper: reads a file and returns it as a data URL.
  function fileToDataUrl(fullPath, mimetype) {
    const data = fs.readFileSync(fullPath);
    return `data:${mimetype};base64,${data.toString('base64')}`;
  }

  // Helper: reads a text file (limited to MAX_TEXT_FILE_BYTES)
  function readTextFile(fullPath) {
    const stat = fs.statSync(fullPath);
    const len = Math.min(stat.size, MAX_TEXT_FILE_BYTES);
    const fd = fs.openSync(fullPath, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    fs.closeSync(fd);
    return buf.toString('utf-8') + (stat.size > len ? '\n[…truncated]' : '');
  }

  // Converts a DB attachment into the OpenAI multimodal content entry.
  // Returns either an image_url object, or null (for text files the content
  // is embedded into the prompt text — handled separately).
  function attachmentToMultimodalContent(att) {
    if (att.mimetype.startsWith('image/')) {
      return {
        type: 'image_url',
        image_url: { url: fileToDataUrl(att.path, att.mimetype) },
      };
    }
    return null;
  }

  // Builds the text annex for non-image attachments:
  // - Text files: full content
  // - Others: only a reference to the filename
  function buildAttachmentTextAnnex(attachments) {
    const parts = [];
    for (const att of attachments) {
      if (att.mimetype.startsWith('image/')) continue;
      const isText = att.mimetype.startsWith('text/') ||
                     att.mimetype === 'application/json' ||
                     /\.(md|txt|csv|log|js|ts|py|html|css|json|yaml|yml)$/i.test(att.filename);
      if (isText) {
        try {
          const content = readTextFile(att.path);
          parts.push(`\n\n[Attachment ${att.alias} — ${att.filename}]\n\`\`\`\n${content}\n\`\`\``);
        } catch (_) {
          parts.push(`\n\n[Attachment ${att.alias} — ${att.filename}, error reading file]`);
        }
      } else {
        parts.push(`\n\n[Attachment ${att.alias} — ${att.filename}, type ${att.mimetype} (binary file, cannot be read)]`);
      }
    }
    return parts.join('');
  }

  // Builds the textual conversation context of a chat: system prompt (incl.
  // full paper text for a bound PDF, ADR-0002, and inherited ancestor
  // context for branches) plus the message history. Used by the real
  // message (dropLastMessage: the current user message is added
  // multimodally) AND by the prefix warm-up (complete state) — both must
  // produce the same prompt prefix, otherwise Ollama's KV cache misses.
  async function buildSystemAndHistory(chat, { dropLastMessage, historyUntil = null, budgetFor = null }) {
    const contextMessages = [];
    // Deliberately NO brevity rule (removed 2026-07-26, user decision):
    // answers may be as detailed as the question warrants. The old
    // "be concise by default" was a latency measure for local decoding
    // (~40 ms/token), but the perceived wait there is dominated by prefill,
    // not decode. If long local answers ever hurt again, reintroduce the
    // rule for provider === 'ollama' only — never globally.
    let systemBase = 'You are a friendly and helpful assistant. Formatting rules: (1) Use proper Markdown for headings — always include a SPACE between the hash characters and the heading text: `# Heading`, `## Subheading`, `### Sub-subheading`. Never write `#Heading` without a space — it will not render as a heading. (2) Do NOT use emojis. Keep prose plain so it reads cleanly. (3) When explaining concepts, always use analogies and real-world comparisons to make things easy to understand. (4) When the user attaches images, examine them carefully and describe what you see when relevant. (5) When the user asks about current or real-time information (news, weather, prices, recent events) or explicitly asks you to search the web, ALWAYS call the web_search tool first and base your answer on its results — never invent real-time information from memory, and never claim the tool is unavailable without having called it. (6) ALWAYS reply in the language of the user\'s most recent message — German message, German reply; English message, English reply. If a message mixes languages, reply in its dominant language. (7) Write EVERY mathematical expression that has an exponent, subscript, fraction, or math symbol as LaTeX inside inline math delimiters $…$ — e.g. $10^{50}$, $w_t$, $\\frac{a}{b}$, $27 \\times 27$. NEVER write a bare caret (^) or underscore (_) for math in plain text (write $10^{50}$, not 10^50), because a bare caret renders as a literal character instead of a superscript. Plain whole numbers without such notation may stay as normal text.';

    // Custom instructions (CONTEXT.md): user free text from the settings —
    // directly after the base rules and BEFORE paper/ancestor context, so
    // budget trimming never touches them. The explicit precedence line is
    // needed because small local models otherwise resolve rule conflicts
    // unpredictably.
    const customInstructions = getSetting(db, 'custom_instructions');
    if (getSetting(db, 'custom_instructions_enabled') === 'true' && customInstructions.trim()) {
      systemBase +=
        '\n\nThe user has set the following custom instructions. Follow them; they take precedence over the style rules above.\n' +
        '--- CUSTOM INSTRUCTIONS START ---\n' +
        customInstructions +
        '\n--- CUSTOM INSTRUCTIONS END ---';
    }

    // Full text of the paper bound to the chat tree (ADR-0002) into the
    // system prompt — without it the model doesn't know the PDF and
    // hallucinates summaries. Extraction is lazy and cached in
    // papers.extracted_text; errors degrade silently to "no paper context".
    const paperContext = await getTreePaperContext(db, chat.id, extractPdfTextFn);

    // YouTube transcript of the tree (ADR-0005) — second source type. A tree
    // has at most ONE source, so paper and video share the same budget slot
    // (paperText) in applyContextBudget.
    const videoContext = getTreeVideoContext(db, chat.id);

    // Inherited conversation context (design 2026-07-20): whole path up to
    // the root — parent verbatim, grandparents+ as cached summary, plus the
    // parent_word chain. Summary errors degrade silently to the context
    // without the affected summary; the lazy path here is the safety net
    // behind the warm-up at branch creation.
    let ancestor = null;
    if (chat.parent_id) {
      try {
        ancestor = await buildAncestorContext(db, chat.id);
      } catch (_) { /* continue without ancestor context */ }
    }

    // The ONE source of the tree, source-type-neutral (paper or video).
    const source = paperContext
      ? { type: 'paper', id: paperContext.paperId, text: paperContext.text }
      : videoContext
        ? { type: 'video', id: videoContext.videoId, text: videoContext.text }
        : null;

    // If-then rule (ADR-0006): If the source fits into the room left after
    // the ancestor context, everything stays on the full-text prefix
    // (KV cache, one-time prefill). If it exceeds it, a stable skeleton
    // replaces the full text, and per question the best-matching chunks are
    // added AFTER the history (retrieval, POST handler below). If the
    // chunking/embedding fails (e.g. embedding model not installed),
    // everything degrades to the old full-text truncation — nothing breaks.
    // Tree-stable mode decision (addendum 2026-07-25): full text vs.
    // retrieval depends ONLY on the source, not on the ancestor context.
    // Previously the room in the child shrank by the ancestor characters —
    // the same source that was full text in the parent chat tipped into
    // retrieval mode in the child, and the expensive shared source prefix
    // (system + custom instructions + source) was worthless when branching:
    // full re-prefill instead of cache hit (~60 s, measured 2026-07-25).
    // If the source alone fits into the budget, the ancestor summaries give
    // way instead (applyContextBudget, sacrifice order flipped the same day).
    // Budget of the model that will answer (ADR-0008): cloud models bring
    // bigger windows — the same source can be full text on Gemini and
    // retrieval on Ollama. The cap (budgetCapTokens) protects free quotas.
    // budgetFor: failover candidates and the one-off local regenerate get a
    // prompt sized to THEIR budget (fix 2026-07-29), default is the active
    // settings model (warm-up contract: same prompt prefix as the real call).
    const budget = contextBudget(db, budgetFor);
    const sourceRoom = budget.maxSystemContextChars;

    let retrieval = null;
    let sourceTextForPrompt = source ? source.text : null;
    if (source && source.text.length > sourceRoom) {
      try {
        await ensureSourceChunks(db, {
          sourceType: source.type,
          sourceId: source.id,
          text: source.text,
          ...(embedTextsFn ? { embedFn: embedTextsFn } : {}),
        });
        retrieval = { sourceType: source.type, sourceId: source.id };
        sourceTextForPrompt = buildSkeleton(source.text);
      } catch (err) {
        console.warn(
          `[retrieval] Chunking/embedding for ${source.type} ${source.id} failed ` +
          `(${err.message}) — falling back to full-text truncation.`
        );
      }
    }

    // Sacrifice order when everything together gets too big:
    // paper → ancestor summaries (oldest first) → never the parent transcript.
    const fitted = applyContextBudget(
      {
        paperText: sourceTextForPrompt,
        summaries: ancestor ? ancestor.summaries : [],
        parentTranscript: ancestor ? ancestor.parentTranscript : null,
      },
      budget.maxSystemContextChars
    );

    if (paperContext && fitted.paperText && retrieval) {
      systemBase +=
        `\n\nA research paper is attached to this conversation: "${paperContext.title}". ` +
        'It is too long for the context window, so below is its SKELETON: the beginning ' +
        '(title/abstract), the section outline, and the end (conclusion). The passages of ' +
        'the paper most relevant to the user\'s current question are provided separately, ' +
        'later in the conversation, in a message marked RELEVANT PAPER EXCERPTS. Base every ' +
        'answer about the paper on this material; if something is not covered by it, say so ' +
        'instead of guessing.\n' +
        '--- PAPER SKELETON START ---\n' +
        fitted.paperText +
        '\n--- PAPER SKELETON END ---';
    } else if (paperContext && fitted.paperText) {
      systemBase +=
        `\n\nA research paper is attached to this conversation: "${paperContext.title}". ` +
        'Its full text is included below. Base every answer about the paper on this text; ' +
        'if something is not covered by it, say so instead of guessing.\n' +
        '--- PAPER TEXT START ---\n' +
        fitted.paperText +
        '\n--- PAPER TEXT END ---';
    } else if (videoContext && fitted.paperText && retrieval) {
      systemBase +=
        `\n\nA YouTube video is attached to this conversation as its source: ` +
        `"${videoContext.title}"${videoContext.channel ? ` by ${videoContext.channel}` : ''}. ` +
        'Its transcript is too long for the context window, so below is its SKELETON: the ' +
        'beginning and the end (with [minute:second] marks). The transcript passages most ' +
        'relevant to the user\'s current question are provided separately, later in the ' +
        'conversation, in a message marked RELEVANT TRANSCRIPT EXCERPTS. Base every answer ' +
        'about the video on this material; if something is not covered by it, say so instead ' +
        'of guessing.\n' +
        '--- TRANSCRIPT SKELETON START ---\n' +
        fitted.paperText +
        '\n--- TRANSCRIPT SKELETON END ---';
    } else if (videoContext && fitted.paperText) {
      // Video overview rule (user decision 2026-07-23): structuring
      // means organizing, NOT shortening — without the explicit rule the
      // model falls back to its default behavior of "summarizing".
      const note = transcriptTruncationNote(
        fitted.paperText, videoContext.text, videoContext.durationSeconds
      );
      systemBase +=
        `\n\nA YouTube video is attached to this conversation as its source: ` +
        `"${videoContext.title}"${videoContext.channel ? ` by ${videoContext.channel}` : ''}. ` +
        'Its full transcript (with [minute:second] marks) is included below. Base every answer ' +
        'about the video on this transcript; if something is not covered by it, say so instead ' +
        'of guessing. When the user asks you to structure the video, reorganize ALL substantive ' +
        'content into sections with key points and minute marks — do NOT summarize and do not ' +
        'drop content.\n' +
        '--- VIDEO TRANSCRIPT START ---\n' +
        fitted.paperText +
        (note || '') +
        '\n--- VIDEO TRANSCRIPT END ---';
    }

    if (ancestor) {
      const ancestorText = renderAncestorText({
        chain: ancestor.chain,
        summaries: fitted.summaries,
        parentTranscript: fitted.parentTranscript,
      });
      // Two branch origins, two truths (decision 2026-07-26): a chat-selection
      // branch really comes "from a previous conversation" and parent_word is
      // the full selected passage. A PDF-selection branch carries
      // parent_context — the text-layer lines around the selection — and the
      // model must know that PDF extraction flattens math notation, or a
      // selection like "Rm" (really R^m) is uninterpretable.
      const branchIntro = chat.parent_context
        ? `The user selected "${chat.parent_word}" inside the tree's PDF source. ` +
          `Text surrounding the selection: "${chat.parent_context}". ` +
          `Note: PDF text extraction flattens math notation — superscripts, subscripts and ` +
          `blackboard/calligraphic letters may be lost (e.g. "Rm" may actually be the math ` +
          `symbol R^m). Infer the intended notation from the surrounding text.`
        : `The user is exploring the term "${chat.parent_word}" from a previous conversation.`;
      contextMessages.push({
        role: 'system',
        content: `${systemBase} ${branchIntro} Context:\n\n${ancestorText}`,
      });
    } else {
      contextMessages.push({ role: 'system', content: systemBase });
    }

    // History (text only — old attachments are not re-uploaded in the context,
    // otherwise the prompt gets too big)
    const history = db.prepare(
      'SELECT role, content, created_at FROM messages WHERE chat_id = ? AND IFNULL(pending, 0) = 0 ORDER BY created_at ASC, id ASC'
    ).all(chat.id);
    // Anchored regenerate: the context is the conversation as it was BEFORE
    // the question being retried — later exchanges must not leak in.
    const included = historyUntil
      ? history.filter((m) => m.created_at < historyUntil)
      : dropLastMessage ? history.slice(0, -1) : history;
    // Prompt hygiene (§07): '*Failed*'/'*Interrupted*' markers are UI state,
    // not conversation — the model must never see them as prior answers.
    included
      .filter((m) => !(m.role === 'assistant' && isRetryableMarker(m.content)))
      .forEach(m => contextMessages.push({ role: m.role, content: m.content }));

    // retrieval ≠ null means: the POST handler fetches the matching chunks
    // per question and appends them AFTER the history — the prefix up to
    // here stays byte-identical with the warm-up, only the excerpt block changes.
    //
    // Diagnostic metadata (perf-log.js): which mode, how big the source is.
    // sourceTokens is an estimate from the character count (same ratio as
    // the budget); the real prompt size appears as promptTokens in the usage.
    const mode = source ? (retrieval ? 'retrieval' : 'fulltext') : 'none';
    const sourceTokens = source ? Math.round(source.text.length / 3.5) : null;
    // Cold/warm proxy: the first question of a chat (almost) never hits a
    // warm KV cache; from the second on the paper prefix is usually warm.
    const cache = included.some((m) => m.role === 'assistant') ? 'warm' : 'cold';

    return { messages: contextMessages, retrieval, meta: { mode, sourceTokens, cache } };
  }

  // Renders the retrieved chunks into the excerpt block after the history.
  // Section headers stay attached so the model knows WHERE in the document
  // an excerpt comes from.
  function renderExcerpts(hits, sourceType) {
    const label = sourceType === 'video' ? 'TRANSCRIPT' : 'PAPER';
    const body = hits
      .map((h) => (h.heading ? `[Section: ${h.heading}]\n${h.text}` : h.text))
      .join('\n\n---\n\n');
    return (
      `RELEVANT ${label} EXCERPTS — the passages of the attached ` +
      `${sourceType === 'video' ? 'video transcript' : 'paper'} most relevant to the ` +
      'user\'s current question, in document order:\n\n' +
      body
    );
  }

  // The one running warm-up (more than one never makes sense). A warm-up
  // is pure upfront work — it must NEVER block a real request. On Ollama's
  // limited slots that would otherwise mean: the user waits up to ~40 s
  // (paper prefill) in the queue before their question even starts
  // (measured 2026-07-21). Therefore: new real message OR new warm-up →
  // abort the running warm-up immediately. The already-processed prefix
  // stays in Ollama's cache — aborted upfront work is thus not lost.
  let activeWarmup = null;
  function abortActiveWarmup() {
    if (activeWarmup) activeWarmup.abort();
    activeWarmup = null;
  }

  // POST /api/chats/:chatId/messages/warmup — prefix warm-up: reads the
  // complete chat context (above all the full paper text) once with a
  // 1-token call so Ollama's KV cache is warm before the user submits
  // their question — and pins the model in memory for 1 h.
  // Fire-and-forget from the frontend when opening a chat; errors are never
  // fatal (warmed:false instead of 5xx).
  router.post('/warmup', async (req, res) => {
    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });

    // No warm-up while real questions are running or waiting: it would
    // queue up behind them and, when it runs, evict the KV prefix of the
    // chat currently answering — exactly that made chat switches expensive
    // (cache=cold despite warm-up, finding 2026-07-24).
    if (processingJob || jobQueue.length > 0) {
      return res.json({ warmed: false, reason: 'busy' });
    }

    abortActiveWarmup();
    const warmupAbort = new AbortController();
    activeWarmup = warmupAbort;

    try {
      const { client, model, provider } = getLLMClient(db);
      if (provider !== 'ollama') {
        return res.json({ warmed: false, reason: 'local models only' });
      }
      const { messages: contextMessages } = await buildSystemAndHistory(chat, { dropLastMessage: false });
      try {
        await client.chat.completions.create({
          model,
          messages: contextMessages,
          // Same tools as the real request — otherwise the prompt prefix
          // diverges and the cache misses.
          tools: ALL_TOOLS,
          ...noThinkExtras(provider),
          max_tokens: 1,
        }, { signal: warmupAbort.signal });
      } catch (err) {
        if (!/does not support tools/i.test(err?.message || '')) throw err;
        await client.chat.completions.create({
          model,
          messages: contextMessages,
          ...noThinkExtras(provider),
          max_tokens: 1,
        }, { signal: warmupAbort.signal });
      }
      await extendOllamaKeepAlive(model);
      res.json({ warmed: true });
    } catch (err) {
      res.json({ warmed: false, reason: err.message });
    } finally {
      if (activeWarmup === warmupAbort) activeWarmup = null;
    }
  });

  // Content of an assistant message whose generation failed (e.g.
  // Ollama error or client timeout): in place of the answer only this
  // marker remains — the frontend renders it as an error row with a retry
  // button. Counterpart to '*Interrupted*'; exactly the same string as
  // FAILED_MARKER in frontend/src/types.
  const FAILED_MARKER = '*Failed*';
  // Stop button / connection drop: the half-generated answer is discarded and
  // this marker takes its place. Regenerate accepts it like FAILED_MARKER
  // (mockup-model-flow §09) — an accidental stop must not force the user to
  // re-type the question.
  const INTERRUPTED_MARKER = '*Interrupted*';
  const isRetryableMarker = (content) => {
    const t = (content || '').trim();
    return t === FAILED_MARKER || t === INTERRUPTED_MARKER;
  };

  // ─── Send queue ─────────────────────────────────────────────────────────
  // Ollama has exactly ONE KV slot (vision models force parallel:1).
  // Without our own queue, concurrent questions pile up in Ollama's
  // internal queue, where they die after 5 minutes at the HTTP client's
  // header timeout (incident 2026-07-24) — and question 2 would be
  // answered without having answer 1 in its context. Therefore the backend
  // serializes itself (FIFO, across chats): user insert, context build and
  // generation only run when the job is up — so answer 1 sits before
  // question 2 in the DB and in its history. Waiting clients get queued
  // events with the number of jobs ahead of them; the start gets a started
  // event with the now-persisted user message.
  const jobQueue = [];
  let processingJob = false;

  // Quota memory (user request 2026-07-25): a model that reported an
  // exhausted quota is remembered and skipped proactively — daily limits
  // until the next UTC midnight, per-minute exhaustion for 90 s. Limits are
  // per MODEL, so the sibling model of the same provider stays usable.
  const quotaCooldowns = new Map(); // 'provider/model' → { until: epoch ms, kind }
  const isQuotaCoolingDown = (p, m) => (quotaCooldowns.get(`${p}/${m}`)?.until || 0) > Date.now();
  // kind: 'daily' (until UTC midnight) | 'minute' (90 s) | 'retired' (24 h) —
  // needed so retryAt can be honest per cause (mockup-model-flow §08): a
  // sibling's 90 s cooldown must not become the daily card's clock.
  const markQuotaCooldown = (p, m, ms, kind) =>
    quotaCooldowns.set(`${p}/${m}`, { until: Date.now() + ms, kind });
  // Earliest moment a cooling model becomes available again — sent as
  // retryAt with the quotaExhausted error so the UI can gate its retry
  // button honestly (mockup-quota-states.html §04/§05). With a kind filter
  // it answers "when does THIS kind of limit reset"; falls back to the
  // global minimum when no entry matches. Null when nothing is cooling
  // down: a retry may work right away.
  const earliestQuotaRetryAt = (kind = null) => {
    const now = Date.now();
    const pick = (filter) => {
      let earliest = null;
      for (const entry of quotaCooldowns.values()) {
        if (filter && entry.kind !== filter) continue;
        if (entry.until > now && (earliest === null || entry.until < earliest)) earliest = entry.until;
      }
      return earliest;
    };
    return pick(kind) ?? (kind ? pick(null) : null);
  };
  function sseWrite(res, payload) {
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) { /* client gone */ }
  }

  // Strictly monotonic timestamps within a chat: on dequeue, answer 1 and
  // the following question 2 can land in the same millisecond — GET and
  // frontend sort by created_at, and equal stamps made the order random.
  // If the last stamp is not in the past, we round up by 1 ms.
  function monotonicNow(chatId) {
    const now = Date.now();
    const last = db.prepare('SELECT MAX(created_at) AS ts FROM messages WHERE chat_id = ? AND IFNULL(pending, 0) = 0').get(chatId);
    const lastMs = last && last.ts ? new Date(last.ts).getTime() : -Infinity;
    return new Date(Math.max(now, lastMs + 1)).toISOString();
  }

  // The local job whose answer is generating right now — queued events name
  // it so the waiting note can link to "the question currently answering"
  // (mockup-model-flow §07, user request 2026-07-26).
  let currentLocalJob = null;

  function queuedPayload(ahead) {
    return {
      queued: {
        ahead,
        // The chip: which model will answer this waiting question. After the
        // queue split only local jobs wait, so this is the local model.
        model: getSetting(db, 'ollama_model'),
        ...(currentLocalJob ? {
          current: {
            chatId: currentLocalJob.req.params.chatId,
            question: String(currentLocalJob.content || '').slice(0, 120),
          },
        } : {}),
      },
    };
  }

  function notifyQueuePositions() {
    jobQueue.forEach((job, i) => {
      sseWrite(job.res, queuedPayload(i + (processingJob ? 1 : 0)));
    });
  }

  // One close handler for the job's whole life — on the RESPONSE, not the
  // request: req 'close' fires in Node as soon as the request has been
  // fully READ (so immediately with SSE), res 'close' only when the
  // connection actually closes; writableEnded distinguishes the normal
  // end (our res.end()) from the client aborting. While the job is
  // waiting, it is only removed from the queue — the persisted pending
  // question stays (§10; only the explicit DELETE removes it). If it's
  // already running, job.abort cancels the upstream generation
  // (stop-button semantics).
  function attachCloseHandler(job) {
    job.res.on('close', () => {
      if (job.res.writableEnded) return;
      job.clientClosed = true;
      job.abort?.abort();
      if (!job.running) {
        job.canceled = true;
        const idx = jobQueue.indexOf(job);
        if (idx !== -1) {
          jobQueue.splice(idx, 1);
          notifyQueuePositions();
        }
        try { job.res.end(); } catch (_) { /* already closed */ }
      }
    });
  }

  // Runs a job outside the FIFO — cloud requests are parallel by decision
  // 2026-07-25 (§07): providers rate-limit server-side; only Ollama's single
  // KV slot needs serialization.
  function runJobParallel(job) {
    job.running = true;
    void runMessageJob(job).catch((err) => {
      console.error('[messages] Unexpected job error:', err);
      sseWrite(job.res, { error: err.message });
      try { job.res.end(); } catch (_) { /* already closed */ }
    });
  }

  function enqueueMessageJob(job) {
    attachCloseHandler(job);

    const provider = job.forceProvider || getSetting(db, 'llm_provider');
    if (provider !== 'ollama') {
      runJobParallel(job);
      return;
    }

    jobQueue.push(job);
    const ahead = jobQueue.length - 1 + (processingJob ? 1 : 0);
    if (ahead > 0) sseWrite(job.res, queuedPayload(ahead));

    void processJobQueue();
  }

  async function processJobQueue() {
    if (processingJob) return;
    processingJob = true;
    try {
      while (jobQueue.length > 0) {
        const job = jobQueue.shift();
        currentLocalJob = job;
        notifyQueuePositions();
        if (job.canceled) continue;
        job.running = true;
        try {
          await runMessageJob(job);
        } catch (err) {
          // Safety net — runMessageJob catches generation errors itself.
          console.error('[messages] Unexpected job error:', err);
          sseWrite(job.res, { error: err.message });
          try { job.res.end(); } catch (_) { /* already closed */ }
        }
      }
    } finally {
      processingJob = false;
      currentLocalJob = null;
    }
  }

  // Settings changed (provider switch from the picker): questions waiting
  // for the local slot may no longer need it. Jobs that now resolve to a
  // cloud provider leave the FIFO and start immediately (§07 — "switch to
  // a cloud model while waiting → the question starts now").
  function reevaluateQueue() {
    for (const job of [...jobQueue]) {
      if (job.canceled) continue;
      const provider = job.forceProvider || getSetting(db, 'llm_provider');
      if (provider === 'ollama') continue;
      const idx = jobQueue.indexOf(job);
      if (idx === -1) continue;
      jobQueue.splice(idx, 1);
      runJobParallel(job);
    }
    // Re-announce positions either way — the chip's model name may have
    // changed even when nobody left the queue.
    notifyQueuePositions();
  }

  // POST /api/chats/:chatId/messages
  // Accepts both JSON (old clients) and multipart/form-data (with files).
  // Multipart fields: text, aliases (JSON array), files (file inputs).
  // Responds immediately with the SSE stream and enqueues the job.
  // The chat check must run BEFORE multer: the storage destination is built
  // from req.params.chatId, so an unvalidated id (e.g. an encoded "../")
  // would create directories outside UPLOADS_DIR. Only ids of existing
  // chats — always server-generated UUIDs — may reach the disk layer.
  const requireChat = (req, res, next) => {
    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    req.chat = chat;
    next();
  };

  router.post('/', requireChat, upload.array('files', 8), (req, res) => {
    // Content from JSON or multipart
    const content = req.body.content || req.body.text || '';
    const aliases = req.body.aliases ? JSON.parse(req.body.aliases) : [];
    if (!content && (!req.files || req.files.length === 0)) {
      return res.status(400).json({ error: 'content or files required' });
    }

    const chat = req.chat;

    // Persist the question at ENQUEUE (mockup-model-flow §10): a reload or
    // backend restart while waiting must never lose typed text. pending=1
    // keeps the row out of prompts and timestamp logic until dequeue, where
    // it is cleared and re-stamped (answers keep their order). Only the
    // explicit DELETE below removes it — a disconnect does not.
    const chatId = req.params.chatId;
    const userMsgId = crypto.randomUUID();
    const enqueuedAt = monotonicNow(chatId);
    db.prepare(
      'INSERT INTO messages (id, chat_id, role, content, created_at, pending) VALUES (?, ?, ?, ?, ?, 1)'
    ).run(userMsgId, chatId, 'user', content, enqueuedAt);
    const files = req.files || [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const alias = aliases[i] || `@file${i + 1}`;
      db.prepare(
        `INSERT INTO attachments (id, message_id, chat_id, alias, filename, mimetype, path, size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(file.attachmentId, userMsgId, chatId, alias, file.originalname, file.mimetype, file.path, file.size, enqueuedAt);
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    enqueueMessageJob({
      req, res, content, aliases,
      files,
      think: String(req.body.think) === 'true',
      persisted: { userMsgId },
    });
  });

  // DELETE /api/chats/:chatId/messages/:messageId — explicit cancel of a
  // QUEUED question (stop button while waiting): "counts as never asked".
  // Only pending rows are deletable; everything else is history.
  router.delete('/:messageId', (req, res) => {
    const { chatId, messageId } = req.params;
    const row = db.prepare('SELECT * FROM messages WHERE id = ? AND chat_id = ?').get(messageId, chatId);
    if (!row) return res.status(404).json({ error: 'Message not found' });
    if (!row.pending) return res.status(409).json({ error: 'only pending questions can be canceled' });

    const idx = jobQueue.findIndex((j) => j.persisted?.userMsgId === messageId);
    if (idx !== -1) {
      const job = jobQueue[idx];
      job.canceled = true;
      jobQueue.splice(idx, 1);
      notifyQueuePositions();
      try { job.res.end(); } catch (_) { /* already closed */ }
    }
    const atts = db.prepare('SELECT * FROM attachments WHERE message_id = ?').all(messageId);
    for (const att of atts) {
      try { fs.unlinkSync(att.path); } catch (_) { /* file already gone */ }
    }
    db.prepare('DELETE FROM attachments WHERE message_id = ?').run(messageId);
    db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
    res.json({ ok: true });
  });

  // POST /api/chats/:chatId/messages/regenerate — retry button of the error
  // row: answers the LAST user question again without duplicating it.
  // A trailing '*Failed*' marker is removed; a bare user question without
  // an answer (legacy of the formerly silent errors) also counts.
  // 409 if the last message is a real answer.
  router.post('/regenerate', (req, res) => {
    const chatId = req.params.chatId;
    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });

    // Anchored variant (user report 2026-07-25): with the send queue several
    // questions can fail in a row, so the retry button sends ITS marker's id.
    // The retry answers the question right above that marker, with the
    // history up to that question, and the result takes the marker's slot —
    // retried answers never land under the wrong question.
    // One-off provider override: after quota exhaustion the retry may run
    // via the LOCAL model without changing the stored settings. Only
    // 'ollama' is allowed — cloud overrides would bypass the key checks.
    const overrideProvider = req.body?.provider;
    if (overrideProvider !== undefined && overrideProvider !== 'ollama') {
      return res.status(400).json({ error: "provider override must be 'ollama'" });
    }

    const targetId = req.body?.messageId;
    if (targetId) {
      const marker = db.prepare(
        'SELECT * FROM messages WHERE id = ? AND chat_id = ?'
      ).get(targetId, chatId);
      if (!marker || marker.role !== 'assistant' || !isRetryableMarker(marker.content)) {
        return res.status(409).json({ error: 'nothing to regenerate' });
      }
      const question = db.prepare(
        "SELECT * FROM messages WHERE chat_id = ? AND role = 'user' AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT 1"
      ).get(chatId, marker.created_at);
      if (!question) return res.status(409).json({ error: 'nothing to regenerate' });
      db.prepare('DELETE FROM messages WHERE id = ?').run(marker.id);
      const attachments = db.prepare('SELECT * FROM attachments WHERE message_id = ?').all(question.id);

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      return enqueueMessageJob({
        req, res,
        content: question.content,
        aliases: [],
        files: [],
        think: String(req.body?.think) === 'true',
        forceProvider: overrideProvider || null,
        regenerate: {
          userMsgId: question.id,
          createdAt: question.created_at,
          attachments,
          anchorCreatedAt: marker.created_at,
          historyUntil: question.created_at,
        },
      });
    }

    const last = db.prepare(
      'SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
    ).get(chatId);
    let userRow = null;
    if (last && last.role === 'user') {
      userRow = last;
    } else if (last && last.role === 'assistant' && isRetryableMarker(last.content)) {
      db.prepare('DELETE FROM messages WHERE id = ?').run(last.id);
      userRow = db.prepare(
        "SELECT * FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY created_at DESC, id DESC LIMIT 1"
      ).get(chatId);
    }
    if (!userRow) return res.status(409).json({ error: 'nothing to regenerate' });

    const attachments = db.prepare('SELECT * FROM attachments WHERE message_id = ?').all(userRow.id);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    enqueueMessageJob({
      req, res,
      content: userRow.content,
      aliases: [],
      files: [],
      think: String(req.body?.think) === 'true',
      forceProvider: overrideProvider || null,
      regenerate: { userMsgId: userRow.id, createdAt: userRow.created_at, attachments },
    });
  });

  // Runs ONE message job — always serially, via processJobQueue.
  async function runMessageJob(job) {
    const { req, res, content } = job;
    const chatId = req.params.chatId;

    // Read fresh — title/source may have changed since the job was
    // enqueued; deleted chats end the job cleanly.
    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    if (!chat) {
      sseWrite(res, { error: 'Chat not found' });
      return void res.end();
    }

    // The question was persisted at ENQUEUE (§10, pending=1). On dequeue it
    // becomes real: pending cleared, created_at re-stamped so the previous
    // answer keeps its place before this question. Regenerate re-answers an
    // existing question; a pending one (unanswered row) is claimed the same way.
    let userMsgId;
    let now;
    let attachments = [];
    if (job.regenerate) {
      userMsgId = job.regenerate.userMsgId;
      now = job.regenerate.createdAt;
      attachments = job.regenerate.attachments;
      const qRow = db.prepare('SELECT pending FROM messages WHERE id = ?').get(userMsgId);
      if (qRow?.pending) {
        now = monotonicNow(chatId);
        db.prepare('UPDATE messages SET pending = 0, created_at = ? WHERE id = ?').run(now, userMsgId);
      }
    } else {
      userMsgId = job.persisted.userMsgId;
      const qRow = db.prepare('SELECT * FROM messages WHERE id = ?').get(userMsgId);
      if (!qRow) {
        // Explicitly canceled between dequeue and here — nothing to do.
        return void res.end();
      }
      now = monotonicNow(chatId);
      db.prepare('UPDATE messages SET pending = 0, created_at = ? WHERE id = ?').run(now, userMsgId);
      attachments = db.prepare('SELECT * FROM attachments WHERE message_id = ?').all(userMsgId);
    }

    // Attachments with URLs for the frontend
    const userAttachments = attachments.map(a => ({
      id: a.id, alias: a.alias, filename: a.filename, mimetype: a.mimetype, size: a.size,
      url: `/uploads/${chatId}/${a.id}-${a.filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)}`,
    }));
    const userMessage = {
      id: userMsgId, chat_id: chatId, role: 'user', content, created_at: now,
      attachments: userAttachments,
    };

    // started event: the job is up. The UI uses it to replace its
    // optimistic question with the persisted one (real timestamp →
    // correct chronological sorting) and switches from "waiting" to the
    // thinking dots.
    sseWrite(res, { started: true, userMessage });

    // Attachment-derived pieces are budget-independent — computed once.
    // Text annexes of other files follow as their own system message AFTER
    // the question — the same pattern as the retrieval excerpts (rework
    // 2026-07-25). Previously the annex sat in the user message itself; the
    // history renders old messages without the annex though (only `content`
    // is persisted), so the prompt of the NEXT round diverged exactly from
    // the attachment message on: KV cache dead, with 64 KB attachments up
    // to ~18k tokens of re-prefill per follow-up question. Now the user
    // message stays byte-identical with its later history form; only the
    // annex block is one-off. (Images must stay in the user message —
    // known residual cache break.)
    const imageContents = attachments.map(attachmentToMultimodalContent).filter(Boolean);
    const textAnnex = buildAttachmentTextAnnex(attachments);

    // Build the context — system prompt (+ paper + ancestors) + history —
    // sized to the budget of the model that will ANSWER. Rebuilt on failover
    // when the candidate's budget differs (fix 2026-07-29): the ladder used
    // to ship the ACTIVE model's prompt to every candidate, so a Gemini-
    // sized full-text prompt hit Groq's 8k cap as a deterministic 413 and
    // the card claimed "too large" although a Groq-sized prompt (retrieval
    // mode) would have fit.
    let contextMessages, meta, chunkCount, excerptChars, currentBudgetChars;
    const buildContextFor = async (budgetFor) => {
      currentBudgetChars = contextBudget(db, budgetFor).maxSystemContextChars;
      const built = await buildSystemAndHistory(chat, {
        dropLastMessage: !job.regenerate?.historyUntil,
        historyUntil: job.regenerate?.historyUntil ?? null,
        budgetFor,
      });
      contextMessages = built.messages;
      meta = built.meta;
      const retrieval = built.retrieval;

      // Retrieval mode (ADR-0006): the chunks of the long source that best
      // match the question, as their own block after the history. Errors are
      // never fatal — the skeleton in the system prompt then carries the
      // answer alone.
      chunkCount = null;
      excerptChars = 0;
      if (retrieval && content) {
        try {
          const hits = await retrieveChunks(db, {
            sourceType: retrieval.sourceType,
            sourceId: retrieval.sourceId,
            query: content,
            k: RETRIEVE_K,
            ...(embedTextsFn ? { embedFn: embedTextsFn } : {}),
          });
          chunkCount = hits.length;
          if (hits.length > 0) {
            const excerptBlock = renderExcerpts(hits, retrieval.sourceType);
            excerptChars = excerptBlock.length;
            contextMessages.push({ role: 'system', content: excerptBlock });
          }
        } catch (err) {
          console.warn(`[retrieval] Chunk retrieval failed (${err.message}) — answering without excerpts.`);
        }
      }

      // Current user message: multimodal with images (see annex note above).
      if (imageContents.length > 0) {
        contextMessages.push({
          role: 'user',
          content: [{ type: 'text', text: content }, ...imageContents],
        });
      } else {
        contextMessages.push({ role: 'user', content });
      }
      if (textAnnex) {
        contextMessages.push({
          role: 'system',
          content:
            'ATTACHED FILES — contents of the files the user attached to their current message:' +
            textAnnex,
        });
      }
    };

    // Initial build for the model that actually starts: the one-off local
    // regenerate (forceProvider 'ollama') must get the LOCAL budget, not the
    // active cloud model's — same root cause as the failover mismatch.
    const startProvider = job.forceProvider ?? getSetting(db, 'llm_provider');
    await buildContextFor({
      provider: startProvider,
      model: getSetting(db, startProvider === 'ollama' ? 'ollama_model' : `${startProvider}_model`),
    });

    // Real questions have right of way: abort a possibly running warm-up
    // immediately so this job doesn't hang behind it in Ollama's queue.
    // (The SSE headers have been set since the POST.)
    abortActiveWarmup();

    try {
      let { client, model, provider } = job.forceProvider
        ? getLLMClientFor(db, job.forceProvider)
        : getLLMClient(db);

      // Thinking is OFF by default (answers start immediately). Only if the
      // client explicitly sends think=true may the model run its chain of
      // thought. Ollama /v1 translates reasoning_effort 'none' into
      // think=false; the thoughts stream as separate reasoning events to
      // the UI (collapsible panel), but never into answer text or DB.
      const thinkOn = job.think;
      let extras = thinkOn ? {} : noThinkExtras(provider);

      // Automatic provider failover (user requests 2026-07-25): quotas are
      // per MODEL, so candidates are tried in this order — remaining models
      // of the SAME provider (same key) first, then other keyed cloud
      // providers. Known-exhausted models (quota memory) and, for image
      // questions, text-only models are skipped. The stored settings stay
      // untouched: the next quota reset puts the user back on their
      // preferred model automatically.
      const modelKey = (p, m) => `${p}/${m}`;
      const tried = new Set([modelKey(provider, model)]);
      const pickFallback = () => {
        const reg = getRegistry(db);
        const order = [provider, ...Object.keys(reg.providers).filter((n) => n !== provider)];
        for (const name of order) {
          const p = reg.providers[name];
          if (!p || p.kind !== 'cloud') continue;
          if (!getSetting(db, `${name}_api_key`)) continue;
          const selected = getSetting(db, `${name}_model`);
          const models = [selected, ...p.models.map((m) => m.name).filter((n) => n !== selected)];
          for (const m of models) {
            if (tried.has(modelKey(name, m))) continue;
            if (isQuotaCoolingDown(name, m)) continue;
            // The ladder never gambles on paid-only models (cost tiers
            // 2026-07-30): without billing they fail deterministically, and
            // WITH billing a silent switch would spend money unasked. Paid
            // models answer only when deliberately selected.
            if (getModelInfo(db, name, m).free === false) continue;
            if (imageContents.length > 0 && !getModelInfo(db, name, m).vision) continue;
            return { provider: name, model: m };
          }
        }
        return null;
      };
      const failoverTo = async (target, reason) => {
        tried.add(modelKey(target.provider, target.model));
        const resolved = getLLMClientFor(db, target.provider);
        sseWrite(res, {
          failover: {
            from: provider,
            fromModel: model,
            to: target.provider,
            model: target.model,
            reason,
          },
        });
        client = resolved.client;
        model = target.model;
        provider = target.provider;
        extras = thinkOn ? {} : noThinkExtras(provider);
        // The prompt follows the model (fix 2026-07-29): rebuild when the
        // candidate's budget differs — a prompt sized for the failed model
        // may not fit the candidate (413) or waste most of its window.
        // Same-budget siblings keep the identical prompt (no wasted
        // chunking/embedding work).
        if (contextBudget(db, target).maxSystemContextChars !== currentBudgetChars) {
          await buildContextFor(target);
        }
      };

      // Vision gate (ADR-0008 slice 3, failover-aware): an image with a
      // text-only model must never be silently dropped — first try a
      // vision-capable candidate, otherwise fail with a clear hint.
      if (imageContents.length > 0 && !getModelInfo(db, provider, model).vision) {
        const to = pickFallback();
        if (to) {
          await failoverTo(to, 'no_vision');
        } else {
          const err = new Error(
            `${model} cannot read images. Remove the image or switch to a vision-capable model (e.g. Gemini 2.5 Flash or your local model).`
          );
          err.status = 400;
          err.failReason = 'no_vision';
          err.failModel = model;
          throw err;
        }
      }

      // Proactive skip: if the active model is known-exhausted, don't burn a
      // request on it — unless there is no candidate at all (then try anyway;
      // maybe the quota reset early).
      if (isQuotaCoolingDown(provider, model)) {
        const to = pickFallback();
        if (to) await failoverTo(to, 'cooldown');
      }


      // Stop button: when the client closes the connection, we abort the
      // upstream request — Ollama/OpenAI stop generating immediately.
      // The close handler has been attached to the request since enqueueing
      // (enqueueMessageJob) and calls job.abort; if the client was already
      // gone at job start, we abort immediately.
      const upstreamAbort = new AbortController();
      job.abort = upstreamAbort;
      if (job.clientClosed) upstreamAbort.abort();

      // 429 handling (ADR-0008 slice 5): per-minute limits of the free
      // tiers are visibly waited out in the queue (Retry-After respected,
      // max. 3 attempts); an exhausted DAILY limit fails immediately with a
      // switch hint. Retry only as long as no text has been streamed yet —
      // otherwise the answer would arrive twice.
      const retryAfterSeconds = (e) => {
        const raw = e?.headers?.['retry-after'] ?? e?.response?.headers?.['retry-after'];
        const parsed = parseInt(raw, 10);
        return Number.isFinite(parsed) ? Math.min(parsed, 120) : 20;
      };
      const sleep = (ms) => new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        upstreamAbort.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
      });

      let streamedAnything = false;

      // Tool-use loop: the LLM may call web_search on its own. On a tool
      // call we stream special SSE events to the frontend so it can show
      // "Searching the web…" and list the sources under the answer.
      const runStream = () => streamWithTools({
        client,
        model,
        messages: contextMessages,
        extras,
        signal: upstreamAbort.signal,
        onText: (delta) => {
          streamedAnything = true;
          res.write(`data: ${JSON.stringify({ delta })}\n\n`);
        },
        onToolEvent: (evt) => {
          res.write(`data: ${JSON.stringify({ tool: evt })}\n\n`);
        },
        onThinking: () => {
          res.write(`data: ${JSON.stringify({ thinking: true })}\n\n`);
        },
        onReasoning: (delta) => {
          res.write(`data: ${JSON.stringify({ reasoning: delta })}\n\n`);
        },
        onPerf: (perf) => {
          // One [perf] line per answer: the basis for every latency diagnosis
          // (prefill vs. decode). Enriched with mode, cache state and
          // source size — the three main drivers of wait time. Pure metrics,
          // NEVER conversation content (guaranteed in perf-log.js), nothing in the DB.
          const record = buildPerfRecord({
            now: new Date().toISOString(),
            chatId: req.params.chatId,
            model,
            mode: meta.mode,
            cache: meta.cache,
            sourceTokens: meta.sourceTokens,
            chunkCount,
            promptTokens: perf.promptTokens,
            ttftMs: perf.ttftMs,
            completionTokens: perf.completionTokens,
            tokensPerSecond: perf.tokensPerSecond,
            totalMs: perf.totalMs,
            finishReason: perf.finishReason,
          });
          console.log(formatPerfLine(record));
          // Analyzable history only on explicit request (SYFLO_PERF_LOG):
          // one JSON line per answer in logs/perf.jsonl, filterable via `jq`.
          if (isPerfJsonlEnabled()) appendPerfJsonl(record);
          // Token log (ADR-0008 slice 7): counting basis for the cost
          // estimate and the free-tier daily counter. Metrics only.
          try {
            db.prepare(
              'INSERT INTO usage_log (id, provider, model, prompt_tokens, completion_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)'
            ).run(
              crypto.randomUUID(), provider, model,
              perf.promptTokens ?? null, perf.completionTokens ?? null,
              new Date().toISOString()
            );
          } catch (_) { /* statistics must never cost an answer */ }
          // A prompt close to the context window means context shifting:
          // Ollama drops tokens at the front, the prefix changes on every
          // request and the KV cache never hits — exactly what the derived
          // character budget is meant to prevent. This warning is the safety net.
          if (provider === 'ollama' && perf.promptTokens && perf.promptTokens > CONTEXT_WINDOW_TOKENS * 0.9) {
            console.warn(
              `[perf] Prompt (${perf.promptTokens} tokens) is close to the context window ` +
              `(${CONTEXT_WINDOW_TOKENS}) — context shifting looms, KV cache becomes ineffective.`
            );
          }
          res.write(`data: ${JSON.stringify({ perf })}\n\n`);
        },
      });

      let fullContent;
      for (let attempt = 1; ; attempt++) {
        try {
          fullContent = await runStream();
          break;
        } catch (err) {
          if (upstreamAbort.signal.aborted) throw err; // stop button
          if (streamedAnything) throw err;
          const tooLarge = isTooLarge(err);
          const unavailable = isModelUnavailable(err);
          // Privacy guard (mockup-model-flow §11): the local provider is a
          // privacy promise — its failures NEVER fall over to the cloud
          // automatically, and no cooldown is remembered (availability is
          // re-checked live; local calls are free). Leaving the private mode
          // is an explicit, named click in the UI.
          if (provider === 'ollama') {
            if (unavailable) {
              err.failReason = 'local_missing';
              err.failModel = model;
            } else if (!err.status && /connection|fetch failed|ECONNREFUSED|ENOTFOUND|socket/i.test(err.message || '')) {
              err.failReason = 'local_unreachable';
            }
            throw err;
          }
          if (!isRateLimit(err) && !tooLarge && !unavailable) throw err;
          if (unavailable) {
            // Long cooldown: a retired model does not come back at midnight.
            markQuotaCooldown(provider, model, 24 * 60 * 60 * 1000, 'retired');
            const to = pickFallback();
            if (to) {
              await failoverTo(to, 'model_unavailable');
              attempt = 0;
              continue;
            }
            throw err;
          }
          // Billing gate (mockup-model-cost-tiers W4, 2026-07-30): a
          // zero-limit 429 is deterministic — it does not reset at midnight,
          // so no cooldown (nothing to wait out) and no ladder move (the
          // user picked this model deliberately; switching is their call
          // via the card, not an automatic failover).
          if (isBillingRequired(err)) {
            const out = new Error(
              `${model} has no free quota on ${provider} — it needs billing. Pick a free model or set up billing.`
            );
            out.quotaExhausted = true;
            out.quotaReason = 'billing';
            out.failProvider = provider;
            out.failModel = model;
            throw out;
          }
          const daily = isRateLimit(err) && isDailyQuota(err);
          // Remember the exhausted model so this and future requests skip it
          // (413 is request-size-dependent, not a quota — no cooldown).
          if (daily) markQuotaCooldown(provider, model, msUntilUtcMidnight(), 'daily');
          else if (!tooLarge) markQuotaCooldown(provider, model, 90_000, 'minute');
          // Waiting is only rational when there is no alternative: if any
          // candidate is free, switch IMMEDIATELY instead of backing off
          // (user request 2026-07-25 — "why wait 20 s when we switch anyway").
          const to = pickFallback();
          if (to) {
            await failoverTo(to, daily ? 'daily' : tooLarge ? 'too_large' : 'rate_limit');
            attempt = 0; // fresh retry budget on the fallback model
            continue;
          }
          if (daily) {
            const out = new Error(
              `The daily quota for ${provider} is exhausted — switch to another provider or the local model for today.`
            );
            // Every candidate was tried or is cooling down — the UI offers
            // the local model as a one-off emergency fallback.
            out.quotaExhausted = true;
            // Honest clock (§08): the daily card promises the DAILY reset,
            // never a sibling's 90 s minute cooldown.
            out.retryAt = earliestQuotaRetryAt('daily');
            // Cause for the precise card copy (mockup-quota-states v3):
            // daily → upgrade hint, no retry (it cannot work today).
            out.quotaReason = 'daily';
            // "Limit erhöhen" must open the billing page of the provider
            // whose limit hit — after a cross-provider failover that is not
            // the active provider.
            out.failProvider = provider;
            throw out;
          }
          if (tooLarge || attempt >= 3) {
            err.quotaExhausted = true;
            err.retryAt = tooLarge ? earliestQuotaRetryAt() : earliestQuotaRetryAt('minute');
            // too_large is size-dependent — retrying the identical request
            // fails deterministically, so the card offers switch/upgrade
            // instead of retry; rate_limit gets the countdown retry.
            err.quotaReason = tooLarge ? 'too_large' : 'rate_limit';
            err.failProvider = provider;
            throw err;
          }
          const wait = retryAfterSeconds(err);
          // Precise wait copy (mockup-quota-states §10, variant C): WHICH
          // minute limit bit — tokens (TPM) or requests (RPM) — and on
          // which model. Classified from the provider's 429 message.
          const scope = /token|TPM/i.test(err?.message || '') ? 'tokens' : 'requests';
          sseWrite(res, { rateLimit: { retryInSeconds: wait, attempt, scope, model } });
          await sleep(wait * 1000);
          if (upstreamAbort.signal.aborted) throw err;
        }
      }

      // After every answer, pull the model TTL back up to 1 h — otherwise
      // it falls back to Ollama's 5-minute default and the paper cache dies.
      if (provider === 'ollama') extendOllamaKeepAlive(model);

      // Stop button (user decision 2026-07-22): the half-generated answer
      // is NOT saved — in its place stands only the marker, which the
      // frontend renders as a gray "Interrupted" row (same string as
      // INTERRUPTED_MARKER in frontend/src/types).
      const aborted = upstreamAbort.signal.aborted;
      const assistantContent = aborted ? '*Interrupted*' : fullContent;

      const assistantMsgId = crypto.randomUUID();
      // Anchored regenerate: the replacement takes the old marker's slot so
      // the answer sits directly under its question.
      const assistantNow = job.regenerate?.anchorCreatedAt ?? monotonicNow(chatId);
      db.prepare(
        'INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(assistantMsgId, req.params.chatId, 'assistant', assistantContent, assistantNow);

      // Title generation as before — skip after an abort (the client is
      // gone, and another LLM call would just be wait time for the next
      // real question).
      const msgCount = db.prepare(
        'SELECT COUNT(*) as count FROM messages WHERE chat_id = ?'
      ).get(req.params.chatId);

      // Trees with a bound source are named after it (papers since
      // slice 03, videos ADR-0005) — the root keeps this name instead of
      // letting title generation overwrite it.
      const hasSourceName = Boolean(chat.paper_id || chat.video_id);
      if (!aborted && !hasSourceName && (chat.title === 'New Chat' || msgCount.count <= 2)) {
        // Caps, prompts and sanitizing live in ../title.js — the
        // passage-title endpoint (routes/chats.js) reuses exactly the same
        // rules, so a branch titled up front and one titled after the first
        // answer can never disagree.
        // Branch chats are titled after the SELECTED PASSAGE they were opened
        // from, not after the first question (user decision 2026-07-26): in
        // the sidebar tree "Kannst du mir alle" says nothing, a summary of
        // the marked text does.
        const branchQuote = chat.parent_word
          ? String(chat.parent_word).trim().slice(0, MAX_PASSAGE_CHARS)
          : null;

        // Fallback: first few words of the passage (branches) or of the
        // user's message, in case the LLM call fails.
        let newTitle = capTitleWords((branchQuote || content || 'Chat').trim());

        try {
          const { client: titleClient, model: titleModel, provider: titleProvider } = getLLMClient(db);
          const titleInstruction = branchQuote
            ? branchTitleInstruction(branchQuote)
            : chatTitleInstruction();
          // Ollama has exactly ONE KV cache slot (vision models force
          // parallel:1). A standalone title prompt would evict the
          // expensive paper prefix — the next question then pays the full
          // prefill again (~40 s measured, 2026-07-21). Therefore: the
          // same prompt base as the conversation (incl. tools, otherwise
          // the rendered prefix diverges) + the title question appended —
          // cache hit instead of eviction. Cloud providers keep the cheap
          // mini prompt (there every input token counts, not the local
          // cache).
          // Branches: the instruction already carries the passage — appending
          // the question would pull the summary toward the question again.
          const titleMessages = titleProvider === 'ollama'
            ? [...contextMessages, { role: 'assistant', content: fullContent }, titleInstruction]
            : branchQuote
              ? [titleInstruction]
              : [titleInstruction, { role: 'user', content: content || 'New chat' }];
          let titleCompletion;
          try {
            titleCompletion = await titleClient.chat.completions.create({
              model: titleModel,
              // For a 4-word title no thinking model may brood for minutes.
              ...noThinkExtras(titleProvider),
              messages: titleMessages,
              ...(titleProvider === 'ollama' ? { tools: ALL_TOOLS } : {}),
            });
          } catch (err) {
            if (!/does not support tools/i.test(err?.message || '')) throw err;
            titleCompletion = await titleClient.chat.completions.create({
              model: titleModel,
              ...noThinkExtras(titleProvider),
              messages: titleMessages,
            });
          }
          const raw = titleCompletion.choices[0]?.message?.content || '';
          if (raw.trim()) newTitle = raw.trim();
        } catch (_) { /* the fallback is good enough */ }

        // Strip wrapping quotes/backticks and trailing punctuation, drop line
        // breaks, enforce both caps, defuse a half-delimiter (../title.js).
        newTitle = sanitizeTitle(newTitle);

        db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(newTitle, req.params.chatId);
      }

      const assistantMessage = {
        id: assistantMsgId, chat_id: req.params.chatId, role: 'assistant', content: assistantContent, created_at: assistantNow,
        attachments: [],
      };

      res.write(`data: ${JSON.stringify({ done: true, userMessage, assistantMessage })}\n\n`);
      res.end();
    } catch (err) {
      // Errors are never silent anymore (incident 2026-07-24: answers
      // vanished without a log and without a trace in the DB): log, persist
      // a '*Failed*' marker in place of the answer and hand the client both
      // persisted messages — the UI shows the error row with retry.
      // One abort = one truth (§09): a stop or disconnect — whether it hits
      // mid-stream, during a rate-limit sleep or anywhere else — persists
      // the *Interrupted* marker, never *Failed*. The UI told the user
      // "Unterbrochen" the moment they clicked; the DB must agree.
      const wasAborted = job.abort?.signal?.aborted || job.clientClosed;
      if (wasAborted) {
        try {
          const interruptedId = crypto.randomUUID();
          const interruptedNow = job.regenerate?.anchorCreatedAt ?? monotonicNow(chatId);
          db.prepare(
            'INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
          ).run(interruptedId, chatId, 'assistant', INTERRUPTED_MARKER, interruptedNow);
        } catch (_) { /* DB error — nothing else to do, the client is gone */ }
        try { res.end(); } catch (_) { /* already closed */ }
        return;
      }
      console.error(`[messages] Answer in chat ${chatId} failed: ${err.message}`);
      // Machine-readable cause for the UI card (mockup-model-flow §05):
      // classify here what wasn't classified at the throw site. A key that
      // was valid on save but got revoked later surfaces as a 401 mid-use.
      if (!err.failReason && (err.status === 401 || err.response?.status === 401)) {
        err.failReason = 'bad_key';
        err.failProvider = err.failProvider || getSetting(db, 'llm_provider');
      }
      let assistantMessage = null;
      try {
        const failedId = crypto.randomUUID();
        const failedNow = job.regenerate?.anchorCreatedAt ?? monotonicNow(chatId);
        // Deterministic causes survive the reload (§06) — quota flags stay
        // transient by design, so they are never persisted here.
        db.prepare(
          'INSERT INTO messages (id, chat_id, role, content, created_at, fail_reason) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(failedId, chatId, 'assistant', FAILED_MARKER, failedNow, err.failReason ?? null);
        assistantMessage = {
          id: failedId, chat_id: chatId, role: 'assistant', content: FAILED_MARKER,
          created_at: failedNow, attachments: [],
          ...(err.failReason ? { fail_reason: err.failReason } : {}),
        };
      } catch (_) { /* DB error: at least the error event goes out */ }
      sseWrite(res, {
        error: err.message, userMessage, assistantMessage,
        ...(err.quotaExhausted ? { quotaExhausted: true } : {}),
        ...(err.quotaExhausted && err.retryAt ? { retryAt: new Date(err.retryAt).toISOString() } : {}),
        ...(err.quotaExhausted && err.quotaReason ? { quotaReason: err.quotaReason } : {}),
        ...(err.failReason ? { failReason: err.failReason } : {}),
        ...(err.failProvider ? { failProvider: err.failProvider } : {}),
        ...(err.failModel ? { failModel: err.failModel } : {}),
      });
      res.end();
    }
  }

  // The context builder is passed on to /api/explain (server.js):
  // word explanations thus share the same prompt prefix as the conversation —
  // cache hit instead of evicting the only KV slot (2026-07-25).
  router.buildSystemAndHistory = buildSystemAndHistory;
  // The quota memory is passed on to /api/explain too (2026-07-28): a limit
  // learned by either route is skipped proactively by both, and the picker
  // badges (GET /api/quota-cooldowns) see definitions' quota hits as well.
  router.isQuotaCoolingDown = isQuotaCoolingDown;
  router.markQuotaCooldown = markQuotaCooldown;
  // Cooldown snapshot for the model picker badges (mockup-quota-states.html
  // §06) — server.js exposes this as GET /api/quota-cooldowns. Only future
  // expiries are reported; model names may themselves contain '/'.
  // Settings PUT calls this (server.js wiring): waiting local jobs whose
  // provider is now cloud leave the FIFO immediately.
  router.reevaluateQueue = reevaluateQueue;
  router.getQuotaCooldowns = () => {
    const now = Date.now();
    const cooldowns = [];
    for (const [key, entry] of quotaCooldowns) {
      if (entry.until <= now) continue;
      const [providerName, ...modelParts] = key.split('/');
      cooldowns.push({
        provider: providerName,
        model: modelParts.join('/'),
        until: new Date(entry.until).toISOString(),
        kind: entry.kind,
      });
    }
    return cooldowns;
  };
  return router;
};
