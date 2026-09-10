/**
 * overview-progress.js
 *
 * How far a Video overview has actually got — read from the answer itself.
 *
 * Two failures made this necessary, both measured in the running app on
 * 2026-08-18:
 *
 * - `gemini-flash-latest` ended its stream with `finish_reason=MISSING` after
 *   as little as 68 tokens. The continuation machinery repaired it, but each
 *   round re-sent the WHOLE transcript: 356 000 prompt tokens bought 13 000
 *   tokens of text in one afternoon, and exhausted the day's quota.
 * - `gemini-flash-lite-latest`, which took over on that exhausted quota,
 *   finished cleanly (`finish=stop`) after covering 16:16 of a 1:06:31 video.
 *   Nothing was cut, so nothing asked to be continued — the reader simply got
 *   a quarter of the video and no sign that anything was missing.
 *
 * Both are answered by the same fact: the overview writes `[m:ss - m:ss]` time
 * ranges, so the answer says where it got to, and the video says where it ends.
 * That comparison needs no provider flag and cannot be talked out of by a model
 * that believes it is done.
 */

/** A time mark inside brackets: [7:30], [1:02:01 - 1:05:00]. */
const MARK = /(\d{1,2}):(\d{2})(?::(\d{2}))?/g;

/** A bracketed span in the answer or the transcript — where a mark may live. */
const BRACKET = /\[([^[\]]*)\]/g;

/** Transcript blocks are separated by a blank line and open with their mark. */
const BLOCK_MARK = /^\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/;

/**
 * A chapter heading whose time range carries NO brackets — the shape Groq
 * gpt-oss-120b wrote on 2026-09-01 ("## 0:04 – 0:34 – Einführung"), after
 * writing the canonical bracketed shape two days earlier. With brackets
 * required, an otherwise well-formed overview read as having no marks at all:
 * no progress, no continuation, and the answer stalled silently at 9:55 of a
 * 47:40 video.
 *
 * Bare marks stay confined to two positions on a HEADING line, because the
 * 2026-08-30 lesson still holds: the video's own duration is injected into
 * the prompt as a bare H:MM:SS string, and a model echoes it — in prose, or
 * in a heading like "## Der Rest bis 3:57:44 fehlt". Only a range that OPENS
 * the heading, or a full start–end range that CLOSES it (optionally in
 * parentheses), is a chapter mark. A single bare mark at the end never
 * counts ("## Treffen um 10:30" is prose, not a chapter).
 *
 * Kept in step with frontend/src/markdown/timeLinks.ts (`parseChapterHeading`)
 * — change both together.
 */
const T_SRC = String.raw`\d{1,2}:\d{2}(?::\d{2})?`;
// The whole Unicode dash block, not just the four obvious ones: gpt-oss-120b
// wrote its ranges with U+2011, the non-breaking hyphen (2026-09-02). Kept in
// step with frontend/src/markdown/timeLinks.ts.
const DASH_SRC = String.raw`\s*[-‐-―−﹘﹣－]\s*`;
const HEADING_LEADING_BARE = new RegExp(
  `^#{1,4}\\s+(${T_SRC})(?:${DASH_SRC}(${T_SRC}))?(?:${DASH_SRC}|\\s*:\\s*|\\s+)\\S`
);
const HEADING_TRAILING_BARE = new RegExp(
  `[^[\\]]\\(?(${T_SRC})${DASH_SRC}(${T_SRC})\\)?\\s*$`
);

/**
 * The last second a bare heading range claims, or null when the line is not
 * a heading carrying one. Reads the END of the range — that is where the
 * answer stood.
 */
function bareHeadingSeconds(line) {
  if (!/^#{1,4}\s/.test(line)) return null;
  if (line.includes('[')) return null; // bracketed marks are the BRACKET scan's job
  const lead = HEADING_LEADING_BARE.exec(line);
  if (lead) {
    // A single leading mark needs an explicit separator (dash/colon) so a
    // heading that merely STARTS with a clock time stays prose.
    if (!lead[2]) {
      const afterMark = line.slice(line.indexOf(lead[1]) + lead[1].length);
      if (!new RegExp(`^(?:${DASH_SRC}|\\s*:\\s*)`).test(afterMark)) return null;
    }
    return markToSeconds(lead[2] || lead[1]);
  }
  const trail = HEADING_TRAILING_BARE.exec(line);
  if (trail) return markToSeconds(trail[2]);
  return null;
}

function markToSeconds(mark) {
  const parts = mark.split(':').map(Number);
  return parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1];
}

function toSeconds(a, b, c) {
  return c === undefined
    ? Number(a) * 60 + Number(b)
    : Number(a) * 3600 + Number(b) * 60 + Number(c);
}

