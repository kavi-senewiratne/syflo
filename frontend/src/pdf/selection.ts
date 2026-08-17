/**
 * pdf/selection.ts
 *
 * Column-aware selection helpers for the PDF text layer — 1:1 port of the
 * module-level helpers in Syflo's PaperView/PdfView.tsx (Slice 04). Two-column
 * papers interleave both columns in DOM order, so the native Selection APIs
 * leak text and highlight rects across the gutter; these helpers filter the
 * selection down to the spans the user visually dragged through and compute
 * tight per-line rects for the highlight overlays.
 */

import { composeMathAwareText, type GlyphRun } from './mathAwareText';

/**
 * Result of column-aware span filtering for the current selection. Shared by
 * `extractColumnAwareSelectionText()` (text-only consumer) and the
 * mouseup-driven selection-rewrite logic in `PdfView` (visual highlight fix).
 */
// ── Drag-Punkt-Verfolgung ────────────────────────────────────────────────
// Endet (oder startet) ein Drag im LEERRAUM neben einer Formel, snappt
// Chrome den Selektions-Fokus auf die nächste Textfluss-Position — und die
// kann bei den absolut positionierten pdf.js-Spans viele Absätze entfernt
// liegen (Repro 2026-07-22: Drag bis kurz vor die Gleichungsnummer ließ die
// native Selektion von 41 auf >1000 Zeichen anschwellen). Die Maus-Punkte
// des Drags sind die einzige verlässliche Quelle der Nutzer-Absicht: PdfView
// meldet sie hier an, das Band-Clipping unten nutzt sie bevorzugt. Die
// Y-Werte werden in Inhalts-Koordinaten des Scroll-Containers gespeichert,
// damit Autoscroll während des Drags sie nicht verfälscht.
interface DragPoint {
  yContent: number;
  scroller: HTMLElement | null;
}
let dragStartPoint: DragPoint | null = null;
let dragEndPoint: DragPoint | null = null;

function toClientY(p: DragPoint): number {
  return p.yContent - (p.scroller?.scrollTop ?? 0);
}

export function noteSelectionDragStart(clientY: number, scroller: HTMLElement | null): void {
  dragStartPoint = { yContent: clientY + (scroller?.scrollTop ?? 0), scroller };
  dragEndPoint = null;
}

export function noteSelectionDragMove(clientY: number): void {
  if (!dragStartPoint) return;
  dragEndPoint = {
    yContent: clientY + (dragStartPoint.scroller?.scrollTop ?? 0),
    scroller: dragStartPoint.scroller,
  };
}

export function clearSelectionDragPoints(): void {
  dragStartPoint = null;
  dragEndPoint = null;
}

// Besitzenden Text-Layer-Span eines Range-/Selection-Knotens finden.
function findOwningSpan(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  return (el?.closest?.('.textLayer span') ?? null) as HTMLElement | null;
}

interface ColumnAwareSelection {
  // The `.textLayer` element that owns the live selection.
  textLayer: HTMLElement;
  // Spans the user actually highlighted, in visual reading order (top, left).
  // Use the first/last entries to build a fresh Range that hugs one column.
  spans: HTMLElement[];
  // Per-line client rectangles from the current Range. Used by the multi-
  // column heuristic — single-column pages have rects spanning ~the full
  // page width, two-column pages have rects spanning < ~50%.
  lineRects: DOMRect[];
}

/**
 * Run the column-aware span filter against `window.getSelection()`. Returns
 * `null` if the selection isn't inside a PDF text layer or no spans match.
 *
 * Algorithm (also documented on the public wrappers below):
 *
 *   1. For each per-line rect from `range.getClientRects()` (these never
 *      cross a column gutter, even when the DOM range does),
 *   2. find every `.textLayer span` whose centre falls inside that rect (or
 *      whose area overlaps by >50% — catches tall glyphs / superscripts),
 *   3. sort the kept spans by (lineIdx, top, left) for natural reading order.
 *
 * Shared by the text extractor and the visual-selection rewriter so both see
 * the same "one column only" view of the user's drag.
 */
