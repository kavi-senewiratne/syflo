/**
 * title.js
 *
 * Chat title generation, shared by the two places that need it:
 *
 *   1. routes/messages.js — after the first answer of a chat (the original
 *      site: the title summarizes the branch passage or the conversation).
 *   2. routes/chats.js — the `passage-title` endpoint, which the frontend
 *      calls WHILE the selection popup is open, so a branch is created with
 *      its finished title instead of showing the raw passage first
 *      (user requirement 2026-08-02: "the formatted formula, immediately").
 *
 * The math reconstruction lives in the prompt: a PDF text layer flattens
 * formulas ("x ( k ) = x ( k ) − E [ x ( k ) ] √ Var" for a fraction with
 * superscripts), because a fraction bar is a drawn line and superscripts are
 * pure geometry — neither survives text extraction. The model recognizes the
 * formula and writes it back as LaTeX; every title render site goes through
 * <MathText>, so `$…$` shows as set math.
 */

// Hard caps so the sidebar list and mindmap stay readable even if the LLM
// ignores the word-limit instruction (some smaller models do).
const MAX_TITLE_WORDS = 4;
const MAX_TITLE_CHARS = 40;

// Titles may carry inline $…$ LaTeX — the frontend renders them via MathText
// (2026-07-26). The word/char caps must never cut through a math span: a
// dangling `$` swallows the rest of the title once rendered.
// Placeholder that cannot occur in a title — marks the spaces inside a
// formula so the word split treats the whole formula as ONE word.
const SPACE_MASK = String.fromCharCode(0);

function capTitleWords(text, maxWords = MAX_TITLE_WORDS) {
  // Mask spaces inside $…$ so a formula counts as ONE word.
  const masked = text.replace(/\$\$?[^$]*\$\$?/g, (m) => m.split(/\s/).join(SPACE_MASK));
  return masked
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords)
    .join(' ')
    .split(SPACE_MASK)
    .join(' ');
}

/**
 * Length of what the user SEES. Stripping only the `$` delimiters was not
 * enough (found 2026-08-02): `$x^{(k)} = \frac{x^{(k)} - E[x^{(k)}]}{\sqrt{
 * Var[x^{(k)}]}}$` is ~58 source characters for a formula that renders about
 * as wide as "x(k) = …". Counting the source cut a perfectly reconstructed
 * formula in half. So: a LaTeX command counts as one glyph, and the pure
 * structure characters count as none.
 */
function renderedLength(text) {
  return text
    .replace(/\$\$?/g, '')
    .replace(/\\[a-zA-Z]+/g, 'x')
    .replace(/[{}^_\\]/g, '')
    .length;
}

/** Split into atoms: each `$…$` span is one indivisible atom, text is per-word. */
function titleAtoms(text) {
  return text.match(/\$\$?[^$]*\$\$?|[^$]+/g) || [];
}

function capTitleChars(text, maxChars = MAX_TITLE_CHARS) {
  if (renderedLength(text) <= maxChars) return text;

  // Formulas are atomic — cutting inside one leaves a dangling delimiter and
  // renders as rubble (user report 2026-07-31: a branch titled only "…").
  // Take whole atoms while the budget lasts; a formula that opens the title
  // is kept even when it alone exceeds the budget, because dropping it would
  // leave nothing.
  let out = '';
  let used = 0;
  for (const atom of titleAtoms(text)) {
    const isMath = atom.startsWith('$');
    const len = renderedLength(atom);
    if (isMath) {
      if (out === '') return atom.trim();      // title IS the formula
      if (used + len > maxChars) break;
      out += atom;
    } else {
      if (used + len <= maxChars) {
        out += atom;
      } else {
        out += atom.slice(0, Math.max(0, maxChars - used - 1));
        used = maxChars;
        break;
      }
    }
    used += len;
  }
  out = out.trimEnd();
  return out ? out + '…' : text.slice(0, maxChars - 1).trimEnd() + '…';
}

/**
 * Sanitize whatever the LLM returned: strip wrapping quotes/backticks and
 * trailing punctuation, drop line breaks, enforce both caps. An unbalanced
 * `$` reads as broken math in the UI, so it falls back to plain text.
 */
function sanitizeTitle(raw, fallback = 'New Chat') {
  let title = capTitleWords(
    String(raw || '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/^["'`*_]+|["'`*_.!?,;:]+$/g, '')
      .trim(),
  );
  title = capTitleChars(title);
  if ((title.match(/\$/g) || []).length % 2 === 1) title = title.replace(/\$/g, '');
  return title || fallback;
}

/** Instruction for a branch chat: title it after the passage it came from. */
function branchTitleInstruction(passage) {
  return {
    role: 'user',
    content:
      'Generate a 2 to 4 word title that summarizes the following selected passage ' +
      '(this branch chat explores it). If the passage is already a short term, use the term itself. ' +
      'Write the title in the language of the passage. ' +
      'If the passage centers on a math expression, use that expression as the title, ' +
      'written as LaTeX wrapped in $...$. PDF text extraction drops superscripts, ' +
      'subscripts and fraction bars — restore them so the formula is correct again. ' +
      'The title must come from the passage itself; never reuse wording or symbols ' +
      'from these instructions. ' +
      'Output ONLY the title — no quotes, no punctuation, no markdown, no labels, no extra commentary ' +
      '(inline $...$ math is the one allowed markup). ' +
      `Passage: "${passage}"`,
  };
}

/** Instruction for a plain chat: title it after the conversation. */
function chatTitleInstruction() {
  return {
    role: 'user',
    content:
      'Generate a 2 to 4 word title for this chat. ' +
      'Write the title in the language of the conversation (a German chat gets a German title). ' +
      'Output ONLY the title — no quotes, no punctuation, no markdown, no labels, no extra commentary ' +
      '(a math expression central to the chat may appear as LaTeX wrapped in $...$). ' +
      'Examples: React hooks tutorial / Bicycle repair guide / Berlin trip planning / Linear algebra basics.',
  };
}

/** How much of a selected passage is fed to the title prompt. */
const MAX_PASSAGE_CHARS = 600;

module.exports = {
  MAX_TITLE_WORDS,
  MAX_TITLE_CHARS,
  MAX_PASSAGE_CHARS,
  capTitleWords,
  capTitleChars,
  sanitizeTitle,
  branchTitleInstruction,
  chatTitleInstruction,
};
