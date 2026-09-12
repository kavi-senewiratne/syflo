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

// Search-wish causes that survive a reload. A missing key and a rejected key
// are facts about this machine's configuration and stay true; a used-up
// allowance is a fact about this month and resets on the 1st, so it is never
// stored (same rule as fail_reason — see database.js).
const STORED_SEARCH_WISH_ERRORS = new Set(['no-search-provider', 'tavily-invalid-key']);

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getLLMClient, getLLMClientFor, getSetting, noThinkExtras, extendOllamaKeepAlive } = require('../llm');
const { getModelInfo, getRegistry } = require('../registry');
const { streamWithTools, availableTools, toolsField, isTruncatedFinish } = require('../tools');
const { joinContinuation, continuationInstruction, condenseWrittenAnswer, detectLanguage, seamSuspect, LANGUAGE_NAMES } = require('../continuation');
const {
  DEFAULT_CHAT_TITLES, MAX_PASSAGE_CHARS, capTitleWords, sanitizeTitle,
  branchTitleInstruction, chatTitleInstruction, parseBranchTitleReply,
  outcomeInstruction, parseOutcomeReply,
} = require('../title');
const { getTreePaperContext } = require('../pdf-text');
const { getTreeVideoContext, transcriptTruncationNote, transcriptCutSeconds } = require('../youtube');
const {
  trimTrailingClosing,
  lastCoveredSeconds,
  capCoverage,
  isShortOfEnd,
  transcriptFrom,
  formatMark,
  overviewSectionTarget,
  overviewWindowTarget,
  stripRoundSignOff,
  stripLeadingNarration,
  closeUnbalancedBold,
} = require('../overview-progress');
const {
  ensureSourceChunks,
  retrieveChunks,
  buildSkeleton,
  RETRIEVE_K,
} = require('../retrieval');
const { buildPerfRecord, formatPerfLine, appendPerfJsonl, isPerfJsonlEnabled } = require('../perf-log');
const { recordUsage } = require('../usage');
const {
  isRateLimit, isDailyQuota, isTooLarge, isModelUnavailable, isBillingRequired,
  isOverloaded, msUntilQuotaReset, callCloudLadder, retryAfterSeconds, isBadKey,
  errorText,
} = require('../quota');
const {
  buildAncestorContext,
  renderAncestorText,
  applyContextBudget,
  CONTEXT_WINDOW_TOKENS,
  contextBudget,
} = require('../ancestor-context');

const MAX_TEXT_FILE_BYTES = 64 * 1024;

// Time budget for the side call after an answer (branch title + the mindmap's
// outcome line). It runs while the client still holds the SSE connection open
// for the done event, so the whole ladder gets one short budget and each single
// call a shorter one — a hanging candidate must not delay the answer's close.
const SIDE_CALL_BUDGET_MS = 12000;
const SIDE_CALL_MS = 6000;

// How often a 503 ("the model is experiencing high demand") is retried before
// the answer fails, and how long we wait in between. Growing pauses, because
// overload is a queue: hammering the same second makes it worse. Three tries
// with 2+4+8 s cost at most 14 s of waiting — long enough to ride out the
// spike measured on 2026-08-16, short enough that a real outage still fails
// while the user is still watching.
const OVERLOAD_BACKOFF_SECONDS = [2, 4, 8];

// How long a CLOUD answer may stay completely silent before the attempt is
// given up on. Measured 2026-08-26 against gemini-flash-latest: besides its
// 503s, one request produced nothing whatsoever — no headers, no error, no
// chunk, the socket still open after 60 s. With maxRetries 0 in the SDK and no
// deadline on the stream, that waited forever and the user saw a spinner and
// no card. The clock is re-armed by every chunk, so this bounds the SILENCE,
// not the answer: a long answer that keeps arriving is never cut off. 60 s
// because Google's own 503 takes 20-30 s to come back — a shorter budget
// would call an answer dead while the provider is still forming its refusal.
// Local (Ollama) is deliberately exempt: a whole-paper prefill legitimately
// sits silent for a minute or more on the 24 GB Mac.
const CLOUD_STALL_MS = 60000;

// How long a cloud answer may stay silent BEFORE its first token, measured
// separately because the two silences mean different things.
//
// Once text is flowing, a gap is a slow model and the 60 s above are right.
// Before the first token there is nothing to lose by asking someone else, and
// waiting is what the user actually felt: on 2026-08-29 an overview spent
// 3 x 60 s of pure silence on one model — the stall was fed into the 503 path,
// which deliberately retries IN PLACE (2 + 4 + 8 s backoff), so ~194 s could
// pass before any other model was tried. The ladder existed the whole time.
//
// 15 s is not "the model is broken", it is "someone else can start now".
// Thinking and tool events re-arm the clock like text does, so a model that
// reasons before it writes is not cut off. And it is only a LADDER move: with
// no candidate left, the in-place retry below still runs.
const FIRST_TOKEN_MS = 15000;