function filterColumnAwareSelectionSpans(): ColumnAwareSelection | null {
  const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);

  // Find the .textLayer that owns the selection. If the selection didn't
  // originate in a PDF text layer (e.g. the user is in MarkdownPane), bail
  // — the regular `.toString()` is correct for flowed content.
  const anchorEl =
    sel.anchorNode?.nodeType === Node.ELEMENT_NODE
      ? (sel.anchorNode as HTMLElement)
      : sel.anchorNode?.parentElement ?? null;
  const textLayer = anchorEl?.closest?.('.textLayer') as HTMLElement | null;
  if (!textLayer) return null;

  // Per-line rectangles. For a single-line selection this is one rect; for a
  // multi-line drag inside one column it's one rect per line, all hugging the
  // column. Crucially, no rect crosses the gutter — that's why this approach
  // sidesteps the cross-column leak.
  const rawLineRects = Array.from(range.getClientRects()).filter(
    (r) => r.width > 0 && r.height > 0,
  );
  if (rawLineRects.length === 0) return null;

  // Collect every span in the active text layer once — we'll bucket them into
  // line rects below. Filtering to `.textLayer span` keeps us off the canvas
  // and any overlay siblings (highlights, search marks).
  const spans = Array.from(textLayer.querySelectorAll('span')) as HTMLElement[];

  // Formula guard. LaTeX emits formula glyphs (fraction bars, integrals,
  // radicals) both out of visual order and several times taller than the
  // running text. A drag across a formula therefore yields a DOM range whose
  // client rects (a) cover the lines above/below via tall glyph boxes and
  // (b) include stowaway rects from spans of unrelated sentences that sit
  // between anchor and focus in DOM order — plus (c) Chrome snaps the focus
  // to a far-away text-flow position when the pointer is in whitespace next
  // to a formula. Clip every line rect to the vertical band the user
  // actually dragged through. Source of truth for the band, in order:
  //   1. the drag's mouse points (PdfView reports them) — immune to (c);
  //   2. the range's boundary spans, each capped to ~1.5× the median span
  //      height so a tall boundary glyph can't blow the band open.
  // For a plain prose drag the band spans exactly the dragged lines, so
  // nothing changes.
  const spanHeights = spans
    .map((s) => s.getBoundingClientRect().height)
    .filter((h) => h > 0)
    .sort((a, b) => a - b);
  const medianSpanH = spanHeights.length
    ? spanHeights[Math.floor(spanHeights.length / 2)]
    : 0;
  const maxLineH = medianSpanH * 1.5;
  let bandTop = -Infinity;
  let bandBottom = Infinity;
  const startSpanForBand = findOwningSpan(range.startContainer);
  const endSpanForBand = findOwningSpan(range.endContainer);
  if (medianSpanH > 0 && dragStartPoint) {
    const y1 = toClientY(dragStartPoint);
    const y2 = dragEndPoint ? toClientY(dragEndPoint) : y1;
    bandTop = Math.min(y1, y2) - maxLineH * 0.75;
    bandBottom = Math.max(y1, y2) + maxLineH * 0.75;
  } else if (medianSpanH > 0 && startSpanForBand && endSpanForBand) {
    const clampToLine = (r: DOMRect) => {
      if (r.height <= maxLineH) return { top: r.top, bottom: r.bottom };
      const cy = r.top + r.height / 2;
      return { top: cy - maxLineH / 2, bottom: cy + maxLineH / 2 };
    };
    const s = clampToLine(startSpanForBand.getBoundingClientRect());
    const e = clampToLine(endSpanForBand.getBoundingClientRect());
    bandTop = Math.min(s.top, e.top) - 2;
    bandBottom = Math.max(s.bottom, e.bottom) + 2;
  }
  const lineRects = rawLineRects
    .map((r) => {
      const top = Math.max(r.top, bandTop);
      const bottom = Math.min(r.bottom, bandBottom);
      return bottom - top > 0 ? new DOMRect(r.left, top, r.width, bottom - top) : null;
    })
    .filter((r): r is DOMRect => r !== null);
  if (lineRects.length === 0) return null;

  type Kept = { span: HTMLElement; top: number; left: number; lineIdx: number };
  const kept: Kept[] = [];
  const seen = new Set<HTMLElement>();
  for (let i = 0; i < lineRects.length; i += 1) {
    const lineRect = lineRects[i];
    for (const span of spans) {
      if (seen.has(span)) continue;
      const r = span.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // Center-point test first — cheap and correct for the common case
      // (selected span is fully inside the line rect).
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const centerInside =
        cx >= lineRect.left &&
        cx <= lineRect.right &&
        cy >= lineRect.top &&
        cy <= lineRect.bottom;
      // Fallback: >50% area overlap with the line rect. Catches spans that
      // straddle a line boundary (e.g. tall glyphs, superscripts).
      let overlapInside = false;
      if (!centerInside) {
        const ix = Math.max(0, Math.min(r.right, lineRect.right) - Math.max(r.left, lineRect.left));
        const iy = Math.max(0, Math.min(r.bottom, lineRect.bottom) - Math.max(r.top, lineRect.top));
        const overlapArea = ix * iy;
        const spanArea = r.width * r.height;
        overlapInside = spanArea > 0 && overlapArea / spanArea > 0.5;
      }
      if (centerInside || overlapInside) {
        kept.push({ span, top: r.top, left: r.left, lineIdx: i });
        seen.add(span);
      }
    }
  }
  // Always include the spans that own the Range's start and end points.
  // The center-point / 50%-overlap test wrongly excludes boundary spans when
  // the user drags mid-span: `range.getClientRects()` clips the first/last
  // line's rect to the actual drag-from / drag-to X positions, so a boundary
  // span whose centre sits outside the clipped rect gets filtered out — and
  // its word disappears from the extracted text (visible bug: the new-chat
  // title is missing the first or last selected word). The startContainer /
  // endContainer are the source of truth for "the user definitely meant this
  // span" because that's where their cursor literally started or ended.
  // Ausnahme: liegt der Boundary-Span KOMPLETT außerhalb des Drag-Bands,
  // ist er kein Nutzer-Endpunkt, sondern Chromes Leerraum-Snap auf eine
  // entfernte Textfluss-Position — dann gerade NICHT einschleusen.
  const boundaryPairs: Array<[HTMLElement | null, number]> = [
    [startSpanForBand, 0],
    [endSpanForBand, Math.max(0, lineRects.length - 1)],
  ];
  for (const [span, lineIdx] of boundaryPairs) {
    if (!span || seen.has(span)) continue;
    if (!textLayer.contains(span)) continue;
    const r = span.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.bottom < bandTop || r.top > bandBottom) continue;
    kept.push({ span, top: r.top, left: r.left, lineIdx });
    seen.add(span);
  }

  if (kept.length === 0) return null;

  // Sort by (lineIdx, then visual top-then-left). lineIdx first preserves the
  // user's drag direction across lines; (top, left) inside a line gives the
  // natural left-to-right reading order even if the DOM order is jumbled.
  kept.sort((a, b) => {
    if (a.lineIdx !== b.lineIdx) return a.lineIdx - b.lineIdx;
    if (Math.abs(a.top - b.top) > 2) return a.top - b.top;
    return a.left - b.left;
  });

  return { textLayer, spans: kept.map((k) => k.span), lineRects };
}

