/**
 * chat/markedOccurrence.ts
 *
 * Which occurrence of a branch word is the MARKED one?
 *
 * A branch born from a marked passage gets its link at that passage and
 * nowhere else (user decision 2026-08-13,
 * design/mockup-simply-blue-fixes.html §04 variant A). Before, every match of
 * the parent word became a link, so a message that writes the words three
 * times showed one yellow-and-blue passage and two blue ones — the reader had
 * no way to tell why they differ (user report 2026-08-13).
 *
 * The two sides live in different coordinate systems: a highlight anchors to
 * character offsets in the RENDERED text (chat/highlightAnchors.ts), while the
 * link is written into RAW markdown before rendering (markdown/branchLinks.ts).
 * They meet on an ordinal instead: this module counts, in the rendered DOM,
 * which match the mark sits on; `insertBranchLinks` then links that n-th match
 * in the raw text. Ordinals survive the trip because markdown markup never
 * reorders words — `**Leaky Abstraction**` is the same n-th match on both
 * sides.
 *
 * Both counters must skip the same places, or the ordinal means two different
 * things. `insertBranchLinks` locks code and math, so the walker below skips
 * `code`, `pre` and `.katex` subtrees. `.katex` matters twice over: KaTeX
 * duplicates every formula into `.katex-mathml` (MathML plus the LaTeX
 * source), so a formula contributes its text to `textContent` about three
 * times — counting it would shift every later ordinal.
 */

// Same boundary logic as markdown/branchLinks.ts wordRegex — a boundary is
// demanded only on the side where the word itself has a letter or digit, so
// parent words that start or end in punctuation still match. Keep the two in
// sync; they are the two halves of one ordinal.
function wordRegex(word: string): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const left = /^\w/.test(word) ? '(?<!\\w)' : '';
  const right = /\w$/.test(word) ? '(?!\\w)' : '';
  return new RegExp(`${left}(${escaped})${right}`, 'gi');
}

const SKIP_SELECTOR = 'code, pre, .katex';

/**
 * The rendered text of `root` with the locked subtrees removed, plus where a
 * full-text offset lands inside that reduced string.
 *
 * `openOffset` is the position in the open text that corresponds to
 * `fullOffset`; it is null when the offset falls inside a skipped subtree (a
 * mark that covers nothing but a formula) or past the end of the text.
 */
function openTextAt(root: Element, fullOffset: number): { text: string; openOffset: number | null } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pieces = '';
  let fullPos = 0;
  let openOffset: number | null = null;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const length = node.data.length;
    const skipped = Boolean(node.parentElement?.closest(SKIP_SELECTOR));
    if (!skipped) {
      if (openOffset === null && fullOffset < fullPos + length) {
        openOffset = pieces.length + (fullOffset - fullPos);
      }
      pieces += node.data;
    }
    fullPos += length;
    node = walker.nextNode() as Text | null;
  }
  return { text: pieces, openOffset };
}

/**
 * 0-based index of the match `startOffset` sits on, counting only matches in
 * open text. Returns null when the offset is not on a match at all — the
 * caller then leaves the word on the all-occurrences rule rather than guessing
 * a position.
 */
export function markedOccurrenceIndex(
  root: Element,
  word: string,
  startOffset: number,
): number | null {
  if (!word || startOffset < 0) return null;
  const { text, openOffset } = openTextAt(root, startOffset);
  if (openOffset === null) return null;
  const re = wordRegex(word);
  let index = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // A hand-made selection can start a character or two inside the word, so
    // the match that COVERS the offset counts, not only one starting on it.
    if (m.index <= openOffset && openOffset < m.index + m[0].length) return index;
    if (m.index > openOffset) return null;
    index += 1;
  }
  return null;
}