module.exports = (db, UPLOADS_DIR, options = {}) => {
  // Injectable for tests: (pdfPath) => Promise<string>.
  const extractPdfTextFn = options.extractPdfTextFn;
  // Injectable for tests: (texts) => Promise<number[][]> (retrieval.js).
  const embedTextsFn = options.embedTextsFn;
  // Injectable for tests: the growing pauses between overload retries. Real
  // seconds would make the 503 suite wait 14 s for what it asserts in code.
  const overloadBackoffSeconds = options.overloadBackoffSeconds || OVERLOAD_BACKOFF_SECONDS;
  // Injectable for tests: the silence a cloud answer may keep. Real seconds
  // would make the stall suite sit through a minute per assertion.
  const stallMs = options.stallMs ?? CLOUD_STALL_MS;
  // Injectable for tests, like stallMs. Defaults to the stall itself when a
  // suite overrides only that one — the old tests then keep their old clock.
  const firstTokenMs = options.firstTokenMs ?? (options.stallMs ? options.stallMs : FIRST_TOKEN_MS);
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
  async function buildSystemAndHistory(chat, {
    dropLastMessage,
    historyUntil = null,
    budgetFor = null,
    resumeFromSeconds = null,
    overview = false,
    continuedAnswer = null,
  }) {
    const contextMessages = [];
    // How far the transcript this round shows actually reaches (null: nothing
    // was cut). Travels out via meta so the answer can be stored with it.
    let transcriptCutAt = null;
    // Deliberately NO brevity rule (removed 2026-07-26, user decision):
    // answers may be as detailed as the question warrants. The old
    // "be concise by default" was a latency measure for local decoding
    // (~40 ms/token), but the perceived wait there is dominated by prefill,
    // not decode. If long local answers ever hurt again, reintroduce the
    // rule for provider === 'ollama' only — never globally.
    // No analogy rule either (removed 2026-08-12, user decision): the old
    // "always use analogies and real-world comparisons" made every answer
    // detour through a metaphor — a question about one term came back as a
    // mixing-desk story before it said anything about the term. Whether a
    // comparison helps is the answer's business, not a standing order; users
    // who want one ask for it, or put it in their custom instructions.
    let systemBase = 'You are a friendly and helpful assistant. Formatting rules: (1) Use proper Markdown for headings — always include a SPACE between the hash characters and the heading text: `# Heading`, `## Subheading`, `### Sub-subheading`. Never write `#Heading` without a space — it will not render as a heading. (2) Do NOT use emojis. Keep prose plain so it reads cleanly. (3) When the user attaches images, examine them carefully and describe what you see when relevant. (4) When the user asks about current or real-time information (news, weather, prices, recent events) or explicitly asks you to search the web, ALWAYS call the web_search tool first and base your answer on its results — never invent real-time information from memory, and never claim the tool is unavailable without having called it. (5) ALWAYS reply in the language of the user\'s most recent message — German message, German reply; English message, English reply. If a message mixes languages, reply in its dominant language. (6) Write EVERY mathematical expression that has an exponent, subscript, fraction, or math symbol as LaTeX inside inline math delimiters $…$ — e.g. $10^{50}$, $w_t$, $\\frac{a}{b}$, $27 \\times 27$. NEVER write a bare caret (^) or underscore (_) for math in plain text (write $10^{50}$, not 10^50), because a bare caret renders as a literal character instead of a superscript. Plain whole numbers without such notation may stay as normal text.';

    // Custom instructions (CONTEXT.md): user free text from the settings —
    // directly after the base rules and BEFORE paper/ancestor context, so
    // budget trimming never touches them. The explicit precedence line is
    // needed because small local models otherwise resolve rule conflicts
    // unpredictably.
    //
    // The Video overview is the one question they do NOT govern (user
    // decision 2026-09-04). It is not a question the user typed — the app
    // sends it by itself when a video is loaded — and its output shape is
    // fully prescribed below (## heading, time range, bold key point, bullet
    // list, section after section). Instructions written for ordinary answers
    // ("close with a mental model", "add a coaching block", "explain in
    // German first") collide with that shape, and because the overview is
    // written over many rounds the collision lands in the MIDDLE of the
    // finished text — the user saw their settings text sitting between two
    // chapters (report 2026-09-04). Suppressing the block outright is the
    // honest fix: continuationInstruction() had been reduced to arguing with
    // instructions round by round ("leave the closing sections out for now"),
    // and every round was another chance for the model to disagree.
    // `overview` is true for the first round AND every continuation of it,
    // so the whole overview is written without them; the next ordinary
    // question in the same chat gets them back.
    const customInstructions = getSetting(db, 'custom_instructions');
    const customInstructionsActive = Boolean(
      getSetting(db, 'custom_instructions_enabled') === 'true'
      && customInstructions.trim()
      && !overview
    );
    if (customInstructionsActive) {
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
    let videoContext = getTreeVideoContext(db, chat.id);

    // Continuing an overview: send only the transcript it has NOT worked
    // through yet. Writing on from 16:16 does not need the first sixteen
    // minutes, and re-sending them is what made a round cost ~19 000 prompt
    // tokens for as little as 15 generated — 356 000 prompt tokens in one
    // afternoon, and the day's quota gone (measured 2026-08-18). The block the
    // answer stopped inside stays, so the continuation can see the sentence it
    // has to finish.
    let transcriptResumedFrom = null;
    if (videoContext && resumeFromSeconds !== null) {
      const rest = transcriptFrom(videoContext.text, resumeFromSeconds);
      if (rest) {
        transcriptResumedFrom = rest.fromSeconds;
        videoContext = { ...videoContext, text: rest.text };
      }
    }

    // Inherited conversation context (design 2026-07-20): whole path up to
    // the root — parent verbatim, grandparents+ as cached summary, plus the
    // parent_word chain. Summary errors degrade silently to the context
    // without the affected summary; the lazy path here is the safety net
    // behind the warm-up at branch creation.
    // Filled for branch chats: the selection block that closes the prompt.
    let branchFocus = null;
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
    // overview lifts the cap to what the model can really take (2026-09-04) —
    // see contextBudget. sourceRoom follows it, so the if-then rule below
    // decides full text vs. retrieval against the SAME number the trimming
    // uses; two different budgets here would put a transcript into retrieval
    // that the overview then had room for after all.
    const budget = contextBudget(db, budgetFor, { overview });
    const sourceRoom = budget.maxSystemContextChars;

    // The Video overview is the one question retrieval cannot serve (user
    // decision 2026-08-20). Retrieval answers "where does he say X?" by
    // fetching the chunks that match the question; the overview asks for the
    // WHOLE video in order, and no handful of chunks matches that. Measured:
    // makemore Part 4 (108 393 chars) was the first transcript ever to exceed
    // the budget (97 184) — the skeleton branch has no overview rule at all,
    // so the answer came back as 4 694 chars with no time marks, and the
    // chapter list stayed empty. Everything shorter had passed through
    // full text and produced chapters, which is why this never showed before.
    //
    // Instead the transcript stays full text and applyContextBudget trims it
    // to what fits; transcriptTruncationNote tells the model where it was cut,
    // and overviewStopsShort + the continue endpoint carry on from the last
    // time mark. That machinery already exists for cut-off overviews — an
    // overview over a long video simply takes more than one round.
    const overviewOverLongVideo = overview && source && source.type === 'video';

    let retrieval = null;
    let sourceTextForPrompt = source ? source.text : null;
    if (source && source.text.length > sourceRoom && !overviewOverLongVideo) {
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
      //
      // Spelled out as an output SHAPE on 2026-08-15. The one-line version
      // ("do NOT summarize and do not drop content") was a prohibition, and a
      // prohibition leaves the model without a picture of what to produce
      // instead. The numbered form below states the target; every clause
      // answers a specific way the old rule was worked around — dropping the
      // last third once the context thinned out, merging two topics into one
      // section, abstracting a concrete number into "several", or ending on
      // "and so on" while looking complete.
      //
      // The time range is not decoration: markdown/timeLinks.ts turns every
      // [m:ss] into a link that opens YouTube at that second, so a missing
      // mark costs a section its jump target.
      //
      // Section GRANULARITY added 2026-09-04, user report: the overview of a
      // 3:42:37 talk arrived as 24 sections covering 27 minutes — one heading
      // per minute, and the chapter list under the player unusable as an
      // overview. The old wording invited it: "never merge two topics into one
      // section" plus "far longer than a summary" reads as an instruction to
      // cut as finely as possible, and a transcript block is a minute long, so
      // a minute became a topic. The repair says where the detail belongs
      // instead — in the bullet list inside a section, not in more sections —
      // and gives the model a rate it can check itself against.
      const note = transcriptTruncationNote(
        fitted.paperText, videoContext.text, videoContext.durationSeconds
      );
      transcriptCutAt = transcriptCutSeconds(fitted.paperText, videoContext.text);
      // A number beats a rate (user decision 2026-09-04): computed here from
      // the running time, with a floor and a ceiling, so a ten-minute video
      // does not come back as two sections and a four-hour one not as sixty.
      const sectionTarget = overviewSectionTarget(videoContext.durationSeconds);
      // The target is pro-rated to the window this round actually sees (user
      // report 2026-09-10): a 2:35:26 talk arrived as 18 half-minute sections
      // for its first 9:37 — Groq's budget had cut the transcript there, the
      // model could not know that was 6 % of the video, and the global "about
      // 22 in total" never triggered; the continuation, counting correctly,
      // then pressed the other 2 h 26 min into the 4 sections that were left.
      const windowFrom = transcriptResumedFrom ?? 0;
      const windowUntil = transcriptCutAt ?? videoContext.durationSeconds;
      const windowTarget = overviewWindowTarget(
        videoContext.durationSeconds, windowFrom, transcriptCutAt
      );
      systemBase +=
        `\n\nA YouTube video is attached to this conversation as its source: ` +
        `"${videoContext.title}"${videoContext.channel ? ` by ${videoContext.channel}` : ''}. ` +
        'Its full transcript (with [minute:second] marks) is included below. Base every answer ' +
        'about the video on this transcript; if something is not covered by it, say so instead ' +
        'of guessing.\n' +
        'When the user asks you to structure the video, work through the transcript from ' +
        'beginning to end and divide it into the sections the video itself has. Write the ' +
        'overview in the LANGUAGE OF THE USER\'S REQUEST — never in the transcript\'s ' +
        'language just because the transcript is longer. A section is ' +
        'a TOPIC the video spends time on, never a unit of time. ' +
        (sectionTarget
          ? `The FINISHED overview of this video should have about ${sectionTarget} sections ` +
            'in total — count them as you go, and if you are about to write many more than ' +
            'that, your sections are too small and belong merged. '
          : 'Aim for roughly one section per 5 to 10 minutes of video. ') +
        (windowTarget !== null
          ? `The transcript below is only a WINDOW of the video: it reaches from ` +
            `[${formatMark(windowFrom)}] to [${formatMark(windowUntil)}] of the ` +
            `[${formatMark(videoContext.durationSeconds)}] running time. Write about ` +
            `${windowTarget} section${windowTarget === 1 ? '' : 's'} for this window and no ` +
            'more — the remaining sections belong to the parts of the video that later ' +
            'rounds will see. Do NOT spend more sections on this window just because it is ' +
            'all you can see right now. '
          : '') +
        'Open a section shorter than 3 minutes only where the video really jumps (a sponsor ' +
        'break, a change of speaker), and NEVER start a new section merely because another ' +
        'minute has passed. Everything the speaker says inside a section belongs in that ' +
        'section\'s bullet list, which is where the detail lives; cutting finely does not add ' +
        'detail, it only takes the overview away. For EACH section, output in this order:\n' +
        '1. a "##" heading naming that section\'s topic, followed by its time range as ' +
        '[m:ss - m:ss] (use [h:mm:ss] past an hour)\n' +
        '2. one bold sentence stating the section\'s key point — the ENTIRE sentence must be ' +
        'inside the ** ** markers, with no unbolded label in front of it (do not write ' +
        '"**Key point:** the sentence" or "**Kernaussage:** der Satz" — that half-bolds it and ' +
        'breaks how the app reads this line); this is different from the bulleted list below, ' +
        'which DOES use a bold label\n' +
        '3. a bullet list carrying the substance — every claim, number, name, example, ' +
        'definition and step the speaker gives, in the speaker\'s own terms. Start EVERY ' +
        'bullet with its own point in bold — the term, the claim or the step it is about — ' +
        'then a colon and the detail, so the list can be skimmed by its bold openings alone\n' +
        'Keep the video\'s order. Never write ' +
        '"and so on", never skip a passage for being minor, and never replace a concrete ' +
        'figure or name with a general phrase. This is a RE-ORGANIZATION of the transcript, ' +
        'not a summary: it must be far longer than a summary and must let someone who has not ' +
        'watched the video follow every argument. If the material is too long to finish in one ' +
        'answer, simply stop at a section boundary — never silently shorten, and never write a ' +
        // Asking for the minute was the bug (user report 2026-09-04): the model
        // obliged with "[Ich habe Minute 40:39 erreicht und setze im nächsten
        // Schritt ab hier fort.]", the rounds were joined, and the sentence sat
        // between two chapters. The app never needed it — it reads the reach
        // from the section time ranges (overview-progress.js).
        'sentence about where you stopped or what you will do next. The app reads how far you ' +
        'got from your section time ranges, and the rounds are joined into ONE answer, so such ' +
        'a sentence would end up in the middle of it. ' +
        'Write NOTHING after that last section: no closing remarks and ' +
        'none of the closing sections your other instructions ask for (a mental model, a ' +
        'coaching block, a summary). They belong once, after the LAST section of the whole ' +
        'video — put in earlier they end up in the middle of the finished overview.\n' +
        '--- VIDEO TRANSCRIPT START ---\n' +
        fitted.paperText +
        (note || '') +
        // Without this line the model reads a transcript that opens at 16:00
        // and takes that for the start of the video — and dutifully writes an
        // introduction for it.
        (transcriptResumedFrom !== null
          ? `\n[Note: this transcript starts at ${formatMark(transcriptResumedFrom)}, not at the ` +
            'beginning of the video. Everything before that point is already covered by your ' +
            'previous answer, which is in the conversation above. Do not restate it.]'
          : '') +
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
      // Bug 2026-08-08: "Ich habe dies nicht verstanden." in a fresh branch
      // made the model explain the whole source instead of the selection.
      // The selection used to be one clause in the MIDDLE of the system
      // prompt — between the source text and the inherited parent transcript,
      // the weakest position there is. It now lives in its own message right
      // before the question (pushed at the end of this function), so it is
      // the last thing the model reads, and it spells out what a vague
      // reference points at. Weak fallback models (Flash Lite on an exhausted
      // quota) need that rule the most — exactly when the user notices.
      // The shared prefix (base rules + source) stays byte-identical and the
      // block is built here, so warm-up and real call agree: KV cache intact.
      // "everything above" used to include the custom instructions (fix
      // 2026-08-09): in a branch this block is the last thing the model
      // reads, so a blanket "only background" told it to drop the user's
      // settings instructions along with the source. The instructions are
      // explicitly exempted since.
      //
      // Second overcorrection of the same block (fix 2026-08-09): demoting
      // the inherited conversation to "background" and forbidding it outright
      // conflated WHAT to explain (the selection) with WHERE its words get
      // their meaning (the parent chat). Flash Lite took the prohibition
      // literally: a selection saying word embeddings need no "imaginary"
      // part was answered as language philosophy, although the parent chat —
      // present in the prompt, 5.7k characters of it — had just explained
      // imaginary NUMBERS two messages earlier. Subject and source of meaning
      // are separated now; the 2026-08-08 protection survives as the closing
      // sentence, which keeps the passage the subject.
      //
      // The origin block is the other half: nearness beats volume. The parent
      // transcript sits in the system message behind up to ~58k characters of
      // source text, so the paragraph the selection came from is repeated
      // HERE, right next to it. It costs at most ORIGIN_MAX_CHARS and sits
      // behind the history, so the shared prefix stays byte-identical.
      const originBlock = ancestor.origin
        ? `\n\nThe passage was selected from this part of the parent conversation ` +
          `(the ${ancestor.origin.role} message it appeared in) — this is what its ` +
          `terms refer to:\n"""\n${ancestor.origin.excerpt}\n"""\n\n`
        : ' ';
      branchFocus =
        `THE USER'S CURRENT FOCUS — this branch of the tree was opened from a selection. ` +
        // Only claim there ARE instructions above when there are: in an
        // overview they are deliberately absent (see customInstructionsActive).
        `${customInstructionsActive ? "The user's custom instructions above still apply in full. " : ''}${branchIntro}${originBlock}` +
        `When the user refers to "this", "that", "it" or "here", or says they did not ` +
        `understand something without naming it, they mean THE SELECTED PASSAGE. Explain ` +
        `that passage, and read its words in the sense the earlier conversation above gave ` +
        `them — that conversation is what decides which meaning a term carries here when it ` +
        `has both an everyday and a technical one. Keep the passage itself as the subject: ` +
        `widen to the source as a whole, or to the earlier conversation as a topic of its ` +
        `own, only when the user explicitly asks.`;
      contextMessages.push({
        role: 'system',
        content: `${systemBase} Context:\n\n${ancestorText}`,
      });
    } else {
      contextMessages.push({ role: 'system', content: systemBase });
    }

    // History (text only — old attachments are not re-uploaded in the context,
    // otherwise the prompt gets too big)
    const history = db.prepare(
      'SELECT id, role, content, created_at FROM messages WHERE chat_id = ? AND IFNULL(pending, 0) = 0 ORDER BY created_at ASC, id ASC'
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
      .map((m) => (continuedAnswer && m.id === continuedAnswer.id
        ? { ...m, content: condenseWrittenAnswer(continuedAnswer.content) }
        : m))
      .forEach(m => contextMessages.push({ role: m.role, content: m.content }));

    // Instruction sandwich (2026-08-09): the custom instructions are repeated
    // as their own message behind the history. Reported symptom: in deep trees
    // the answers stopped following the settings instructions. The block sat
    // at the very FRONT of the system prompt, and by then the prompt had grown
    // to ~20k tokens (perf log, gemini-flash-lite) — source, ancestor context
    // and the branch's own history all between the rule and the question.
    // Same reasoning, same position as the branch focus below (bug 2026-08-08):
    // what must be obeyed belongs next to the question, not at the top.
    // The front copy stays where it is, so the shared prefix — and with it
    // Ollama's KV cache and the warm-up contract — is byte-identical.
    if (customInstructionsActive) {
      contextMessages.push({
        role: 'system',
        content:
          "REMINDER — the user's custom instructions from Settings, repeated here because " +
          'they govern the answer you are about to write. They outrank the style rules and ' +
          'anything the conversation above did differently.\n' +
          '--- CUSTOM INSTRUCTIONS START ---\n' +
          customInstructions +
          '\n--- CUSTOM INSTRUCTIONS END ---',
      });
    }

    // The selection closes the prompt — after the branch's own history, so
    // it stays the last instruction no matter how long the conversation gets.
    if (branchFocus) contextMessages.push({ role: 'system', content: branchFocus });

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

    return { messages: contextMessages, retrieval, meta: { mode, sourceTokens, cache, transcriptCutAt } };
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
          // diverges and the cache misses. availableTools caches its answer
          // for a moment precisely so these three call sites agree, and
          // toolsField keeps "no tools" spelled the same way in all three.
          ...toolsField(await availableTools({ db })),
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
  // The only way OUT of the memory (mockup-onboarding-flow §02, 2026-08-15):
  // one answer that actually arrived. An expired wait alone proves nothing —
  // it only means the clock ran out, which is why an expired entry survives
  // as 'unknown' (see getQuotaCooldowns) instead of vanishing.
  const clearQuotaCooldown = (p, m) => quotaCooldowns.delete(`${p}/${m}`);
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
    // Anchor of an "Ask in chat" quote: the highlight the quoted passage was
    // taken from, so the rendered quote can jump back to it. Optional — a
    // question without a quote, and a PDF quote saved without a color, send
    // nothing here.
    const quoteHighlightId = req.body.quoteHighlightId || null;
    // Save-&-retry after a search key arrived: the query the model wished for.
    // A plain resend is not enough — the identical question plus the model's
    // own "I cannot search" answer sit one turn above in the history, and the
    // model paraphrases itself instead of calling the tool (verified in the
    // running app, 2026-09-12).
    const searchNudge =
      typeof req.body.searchNudge === 'string'
        ? req.body.searchNudge.trim().slice(0, 300)
        : '';
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
    const overviewRequest = String(req.body.overview) === 'true';
    db.prepare(
      'INSERT INTO messages (id, chat_id, role, content, created_at, pending, quote_highlight_id, overview_request) VALUES (?, ?, ?, ?, ?, 1, ?, ?)'
    ).run(userMsgId, chatId, 'user', content, enqueuedAt, quoteHighlightId, overviewRequest ? 1 : 0);
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
      // The client says whether this is the Video overview request; the
      // backend must not guess it from the question text, or the same flag
      // would depend on the app language and on the user rewording the
      // prompt. It only turns retrieval off (see buildSystemAndHistory).
      overview: overviewRequest,
      searchNudge: searchNudge || null,
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
  // Continue writing a cut-off answer (design/mockup-truncated-answer.html
  // §01). Not a regenerate: regenerate REPLACES an answer, this one grows it.
  // The text that arrived is real work the user already paid tokens for, and
  // for a Video overview it is also the chapters already parsed — throwing it
  // away to start over is the one thing the card must not do.
  router.post('/continue', (req, res) => {
    const chatId = req.params.chatId;
    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });

    const target = db.prepare(
      'SELECT * FROM messages WHERE id = ? AND chat_id = ?'
    ).get(req.body?.messageId, chatId);
    // Two kinds of unfinished, one endpoint.
    //
    // The flag catches an answer the provider CUT. It used to be the only key,
    // and on 2026-08-18 that turned out to be half the problem: Flash Lite
    // ended cleanly after covering 16:16 of a 1:06:31 video, so nothing was
    // truncated, nothing offered to continue, and the reader got a quarter of
    // the video with no sign of it. The overview's own time marks say how far
    // it got — measured against the video's length, that is a fact no model
    // can talk its way out of.
    const video = target ? getTreeVideoContext(db, chatId) : null;
    // Writing on means the answer is not over — so the sections the model puts
    // at the END of a round (a mental model, a coaching block, "the video is
    // long, I stop here") must not stay where they are. They are cut here and
    // the continuation grows from the last real chapter; the model writes them
    // again when the overview is genuinely finished (user report 2026-08-18).
    const existing = video ? trimTrailingClosing(target.content) : target?.content;
    // Capped at what the last round could SEE: a closing section that runs to
    // the video's end over a transcript that stopped an hour earlier is the
    // truncation note echoed back, and taking it at face value is what ended
    // the Neel Nanda overview at 43 % (2026-09-02).
    const covered = target
      ? capCoverage(lastCoveredSeconds(existing), target.covered_until_seconds)
      : null;
    const stoppedEarly = Boolean(video && isShortOfEnd(covered, video.durationSeconds));
    if (!target || target.role !== 'assistant' || (!target.truncated && !stoppedEarly)) {
      return res.status(409).json({ error: 'nothing to continue' });
    }
    const question = db.prepare(
      "SELECT * FROM messages WHERE chat_id = ? AND role = 'user' AND created_at < ? " +
      'ORDER BY created_at DESC, id DESC LIMIT 1'
    ).get(chatId, target.created_at);
    if (!question) return res.status(409).json({ error: 'nothing to continue' });

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
      forceProvider: null,
      continueOf: {
        assistantMsgId: target.id,
        assistantCreatedAt: target.created_at,
        existingContent: existing,
        userMsgId: question.id,
        userCreatedAt: question.created_at,
        // A cut answer is picked up mid-word ('seam'); one that merely stopped
        // early starts a new section ('append').
        mode: target.truncated ? 'seam' : 'append',
        // Second attempt after a round whose seam could not be verified
        // (mockup-truncated-answer §04). The client sets this on its immediate
        // retry; a suspect seam is then appended anyway — flagged — instead of
        // being discarded again, because a third call would buy the same coin
        // flip at the same price.
        seamRetry: req.body?.seamRetry === true,
        // Where the answer got to. The transcript before this second is
        // already worked through, and re-sending it is what made a round cost
        // ~19 000 prompt tokens for as few as 15 generated (measured
        // 2026-08-18) — enough to exhaust a day's quota in an afternoon.
        resumeFromSeconds: covered,
        videoDurationSeconds: video ? video.durationSeconds : null,
      },
    });
  });

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
      // Besides the *Failed*/*Interrupted* markers, a REAL answer may be
      // regenerated when its seam is flagged (mockup-truncated-answer §04):
      // the text is damaged in the middle, and the warning card's button is
      // an explicit reader decision to trade it for a fresh one.
      const retryable = marker && marker.role === 'assistant'
        && (isRetryableMarker(marker.content) || Boolean(marker.seam_suspect));
      if (!retryable) {
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
        // Retrying a failed Video overview must stay in overview mode
        // (full text, not retrieval/chunking) — see the messages.overview_request
        // migration note in database.js.
        overview: Boolean(question.overview_request),
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
      // See the overview_request note on the targetId branch above.
      overview: Boolean(userRow.overview_request),
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
    if (job.continueOf) {
      // A continuation has no new question — it re-uses the one the cut-off
      // answer belongs to, and nothing about that row changes.
      userMsgId = job.continueOf.userMsgId;
      now = job.continueOf.userCreatedAt;
    } else if (job.regenerate) {
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
    // Read the anchor back from the row instead of from the job: this event
    // REPLACES the frontend's optimistic question, so anything missing here
    // silently disappears from the open chat until the next reload — which is
    // exactly how the quote lost its jump on the first try (2026-08-08).
    // Regenerate takes the same path and keeps the original question's anchor.
    const anchorRow = db.prepare('SELECT quote_highlight_id FROM messages WHERE id = ?').get(userMsgId);
    const userMessage = {
      id: userMsgId, chat_id: chatId, role: 'user', content, created_at: now,
      attachments: userAttachments,
      quote_highlight_id: anchorRow?.quote_highlight_id ?? null,
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
    // Continuing an overview is an overview too: resumeFromSeconds is set
    // only by the continue endpoint for a Video overview, and its second
    // half must stay in the same full-text mode — and on the same lifted
    // budget — as its first.
    const isOverview = Boolean(job.overview) || job.continueOf?.resumeFromSeconds != null;
    let contextMessages, meta, chunkCount, excerptChars, currentBudgetChars;
    const buildContextFor = async (budgetFor) => {
      currentBudgetChars = contextBudget(db, budgetFor, { overview: isOverview }).maxSystemContextChars;
      const built = await buildSystemAndHistory(chat, {
        // A continuation needs the FULL history including the cut-off answer:
        // that text is what the model has to pick up mid-sentence.
        dropLastMessage: job.continueOf ? false : !job.regenerate?.historyUntil,
        historyUntil: job.regenerate?.historyUntil ?? null,
        budgetFor,
        resumeFromSeconds: job.continueOf?.resumeFromSeconds ?? null,
        overview: isOverview,
        // The answer being written on goes into the prompt condensed, and from
        // `existingContent` — the version the continuation actually grows from
        // (trailing closing sections already trimmed), not the raw DB row.
        continuedAnswer: job.continueOf
          ? { id: job.continueOf.assistantMsgId, content: job.continueOf.existingContent }
          : null,
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
          // In a branch the question alone is a bad query (bug 2026-08-08):
          // "Ich habe dies nicht verstanden." has no content word, so it
          // matches nothing and the passage the branch was opened from never
          // reaches the excerpts. The selection carries the topic — prepend
          // it so a vague follow-up still retrieves around its own passage.
          const retrievalQuery = chat.parent_word
            ? `${String(chat.parent_word).slice(0, MAX_PASSAGE_CHARS)}\n${content}`
            : content;
          const hits = await retrieveChunks(db, {
            sourceType: retrieval.sourceType,
            sourceId: retrieval.sourceId,
            query: retrievalQuery,
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
      // In a branch the selection is prefixed to the question (bug
      // 2026-08-08). A system message saying "vague references mean the
      // selection" was NOT enough — measured against the running app with
      // gemini-flash-lite on a 67k-char prompt, the model still explained the
      // whole paper; prefixed to the user turn it explained the passage. It
      // is the same repair the user made by hand ("also ich meine, was ich
      // markiert habe"). Prompt scaffolding only: the stored message, and
      // therefore the tree and the UI, keep the raw question.
      let askedText = chat.parent_word
        ? `[Selected passage from the source, the subject of this branch: ` +
          `"${String(chat.parent_word).trim().slice(0, MAX_PASSAGE_CHARS)}"]\n\n${content}`
        : content;
      // The FIRST overview round names its language too (user report
      // 2026-09-12): the mirror rule sits in the system block ABOVE the whole
      // transcript, and gemini-flash-lite answered the German overview request
      // in English from the very first heading — it followed the tens of
      // thousands of English source tokens, not the far-away rule. Same lever
      // as the continuation fix (2026-09-05), same placement lesson as the
      // branch selection (2026-08-08): name the language next to where the
      // model answers, and take away the excuse it actually used — a source in
      // another language. The overview prompt follows the app language
      // (ADR-0005), so detecting it from the request itself is reliable; with
      // no clear signal nothing is appended and today's behavior stands.
      // Prompt scaffolding only: the stored message, and therefore the tree
      // and the UI, keep the raw question.
      // A single suffix line was NOT enough (verified live 2026-09-12 against
      // gemini-flash-lite on a fresh chat: the very same request answered
      // German with chat history present and English without it). Two
      // reinforcements, measured to matter for a small model over a large
      // foreign-language source: the demand is a SANDWICH (first and last
      // thing in the user turn), and the prefix is written IN the target
      // language — an instruction that is itself German pulls the answer
      // toward German harder than an English sentence about German. The
      // German string is prompt copy, not code (same status as the DE half
      // of strings.ts).
      const OVERVIEW_LANGUAGE_PREFIX = {
        de: '[Antworte AUSSCHLIESSLICH auf Deutsch — jede Überschrift, jede Kernaussage, ' +
          'jeder Stichpunkt. Auch wenn das Transkript in einer anderen Sprache ist, bleibt ' +
          'die gesamte Antwort deutsch.]',
        en: '[Answer ONLY in English — every heading, key point and bullet. Even if the ' +
          'transcript is in another language, the entire answer stays English.]',
      };
      const overviewLanguage = job.overview && !job.continueOf ? detectLanguage(content) : null;
      if (LANGUAGE_NAMES[overviewLanguage]) {
        askedText =
          `${OVERVIEW_LANGUAGE_PREFIX[overviewLanguage]}\n\n${askedText}` +
          `\n\n[Write the ENTIRE overview in ${LANGUAGE_NAMES[overviewLanguage]}, the language ` +
          'of this request. A transcript in another language does NOT change the language of ' +
          'the answer — only quoted terms and proper names stay as spoken.]';
      }
      // Save-&-retry after a search key arrived (design/mockup-search-key-saved
      // .html): name the tool AND the query, or the model copies its own
      // refusal from one turn above instead of calling it — "call the
      // web_search tool" is the same push the 2026-08-25 verification needed.
      // Prompt scaffolding only: the stored message keeps the raw question.
      if (job.searchNudge) {
        askedText +=
          `\n\n[The web search key is configured now. Call the web_search tool with the ` +
          `query: "${job.searchNudge}" and answer from its results. Do not repeat the ` +
          `earlier answer that said searching was unavailable.]`;
      }
      if (job.continueOf) {
        // One instruction, two shapes — and in both the model is told NOT to
        // write the closing sections the user's custom instructions ask for:
        // a round is not an answer, and a "## Mentales Modell" per round ended
        // up in the middle of one overview (user report 2026-08-18).
        const from = job.continueOf.resumeFromSeconds;
        const total = job.continueOf.videoDurationSeconds;
        // Name the language of the text written so far, so a long overview
        // over an English transcript cannot drift out of German mid-way
        // (user report 2026-09-05). Derived from what is already on screen,
        // so the continuation always matches the answer it extends.
        const priorLanguage = detectLanguage(job.continueOf.existingContent);
        contextMessages.push({
          role: 'user',
          content: continuationInstruction({
            mode: job.continueOf.mode,
            fromMark: from !== null && from !== undefined ? formatMark(from) : null,
            untilMark: total ? formatMark(total) : null,
            language: priorLanguage,
          }),
        });
      } else if (imageContents.length > 0) {
        contextMessages.push({
          role: 'user',
          content: [{ type: 'text', text: askedText }, ...imageContents],
        });
      } else {
        contextMessages.push({ role: 'user', content: askedText });
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

    // Who the answer is riding on, visible OUTSIDE the try: a call that never
    // reached the stream loop (context build, client resolution) still has to
    // land in usage_log, and `provider`/`model` below live inside the try.
    // `failureLogged` keeps the two logging sites from counting one spent call
    // twice — the stream loop logs the candidate that failed, the outer catch
    // only what never got that far.
    let usedProvider = startProvider;
    let usedModel = getSetting(db, startProvider === 'ollama' ? 'ollama_model' : `${startProvider}_model`);
    let failureLogged = false;

    try {
      let { client, model, provider } = job.forceProvider
        ? getLLMClientFor(db, job.forceProvider)
        : getLLMClient(db);
      usedProvider = provider;
      usedModel = model;

      // Thinking is OFF by default (answers start immediately). Only if the
      // client explicitly sends think=true may the model run its chain of
      // thought. Ollama /v1 translates reasoning_effort 'none' into
      // think=false; the thoughts stream as separate reasoning events to
      // the UI (collapsible panel), but never into answer text or DB.
      const thinkOn = job.think;
      let extras = thinkOn ? {} : noThinkExtras(provider, model);

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
        usedProvider = provider;
        usedModel = model;
        extras = thinkOn ? {} : noThinkExtras(provider, model);
        // The prompt follows the model (fix 2026-07-29): rebuild when the
        // candidate's budget differs — a prompt sized for the failed model
        // may not fit the candidate (413) or waste most of its window.
        // Same-budget siblings keep the identical prompt (no wasted
        // chunking/embedding work).
        if (contextBudget(db, target, { overview: isOverview }).maxSystemContextChars !== currentBudgetChars) {
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
      const sleep = (ms) => new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        upstreamAbort.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
      });

      let streamedAnything = false;
      let lastFinishReason = null;
      // Overload retries (mockup-truncated-answer §03): own budget, separate
      // from the 429 attempts above — a saturated provider says nothing about
      // this request's token cost, so one cause must not eat the other's tries.
      let overloadAttempt = 0;

      // Set by onToolEvent below, read when the answer is stored. A retry
      // re-runs the whole stream, so the last attempt's verdict wins — which
      // is the one whose text is kept.
      let searchWish = null;

      // Re-armed by every sign of life from upstream — text, a thought, a
      // tool event, the closing perf chunk. Replaced by the stall guard for
      // the duration of a watched attempt and reset to a no-op afterwards.
      let noteUpstreamActivity = () => {};

      // Tool-use loop: the LLM may call web_search on its own. On a tool
      // call we stream special SSE events to the frontend so it can show
      // "Searching the web…" and list the sources under the answer.
      const runStream = (signal) => streamWithTools({
        client,
        model,
        messages: contextMessages,
        extras,
        // The web search is only offered when one is configured (a stored
        // Tavily key); otherwise the model would call a tool that can only
        // fail. searchDeps also binds the tool's implementation to db.
        searchDeps: { db },
        signal,
        onText: (delta) => {
          // Order matters: the deadline re-arms itself from this flag, and the
          // first chunk has to buy the LONG budget, not another short one.
          streamedAnything = true;
          noteUpstreamActivity();
          res.write(`data: ${JSON.stringify({ delta })}\n\n`);
        },
        onToolEvent: (evt) => {
          noteUpstreamActivity();
          res.write(`data: ${JSON.stringify({ tool: evt })}\n\n`);
          // The model wanted to search and nobody looked. Kept for the row
          // below, not just for the stream: the card would otherwise vanish on
          // the next chat switch (user report 2026-08-25) and a stale answer
          // would look current. Only deterministic causes — a used-up
          // allowance resets on the 1st, so storing it would lie next month.
          if (evt.phase === 'result' && evt.name === 'web_search' && evt.result?.error) {
            searchWish = STORED_SEARCH_WISH_ERRORS.has(evt.result.error)
              ? { query: evt.result.query ?? '', error: evt.result.error }
              : null;
          }
        },
        onThinking: () => {
          noteUpstreamActivity();
          // Thinking OFF means the user asked not to see it. Some models think
          // anyway (gpt-oss on Groq rejects reasoning_effort 'none' and takes
          // 'low', so it produces a little reasoning regardless — user report
          // 2026-09-06: a "thought for 7s" line over an overview with Thinking
          // off). Swallow the reasoning stream in that case: it never reaches
          // the answer or the DB, so hiding the indicator is the whole fix.
          if (!thinkOn) return;
          res.write(`data: ${JSON.stringify({ thinking: true })}\n\n`);
        },
        onReasoning: (delta) => {
          noteUpstreamActivity();
          if (!thinkOn) return;
          res.write(`data: ${JSON.stringify({ reasoning: delta })}\n\n`);
        },
        onPerf: (perf) => {
          noteUpstreamActivity();
          // The provider's own verdict on how this answer ended. 'stop' and
          // 'tool_calls' are clean; anything else (length, content_filter,
          // Gemini's MAX_TOKENS/RECITATION, or a missing finish chunk) means
          // the text stopped mid-thought — the only witness there is, since
          // a cut-off answer reads like a finished one.
          lastFinishReason = perf.finishReason ?? null;
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
          // The INSERT lives in ../usage.js now — six call sites write this
          // table since 2026-08-11, and a copied statement is how they would
          // start disagreeing about the columns.
          recordUsage(db, {
            provider,
            model,
            kind: 'chat',
            outcome: 'ok',
            promptTokens: perf.promptTokens,
            completionTokens: perf.completionTokens,
          });
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

      /**
       * The same stream, but with a deadline on SILENCE (see CLOUD_STALL_MS).
       *
       * The stall gets its OWN controller, combined with the stop button's:
       * `upstreamAbort` is what the catch below reads to tell a user's stop
       * from a provider's failure, and it must stay untouched — an aborted
       * signal never un-aborts, so retrying on it would abort instantly.
       */
      const runStreamWatched = async () => {
        // The local path stays as it was (CLAUDE.md: no complexity on Ollama).
        if (provider === 'ollama' || !stallMs) return runStream(upstreamAbort.signal);

        const stall = new AbortController();
        let timedOut = false;
        const fire = () => { timedOut = true; stall.abort(); };
        // Two clocks, one timer: the short one runs until the first sign of
        // life, the long one between chunks of an answer already arriving.
        // `noteUpstreamActivity` fires on text, reasoning, thinking and tool
        // events, so the switch happens at the first of those — a model that
        // reasons for twenty seconds before writing is never cut off.
        const budget = () => (streamedAnything ? stallMs : firstTokenMs);
        let timer = setTimeout(fire, budget());
        noteUpstreamActivity = () => {
          if (timedOut) return;
          clearTimeout(timer);
          timer = setTimeout(fire, budget());
        };
        // A user's stop wins over the deadline: they aborted the same combined
        // signal, and their own click must not come back to them as a provider
        // fault. And a silence that begins mid-answer is NOT a dead attempt —
        // the text that did arrive is kept and read as the cut-off answer it
        // is, which the truncation machinery already knows how to continue.
        const deadAttempt = () =>
          timedOut && !streamedAnything && !upstreamAbort.signal.aborted;
        const stalled = () => {
          const out = new Error(
            `${model} on ${provider} sent nothing for ${Math.round(firstTokenMs / 1000)} s.`
          );
          out.stalled = true;
          return out;
        };
        try {
          // streamWithTools reads any abort as the stop button and RETURNS the
          // text so far rather than throwing (tools.js), so the deadline has to
          // be checked on the way out as well, not only in the catch.
          const text = await runStream(AbortSignal.any([upstreamAbort.signal, stall.signal]));
          if (deadAttempt()) throw stalled();
          return text;
        } catch (err) {
          if (err.stalled || !deadAttempt()) throw err;
          throw stalled();
        } finally {
          clearTimeout(timer);
          noteUpstreamActivity = () => {};
        }
      };

      let fullContent;
      for (let attempt = 1; ; attempt++) {
        try {
          fullContent = await runStreamWatched();
          // Proof of life for the model that answered (provider/model may
          // have moved down the failover ladder above): its quota memory is
          // dropped here and nowhere else. Anything short of a real answer —
          // above all a wait that merely ran out — leaves the entry standing.
          clearQuotaCooldown(provider, model);
          break;
        } catch (err) {
          // A refused call is a SPENT call. The provider counted it, the meter
          // did not — which is how the model window claimed "0/20" for Gemini
          // Flash while its daily quota was gone (measured 2026-08-11: four
          // logged answers on 2026-08-10, a full limit). Logged HERE, at the
          // failing candidate, not in the outer catch: a 429 on model A
          // followed by a clean answer from model B used to leave only B's
          // row, and A's spent request stayed invisible.
          // A stop is the user's own doing and gets no row.
          if (!upstreamAbort.signal.aborted) {
            recordUsage(db, {
              provider, model, kind: 'chat',
              outcome: isRateLimit(err) ? 'quota' : 'failed',
            });
            failureLogged = true;
          }
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
          // Provider overloaded (503 UNAVAILABLE, "high demand"): the same
          // request succeeds seconds later — measured 2026-08-16, five 503s
          // and one clean answer for one prompt inside four minutes. So it is
          // retried IN PLACE: no cooldown (overload is weather, not an
          // exhausted budget) and no ladder move (the model itself is fine).
          // The wait is announced over SSE like the 429 countdown — the user
          // learns the provider is busy instead of watching nothing happen.
          // A silence that ran out its deadline joins the 503s here: from the
          // user's seat both are the same event — the provider is not
          // answering right now — and both pass on their own, so both are
          // retried in place and neither earns a cooldown.
          // A model that has not said a word yet is the one case where waiting
          // buys nothing: nobody has invested anything in this attempt, and
          // the ladder is standing right there. So a stall asks the next
          // candidate FIRST and only falls back on the in-place retry when
          // there is nobody left to ask (user request 2026-09-01 — "the user
          // should not wait 50 seconds, we should switch models").
          //
          // No cooldown either way: silence is weather, and the model is
          // expected back. It is simply not worth standing in the rain for.
          if (err.stalled) {
            const to = pickFallback();
            if (to) {
              await failoverTo(to, 'stalled');
              attempt = 0;
              overloadAttempt = 0; // a fresh model gets the full retry budget
              continue;
            }
          }
          if (isOverloaded(err) || err.stalled) {
            if (overloadAttempt >= overloadBackoffSeconds.length) {
              err.failReason = 'overloaded';
              err.failProvider = provider;
              err.failModel = model;
              throw err;
            }
            const wait = overloadBackoffSeconds[overloadAttempt];
            overloadAttempt += 1;
            sseWrite(res, {
              overloaded: {
                retryInSeconds: wait,
                attempt: overloadAttempt,
                maxAttempts: overloadBackoffSeconds.length,
                provider,
                model,
              },
            });
            await sleep(wait * 1000);
            if (upstreamAbort.signal.aborted) throw err;
            attempt = 0; // an overload round never spends the 429 budget
            continue;
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
          if (daily) markQuotaCooldown(provider, model, msUntilQuotaReset(provider), 'daily');
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
          const scope = /token|TPM/i.test(errorText(err)) ? 'tokens' : 'requests';
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
      let assistantContent = aborted ? '*Interrupted*' : fullContent;

      // Cut short by the provider? Only for answers that actually carry text:
      // an aborted one is already the *Interrupted* marker, and marking that
      // truncated would offer to continue a text nobody kept.
      const truncated = !aborted && isTruncatedFinish(lastFinishReason) && Boolean(assistantContent);
      // The sign-off no overview round may keep (user report 2026-09-04). The
      // prompt asks the model not to write it and the model writes it anyway,
      // so it is removed here, on the way into the database — before the
      // rounds are joined and the line would land between two chapters.
      if (isOverview) {
        assistantContent = closeUnbalancedBold(stripRoundSignOff(assistantContent));
        // A preamble before the first heading — an apology that the transcript
        // was cut, an "I will now add the sections" — is dropped so it cannot
        // land between two chapters (user report 2026-09-06). NEVER on a seam
        // continuation, whose prose prefix is real content welded onto a cut
        // word; only an append/first round opens with a heading.
        if (!job.continueOf || job.continueOf.mode === 'append') {
          assistantContent = stripLeadingNarration(assistantContent);
        }
      }
      let assistantMsgId;
      let assistantNow;
      let storedContent;
      // A seam the join cannot verify (mockup-truncated-answer §04): the
      // continuation neither repeated the last words it was told to repeat
      // nor opened with a space, and the old text stops mid-sentence. Welding
      // that on blind is what turned "* Nur " + "der Normalverteilungsannahme
      // erfüllt ist" into a garbled sentence with a silent gap (live incident
      // 2026-09-07). First offence: the round is DISCARDED and the client is
      // asked to try once more. Second offence: appended anyway — half the
      // answer is better than none — but flagged, so the reader sees the seam.
      let seamDiscarded = false;
      let seamFlagged = false;
      if (job.continueOf) {
        // ONE message, not two (mockup-truncated-answer §01): the chapter
        // list parses a single overview, and a second bubble starting
        // mid-sentence would read as a new answer. A stopped continuation
        // keeps the text as it was — the same rule as the stop button, which
        // discards what it did not finish.
        assistantMsgId = job.continueOf.assistantMsgId;
        assistantNow = job.continueOf.assistantCreatedAt;
        const broken = !aborted
          && job.continueOf.mode === 'seam'
          && Boolean(assistantContent)
          && seamSuspect(job.continueOf.existingContent, assistantContent);
        seamDiscarded = broken && !job.continueOf.seamRetry;
        seamFlagged = broken && job.continueOf.seamRetry;
        storedContent = aborted || seamDiscarded
          ? job.continueOf.existingContent
          : joinContinuation(job.continueOf.existingContent, assistantContent, {
              mode: job.continueOf.mode,
            });
        if (seamDiscarded) {
          // Nothing is written: the row keeps its text and its truncated flag,
          // exactly as if this round had never run. The done event says why.
        } else {
          db.prepare(
            'UPDATE messages SET content = ?, truncated = ?, '
            + 'seam_suspect = MAX(seam_suspect, ?), '
            + 'search_wish_query = ?, search_wish_error = ?, covered_until_seconds = ? WHERE id = ?'
          ).run(
            storedContent, aborted ? 1 : truncated ? 1 : 0,
            seamFlagged ? 1 : 0,
            searchWish?.query ?? null, searchWish?.error ?? null,
            // The LATEST round's reach wins: each one starts further in, so the
            // newest cut is the furthest the whole answer has been able to see.
            meta?.transcriptCutAt ?? null,
            assistantMsgId,
          );
        }
      } else {
        assistantMsgId = crypto.randomUUID();
        // Anchored regenerate: the replacement takes the old marker's slot so
        // the answer sits directly under its question.
        assistantNow = job.regenerate?.anchorCreatedAt ?? monotonicNow(chatId);
        storedContent = assistantContent;
        db.prepare(
          'INSERT INTO messages (id, chat_id, role, content, created_at, truncated, '
          + 'search_wish_query, search_wish_error, covered_until_seconds) '
          + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(
          assistantMsgId, req.params.chatId, 'assistant', assistantContent, assistantNow,
          truncated ? 1 : 0, searchWish?.query ?? null, searchWish?.error ?? null,
          meta?.transcriptCutAt ?? null,
        );
      }
      if (truncated) sseWrite(res, { truncated: true, messageId: assistantMsgId });

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
      // A TOPIC BRANCH (`/branch <topic>`, design/mockup-branch-command.html)
      // is a branch without a parent_word: the user typed its subject, and
      // routes/chats.js/passage-title already titled it from exactly that.
      // That title is settled at birth — rewriting it from the first answer
      // would throw away the words the user chose.
      const isTopicBranch = Boolean(chat.parent_id) && !chat.parent_word;
      // A chat still wearing its localized placeholder title has never been
      // titled — regardless of message count. The count window alone missed
      // queued questions (two user turns before the first answer finishes,
      // report 2026-09-05), and the old `=== 'New Chat'` literal never
      // matched the German placeholder.
      const needsTitle = !hasSourceName && !isTopicBranch
        && (DEFAULT_CHAT_TITLES.has(chat.title) || msgCount.count <= 2);

      // Fallback: first few words of the passage (branches) or of the
      // user's message, in case the LLM call fails.
      const branchQuote = chat.parent_word
        ? String(chat.parent_word).trim().slice(0, MAX_PASSAGE_CHARS)
        : null;

      // The mindmap's outcome line is NOT a one-shot. It used to be written
      // only inside the title gate above — so a branch whose title call timed
      // out, hit a quota, or came back without the OUTCOME line kept its
      // "Ergebnis folgt …" placeholder forever, because that gate never opens
      // a second time (found 2026-08-03: 22 of 60 branches). Now every further
      // answer in a branch without an outcome tries again, with a lean
      // outcome-only call that leaves the settled title alone.
      // Deliberately not capped by an attempt counter: each retry asks about a
      // conversation that has grown since the last one, so a branch where the
      // model still finds nothing to state is a branch that genuinely has not
      // concluded anything yet. The cost is one short call per answer, and it
      // stops for good the moment a line is stored.
      // What the outcome line is ABOUT: the passage a branch was cut from —
      // or, for a topic branch, the topic itself, which lives in the title.
      // Live report 2026-08-08: every /branch node stayed on "Ergebnis folgt …"
      // because this gate asked for a parent_word no topic branch has.
      const outcomeSubject = branchQuote
        || (isTopicBranch ? String(chat.title || '').trim() : null);
      const needsOutcome = Boolean(outcomeSubject) && !String(chat.outcome || '').trim();

      if (!aborted && (needsTitle || needsOutcome)) {
        // Caps, prompts and sanitizing live in ../title.js — the
        // passage-title endpoint (routes/chats.js) reuses exactly the same
        // rules, so a branch titled up front and one titled after the first
        // answer can never disagree.
        // Branch chats are titled after the SELECTED PASSAGE they were opened
        // from, not after the first question (user decision 2026-07-26): in
        // the sidebar tree "Kannst du mir alle" says nothing, a summary of
        // the marked text does.
        let newTitle = capTitleWords((branchQuote || content || 'Chat').trim());

        try {
          const { client: titleClient, model: titleModel, provider: titleProvider } = getLLMClient(db);
          // withOutcome: this call runs AFTER the answer, so it can also
          // report what the conversation established — the mindmap node's
          // second line (chats.outcome, decision 2026-08-02). One call for
          // both; the pre-branch lookup in routes/chats.js keeps asking for
          // title + quote only, because there is no answer yet.
          // The answer travels INSIDE the instruction: on cloud providers the
          // call is that one message, so "what the conversation above
          // established" had nothing to look at (see ../title.js).
          // Title already settled: ask for the missing outcome alone.
          const titleInstruction = !needsTitle
            ? outcomeInstruction(outcomeSubject, fullContent)
            : branchQuote
              ? branchTitleInstruction(branchQuote, { withOutcome: true, answer: fullContent })
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
            : outcomeSubject
              ? [titleInstruction]
              : [titleInstruction, { role: 'user', content: content || 'New chat' }];
          let raw = '';
          if (titleProvider === 'ollama') {
            // Local path stays a single call on the configured model: there is
            // no ladder to walk (one KV slot, no quotas) and a second model
            // would evict the paper prefix.
            let titleCompletion;
            try {
              titleCompletion = await titleClient.chat.completions.create({
                model: titleModel,
                // For a 4-word title no thinking model may brood for minutes.
                ...noThinkExtras(titleProvider),
                messages: titleMessages,
                ...toolsField(await availableTools({ db })),
              });
            } catch (err) {
              if (!/does not support tools/i.test(err?.message || '')) throw err;
              titleCompletion = await titleClient.chat.completions.create({
                model: titleModel,
                ...noThinkExtras(titleProvider),
                messages: titleMessages,
              });
            }
            raw = titleCompletion.choices[0]?.message?.content || '';
            // A title call spends the same quota as the answer (kind 'title'
            // since 2026-08-11) — local is free, but the row keeps both
            // providers comparable.
            recordUsage(db, {
              provider: titleProvider, model: titleModel, kind: 'title', outcome: 'ok',
              promptTokens: titleCompletion.usage?.prompt_tokens,
              completionTokens: titleCompletion.usage?.completion_tokens,
            });
          } else {
            // Cloud: the SAME failover ladder as the answer, the passage title
            // and explain (../quota.js). Without it an exhausted quota left the
            // mindmap node saying "Ergebnis folgt …" forever, even with a
            // second keyed provider sitting right there (user report
            // 2026-08-06) — and the next answer only retried on the very model
            // that had just hit the wall.
            const ladder = await callCloudLadder(db, {
              activeProvider: titleProvider,
              messages: titleMessages,
              budgetMs: SIDE_CALL_BUDGET_MS,
              callMs: SIDE_CALL_MS,
              isCoolingDown: isQuotaCoolingDown,
              markCooldown: markQuotaCooldown,
              label: needsTitle ? 'branch title' : 'outcome line',
              // Every candidate the ladder burns is a spent call, whether it
              // answered or not — the ladder walks up to four models, and
              // before 2026-08-11 none of them appeared in the meter.
              onError: (err, cand) => recordUsage(db, {
                provider: cand.provider, model: cand.model, kind: 'title',
                outcome: isRateLimit(err) ? 'quota' : 'failed',
              }),
            });
            raw = ladder?.raw || '';
            if (ladder) {
              recordUsage(db, {
                provider: ladder.provider, model: ladder.model, kind: 'title', outcome: 'ok',
              });
            }
          }
          if (raw.trim()) {
            if (!needsTitle) {
              // Catch-up call: one line, and nothing else may be touched.
              const outcome = parseOutcomeReply(raw);
              if (outcome) {
                db.prepare('UPDATE chats SET outcome = ? WHERE id = ?')
                  .run(outcome, req.params.chatId);
              }
            } else if (branchQuote) {
              // The branch instruction asks for TITLE/QUOTE lines, so the
              // reply must go through the same parser as the passage-title
              // endpoint. Taking it verbatim was how a JSON reply ended up as
              // the tree node `{ "title": "θ₂ Update` (user report
              // 2026-08-02) — the two paths must never disagree.
              const parsed = parseBranchTitleReply(raw, {
                maxQuoteChars: MAX_PASSAGE_CHARS,
                passage: branchQuote,
              });
              if (parsed.title) newTitle = parsed.title;
              // The outcome line of the mindmap node. Stored separately from
              // the title so the node can show both without the two saying
              // the same thing (decision 2026-08-02).
              if (parsed.outcome) {
                db.prepare('UPDATE chats SET outcome = ? WHERE id = ?')
                  .run(parsed.outcome, req.params.chatId);
              }
              // Second chance for the restored formula: when the pre-branch
              // lookup came back empty (quota, timeout, Ollama), the header
              // still shows the flattened text — this fills it in.
              if (parsed.quote && !chat.parent_word_display) {
                db.prepare('UPDATE chats SET parent_word_display = ? WHERE id = ?')
                  .run(parsed.quote, req.params.chatId);
              }
            } else {
              newTitle = raw.trim();
            }
          }
        } catch (_) { /* the fallback is good enough */ }

        // Strip wrapping quotes/backticks and trailing punctuation, drop line
        // breaks, enforce both caps, defuse a half-delimiter (../title.js).
        // Only when the title was actually asked for — a pure outcome catch-up
        // must never rename a branch the user has been reading for days.
        if (needsTitle) {
          newTitle = sanitizeTitle(newTitle);
          db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(newTitle, req.params.chatId);
        }
      }

      const assistantMessage = {
        id: assistantMsgId, chat_id: req.params.chatId, role: 'assistant', content: storedContent, created_at: assistantNow,
        attachments: [],
        // A discarded seam round leaves the row as it was: still truncated.
        ...(truncated || seamDiscarded ? { truncated: 1 } : null),
        // `seam_retry` is transient (never a column): it asks the CLIENT to
        // call /continue once more with seamRetry=true — the server holds no
        // SSE stream open across rounds, so the retry is the client's move.
        ...(seamDiscarded ? { seam_retry: 1 } : null),
        ...(seamFlagged ? { seam_suspect: 1 } : null),
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
      // Everything the stream loop never saw — a client that could not be
      // resolved, a context build that threw, a failure past the loop. The
      // loop's own candidates are already logged (failureLogged), and one
      // spent call must not become two rows.
      if (!failureLogged) {
        recordUsage(db, {
          provider: err.failProvider || usedProvider,
          model: err.failModel || usedModel,
          kind: 'chat',
          outcome: err.quotaExhausted || isRateLimit(err) ? 'quota' : 'failed',
        });
      }
      // Machine-readable cause for the UI card (mockup-model-flow §05):
      // classify here what wasn't classified at the throw site. A key that
      // was valid on save but got revoked later surfaces as a 401 mid-use.
      if (!err.failReason && isBadKey(err)) {
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
  // Exported for the same reason markQuotaCooldown is: /explain, /btw and the
  // passage title share this memory, so a model that answers THERE should be
  // able to clear its own entry too (server.js wiring).
  router.clearQuotaCooldown = clearQuotaCooldown;
  // Cooldown snapshot for the model picker badges (mockup-quota-states.html
  // §06) — server.js exposes this as GET /api/quota-cooldowns. Only future
  // expiries are reported; model names may themselves contain '/'.
  // Settings PUT calls this (server.js wiring): waiting local jobs whose
  // provider is now cloud leave the FIFO immediately.
  router.reevaluateQueue = reevaluateQueue;
  // `nowMs` is injectable so tests can drive the clock past a wait instead of
  // sleeping through it; production callers pass nothing.
  router.getQuotaCooldowns = (nowMs = Date.now()) => {
    const cooldowns = [];
    for (const [key, entry] of quotaCooldowns) {
      const [providerName, ...modelParts] = key.split('/');
      cooldowns.push({
        provider: providerName,
        model: modelParts.join('/'),
        until: new Date(entry.until).toISOString(),
        // Six states, six words (mockup-onboarding-flow §02, 2026-08-15): an
        // expired wait is NOT "usable again". The old code dropped the entry
        // here, so the picker row went green the second the countdown hit
        // zero — user complaint: "Countdown vorbei, Limit trotzdem
        // erschöpft". Nothing was measured; the clock merely ran out. The
        // entry therefore stays as 'unknown' until a real call settles it.
        // A retired model is the exception: it is switched off, not waiting,
        // so its word never softens into a question mark.
        kind: entry.until <= nowMs && entry.kind !== 'retired' ? 'unknown' : entry.kind,
      });
    }
    return cooldowns;
  };
  return router;
};