/**
 * Compute tight per-line bounding rects for the current selection, in
 * viewport (client) coordinates.
 *
 * The native `range.getClientRects()` already returns tight per-line rects:
 *   - First line (drag starts mid-line): from the drag-start X to line end
 *   - Intermediate lines (fully selected): from line start to line end (this
 *     is intentional and matches how Adobe/Mendeley draw highlights — for
 *     justified text the text really does fill the column)
 *   - Last line (drag ends mid-line): from line start to drag-end X
 *
 * A previous attempt used `span.getBoundingClientRect()` as the source, but
 * PDF.js packs an ENTIRE visual line into a single span (the span's width is
 * the full column width, not the selected word's width). Using span boxes
 * produced 311px-wide highlights for a 2-word ("135px") selection — exactly
 * the "empty space being highlighted" bug. Range rects are the right source.
 *
 * Filter step: drop rects that lie outside the text layer the selection
 * anchored to. `constrainSelectionToColumn()` already rewrites the range so
 * its clients are column-bound on multi-column pages — this filter is just
 * belt-and-braces for the rare case where the range escapes the layer.
 *
 * Returns null when there's no live selection or no usable rects.
 */
export function computeTightLineRects(): { textLayer: HTMLElement; lines: DOMRect[] } | null {
  const filtered = filterColumnAwareSelectionSpans();
  if (!filtered) return null;
  const { textLayer, spans } = filtered;
  if (spans.length === 0) return null;

  const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);

  // Critical: the live range, after `constrainSelectionToColumn`, still
  // contains the user's preserved start/end offsets BUT in DOM order it can
  // still include cross-column spans between firstSpan and lastSpan. So
  // `range.getClientRects()` returns one rect per visual line — including
  // rects from the OTHER column on multi-line selections. That's the
  // "selection leaks into the right column" bug at zooms < 160 %.
  //
  // Fix: keep only rects that overlap at least one of the kept (column-
  // filtered) spans. Same approach as filterColumnAwareSelectionSpans, but
  // applied to line rects instead of span rects.
  const allRects = Array.from(range.getClientRects()).filter(
    (r) => r.width > 0 && r.height > 0,
  );
  // Filter 1: column-aware. range.getClientRects can include rects from the
  // OTHER column on multi-line selections (DOM order interleaves columns).
  const columnAware = allRects.filter((lr) =>
    spans.some((span) => {
      const sr = span.getBoundingClientRect();
      const cy = sr.top + sr.height / 2;
      const horizontalOverlap = sr.right > lr.left && sr.left < lr.right;
      const verticalContains = cy >= lr.top - 1 && cy <= lr.bottom + 1;
      return horizontalOverlap && verticalContains;
    }),
  );

  // Filter 2: consolidate the raw rects into exactly one rect per visual
  // line. Chrome's range.getClientRects() returns BOTH the element rect and
  // the text rect for fully-selected spans (near-duplicates of the same
  // line), and the rect height (font box) exceeds the PDF's line leading, so
  // consecutive lines overlap by a few pixels — with the multiply-blended
  // overlay every overlap renders as a dark double-tinted band.
  const consolidated = consolidateLineRects(columnAware).map(
    (r) => new DOMRect(r.left, r.top, r.width, r.height),
  );

  // Filter 3: trim each rect's right edge to where the actual canvas text
  // ends. PDF.js sizes text-layer spans with a fallback sans-serif font +
  // approximate scaleX, which on single-column papers can end up 150–200 px
  // wider than the canvas-rendered glyph run — the user sees the highlight
  // overflowing into the right margin. We scan canvas pixels along each
  // line's mid-Y for the rightmost dark pixel inside the rect, then clamp
  // rect.right to that. O(rect.width) per rect, only runs on mouseup —
  // well within budget.
  const lines: DOMRect[] = [];
  for (const lr of consolidated) {
    lines.push(tightenRectToCanvasText(lr, textLayer));
  }

  return lines.length > 0 ? { textLayer, lines } : null;
}

