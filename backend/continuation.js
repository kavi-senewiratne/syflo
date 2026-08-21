/**
 * continuation.js
 *
 * Joining a cut-off answer to its continuation
 * (design/mockup-truncated-answer.html §01).
 *
 * The hard part is the seam, not the request. A provider that stops at a token
 * boundary leaves the text either between two words ("…die Aktivierungen dem")
 * or inside one ("…die Aktivie"), and nothing in the text says which. Models
 * also drop the leading space of their answer, so a naive concatenation
 * produced "demArbeitsspeicher" on the first real run (2026-08-16).
 *
 * The repair is to ask the continuation to REPEAT its first few words and cut
 * the repetition away here. The repeated fragment is what makes the seam
 * visible: "Aktivierungen…" overlaps "…Aktivie" inside the word, "die
 * Aktivierungen dem" overlaps between words. One rule covers both.
 */

/**
 * Below this an overlap is coincidence, not evidence — a single "e" meeting
 * an "e". Four is the smallest length that still carries a word fragment:
 * a cut inside a word leaves stubs like "Aktivie", and demanding more would
 * miss exactly the case this exists for (measured 2026-08-16). Comparison is
 * case-sensitive, which rules out most accidental hits on its own.
 */
const MIN_OVERLAP = 4;
/** Above this we stop looking; the model was asked for a few words, not a page. */
const MAX_OVERLAP = 240;

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Longest suffix of `existing` that `continuation` starts with, or 0.
 * Compared case-sensitively: a model repeating its own words repeats their
 * case, and a loose match would eat real text.
 */
function overlapLength(existing, continuation) {
  const max = Math.min(MAX_OVERLAP, existing.length, continuation.length);
  for (let len = max; len >= MIN_OVERLAP; len--) {
    const candidate = continuation.slice(0, len);
    // Punctuation and whitespace alone prove nothing — ".\n\n" matches
    // everywhere. The overlap has to carry letters.
    if (!WORD_CHAR.test(candidate)) continue;
    if (existing.endsWith(candidate)) return len;
  }
  return 0;
}

/**
 * The finished text of a continued answer.
 *
 * @param {string} existing     What the provider managed to write.
 * @param {string} continuation What the second call produced.
 * @param {object} [opts]
 * @param {'seam'|'append'} [opts.mode]
 *   'seam' (default) joins a sentence that broke off mid-word: the
 *   continuation repeats its first words and the repetition is cut away.
 *   'append' joins a FINISHED answer that merely stopped early — the case of a
 *   model that covered 16:16 of a 1:06:31 video and called it done
 *   (2026-08-18). There is no seam to find there; what is needed is the blank
 *   line between the old last sentence and the new "## heading", without which
 *   the two collide into "…anpasst.## Werkzeuge" and the heading stops being
 *   a heading.
 */
function joinContinuation(existing, continuation, opts = {}) {
  if (!existing) return continuation;
  if (!continuation) return existing;

  if (opts.mode === 'append') {
    const gap = /\n\s*\n\s*$/.test(existing) ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    return existing + gap + continuation.replace(/^\s+/, '');
  }

  const overlap = overlapLength(existing, continuation);
  if (overlap > 0) return existing + continuation.slice(overlap);

  // No repetition to go by. A space is needed only where two word characters
  // would collide — never after a line break or before punctuation.
  const needsSpace =
    WORD_CHAR.test(existing[existing.length - 1]) && WORD_CHAR.test(continuation[0]);
  return needsSpace ? `${existing} ${continuation}` : existing + continuation;
}

/**
 * What the model is told when it has to carry an answer further.
 *
 * Deliberately a USER turn and the LAST message (same lesson as the branch
 * selection, 2026-08-08): an instruction the model must obey belongs next to
 * where it answers, not in a system block above 20 000 tokens of source.
 *
 * The closing rule is not decoration. A user whose custom instructions ask for
 * a section "at the end of every answer" got that section at the end of every
 * ROUND — and since rounds are appended into one message, their "## Mentales
 * Modell" ended up twice in the middle of one overview (user report with
 * picture 2026-08-18). A round is not an answer; only the last one is.
 */
function continuationInstruction({ mode, fromMark = null, untilMark = null }) {
  const closing =
    ' Your instructions may ask for closing sections at the end of an answer (a mental ' +
    'model, a coaching section, a summary). This answer is NOT finished yet, so leave them ' +
    'out entirely' +
    (untilMark ? ` until you have reached ${untilMark}` : '') +
    ' — they belong once, at the very end.';

  if (mode === 'append') {
    // The answer is not cut: it stopped early and believes it is done (Flash
    // Lite covered 16:16 of a 1:06:31 video with finish=stop, 2026-08-18). So
    // there is no seam to repair; what it needs is the arithmetic it ignored.
    return (
      `Your previous answer stops at ${fromMark ?? 'its last section'}` +
      `${untilMark ? `, but the video runs to ${untilMark}` : ''}. The rest is not covered ` +
      'yet. Carry on from exactly there, in the same format and language: start with the ' +
      'next "##" section heading and its time range, and work through to the end of the ' +
      'video. Your text is appended directly to the answer above, so do not restate ' +
      'anything, do not introduce yourself, and do not repeat a section that is already ' +
      'there.' + closing
    );
  }
  return (
    'Your previous answer was cut off mid-sentence. Continue it — but START by ' +
    'repeating its LAST FEW WORDS verbatim (if it broke off inside a word, start ' +
    'with that whole word), then carry straight on. Those repeated words are the ' +
    'seam: they are removed automatically when your text is joined to the old one, ' +
    'and without them the two halves collide. Beyond that repetition, repeat ' +
    'nothing: no restart, no summary of what came before, no introduction. Keep the ' +
    'same format and language, and carry on to the end.' + closing
  );
}

// MAX_OVERLAP travels with the joiner: a caller that streams a continuation
// has to hold back exactly this many characters before it may pass anything
// on — beyond them no repetition can be hiding any more, so everything after
// is safe to forward live (routes/btw.js).
module.exports = { joinContinuation, continuationInstruction, MAX_OVERLAP };
