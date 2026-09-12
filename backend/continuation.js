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
 * Does the text stop in the middle of a sentence? The last visible character
 * is the witness: a word character, comma or dash means the sentence was
 * still going; sentence-final punctuation (also a closing quote/bracket right
 * after it) means it ended. Used only as one half of `seamSuspect` — on its
 * own, ending mid-sentence is what every truncated answer does.
 */
function endsMidSentence(text) {
  const trimmed = String(text ?? '').replace(/[\s*_`>#]+$/u, '');
  if (!trimmed) return false;
  const last = trimmed[trimmed.length - 1];
  return WORD_CHAR.test(last) || ',;-–—('.includes(last);
}

/**
 * A seam join that cannot be trusted (live incident 2026-09-07): the answer
 * broke off at "* Nur " and the continuation opened with "der
 * Normalverteilungsannahme erfüllt ist" — no repeated words, a jump past the
 * middle of the answer — and the blind concatenation produced a garbled
 * sentence with a silent gap. Three conditions, all required:
 *
 * - no overlap: the continuation did NOT repeat the last words it was
 *   explicitly instructed to repeat, so the one verification the seam has is
 *   missing;
 * - the existing text ends mid-sentence: after a finished sentence a plain
 *   append is safe even without repetition;
 * - the continuation starts with a word character: a leading space or line
 *   break is itself evidence of a deliberate mid-sentence continuation
 *   (models that continue correctly but skip the repetition start with " …",
 *   measured 2026-08-16 — those joins were fine).
 *
 * The caller's reaction is decided elsewhere (routes/messages.js): one more
 * attempt first, and only a second suspect round is appended — flagged, so
 * the reader sees that the seam may hide a gap.
 */
function seamSuspect(existing, continuation) {
  if (!existing || !continuation) return false;
  if (!WORD_CHAR.test(continuation[0])) return false;
  if (!endsMidSentence(existing)) return false;
  return overlapLength(existing, continuation) === 0;
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
/**
 * Which language the already-written text is in — 'de' or 'en', or null when
 * there is no clear signal. Used to NAME the language in the continuation
 * instruction instead of trusting the model to infer "same language" on its
 * own (user report 2026-09-05): a German video overview drifted into English
 * partway through, because the whole transcript is English and a free model,
 * re-reading it at every round boundary, followed the source rather than a
 * German opening it can no longer see. Naming the language at the start of
 * each round is the lever "same language" was missing.
 *
 * The app only speaks German and English (frontend/src/appLanguage.ts), so a
 * binary heuristic is enough: German-only letters (ä/ö/ü/ß) and a handful of
 * function words that are common in German and absent from English. Content
 * words (many of them English technical terms even in a German answer) are
 * deliberately ignored — only the connective tissue tells the languages apart.
 */
function detectLanguage(text) {
  if (!text || typeof text !== 'string') return null;
  const sample = text.toLowerCase();
  let german = 0;
  // Umlauts and ß never appear in English — each is a strong vote.
  german += (sample.match(/[äöüß]/g) || []).length;
  // Function words: frequent in German, not English words. Whole-word only.
  const GERMAN_WORDS = /\b(und|nicht|ist|eine|der|die|das|den|dem|mit|für|von|auf|auch|wird|sich|über|zwischen|Abschnitt|Kernaussage|Überschrift)\b/gi;
  german += (sample.match(GERMAN_WORDS) || []).length;
  const ENGLISH_WORDS = /\b(the|and|is|are|of|to|with|for|this|that|into|section|heading|key point)\b/gi;
  const english = (sample.match(ENGLISH_WORDS) || []).length;
  if (german === 0 && english === 0) return null;
  return german >= english ? 'de' : 'en';
}

const LANGUAGE_NAMES = { de: 'German', en: 'English' };

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
 *
 * `language` ('de'/'en') names the target language explicitly; passing it is
 * what stops the mid-overview English drift (2026-09-05). Left null, the
 * instruction falls back to the old "same language" wording — the model then
 * has to infer it, which is exactly what failed.
 */
function continuationInstruction({ mode, fromMark = null, untilMark = null, language = null }) {
  const langName = LANGUAGE_NAMES[language] || null;
  // The tail after "in the …" / "Keep the …": names the language when we know
  // it ("same format, in German") so the model is told German/English outright
  // instead of guessing "same language".
  const formatAndLanguage = langName
    ? `same format, in ${langName}`
    : 'same format and language';
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
      `yet. Carry on from exactly there, in the ${formatAndLanguage}: start with the ` +
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
    `nothing: no restart, no summary of what came before, no introduction. Keep the ${formatAndLanguage}, ` +
    'and carry on to the end.' + closing
  );
}

/**
 * How much of the answer written so far the continuation still sees verbatim.
 * Generous enough that the seam and the section being finished are both fully
 * inside it, small enough that a metered model can still carry it.
 */
const TAIL_CHARS = 4_000;

/** A markdown heading line — what a section is called, and all we keep of it. */
const HEADING = /^#{1,4}\s/;

/**
 * The answer so far, shrunk to what the next round actually needs.
 *
 * A continuation used to carry the whole text back to the model every round.
 * That is the same waste `resumeFromSeconds` removed from the transcript side,
 * and it bit in the same way: measured 2026-09-04, an overview that had grown
 * to 36 422 characters made Groq answer `413 Request too large … Limit 8000,
 * Requested 14696` — the source budget was already at its minimum, the history
 * alone was over the line. Every further round then failed, whatever the cap.
 *
 * Two things survive the cut, because two things are load-bearing: the LAST
 * few thousand characters (the seam the model writes on from, and the section
 * it is in the middle of) and every heading written so far (so it does not
 * open a section that is already there). Everything between them is text the
 * reader has and the model does not need again.
 */
function condenseWrittenAnswer(content) {
  const text = String(content ?? '');
  if (text.length <= TAIL_CHARS) return text;
  const headings = text.split('\n').filter((l) => HEADING.test(l));
  // Start the tail at a line boundary so it does not open mid-line — but the
  // END stays byte-exact, because that is the seam.
  const rawTail = text.slice(-TAIL_CHARS);
  const nl = rawTail.indexOf('\n');
  const tail = nl > -1 && nl < 400 ? rawTail.slice(nl + 1) : rawTail;
  return (
    '[The earlier part of this answer is left out here to save room — the reader has it. ' +
    'These are the sections it already contains; never write any of them again:]\n' +
    (headings.length ? headings.join('\n') : '(no headings yet)') +
    '\n\n[…]\n\n' +
    tail
  );
}

// MAX_OVERLAP travels with the joiner: a caller that streams a continuation
// has to hold back exactly this many characters before it may pass anything
// on — beyond them no repetition can be hiding any more, so everything after
// is safe to forward live (routes/btw.js).
module.exports = {
  joinContinuation, continuationInstruction, condenseWrittenAnswer, detectLanguage, MAX_OVERLAP,
  seamSuspect, endsMidSentence, LANGUAGE_NAMES,
};