// Scan the rendered canvas for the rightmost dark pixel inside `lineRect`,
// then return a copy of the rect clamped to that pixel's viewport X. Falls
// back to the original rect when the canvas isn't readable.
function tightenRectToCanvasText(lineRect: DOMRect, textLayer: HTMLElement): DOMRect {
  const wrapper = textLayer.closest('[data-testid^="pdf-page-"]') as HTMLElement | null;
  const canvas = wrapper?.querySelector('canvas') as HTMLCanvasElement | null;
  if (!canvas) return lineRect;
  let ctx: CanvasRenderingContext2D | null;
  try {
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  } catch (_err) {
    return lineRect;
  }
  if (!ctx) return lineRect;

  const canvasRect = canvas.getBoundingClientRect();
  const xScale = canvasRect.width > 0 ? canvas.width / canvasRect.width : 1;
  const yScale = canvasRect.height > 0 ? canvas.height / canvasRect.height : 1;

  const yMid = Math.round((lineRect.top - canvasRect.top + lineRect.height / 2) * yScale);
  if (yMid < 0 || yMid >= canvas.height) return lineRect;

  const xStart = Math.max(0, Math.floor((lineRect.left - canvasRect.left) * xScale));
  const xEnd = Math.min(canvas.width, Math.ceil((lineRect.right - canvasRect.left) * xScale));
  if (xEnd <= xStart) return lineRect;

  // Sample a small vertical band of rows through the line's x-height. A
  // single row can miss thin glyphs (apostrophes, periods); 5 rows gives a
  // reliable answer without breaking the budget.
  let rightmostDarkX = -1;
  for (const dy of [0, -2, 2, -4, 4]) {
    const y = yMid + dy;
    if (y < 0 || y >= canvas.height) continue;
    let data: Uint8ClampedArray;
    try {
      data = ctx.getImageData(xStart, y, xEnd - xStart, 1).data;
    } catch (_err) {
      return lineRect;
    }
    for (let i = data.length - 4; i >= 0; i -= 4) {
      if (data[i] < 180 && data[i + 1] < 180 && data[i + 2] < 180) {
        const xInCanvas = xStart + i / 4;
        if (xInCanvas > rightmostDarkX) rightmostDarkX = xInCanvas;
        break;
      }
    }
  }
  if (rightmostDarkX < 0) return lineRect;

  // +2 px nudge so the highlight covers the trailing serif/punctuation
  // instead of cutting through the last glyph mid-stroke.
  const tightenedRightViewport = canvasRect.left + rightmostDarkX / xScale + 2;
  if (tightenedRightViewport >= lineRect.right - 1) return lineRect;
  return new DOMRect(
    lineRect.left,
    lineRect.top,
    Math.max(0, tightenedRightViewport - lineRect.left),
    lineRect.height,
  );
}

