/**
 * components/PdfView/index.tsx
 *
 * Center column of the three-column view (design/mockup-pdf-layout.html):
 * a toolbar with zoom controls and a page indicator, above a gray scroll
 * area with one white page card per PDF page. Each page renders a canvas
 * plus the selectable pdf.js text layer, with persistent colored highlight
 * overlays on top (design/mockup-paper-pdf-highlights-v2.html).
 *
 * Highlight geometry (the zoom-safe fix, Slice 04): rects are stored in
 * zoom=1 page-local coordinates with ALL FOUR values normalized by the
 * capture zoom, and all four multiplied by the live zoom at render time.
 * Syflo only normalized left/top (its comments claimed pdf.js keeps span
 * sizes constant across zoom — wrong for modern pdf.js), so highlights were
 * only correctly sized at their creation zoom. Rendering goes through the
 * pdfDocument wrapper so pdf.js stays out of component tests.
 */

import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Minus, Plus, ChevronLeft, ChevronRight, FileText } from 'lucide-react';
import { loadPdfDocument, type PdfDocumentHandle } from '../../pdf/pdfDocument';
import {
  clearSelectionDragPoints,
  computeTightLineRects,
  constrainSelectionToColumn,
  extractColumnAwareSelectionText,
  noteSelectionDragMove,
  noteSelectionDragStart,
  normalizeRectsToZoom,
} from '../../pdf/selection';
import { snapLiveSelectionToWords } from '../../selection/wordSnap';
import type { Highlight, HighlightColor, HighlightRect, PaperCitation } from '../../types';
import { useStrings } from '../../strings';
import { MathText, hasMath } from '../MathText';

// Captured at mouseup time so the FloatingPopup can save a colored
// highlight against the actual user selection (multi-line, column-aware).
export interface PdfHighlightSelection {
  pageNumber: number;
  text: string;
  rects: HighlightRect[];
}

// Imperative Sprung-API für den Highlights-Drawer: App hält eine Ref und
// ruft scrollToHighlight, wenn eine PDF-Karte geklickt wird
// (mockup-highlights-overview.html, Grill-Entscheidung 8: punktgenau + Flash).
export interface PdfViewHandle {
  scrollToHighlight: (highlightId: string) => void;
}

interface Props {
  pdfUrl: string;
  title?: string;
  // Persistent colored highlights, drawn as multi-rect overlays per page.
  highlights?: Highlight[];
  // Finishing a drag-selection inside a page (mouseup): receives the
  // captured selection, then onSelectionFinalized fires so the parent can
  // open the FloatingPopup — no right-click needed (user request 2026-07-31).
  onCaptureHighlight?: (sel: PdfHighlightSelection | null) => void;
  onSelectionFinalized?: (point: { clientX: number; clientY: number }) => void;
  // Reference links (design/mockup-paper-reference-links.html): one click
  // rect per citation mark, in PDF user space. Empty until the background
  // pass finishes, and forever empty for a PDF without citation links.
  citations?: PaperCitation[];
  // Fires for a click that carried no drag and left no selection — the
  // gesture must never compete with text selection, which is what Syflo's
  // whole branching rests on.
  onCitationClick?: (citation: PaperCitation, point: { clientX: number; clientY: number }) => void;
  // Prefetch signals for the silent full-text search
  // (design/mockup-citation-card-standard.html § 05). Hover is the earliest
  // honest sign a mark is about to be clicked; the visible page decides which
  // handful of references are worth looking up at all.
  onCitationHover?: (citation: PaperCitation) => void;
  onVisibleCitationsChange?: (citations: PaperCitation[]) => void;
  // Click an existing highlight → the parent opens the actions menu.
  onColorHighlightClick?: (highlight: Highlight, e: React.MouseEvent) => void;
  // Solange das Auswahl-Popup offen ist: das transiente Auswahl-Overlay
  // NICHT wegräumen, wenn die native Selektion kollabiert (der Klick ins
  // Popup kollabiert sie zwangsläufig) — der Nutzer soll weiter sehen, was
  // er markiert hat.
  keepSelectionVisible?: boolean;
  ref?: React.Ref<PdfViewHandle>;
}

// Dauer des Aufglühens nach einem Drawer-Sprung. Muss zu den Flash-Animationen
// in index.css passen (3 × 0,45 s) und zu FLASH_MS in ChatArea/index.tsx —
// alle drei immer zusammen ändern.
const FLASH_MS = 1350;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.25;

// Satte Variante jeder Highlight-Farbe für den Flash-Glow nach einem
// Drawer-Sprung (Nutzerkorrektur 2026-07-21: farbiger Glow statt schwarzem
// Ring). Gleiche Deep-Töne wie die Chip-Punkte im Drawer.
const HIGHLIGHT_GLOW_HEX: Record<HighlightColor, string> = {
  yellow: '#CA8A04',
  green: '#16A34A',
  blue: '#2563EB',
  pink: '#DB2777',
  orange: '#EA580C',
};

// Tailwind class per highlight color — same pastel palette as the
// FloatingPopup swatches (mockup-popup-edit-labels.html).
const HIGHLIGHT_BG_CLASS: Record<HighlightColor, string> = {
  yellow: 'bg-[#FEF08A]',
  green: 'bg-[#BBF7D0]',
  blue: 'bg-[#BFDBFE]',
  pink: 'bg-[#FBCFE8]',
  orange: 'bg-[#FED7AA]',
};

