/**
 * selection/wordSnap.ts
 *
 * Chrome puts the caret on the NEAREST character boundary of the glyph under
 * the press point: press past the middle of a word's first letter and the
 * drag starts AFTER that letter. The selection, the definition popup, the
 * branch title and the persisted highlight then all miss it — reproduced in
 * the running app 2026-08-06, both in chat bubbles and in the PDF text layer:
 * pressing at 55% into the "l" of "legacy waypoint stack" yielded "egacy
 * waypoint stack" everywhere downstream.
 *
 * The WORD the user pressed on carries their intent, not the sub-pixel half
 * of its first glyph — the same reasoning that makes the drag-point band in
 * pdf/selection.ts the source of truth over Chrome's whitespace snap. So both
 * boundaries grow OUTWARDS to the enclosing word; boundaries that already sit
 * on a word edge (or next to punctuation/whitespace) never move.
 *
 * Snapping stays inside the boundary text nodes: a word split across inline
 * elements (markdown's `**b**old`) keeps whatever Chrome reported for the
 * part that lies outside them.
 */

// Letters, digits and underscore — a hyphen stays a boundary so selecting
// "space" out of "joint-space" is still possible.
const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

/**
 * A copy of `range` whose boundaries no longer cut a word in half. Collapsed
 * ranges (a caret, not a selection) are returned unchanged.
 */
export function snapRangeToWords(range: Range): Range {
  const snapped = range.cloneRange();
  if (snapped.collapsed) return snapped;

  const start = snapped.startContainer;
  if (start.nodeType === Node.TEXT_NODE) {
    const data = (start as Text).data;
    let i = snapped.startOffset;
    // Only a boundary INSIDE a word moves: word character on both sides.
    if (isWordChar(data[i]) && isWordChar(data[i - 1])) {
      while (i > 0 && isWordChar(data[i - 1])) i--;
      snapped.setStart(start, i);
    }
  }

  const end = snapped.endContainer;
  if (end.nodeType === Node.TEXT_NODE) {
    const data = (end as Text).data;
    let j = snapped.endOffset;
    if (isWordChar(data[j]) && isWordChar(data[j - 1])) {
      while (j < data.length && isWordChar(data[j])) j++;
      snapped.setEnd(end, j);
    }
  }

  return snapped;
}

/**
 * Snap the live selection and write the result back, so the blue selection
 * the user sees is the same text the popup, the branch and the highlight get.
 * Returns the snapped range, or null when there is nothing selected.
 *
 * Callers inside a mouseup handler should run this before any other selection
 * rewrite (PdfView's column constrain reads the boundary offsets it finds).
 */
export function snapLiveSelectionToWords(): Range | null {
  const selection = typeof window !== 'undefined' ? window.getSelection?.() : null;
  // No live range to work with: a caret, an empty selection, or an environment
  // that reports a selection without exposing ranges (jsdom).
  if (!selection || !selection.rangeCount || selection.isCollapsed) return null;
  if (typeof selection.getRangeAt !== 'function') return null;
  const range = selection.getRangeAt(0);
  const snapped = snapRangeToWords(range);
  if (
    snapped.startContainer === range.startContainer &&
    snapped.startOffset === range.startOffset &&
    snapped.endContainer === range.endContainer &&
    snapped.endOffset === range.endOffset
  ) {
    return range;
  }
  try {
    selection.removeAllRanges();
    selection.addRange(snapped);
  } catch {
    // A detached node between read and write (re-render mid-mouseup) — the
    // snapped range is still the better text to hand on.
  }
  return snapped;
}