/**
 * Column-aware text extraction from the live `window.getSelection()`.
 *
 * Why this exists: PDF.js positions every text span absolutely on the page in
 * *reading order* (top-of-page → bottom-of-page, line by line). For a
 * two-column paper that means the DOM order is:
 *
 *   left-col-line-1, right-col-line-1, left-col-line-2, right-col-line-2, …
 *
 * When the user drags from "top of left column" down to "bottom of left
 * column", the browser's `Selection.toString()` walks the DOM range in DOM
 * order — which inevitably picks up every right-column span sandwiched between
 * the chosen left-column spans. The visible selection looks fine (the OS
 * draws per-line rectangles), but the *string* leaks across columns.
 *
 * Fix: ignore the DOM-range text entirely. Use
 * `filterColumnAwareSelectionSpans()` to keep only the spans whose visual
 * rects actually fall inside the per-line selection rectangles, then hand the
 * kept spans to `composeMathAwareText()`.
 *
 * Composing is geometric rather than a plain `join(' ')`: pdf.js shreds a
 * formula into one item per glyph, so joining with blanks yielded
 * "ˆ P ( Z 1 = z 1 , · · · )" — the string the user found unreadable in the
 * highlights drawer on 2026-08-08. See `pdf/mathAwareText.ts`.
 *
 * Returns `null` if there's no live selection or if extraction can't find any
 * spans (caller should fall back to `getSelection().toString()` in that case).
 */
