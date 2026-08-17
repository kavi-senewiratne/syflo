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
 */
function joinContinuation(existing, continuation) {
  if (!existing) return continuation;
  if (!continuation) return existing;

  const overlap = overlapLength(existing, continuation);
  if (overlap > 0) return existing + continuation.slice(overlap);

  // No repetition to go by. A space is needed only where two word characters
  // would collide — never after a line break or before punctuation.
  const needsSpace =
    WORD_CHAR.test(existing[existing.length - 1]) && WORD_CHAR.test(continuation[0]);
  return needsSpace ? `${existing} ${continuation}` : existing + continuation;
}

module.exports = { joinContinuation };
