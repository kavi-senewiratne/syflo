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

/** A time mark in the answer or the transcript: [7:30], [1:02:01], 07:30. */
const MARK = /(\d{1,2}):(\d{2})(?::(\d{2}))?/g;

/** Transcript blocks are separated by a blank line and open with their mark. */
const BLOCK_MARK = /^\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/;

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
 */
function lastCoveredSeconds(text) {
  if (!text) return null;
  let last = null;
  for (const m of String(text).matchAll(MARK)) {
    last = toSeconds(m[1], m[2], m[3]);
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
  const hasMark = (l) => /\[\s*\d{1,2}:\d{2}(?::\d{2})?/.test(l);

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
  }
  if (cut === -1) return text;
  return lines.slice(0, cut).join('\n').replace(/\s+$/, '');
}

module.exports = {
  trimTrailingClosing,
  lastCoveredSeconds,
  isShortOfEnd,
  transcriptFrom,
  formatMark,
};