export function extractColumnAwareSelectionText(): string | null {
  const filtered = filterColumnAwareSelectionSpans();
  if (!filtered) return null;
  const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);

  // PDF.js packs an entire visual line into one span — using span.textContent
  // would return the whole line even when the user selected only a few words
  // inside it. Walk each kept span and slice its text node to the bounds the
  // original range stops/starts at. Middle spans (fully inside the selection)
  // use their full textContent; the first and last spans use the original
  // range's offsets to clip to exactly the dragged characters.
  // Each kept span carries its own rect, which is what lets the composer tell
  // an index from an exponent. A clipped boundary span keeps the full span's
  // rect: the clip only shortens prose, where the geometry plays no role.
  const runs: GlyphRun[] = [];
  filtered.spans.forEach((span) => {
    const rect = span.getBoundingClientRect();
    const geometry = {
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      height: rect.height,
    };
    const textNode = span.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
      // Span has no plain text-node child (rare — usually a wrapper). Fall
      // back to its full textContent so we don't drop the span entirely.
      runs.push({ text: span.textContent ?? '', ...geometry });
      return;
    }
    const full = textNode.textContent ?? '';
    const isStart = range.startContainer === textNode;
    const isEnd = range.endContainer === textNode;
    let start = 0;
    let end = full.length;
    if (isStart) start = Math.max(0, Math.min(full.length, range.startOffset));
    if (isEnd) end = Math.max(start, Math.min(full.length, range.endOffset));
    runs.push({ text: full.slice(start, end), ...geometry });
  });
  const text = composeMathAwareText(runs).replace(/[^\S\n]+/g, ' ').trim();
  return text || null;
}

/**
 * Heuristic: is the page that owns the current selection laid out in
 * multiple columns? A line rect on a single-column page is essentially the
 * full page-content width. On a two-column page each line rect hugs one
 * column, so its width is < ~50% of the page wrapper. We use a 60% threshold
 * to give a buffer for narrow single-column papers (figures, headers) and
 * still catch the two-column case.
 *
 * Returns false when we can't decide (missing wrapper, zero-width rects) —
 * better to skip the selection rewrite than risk clobbering a single-column
 * selection.
 */
function isMultiColumnLayout(
  lineRects: DOMRect[],
  textLayer: HTMLElement,
): boolean {
  if (lineRects.length === 0) return false;
  // The text layer sits inside the page wrapper (`[data-testid^="pdf-page-"]`).
  // We compare against the wrapper's width, not the layer's, so the heuristic
  // is stable against any padding/zoom-quirks the layer might pick up.
  const wrapper = textLayer.closest('[data-testid^="pdf-page-"]') as HTMLElement | null;
  const pageWidth = wrapper?.getBoundingClientRect().width ?? textLayer.getBoundingClientRect().width;
  if (!pageWidth) return false;
  // Use the widest rect — most representative of the actual column width and
  // robust against partial last-line rects in a multi-line drag.
  const maxRectWidth = Math.max(...lineRects.map((r) => r.width));
  return maxRectWidth / pageWidth < 0.6;
}

/**
 * Rewrite the live browser `Selection` so it covers only the spans the user
 * dragged through inside one column. The browser's native highlight follows
 * the new range, so the cross-column bleed disappears visually too.
 *
 * Why this is needed on top of `extractColumnAwareSelectionText()`: the text
 * extractor only fixes the *string* the popup shows. The browser still paints
 * its own highlight rectangles from the DOM range — which on a two-column
 * page spills into the gutter column. We have to mutate the Selection itself
 * to make the highlight match what the user sees.
 *
 * Build a single Range from the first kept span's start to the last kept
 * span's end (visual order). That gives the browser a contiguous range that
 * happens to live entirely in one column. We don't try to build a multi-range
 * selection — browsers other than Firefox ignore additional ranges anyway,
 * and a single hugging range matches the per-line highlight rectangles
 * naturally.
 *
 * Returns true when the selection was rewritten, false otherwise.
 */