/**
 * The last second the answer claims to have covered, or null when it carries
 * no time mark at all (an overview cut before its first heading).
 *
 * The LAST mark anywhere, not the last heading: a chapter is written
 * "[12:56 - 16:16]", and the end of that range is how far the answer got.
 *
 * Only marks INSIDE brackets count — mirroring the frontend's own detector
 * (frontend/src/markdown/timeLinks.ts, `lastTimeMark`), which the comment on
 * `overviewStopsShort` says this file is "kept in step with". Without the
 * bracket, a plain H:MM:SS-shaped mention anywhere in the answer's prose
 * reads as a covered timestamp — and the video's own duration gets injected
 * into the prompt as exactly such a bare string (backend/youtube.js's
 * `transcriptTruncationNote`, backend/continuation.js's continuation
 * instruction). A model that echoes it back verbatim in a closing sentence
 * ("…the remainder, up to 3:57:44, is not included…", measured 2026-08-30,
 * Groq gpt-oss-120b on a 3:57:44 video) used to make this function conclude
 * the overview had reached the video's own end — and `/continue` refuses a
 * round that already "reached the end", permanently stalling a 4-hour
 * overview at the 32-minute mark while 180 000+ characters of transcript sat
 * unread in the database.
 */
function lastCoveredSeconds(text) {
  if (!text) return null;
  let last = null;
  for (const line of String(text).split('\n')) {
    for (const b of line.matchAll(BRACKET)) {
      for (const m of b[1].matchAll(MARK)) {
        last = toSeconds(m[1], m[2], m[3]);
      }
    }
    // Headings may carry their range without brackets (gpt-oss, 2026-09-01).
    const bare = bareHeadingSeconds(line);
    if (bare !== null) last = bare;
  }
  return last;
}

/**
 * Everything past this much of the video counts as finished. A minute of
 * outro — thanks, credits, a plug for the channel — is not worth a paid round;
 * a quarter of the video, as in the case above, plainly is. The percentage
 * carries long videos, the minute carries short ones.
 */
const TAIL_TOLERANCE_RATIO = 0.05;
const TAIL_TOLERANCE_MIN_SECONDS = 60;

/**
 * The furthest second an answer may CLAIM, given how far the transcript it saw
 * reached. A mark past that is not coverage — it is the number from the
 * truncation note coming back out (measured 2026-09-02: a transcript cut at
 * 1:41:43 produced a closing section "[1:41:43 - 3:57:44]" over 2 h 16 min of
 * unseen video, and the overview then read as finished).
 *
 * `coveredUntil` null means nothing was cut, so nothing is capped.
 */
function capCoverage(lastSeconds, coveredUntil) {
  if (lastSeconds === null || lastSeconds === undefined) return lastSeconds;
  if (coveredUntil === null || coveredUntil === undefined) return lastSeconds;
  return Math.min(lastSeconds, coveredUntil);
}

/**
 * Is the overview short of the video's end? Unknown duration means "no
 * opinion": a claim this drives a paid call with must be measured, not guessed.
 */
function isShortOfEnd(lastSeconds, durationSeconds) {
  if (!durationSeconds || lastSeconds === null || lastSeconds === undefined) return false;
  const tolerance = Math.max(TAIL_TOLERANCE_MIN_SECONDS, durationSeconds * TAIL_TOLERANCE_RATIO);
  return lastSeconds < durationSeconds - tolerance;
}

