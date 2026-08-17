/**
 * markdown/branchLinks.ts
 *
 * Turns the parent words of a chat's children into markdown links
 * (`[word](branch:<chatId>)`) BEFORE the markdown/KaTeX pipeline runs, so
 * ReactMarkdown renders them as clickable branch links.
 *
 * The whole difficulty is WHERE a word may be linked. A plain
 * `content.replace(/\bword\b/gi, …)` rewrites three places it must not touch
 * (user screenshot 2026-08-12, chat "A Neural Probabilistic Language Model"):
 *
 *   1. Inside a formula. The branch word `V` also occurs in `$V$`, and the
 *      replacement produced `$[V](branch:a40a9fd4-…)$` — KaTeX then typeset
 *      the raw link syntax as math, so the paragraph read
 *      "[V](branch : a40a9f d4 – 93b5 – …)" in italic letters.
 *   2. Inside code — a fence or an inline span is quoted text, never a link.
 *   3. Inside a link this function has ALREADY inserted. Branch words are
 *      applied one after another; without protection a later, shorter word
 *      matches inside an earlier word's link text or even inside its chat id,
 *      nesting brackets that markdown then renders as literal `[`/`]`.
 *
 * So the content is held as a list of segments, each either open for matching
 * or locked (code, math, a finished link). Words are linked in open segments
 * only, and every link that is written is locked immediately — nothing this
 * function emits can be matched again.
 *
 * A word that IS a formula keeps its link: when a math span's content equals
 * the word (`$V$` for `V`), the WHOLE span becomes the link text
 * (`[$V$](branch:…)`) — the `a()` renderer in MessageBubble passes rendered
 * KaTeX children through untouched, so the formula stays a formula and gains
 * the blue underline. Without this the `$V$` branch would have no visible link
 * at all in a message that writes `V` only inside math.
 *
 * Runs before normalizeMathDelimiters, i.e. on RAW model text, so the
 * `\(…\)` / `\[…\]` delimiters some models emit have to be recognised here as
 * well — they become `$`/`$$` only one step later.
 */

export interface BranchWord {
  word: string;
  chatId: string;
  /**
   * Link ONLY this 0-based match, counted over the open (non-code, non-math)
   * text — the ordinal the marked passage sits on
   * (chat/markedOccurrence.ts). Set for branches born from a marked passage
   * (user decision 2026-08-13, design/mockup-simply-blue-fixes.html §04
   * variant A); undefined keeps the all-occurrences rule that branches from
   * `/branch`, `/btw` and a right-clicked word still use.
   *
   * A negative value means "the ordinal is not measured yet" and links
   * nothing — better a plain word for one frame than three links that vanish
   * again.
   */
  occurrence?: number;
}

// Protected spans, in the order the model may write them: fenced code
// (unclosed fences swallow to the end — correct while streaming), inline code,
// display math, inline math, and both Gemini bracket forms.
//
// Exported because timeLinks.ts rewrites the same raw markdown and has to skip
// exactly the same places. Two copies of this list would drift apart, and the
// bug that follows is the one from 2026-08-12: a link written into a formula,
// typeset by KaTeX as its own raw syntax.
export const PROTECTED_SOURCE = [
  '```[\\s\\S]*?(?:```|$)',
  '~~~[\\s\\S]*?(?:~~~|$)',
  '`[^`\\n]*`',
  '\\$\\$[\\s\\S]*?\\$\\$',
  '\\$[^$\\n]*\\$',
  '\\\\\\[[\\s\\S]*?\\\\\\]',
  '\\\\\\([\\s\\S]*?\\\\\\)',
].join('|');

// Only math spans may become link text; code never does.
const MATH_SPAN_RE = /^(?:\$\$|\$|\\\[|\\\()([\s\S]*?)(?:\$\$|\$|\\\]|\\\))$/;

interface Segment {
  text: string;
  // Locked segments are never searched again: code, math, and finished links.
  locked: boolean;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `\b` only anchors between a word character and a non-word character, so it
 * fails on words that start or end with punctuation — and parent words often
 * do (`non-parametric density estimation,`, `| V | (1 + nm + h)+h(1 + nm)+nm`).
 * Lookarounds on the word-character class hold for every shape: a boundary is
 * demanded only on the side where the word itself has a letter or digit.
 */
function wordRegex(word: string): RegExp {
  const left = /^\w/.test(word) ? '(?<!\\w)' : '';
  const right = /\w$/.test(word) ? '(?!\\w)' : '';
  return new RegExp(`${left}(${escapeRegex(word)})${right}`, 'gi');
}

/**
 * Splits one open segment at every hit, locking the links it writes.
 *
 * `counter` runs across ALL open segments of the message, so `only` addresses
 * one match of the whole message rather than one per paragraph. It is passed as
 * a box because the segments are processed in a loop outside.
 */
function linkInOpenSegment(
  text: string,
  word: string,
  chatId: string,
  counter: { seen: number },
  only?: number,
): Segment[] {
  const re = wordRegex(word);
  const out: Segment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    const ordinal = counter.seen;
    counter.seen += 1;
    if (only !== undefined && ordinal !== only) continue;
    if (m.index > last) out.push({ text: text.slice(last, m.index), locked: false });
    out.push({ text: `[${m[1]}](branch:${chatId})`, locked: true });
    last = m.index + m[0].length;
    // Zero-length matches cannot happen (the word is non-empty), so lastIndex
    // always advances.
  }

  if (out.length === 0) return [{ text, locked: false }];
  if (last < text.length) out.push({ text: text.slice(last), locked: false });
  return out;
}

export function insertBranchLinks(content: string, branchWords: BranchWord[]): string {
  if (!content || branchWords.length === 0) return content;

  // Cut into alternating open / protected parts (odd indices = protected).
  let segments: Segment[] = content
    .split(new RegExp(`(${PROTECTED_SOURCE})`, 'g'))
    .map((text, i) => ({ text, locked: i % 2 === 1 }));

  for (const { word, chatId, occurrence } of branchWords) {
    if (!word) continue;
    // Negative = the ordinal is still being measured; link nothing this pass.
    if (occurrence !== undefined && occurrence < 0) continue;
    const next: Segment[] = [];
    const counter = { seen: 0 };

    for (const segment of segments) {
      if (!segment.locked) {
        next.push(...linkInOpenSegment(segment.text, word, chatId, counter, occurrence));
        continue;
      }
      // A locked span links only as a whole, and only if it is math whose body
      // IS the word — `$V$` for `V`. Everything else stays untouched.
      // Skipped once an ordinal is in play: the DOM-side counter
      // (chat/markedOccurrence.ts) skips formulas, so counting them here would
      // make the same number mean two different positions. Formula branches
      // therefore stay on the all-occurrences path.
      const math = occurrence === undefined ? MATH_SPAN_RE.exec(segment.text) : null;
      if (math && math[1].trim() === word.trim()) {
        next.push({ text: `[${segment.text}](branch:${chatId})`, locked: true });
        continue;
      }
      next.push(segment);
    }

    segments = next;
  }

  return segments.map(s => s.text).join('');
}