export function constrainSelectionToColumn(): boolean {
  const filtered = filterColumnAwareSelectionSpans();
  if (!filtered) return false;
  const { textLayer, spans, lineRects } = filtered;
  if (spans.length === 0) return false;

  const sel = window.getSelection?.();
  if (!sel || sel.rangeCount === 0) return false;
  const original = sel.getRangeAt(0);

  // Rewrite in zwei Fällen: mehrspaltiges Layout (klassisches Spalten-Leck)
  // ODER ein Range-Ende, das nicht auf einem behaltenen Span liegt — dann
  // hat Chrome den Leerraum neben einer Formel auf eine entfernte Textfluss-
  // Position gesnappt. Wichtig: bei einem Leerraum-Snap ist der Container
  // oft das textLayer-DIV selbst (findOwningSpan → null) — auch das zählt
  // als entkommen, sonst kopiert ⌘C weiterhin die angeschwollene Selektion.
  const snapEscaped = (() => {
    const startSpan = findOwningSpan(original.startContainer);
    const endSpan = findOwningSpan(original.endContainer);
    return (
      !startSpan || !spans.includes(startSpan) || !endSpan || !spans.includes(endSpan)
    );
  })();
  if (!isMultiColumnLayout(lineRects, textLayer) && !snapEscaped) return false;

  // PDF.js packs an entire visual line into a single span. The old impl did
  // `setStartBefore(firstSpan)` / `setEndAfter(lastSpan)` which expanded a
  // partial-word selection ("Sequential prediction") into a full-line one
  // ("Sequential prediction problems such as imitation"). Preserve the
  // user's original boundary offsets so the highlight ends exactly where
  // their cursor did — the whole point of the column-aware rewrite is to
  // drop cross-column spans that ended up BETWEEN start and end in DOM
  // order, not to extend the boundaries.
  try {
    const firstSpan = spans[0];
    const lastSpan = spans[spans.length - 1];
    const newRange = document.createRange();
    // Start: if the original range's startContainer is inside (or is) the
    // first kept span, use the original offset. Otherwise fall back to
    // start-of-span so the range still begins in the right column.
    if (firstSpan.contains(original.startContainer)) {
      newRange.setStart(original.startContainer, original.startOffset);
    } else {
      newRange.setStartBefore(firstSpan);
    }
    if (lastSpan.contains(original.endContainer)) {
      newRange.setEnd(original.endContainer, original.endOffset);
    } else {
      newRange.setEndAfter(lastSpan);
    }
    sel.removeAllRanges();
    sel.addRange(newRange);
  } catch (_err) {
    // setStart/setEnd can throw if a span has been detached between
    // filterColumnAwareSelectionSpans() collecting it and now (very rare —
    // would require a re-render mid-mouseup). Bail silently; the popup text
    // extractor still got the right text, and a stale visual highlight is
    // strictly less bad than a thrown exception.
    return false;
  }
  return true;
}

/**
 * Text surrounding the current selection, for the AI definition prompt
 * (Issue 06: the popup's definition should use surrounding text as context,
 * not just the selection itself). pdf.js packs one visual line per span, so
 * a few spans either side of the selection's start span give the enclosing
 * sentences. Falls back to `fallback` when there's no usable selection.
 */
export function contextAroundSelection(fallback: string, spanRadius = 2): string {
  const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
  if (!sel || sel.rangeCount === 0) return fallback;
  const node = sel.getRangeAt(0).startContainer;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  const span = el?.closest?.('.textLayer span') as HTMLElement | null;
  if (!span) return fallback;
  const layer = span.closest('.textLayer');
  if (!layer) return fallback;
  const spans = Array.from(layer.querySelectorAll('span'));
  const i = spans.indexOf(span);
  if (i < 0) return fallback;
  const from = Math.max(0, i - spanRadius);
  const to = Math.min(spans.length, i + spanRadius + 1);
  const text = spans
    .slice(from, to)
    .map((s) => s.textContent ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, 400) : fallback;
}

// Minimal rect shape shared by DOMRect and plain objects — lets the pure
// zoom math below be unit-tested without a DOM.
export interface ClientRectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * Consolidate raw selection rects into exactly one tidy rect per visual line.
 *
 * Fixes three artifacts of Chrome's range.getClientRects() that made saved
 * highlights look broken (overlapping double-dark bands, stray tall blocks):
 *
 *   1. Container rects: a rect spanning multiple lines (the element box of a
 *      fully-selected multi-line span) is dropped when it is much taller than
 *      the median rect and vertically contains the centers of ≥2 other rects.
 *   2. Same-line duplicates: rects whose vertical overlap is >50% of the
 *      smaller height (element box + text box of the same line) are merged
 *      into their union.
 *   3. Inter-line bleed: the font box is taller than the PDF's line leading,
 *      so consecutive line rects overlap by a few pixels; with multiply
 *      blending every overlap renders darker. Consecutive rects are trimmed
 *      to meet at the midpoint of their overlap.
 *
 * Pure math on ClientRectLike so it can be unit-tested without a DOM.
 */