// The "has a branch" underline of a linked highlight: ONE stroke per real
// visual line, spanning that line's full width — never one stroke per rect.
//
// The signal is the vertical GAP between consecutive rects, and it works
// because `consolidateLineRects` has already run on capture:
//   - Real text lines never overlap, so their rects keep the leading as a
//     small positive gap (measured across the stored corpus: 0.3–3.7 pt).
//   - A formula's sub/superscript bands DO overlap vertically (a subscript
//     sits inside the main band's box), so consolidation trims them flush —
//     gap exactly 0. Every formula in the corpus lands here.
// A stack of flush rects is therefore one visual line: the stroke spans the
// union of their left/right edges and sits at the lowest bottom, so a
// fraction with a numerator, a bar and a denominator gets a single stroke
// under the whole formula instead of a staircase (user report 2026-08-11;
// the earlier top-distance threshold never fired because consolidation makes
// a formula band's top-distance equal to its height, exactly like a line).
const LINE_FLUSH_TOLERANCE = 0.1;

// The one exception: tightly-set text lines (an algorithm box, a table cell)
// can overlap too and come out flush as well. They give themselves away by
// starting at the SAME column edge at the SAME size — a formula's numerator,
// bar, subscript and denominator each start somewhere else and differ in
// height. Measured on BatchNorm p3, Algorithm 1 ("Values of x over a
// mini-batch …"): both lines at left 343.1, heights 12.4 and 11.7.
const SAME_COLUMN_EDGE = 1; // pt
const SAME_TEXT_SIZE = 0.8; // height ratio

function stackedTextLines(a: HighlightRect, b: HighlightRect): boolean {
  const heights = [a.height, b.height].sort((x, y) => x - y);
  return (
    Math.abs(a.left - b.left) <= SAME_COLUMN_EDGE && heights[0] / heights[1] >= SAME_TEXT_SIZE
  );
}

type UnderlineSegment = { left: number; top: number; width: number };

function underlineSegments(rects: HighlightRect[]): UnderlineSegment[] {
  if (rects.length === 0) return [];
  const order = [...rects].sort((a, b) => a.top - b.top);
  const segments: UnderlineSegment[] = [];
  let left = order[0].left;
  let right = order[0].left + order[0].width;
  let bottom = order[0].top + order[0].height;
  const flush = () => segments.push({ left, top: bottom, width: right - left });
  for (let i = 1; i < order.length; i += 1) {
    const r = order[i];
    if (r.top - bottom <= LINE_FLUSH_TOLERANCE && !stackedTextLines(order[i - 1], r)) {
      left = Math.min(left, r.left);
      right = Math.max(right, r.left + r.width);
      bottom = Math.max(bottom, r.top + r.height);
    } else {
      flush();
      left = r.left;
      right = r.left + r.width;
      bottom = r.top + r.height;
    }
  }
  flush();
  return segments;
}

// Find the page wrapper that owns a DOM node (selection anchor or event
// target). Pages carry data-testid="pdf-page-N".
function findPageWrapper(node: Node | HTMLElement | null): HTMLElement | null {
  let el: HTMLElement | null = null;
  if (node && node.nodeType === Node.ELEMENT_NODE) {
    el = node as HTMLElement;
  } else if (node && node.parentElement) {
    el = node.parentElement;
  }
  return el?.closest?.('[data-testid^="pdf-page-"]') as HTMLElement | null;
}

function pageNumberOf(wrapper: HTMLElement): number | null {
  const tid = wrapper.getAttribute('data-testid') ?? '';
  const n = Number(tid.slice('pdf-page-'.length));
  return n && !Number.isNaN(n) ? n : null;
}

// The annotation rect clips the citation token: it swallows the trailing
// comma and sometimes cuts the bracket (measured on real papers). A couple of
// points of slack on every side makes the target match what the reader sees.
const HIT_SLACK = 2;

// How far BELOW THE BASELINE the underline is drawn, in PDF points. A rule on
// the baseline itself crosses the descenders and reads as a strikethrough —
// across a whole reference row that was the first thing the eye noticed (user
// report 2026-08-09).
//
// Measured from the baseline, never from the citation's rect: that rect is the
// PDF's link box, and hyperref sizes it differently per paper (see
// backend/pdf-citations.js). Hung off the box, the rule sat ~2 pt lower under
// "(Bahdanau et al., 2015)" than under "[38]" — visible side by side, and the
// numeric one was the good one (user report 2026-08-10). 3.5 pt reproduces
// exactly that spacing for every kind of mark.
const UNDERLINE_GAP = 3.5;