/** [m:ss] / [h:mm:ss] for a note the model reads. */
function formatMark(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(rest).padStart(2, '0')}`;
}

/**
 * The transcript from `seconds` on — the part a continuation still has to
 * work through.
 *
 * The block CONTAINING that second stays: the answer stopped inside it, and
 * cutting it away would leave the continuation to invent the sentence it has
 * to finish. Everything before it goes, and that is the whole point — writing
 * on from 16:16 does not need the first sixteen minutes, and re-sending them
 * is what made every round cost ~19 000 prompt tokens.
 *
 * Returns null when there is nothing to gain (no marks, or the cut would keep
 * everything anyway), so the caller can simply use the full transcript.
 */
function transcriptFrom(transcript, seconds) {
  if (!transcript || seconds === null || seconds === undefined) return null;
  const blocks = String(transcript).split(/\n{2,}/);
  let keepFrom = -1;
  for (let i = 0; i < blocks.length; i++) {
    const m = BLOCK_MARK.exec(blocks[i].trimStart());
    if (!m) continue;
    if (toSeconds(m[1], m[2], m[3]) <= seconds) keepFrom = i;
    else break;
  }
  if (keepFrom <= 0) return null;
  const kept = blocks.slice(keepFrom).join('\n\n');
  const first = BLOCK_MARK.exec(kept.trimStart());
  return {
    text: kept,
    fromSeconds: first ? toSeconds(first[1], first[2], first[3]) : seconds,
    droppedChars: transcript.length - kept.length,
  };
}

/**
 * The overview WITHOUT the sections a model tacks onto the end of a round.
 *
 * The user's custom instructions ask for a closing section "at the end of every
 * answer" — a mental model, a German-coaching block. The model obliges at the
 * end of every ROUND, including the first, which never sees any continuation
 * instruction. Rounds are appended into one message, so those sections ended up
 * in the MIDDLE of an overview (user report with picture 2026-08-18: lines 46
 * and 51 of 146, and again at 133 and 138).
 *
 * No instruction can repair that, because the round that writes them is not the
 * round that could be told. The shape can: an overview is a list of sections
 * WITH a time mark. Whatever follows the last of them is a closing, and a
 * closing belongs after the last section of the whole video — so it is cut away
 * before the continuation writes on, and the model writes it again when it is
 * really finished.
 *
 * Also cut: a trailing meta note ("*(Hinweis: das Video ist sehr lang …)*"),
 * which is the same kind of end-of-round remark and reads as nonsense once the
 * text carries on past it.
 */
function trimTrailingClosing(text) {
  if (!text) return text;
  const lines = String(text).split('\n');
  const isHeading = (l) => /^\s*#{1,6}\s+/.test(l);
  const hasMark = (l) =>
    /\[\s*\d{1,2}:\d{2}(?::\d{2})?/.test(l) || bareHeadingSeconds(l.trimStart()) !== null;

  let lastChapter = -1;
  lines.forEach((l, i) => {
    if (isHeading(l) && hasMark(l)) lastChapter = i;
  });
  if (lastChapter === -1) return text;

  let cut = -1;
  for (let i = lastChapter + 1; i < lines.length; i++) {
    const l = lines[i];
    if ((isHeading(l) && !hasMark(l)) || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { cut = i; break; }
    // The model's own end-of-round remark: a whole paragraph in brackets,
    // usually italic, opening with Hinweis/Note/Anmerkung.
    if (/^\s*[*_]*\(?\s*(Hinweis|Note|Anmerkung|Fortsetzung folgt)\b/i.test(l)) { cut = i; break; }
    // The same remark without an opener — the model just states where the
    // transcript stopped: "*Ende des verfügbaren Transkripts bei [36:30].*",
    // "*Ende des transkribierten Abschnitts bei [27:05].*" (user report with
    // picture 2026-09-04). It survived the rule above because it names no
    // Hinweis, and every round left one behind, so a finished overview carried
    // a row of them between its chapters. A bullet is never one of these: the
    // detail list of the last section may well mention the transcript.
    // "transkri" and not "transkript": the same sentence comes as "Ende des
    // transkribierten Abschnitts bei [27:05]" just as often.
    if (!/^\s*([-+]|\*\s)/.test(l) && /transkri|transcript/i.test(l)) { cut = i; break; }
  }
  if (cut === -1) return text;
  return lines.slice(0, cut).join('\n').replace(/\s+$/, '');
}

/**
 * The answer without the remark a round signs off with.
 *
 * `trimTrailingClosing` above removes the same lines, but only when a
 * continuation STARTS — and a round that ends cleanly starts no continuation,
 * so they stayed. Three shapes have been reported, all on 2026-09-04, each
 * after the previous one was forbidden in the prompt:
 *   "*Ende des verfügbaren Transkripts bei 15:54.*"
 *   "Ende des transkribierten Abschnitts bei [27:05]."
 *   "[Ich habe Minute 40:39 erreicht und setze im nächsten Schritt ab hier fort.]"
 * The last one the prompt had even ASKED for. A prompt rule is a request; this
 * is the guarantee. It runs on every stored overview round, so the line never
 * reaches the reader — least of all in the middle, where the rounds join.
 *
 * Only the TAIL is touched, and only free-standing lines: a bullet in the last
 * section may legitimately mention the transcript, a heading ends the scan, and
 * the closing sections a finished overview is allowed to have stay untouched.
 * A line counts as a sign-off when it names the transcript, or when the WHOLE
 * line is set apart as an aside — wrapped in brackets, parentheses or italics,
 * which is how models mark "this is me talking, not the overview".
 */
function stripRoundSignOff(text) {
  if (!text) return text;
  const lines = String(text).split('\n');
  const isAside = (l) => {
    const s = l.trim();
    return /^\[.*\]$/.test(s) || /^\(.*\)$/.test(s) || /^\*[^*].*[^*]\*$/.test(s);
  };
  const isSignOff = (l) =>
    !/^\s*([-+]|\*\s)/.test(l)     // a bullet is content, not a sign-off
    && !/^\s*#{1,6}\s/.test(l)     // and neither is a heading
    && (/transkri|transcript/i.test(l) || isAside(l));
  let changed = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    if (!isSignOff(lines[i])) break;
    lines.splice(i, 1);
    changed = true;
  }
  return changed ? lines.join('\n').replace(/\s+$/, '') : text;
}

/**
 * Drops a preamble the overview format does not allow: any free-standing prose
 * before the round's first "##" heading. A continuation round is supposed to
 * open with a section heading; when the transcript was cut for the budget, a
 * model instead narrated the gap ("Die Fortsetzung ist leider nicht möglich…
 * ich ergänze sie hier im geforderten Format:") and only THEN resumed the
 * sections — so the apology landed in the MIDDLE of the finished overview,
 * between two chapters (user report 2026-09-06, Steve Jobs video cut at 19:48).
 *
 * Only ever call this on an 'append'/first round, never on a 'seam'
 * continuation: a seam round legitimately opens mid-sentence (no heading yet),
 * and its prefix is real content being welded onto a cut word — dropping it
 * would delete the answer. Guarded here too: with no "##" heading anywhere,
 * nothing is stripped, and the preamble is removed only when everything before
 * the first heading is prose or blank (never a bullet or a second heading).
 */
function stripLeadingNarration(text) {
  if (!text) return text;
  const lines = String(text).split('\n');
  const firstHeading = lines.findIndex((l) => /^\s*#{1,6}\s/.test(l));
  if (firstHeading <= 0) return text;
  const preamble = lines.slice(0, firstHeading);
  const onlyProseOrBlank = preamble.every(
    (l) => !l.trim() || (!/^\s*([-+]|\*\s)/.test(l) && !/^\s*#{1,6}\s/.test(l)),
  );
  if (!onlyProseOrBlank) return text;
  return lines.slice(firstHeading).join('\n');
}

/**
 * The key-point line with its closing `**` put back.
 *
 * The overview rule asks for one fully bold sentence under each heading, and
 * the model opens it correctly and then forgets the end (user report with
 * picture 2026-09-04: "**NVIDIA stellt mit Cosmos … zu beschleunigen"). Nothing
 * closes the emphasis, so markdown renders the asterisks as literal text and
 * the line that should carry the section's point looks broken.
 *
 * The rule is deliberately narrow: only a line that OPENS with `**` and has an
 * ODD number of `**` in it is repaired. A bullet ("- **Punkt**: Detail") has an
 * even count and is left alone, and so is every line that does not start bold.
 */
function closeUnbalancedBold(text) {
  if (!text) return text;
  return String(text).split('\n').map((line) => {
    if (!/^\s*\*\*\S/.test(line)) return line;
    const marks = line.match(/\*\*/g);
    if (!marks || marks.length % 2 === 0) return line;
    return `${line.replace(/\s+$/, '')}**`;
  }).join('\n');
}

/**
 * How many sections the finished overview should have.
 *
 * A rate alone does not survive both ends of the range (user question
 * 2026-09-04). "One section per 5 to 10 minutes" leaves a ten-minute video
 * with one or two — too coarse to be an outline at all. A share of the running
 * time ("a section every 5 %") fails the other way: on that same ten-minute
 * video it asks for twenty sections of thirty seconds, which is the per-minute
 * chopping this was meant to end.
 *
 * So the number is computed here and put in the prompt as a number. It is
 * minute-based, but with a floor and a ceiling — and the model is told what to
 * write instead of being asked to divide.
 *
 *   10:00 → 4     22:47 → 4     1:00:00 → 9     3:42:37 → 25
 */
const SECTION_MINUTES = 7;
const MIN_SECTIONS = 4;
const MAX_SECTIONS = 25;

function overviewSectionTarget(durationSeconds) {
  if (!durationSeconds || durationSeconds <= 0) return null;
  const fromRate = Math.round(durationSeconds / 60 / SECTION_MINUTES);
  return Math.min(MAX_SECTIONS, Math.max(MIN_SECTIONS, fromRate));
}

module.exports = {
  trimTrailingClosing,
  lastCoveredSeconds,
  capCoverage,
  isShortOfEnd,
  transcriptFrom,
  formatMark,
  overviewSectionTarget,
  stripRoundSignOff,
  stripLeadingNarration,
  closeUnbalancedBold,
};