export function consolidateLineRects(
  rects: readonly ClientRectLike[],
): Array<{ left: number; top: number; width: number; height: number }> {
  if (rects.length === 0) return [];
  const rs = rects.map((r) => ({
    left: r.left,
    top: r.top,
    right: r.left + r.width,
    bottom: r.top + r.height,
  }));

  // 1. Drop multi-line container rects.
  const heights = rs.map((r) => r.bottom - r.top).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)];
  const singles = rs.filter((r) => {
    if (r.bottom - r.top <= median * 1.7) return true;
    let contained = 0;
    for (const o of rs) {
      if (o === r) continue;
      const cy = (o.top + o.bottom) / 2;
      if (cy > r.top && cy < r.bottom) contained += 1;
      if (contained >= 2) return false;
    }
    return true;
  });

  // 2. Cluster into visual lines (vertical overlap >50% of the smaller
  //    height ⇒ same line) and merge each cluster into its union. Adjacent
  //    PDF lines only overlap by the font-box bleed (~25–30%), so they stay
  //    separate clusters.
  singles.sort((a, b) => a.top - b.top || a.left - b.left);
  const lines: Array<{ left: number; top: number; right: number; bottom: number }> = [];
  for (const r of singles) {
    const line = lines.find((l) => {
      const overlap = Math.min(l.bottom, r.bottom) - Math.max(l.top, r.top);
      return overlap > 0.5 * Math.min(r.bottom - r.top, l.bottom - l.top);
    });
    if (line) {
      line.left = Math.min(line.left, r.left);
      line.top = Math.min(line.top, r.top);
      line.right = Math.max(line.right, r.right);
      line.bottom = Math.max(line.bottom, r.bottom);
    } else {
      lines.push({ ...r });
    }
  }

  // 3. Trim vertical bleed between consecutive lines at the midpoint.
  lines.sort((a, b) => a.top - b.top);
  for (let i = 1; i < lines.length; i += 1) {
    const prev = lines[i - 1];
    const cur = lines[i];
    if (prev.bottom > cur.top) {
      const mid = (cur.top + prev.bottom) / 2;
      prev.bottom = mid;
      cur.top = mid;
    }
  }

  return lines
    .filter((l) => l.right > l.left && l.bottom > l.top)
    .map((l) => ({ left: l.left, top: l.top, width: l.right - l.left, height: l.bottom - l.top }));
}

/**
 * Convert client-space line rects into zoom=1 page-local coordinates.
 *
 * THE zoom-safe fix (Slice 04): all four values are divided by the capture
 * zoom. Syflo divided only left/top and stored width/height in raw client
 * pixels (its comments claimed pdf.js text-layer spans keep constant pixel
 * sizes across zoom — wrong for modern pdf.js, where the whole layer scales
 * with --scale-factor). The result was a highlight that was only correctly
 * sized at its creation zoom. Rects outside the page are dropped.
 */
export function normalizeRectsToZoom(
  lines: readonly ClientRectLike[],
  pageRect: ClientRectLike,
  zoom: number,
): Array<{ left: number; top: number; width: number; height: number }> {
  return lines
    .filter(
      (r) =>
        r.right > pageRect.left &&
        r.left < pageRect.right &&
        r.bottom > pageRect.top &&
        r.top < pageRect.bottom,
    )
    .map((r) => ({
      left: (r.left - pageRect.left) / zoom,
      top: (r.top - pageRect.top) / zoom,
      width: r.width / zoom,
      height: r.height / zoom,
    }));
}