export function PdfView({
  pdfUrl,
  title,
  highlights,
  onCaptureHighlight,
  onSelectionFinalized,
  onColorHighlightClick,
  citations,
  onCitationClick,
  onCitationHover,
  onVisibleCitationsChange,
  keepSelectionVisible,
  ref,
}: Props) {
  const [doc, setDoc] = useState<PdfDocumentHandle | null>(null);
  const [error, setError] = useState<string | null>(null);
  // UI-Texte in der App language — re-rendert beim Sprachwechsel mit.
  const S = useStrings().pdfView;
  const [zoom, setZoom] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  // Re-entrancy guard for the column-aware selection rewrite (see the
  // mouseup effect below) — addRange() can synthesise a selectionchange.
  const isConstrainingRef = useRef(false);
  // Linke Maustaste gedrückt? Ein Mousedown im Leerraum setzt kurz eine
  // KOLLABIERTE Caret-Selektion → selectionchange → der Collapse-Cleanup
  // unten würde die gerade notierten Drag-Punkte sofort wieder löschen.
  // Solange die Taste unten ist, wird deshalb nicht aufgeräumt.
  const isMouseDownRef = useRef(false);
  // Reference links: the marks and the callback live in refs so the mouse
  // effect below — which is keyed on [doc, zoom] — always sees the current
  // ones without re-binding its listeners on every citation update.
  const citationsRef = useRef<PaperCitation[] | undefined>(citations);
  citationsRef.current = citations;
  const onCitationClickRef = useRef(onCitationClick);
  onCitationClickRef.current = onCitationClick;
  const onCitationHoverRef = useRef(onCitationHover);
  onCitationHoverRef.current = onCitationHover;
  // Page heights in PDF points, filled as pages render. Needed to flip a
  // rect from PDF user space (origin bottom-left) into CSS coordinates.
  const pageHeightsRef = useRef<Map<number, number>>(new Map());
  const [, setPageHeights] = useState<Map<number, number>>(new Map());
  // Stable identity: PdfPageView takes this as an effect dependency, so a new
  // function on every render would re-measure the page endlessly.
  const rememberPageHeight = useCallback((pageNumber: number, height: number) => {
    if (pageHeightsRef.current.get(pageNumber) === height) return;
    pageHeightsRef.current.set(pageNumber, height);
    setPageHeights(new Map(pageHeightsRef.current));
  }, []);
  // Transient selection overlay: one tight rect per visible line while the
  // user has live text selected. Replaces the native blocky selection paint.
  const [transientSelection, setTransientSelection] = useState<{
    pageNumber: number;
    rects: HighlightRect[];
  } | null>(null);
  // Live-Spiegel des keepSelectionVisible-Props für die DOM-Event-Handler
  // (selectionchange läuft außerhalb des React-Renders).
  const keepSelectionRef = useRef(false);
  keepSelectionRef.current = !!keepSelectionVisible;

  // Popup geschlossen (oder Aktion ausgeführt): falls die native Selektion
  // inzwischen kollabiert ist, das festgehaltene Overlay jetzt wegräumen.
  useEffect(() => {
    if (keepSelectionVisible) return;
    const sel = window.getSelection?.();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setTransientSelection(null);
    }
  }, [keepSelectionVisible]);

  useEffect(() => {
    let cancelled = false;
    let handle: PdfDocumentHandle | null = null;
    setDoc(null);
    setError(null);
    setCurrentPage(1);
    setTransientSelection(null);
    loadPdfDocument(pdfUrl)
      .then(h => {
        if (cancelled) { h.destroy?.(); return; }
        handle = h;
        setDoc(h);
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load PDF');
      });
    return () => {
      cancelled = true;
      handle?.destroy?.();
    };
  }, [pdfUrl]);

  // Multi-rect highlight capture at mouseup time. Positions AND sizes are
  // normalized to zoom=1 (the zoom-safe fix) so the highlight renders with
  // correct geometry at every zoom level.
  const captureHighlightFromPoint = (target: EventTarget | null): PdfHighlightSelection | null => {
    const sel = window.getSelection?.();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;

    // sel.toString() (the fallback when the text layer/spans can't be
    // resolved) serializes pdf.js's per-line <br> elements as literal "\n"
    // characters — unlike extractColumnAwareSelectionText(), which already
    // collapses whitespace. Left unnormalized, those embedded newlines later
    // render as forced <br/> line breaks wherever the quote flows through
    // markdown (InlineMarkdown), breaking the "always one line" branch
    // header/mind-map layout (user report 2026-07-31).
    const text = extractColumnAwareSelectionText() ?? sel.toString().replace(/\s+/g, ' ');
    if (!text || !text.trim()) return null;

    const pageWrapper =
      findPageWrapper(sel.anchorNode) ??
      findPageWrapper(sel.focusNode) ??
      findPageWrapper(target as HTMLElement);
    if (!pageWrapper) return null;
    const pageNumber = pageNumberOf(pageWrapper);
    if (!pageNumber) return null;

    const pageRect = pageWrapper.getBoundingClientRect();
    const tight = computeTightLineRects();
    const sourceLines: DOMRect[] = tight
      ? tight.lines
      : Array.from(sel.getRangeAt(0).getClientRects()).filter(
          (r) => r.width > 0 && r.height > 0,
        );
    const rects: HighlightRect[] = normalizeRectsToZoom(sourceLines, pageRect, zoom);
    if (rects.length === 0) return null;

    return { pageNumber, text: text.trim(), rects };
  };

  // After a drag-select inside a PDF text layer, rewrite the live Selection
  // to hug one column (two-column papers interleave columns in DOM order),
  // then capture tight per-line rects into the transient overlay. Ported
  // from Syflo's PdfView — with width/height normalized by zoom too.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // Drag-Punkte an die Auswahl-Helfer melden (pdf/selection.ts): Chrome
    // snappt den Selektions-Fokus im Leerraum neben Formeln auf entfernte
    // Textfluss-Positionen — nur die echten Maus-Punkte tragen die Absicht.
    // Which citation rect, if any, sits under a click. Page sizes come from
    // the size cache below; a page not measured yet simply has no targets,
    // which resolves itself on the next render.
    const markAt = (e: MouseEvent): PaperCitation | null => {
      const marks = citationsRef.current;
      if (!marks || marks.length === 0) return null;
      const wrapper = findPageWrapper(e.target as Node | null);
      if (!wrapper) return null;
      const pageNumber = pageNumberOf(wrapper);
      if (!pageNumber) return null;
      const pageHeight = pageHeightsRef.current.get(pageNumber);
      if (!pageHeight) return null;
      const box = wrapper.getBoundingClientRect();
      // Pointer position in PDF user space: origin bottom-left, unscaled.
      const px = (e.clientX - box.left) / zoom;
      const py = pageHeight - (e.clientY - box.top) / zoom;
      for (const mark of marks) {
        if (mark.pageNumber !== pageNumber) continue;
        const [x0, y0, x1, y1] = mark.rect;
        // The raw rect clips the citation token — it stops at the comma and
        // sometimes cuts the bracket (measured on real papers) — so the hit
        // area is grown by a couple of points on every side.
        if (px < x0 - HIT_SLACK || px > x1 + HIT_SLACK) continue;
        if (py < y0 - HIT_SLACK || py > y1 + HIT_SLACK) continue;
        return mark;
      }
      return null;
    };

    const hitTestCitation = (e: MouseEvent) => {
      if (!onCitationClickRef.current) return;
      const mark = markAt(e);
      if (mark) onCitationClickRef.current(mark, { clientX: e.clientX, clientY: e.clientY });
    };

    // Pointing at a mark starts its full-text search (§ 05). Only the CHANGE
    // is reported: mousemove fires continuously, and the queue should hear
    // about a mark once, not sixty times a second.
    let hoveredAnchor: string | null = null;
    const hitTestHover = (e: MouseEvent) => {
      if (!onCitationHoverRef.current) return;
      const mark = markAt(e);
      const anchor = mark ? `${mark.pageNumber}:${mark.anchor}` : null;
      if (anchor === hoveredAnchor) return;
      hoveredAnchor = anchor;
      if (mark) onCitationHoverRef.current(mark);
    };

    const onMouseDown = (e: MouseEvent) => {
      // Nur die LINKE Taste startet eine Auswahl. Ein Rechtsklick (z. B. für
      // das native Kontextmenü) darf die Drag-Punkte der bestehenden Auswahl
      // nicht überschreiben — sonst schnurrt das Band einer mehrzeiligen
      // Auswahl zusammen und die Highlight-Erfassung verliert Zeilen.
      if (e.button !== 0) return;
      isMouseDownRef.current = true;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('.textLayer')) {
        noteSelectionDragStart(e.clientY, container);
      } else {
        clearSelectionDragPoints();
      }
    };
    const onMouseMove = (e: MouseEvent) => {
      if (e.buttons & 1) noteSelectionDragMove(e.clientY);
      else hitTestHover(e);
    };
    const onMouseUp = (e: MouseEvent) => {
      const wasDragging = isMouseDownRef.current;
      isMouseDownRef.current = false;
      if (isConstrainingRef.current) return;
      const target = e.target as HTMLElement | null;
      if (!target?.closest?.('.textLayer')) return;
      const sel = window.getSelection?.();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        // No selection came out of this press: it was a plain click, so it
        // may have landed on a citation. Testing the rects HERE — rather than
        // rendering anchors over the text layer — is what keeps the drag-select
        // gesture untouched: an <a> would swallow mousedown outright.
        if (wasDragging) hitTestCitation(e);
        return;
      }
      noteSelectionDragMove(e.clientY);

      isConstrainingRef.current = true;
      try {
        // First: grow boundaries that Chrome rounded into a glyph out to whole
        // words (selection/wordSnap.ts) — otherwise the popup, the branch and
        // the highlight all lose the first or last letter (repro 2026-08-06).
        // Runs BEFORE the column constrain, which preserves the boundary
        // offsets it finds.
        snapLiveSelectionToWords();
        constrainSelectionToColumn();
      } finally {
        queueMicrotask(() => {
          isConstrainingRef.current = false;
        });
      }

      const tight = computeTightLineRects();
      const wrapper = findPageWrapper(e.target as HTMLElement);
      if (!wrapper || !tight) {
        setTransientSelection(null);
        return;
      }
      const pageNumber = pageNumberOf(wrapper);
      if (!pageNumber) return;
      const pageRect = wrapper.getBoundingClientRect();
      const rects: HighlightRect[] = normalizeRectsToZoom(tight.lines, pageRect, zoom);
      setTransientSelection(rects.length > 0 ? { pageNumber, rects } : null);
      // The constrain above re-adds the range, firing a selectionchange whose
      // rAF update recomputes the same rects — harmless double work, but it
      // keeps the overlay consistent when the mouseup landed off-page.

      // Finishing the drag opens the FloatingPopup directly — no right-click
      // needed (user request 2026-07-31).
      if (rects.length > 0) {
        const captured = captureHighlightFromPoint(e.target);
        if (captured) {
          onCaptureHighlight?.(captured);
          onSelectionFinalized?.({ clientX: e.clientX, clientY: e.clientY });
        }
      }
    };
    container.addEventListener('mousedown', onMouseDown);
    container.addEventListener('mousemove', onMouseMove);
    container.addEventListener('mouseup', onMouseUp);
    return () => {
      container.removeEventListener('mousedown', onMouseDown);
      container.removeEventListener('mousemove', onMouseMove);
      container.removeEventListener('mouseup', onMouseUp);
      clearSelectionDragPoints();
    };
  }, [doc, zoom]);

  // Live transient overlay while the user drags: the native selection paint
  // is suppressed entirely (index.css — pdf.js font boxes are wider and
  // taller than the canvas glyphs, so the browser's own rectangles covered
  // empty margin space and neighboring lines). Instead, recompute the tight
  // per-line rects on every selectionchange, throttled to one update per
  // animation frame. Also clears the overlay when the selection collapses.
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const sel = window.getSelection?.();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        // Popup offen → die erfasste Auswahl bleibt sichtbar, obwohl die
        // native Selektion (durch den Klick ins Popup) kollabiert ist.
        if (!keepSelectionRef.current) {
          setTransientSelection(null);
          if (!isMouseDownRef.current) clearSelectionDragPoints();
        }
        return;
      }
      // Only react to selections anchored inside one of OUR text layers.
      const anchorEl =
        sel.anchorNode?.nodeType === Node.ELEMENT_NODE
          ? (sel.anchorNode as HTMLElement)
          : sel.anchorNode?.parentElement ?? null;
      const layer = anchorEl?.closest?.('.textLayer');
      if (!layer || !containerRef.current?.contains(layer)) return;
      const tight = computeTightLineRects();
      const wrapper = findPageWrapper(sel.anchorNode);
      if (!tight || !wrapper) {
        setTransientSelection(null);
        return;
      }
      const pageNumber = pageNumberOf(wrapper);
      if (!pageNumber) return;
      const pageRect = wrapper.getBoundingClientRect();
      const rects = normalizeRectsToZoom(tight.lines, pageRect, zoom);
      setTransientSelection(rects.length > 0 ? { pageNumber, rects } : null);
    };
    const onSelChange = () => {
      if (isConstrainingRef.current) return;
      if (!raf) raf = requestAnimationFrame(update);
    };
    document.addEventListener('selectionchange', onSelChange);
    return () => {
      document.removeEventListener('selectionchange', onSelChange);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [zoom]);

  // Which citations are on the page in view — the list the prefetch queue
  // works through (design/mockup-citation-card-standard.html § 05). About
  // four references appear per page in a typical paper, so this is a handful
  // of requests spread over reading, not ~25 in a burst at import.
  //
  // The page just left is dropped by the parent, deliberately: its citations
  // are no longer the ones about to be clicked.
  const onVisibleCitationsChangeRef = useRef(onVisibleCitationsChange);
  onVisibleCitationsChangeRef.current = onVisibleCitationsChange;
  useEffect(() => {
    const notify = onVisibleCitationsChangeRef.current;
    if (!notify || !citations?.length) return;
    notify(citations.filter((c) => c.pageNumber === currentPage));
  }, [currentPage, citations]);

  // Scroll spy: the toolbar page indicator follows the scroll position. Until
  // this existed, currentPage only ever moved through the arrow buttons and
  // the highlight jump, so free scrolling left it stuck at "1 / N" (user
  // report 2026-08-08). The active page is the one covering most of the
  // visible area — that also keeps the drawer jump (which centers a rect on
  // its page) reporting the page the user actually landed on.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !doc) return;
    let raf: number | null = null;
    const update = () => {
      raf = null;
      const view = container.getBoundingClientRect();
      let bestPage = 1;
      let bestVisible = -1;
      for (let n = 1; n <= doc.numPages; n++) {
        const el = pageRefs.current.get(n);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        const visible = Math.min(rect.bottom, view.bottom) - Math.max(rect.top, view.top);
        if (visible > bestVisible) {
          bestVisible = visible;
          bestPage = n;
        }
      }
      if (bestVisible > 0) setCurrentPage(bestPage);
    };
    const onScroll = () => {
      if (raf === null) raf = requestAnimationFrame(update);
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [doc]);

  const goToPage = (page: number) => {
    if (!doc) return;
    const clamped = Math.min(Math.max(page, 1), doc.numPages);
    setCurrentPage(clamped);
    pageRefs.current.get(clamped)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Sprung aus dem Highlights-Drawer: Rect vertikal mittig in den Viewport
  // scrollen und das Highlight kurz aufblinken lassen. Alle Seiten sind
  // eager gerendert, das Ziel existiert also immer sofort.
  const [flashHighlightId, setFlashHighlightId] = useState<string | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const scrollSettleRafRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    if (scrollSettleRafRef.current !== null) cancelAnimationFrame(scrollSettleRafRef.current);
  }, []);

  useImperativeHandle(ref, () => ({
    scrollToHighlight: (highlightId: string) => {
      const h = (highlights ?? []).find((x) => x.id === highlightId);
      if (!h) return;
      setCurrentPage(h.pageNumber);
      const container = containerRef.current;
      const pageEl = pageRefs.current.get(h.pageNumber);
      if (container && pageEl) {
        const rectTop = (h.rects[0]?.top ?? 0) * zoom;
        const pageTopInContainer =
          pageEl.getBoundingClientRect().top -
          container.getBoundingClientRect().top +
          container.scrollTop;
        const target = pageTopInContainer + rectTop - container.clientHeight / 2;
        container.scrollTo?.({ top: Math.max(0, target), behavior: 'smooth' });
      }
      const startFlash = () => {
        setFlashHighlightId(highlightId);
        if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
        flashTimerRef.current = window.setTimeout(() => setFlashHighlightId(null), FLASH_MS);
      };
      // Erst scrollen, DANN aufglühen (Nutzer-Report 2026-08-15). Vorher lief
      // beides gleichzeitig los: der Glow begann, während die Seite noch fuhr,
      // also spielte ein Teil der Pulse ab, bevor die Stelle überhaupt im Bild
      // war — gemessen brauchte ein Sprung über mehrere Seiten deutlich länger
      // als die 1,35 s der Animation. Das war der Hauptgrund, warum das
      // Aufglühen schwer zu bemerken war.
      //
      // Dieselbe Scroll-Ruhe-Erkennung wie in ChatArea (jumpToMessage): drei
      // Frames ohne Positionsänderung. Kein `scrollend`-Event, weil das nicht
      // feuert, wenn die Stelle schon im Sichtfeld lag und gar nicht gescrollt
      // wurde — die Frame-Prüfung deckt beide Fälle ab. Harter Deckel bei 2 s,
      // damit ein hängender Smooth-Scroll den Glow nicht ganz verschluckt.
      if (!container) {
        startFlash();
        return;
      }
      if (scrollSettleRafRef.current !== null) cancelAnimationFrame(scrollSettleRafRef.current);
      const startedAt = performance.now();
      let lastTop = container.scrollTop;
      let stableFrames = 0;
      const tick = () => {
        const top = container.scrollTop;
        if (top === lastTop) {
          stableFrames++;
        } else {
          stableFrames = 0;
          lastTop = top;
        }
        if (stableFrames >= 3 || performance.now() - startedAt > 2000) {
          scrollSettleRafRef.current = null;
          startFlash();
          return;
        }
        scrollSettleRafRef.current = requestAnimationFrame(tick);
      };
      scrollSettleRafRef.current = requestAnimationFrame(tick);
    },
  }));

  const pages = doc ? Array.from({ length: doc.numPages }, (_, i) => i + 1) : [];

  // overflow-hidden: dragged narrow, the toolbar and the PDF page keep their
  // min-content width and would otherwise spill out of the pane and paint under
  // the transparent chat pane — white slivers between the two sidebars in the
  // dark themes (user report 2026-08-08).
  return (
    <div
      data-focus-region="source"
      className="syflo-pdf-pane flex-1 flex flex-col min-w-0 overflow-hidden bg-gray-100">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 bg-white border-b border-gray-200 shrink-0">
        <div className="flex items-center gap-2 min-w-0 flex-1 text-sm text-gray-700">
          <FileText size={15} className="text-gray-400 shrink-0" />
          <span className={title && hasMath(title) ? 'syflo-math-fade' : 'truncate'}><MathText text={title || 'PDF'} /></span>
        </div>
        <div className="flex items-center gap-1 bg-gray-50 border border-gray-200 rounded-lg px-1 py-0.5">
          <button
            onClick={() => setZoom(z => Math.max(ZOOM_MIN, z - ZOOM_STEP))}
            className="w-7 h-7 flex items-center justify-center rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100"
            aria-label={S.zoomOut}
            data-focus-item="pdf-zoom-out"
            data-testid="pdf-zoom-out"
          >
            <Minus size={14} />
          </button>
          <span className="text-xs text-gray-700 w-12 text-center tabular-nums" data-testid="pdf-zoom-level">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={() => setZoom(z => Math.min(ZOOM_MAX, z + ZOOM_STEP))}
            className="w-7 h-7 flex items-center justify-center rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100"
            aria-label={S.zoomIn}
            data-focus-item="pdf-zoom-in"
            data-testid="pdf-zoom-in"
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="flex items-center gap-1 text-xs text-gray-700">
          <button
            onClick={() => goToPage(currentPage - 1)}
            className="w-7 h-7 flex items-center justify-center rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100"
            aria-label={S.previousPage}
            data-focus-item="pdf-prev-page"
            data-testid="pdf-prev-page"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="tabular-nums" data-testid="pdf-page-indicator">
            {currentPage} / {doc?.numPages ?? '–'}
          </span>
          <button
            onClick={() => goToPage(currentPage + 1)}
            className="w-7 h-7 flex items-center justify-center rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100"
            aria-label={S.nextPage}
            data-focus-item="pdf-next-page"
            data-testid="pdf-next-page"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      {/* Pages */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto p-6"
        // The marks in the document are a reading sequence, not a layout of
        // rows: two highlights on one line are two places in the text, and ←
        // out of them must mean "leave", not "the mark to my left". The
        // toolbar above is an ordinary row and keeps its left/right.
        data-focus-axis="sequence"
        data-testid="pdf-scroll-container"
      >
        {error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3 max-w-md mx-auto">
            {S.loadError(error)}
          </div>
        )}
        {doc && (
          <div className="flex flex-col items-center gap-4">
            {pages.map(n => (
              <PdfPageView
                key={n}
                doc={doc}
                pageNumber={n}
                zoom={zoom}
                highlights={(highlights ?? []).filter(h => h.pageNumber === n)}
                // Keyboard items of the source region are the highlights
                // (ADR-0011). A paper that carries none falls back to the page
                // itself, so the region never empties out and vanishes from
                // the focus map — then ↑/↓ turn pages.
                isFocusItem={(highlights ?? []).length === 0}
                flashHighlightId={flashHighlightId}
                transientRects={
                  transientSelection && transientSelection.pageNumber === n
                    ? transientSelection.rects
                    : null
                }
                onColorHighlightClick={onColorHighlightClick}
                citations={(citations ?? []).filter((c) => c.pageNumber === n)}
                onPageHeight={rememberPageHeight}
                registerPage={(el) => {
                  if (el) pageRefs.current.set(n, el);
                  else pageRefs.current.delete(n);
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// One page card: canvas + selectable text layer + highlight overlays, all in
// a relative wrapper so the absolute overlays align with the canvas.
function PdfPageView({
  doc,
  pageNumber,
  zoom,
  highlights,
  flashHighlightId,
  transientRects,
  onColorHighlightClick,
  registerPage,
  citations,
  onPageHeight,
  isFocusItem,
}: {
  doc: PdfDocumentHandle;
  pageNumber: number;
  zoom: number;
  highlights: Highlight[];
  // True while the whole source carries no highlights — then the page itself
  // is the keyboard item (ADR-0011).
  isFocusItem: boolean;
  flashHighlightId: string | null;
  transientRects: HighlightRect[] | null;
  onColorHighlightClick?: (highlight: Highlight, e: React.MouseEvent) => void;
  registerPage: (el: HTMLDivElement | null) => void;
  // Citation marks on THIS page, in PDF user space.
  citations?: PaperCitation[];
  // Reported once the page size is known, so the parent can hit-test clicks.
  onPageHeight?: (pageNumber: number, height: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [pageHeight, setPageHeight] = useState<number | null>(null);

  // The page's own height in PDF points — the one number needed to flip a
  // citation rect from PDF user space into CSS coordinates. Independent of
  // zoom, so it is fetched once per page.
  useEffect(() => {
    let cancelled = false;
    void doc.getPageSize(pageNumber).then(({ height }) => {
      if (cancelled) return;
      setPageHeight(height);
      onPageHeight?.(pageNumber, height);
    });
    return () => { cancelled = true; };
  }, [doc, pageNumber, onPageHeight]);

  // Canvas first, then the text layer on top. Re-runs on zoom change so both
  // stay in sync with the viewport scale.
  useEffect(() => {
    const canvas = canvasRef.current;
    const layer = textLayerRef.current;
    if (!canvas) return;
    let cancelled = false;
    (async () => {
      await doc.renderPage(pageNumber, canvas, zoom);
      if (cancelled || !layer) return;
      await doc.renderTextLayer?.(pageNumber, layer, zoom);
    })();
    return () => { cancelled = true; };
  }, [doc, pageNumber, zoom]);

  return (
    <div
      ref={registerPage}
      data-testid={`pdf-page-${pageNumber}`}
      data-focus-item={isFocusItem ? `page-${pageNumber}` : undefined}
      // overflow-hidden: highlight overlays are absolutely positioned from
      // STORED rects — a degenerate rect (pre-drag-band-fix data, or any
      // future coordinate bug) must never paint past its own page onto the
      // pane or the neighboring column (user report 2026-07-25).
      className="relative isolate overflow-hidden bg-white rounded shadow-md w-fit"
    >
      <canvas ref={canvasRef} className="block rounded" data-testid="pdf-page-canvas" />
      {/* `textLayer` class triggers pdf.js's positioning CSS (imported in
          pdfDocument.ts). Without it the spans aren't absolutely positioned
          and the selection appears offset from the visible text. */}
      <div
        ref={textLayerRef}
        className="textLayer"
        data-testid={`pdf-text-layer-${pageNumber}`}
      />
      {/* Transient drag-selection overlay — one semi-transparent blue rect
          per visible line, exactly hugging the text. Pointer-events none so
          the rects don't intercept the user's drag. */}
      {transientRects?.map((r, idx) => (
        <div
          key={`sel-${idx}`}
          aria-hidden="true"
          className="absolute pointer-events-none"
          style={{
            left: r.left * zoom,
            top: r.top * zoom,
            width: r.width * zoom,
            height: r.height * zoom,
            background: 'rgba(59, 130, 246, 0.30)',
            mixBlendMode: 'multiply',
            zIndex: 3,
          }}
        />
      ))}
      {/* Citation underlines. A dotted rule under each mark, nothing blue —
          the page must still read as a paper, and there is no toggle to find
          (design/mockup-paper-reference-links.html § 02). Pointer-events are
          off: the click is hit-tested against the rects in the parent's mouse
          handler, so an underline can never swallow a drag-select. */}
      {pageHeight !== null &&
        citations?.map((c, idx) => {
          const [x0, y0, x1] = c.rect;
          // The line the glyphs sit on. Older geometry carries no baseline;
          // the rect's bottom edge is the closest thing to it, and the backend
          // re-measures the paper in the background so this is temporary.
          const baseline = c.baseline ?? y0;
          return (
            <div
              key={`cite-${idx}`}
              aria-hidden="true"
              data-testid={`pdf-citation-${c.anchor}`}
              className="absolute pointer-events-none border-b border-dotted border-gray-400"
              style={{
                left: x0 * zoom,
                // PDF user space has its origin bottom-left; CSS counts down
                // from the top. The box is drawn flat ON the rule's own line,
                // UNDERLINE_GAP below the baseline, so nothing about the link
                // box's height can move the mark.
                top: (pageHeight - baseline + UNDERLINE_GAP) * zoom,
                width: (x1 - x0) * zoom,
                height: 0,
                zIndex: 2,
              }}
            />
          );
        })}
      {/* Colored highlights — multi-rect (one element per line) so the
          stripe hugs the text. All four rect values scale with zoom (the
          zoom-safe fix). Click opens the actions menu. The branch underline
          is NOT drawn on these rects: it is its own layer below, one stroke
          per visual line (underlineSegments).

          The multiply blend sits on this GROUP, not on each rect. Multiply is
          what keeps the black glyphs readable through the pastel, but applied
          per rect it also multiplies two highlights with each other wherever
          they overlap — and they do overlap across highlights: a formula's
          rect is taller than the line (its subscripts hang below), so marking
          the formula and then the text under it painted a band of a third
          colour, measured in the running app as yellow × green =
          rgb(186,232,113) over 3.8 pt (user report 2026-08-11). Consolidation
          only trims rects WITHIN one selection; nothing coordinates two.
          Blending the finished group once means an overlap is painted in one
          colour — the same pastel where the colours match, the later
          highlight's where they don't. */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ mixBlendMode: 'multiply', zIndex: 4 }}
      >
        {highlights.map((h) => {
          return h.rects.map((r, idx) => (
            <button
              key={`${h.id}-${idx}`}
              type="button"
              // Every rect of a highlight carries the id. It is ONE keyboard
              // item — readScreen deduplicates — but the ring belongs on all
              // of it. Marking only the first rect put the ring on a formula's
              // superscript alone, because a formula is stored as several
              // bands and the superscript happens to come first (user report
              // 2026-08-11).
              data-focus-item={h.id}
              data-testid={`pdf-color-highlight-${h.id}`}
              data-color={h.color}
              data-flash={flashHighlightId === h.id ? 'true' : undefined}
              data-linked={h.chatId ? 'true' : undefined}
              title={h.text}
              onClick={(e) => {
                e.stopPropagation();
                onColorHighlightClick?.(h, e);
              }}
              className={`absolute border-0 p-0 cursor-pointer rounded-[2px] pointer-events-auto ${HIGHLIGHT_BG_CLASS[h.color]}`}
              style={{
                left: r.left * zoom,
                top: r.top * zoom,
                width: r.width * zoom,
                height: r.height * zoom,
              }}
            />
          ));
        },
        )}
      </div>
      {/* Branch underline: one stroke per visual line, spanning that line's
          full width. Its own layer — hanging it off the rects made a formula
          look like a staircase, because a formula is many rects but ONE
          line. Not clickable; the colored rect underneath takes the click. */}
      {highlights
        .filter((h) => h.chatId)
        .flatMap((h) =>
          underlineSegments(h.rects).map((s, idx) => (
            <div
              key={`ul-${h.id}-${idx}`}
              aria-hidden="true"
              data-testid={`pdf-highlight-underline-${h.id}`}
              className="absolute pointer-events-none border-t border-gray-900/50"
              style={{
                left: s.left * zoom,
                top: s.top * zoom,
                width: s.width * zoom,
                height: 0,
                zIndex: 5,
              }}
            />
          )),
        )}
      {/* Flash-Glow nach einem Drawer-Sprung: eigenes Overlay über dem
          Highlight (normaler Blend), damit der farbige Schein leuchtet, ohne
          den Multiply-Blend der Markierung anzufassen. Alle Zeilen-Rects
          liegen in EINEM Container mit drop-shadow — der Glow folgt der
          gemeinsamen Silhouette, mehrzeilige Markierungen leuchten als eine
          Form ohne hellere Nähte an den Zeilengrenzen. */}
      {highlights
        .filter((h) => h.id === flashHighlightId)
        .map((h) => (
          <div
            key={`flash-${h.id}`}
            aria-hidden="true"
            className="absolute inset-0 pointer-events-none syflo-hl-flash-group"
            style={{
              zIndex: 5,
              ...({
                '--flash-color': HIGHLIGHT_GLOW_HEX[h.color],
                // The page is white paper in every theme, so the silhouette
                // stays white × multiply here even where the app is dark. Only
                // the shared overlay over CHAT text follows the theme (see
                // .syflo-hl-flash-group in index.css).
                '--syflo-flash-fill': '#ffffff',
                '--syflo-flash-blend': 'multiply',
              } as React.CSSProperties),
            }}
          >
            {h.rects.map((r, idx) => (
              <div
                key={idx}
                className="absolute rounded-[2px]"
                style={{
                  left: r.left * zoom,
                  top: r.top * zoom,
                  width: r.width * zoom,
                  height: r.height * zoom,
                }}
              />
            ))}
          </div>
        ))}
    </div>
  );
}
