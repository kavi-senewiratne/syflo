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

import { useEffect, useImperativeHandle, useRef, useState } from 'react';
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
import type { Highlight, HighlightColor, HighlightRect } from '../../types';
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
  // Click an existing highlight → the parent opens the actions menu.
  onColorHighlightClick?: (highlight: Highlight, e: React.MouseEvent) => void;
  // Solange das Auswahl-Popup offen ist: das transiente Auswahl-Overlay
  // NICHT wegräumen, wenn die native Selektion kollabiert (der Klick ins
  // Popup kollabiert sie zwangsläufig) — der Nutzer soll weiter sehen, was
  // er markiert hat.
  keepSelectionVisible?: boolean;
  ref?: React.Ref<PdfViewHandle>;
}

// Dauer des Aufblink-Rings nach einem Drawer-Sprung.
const FLASH_MS = 1500;

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

// Which rects of a linked highlight get the "has a branch" underline. One
// per REAL visual line, not one per rect — a genuine multi-line paragraph
// highlight has one rect per line, roughly a full line-height apart
// (top-gap ≈ height). A formula's sub/superscript baselines instead split
// a SINGLE visual line into several rects only a few px apart (top-gap well
// under half the height) — those must collapse into one underline or they
// scatter across the glyph (user report 2026-08-01). Threshold: rects
// within half a line-height of the previous one join its line; anything
// further is a new line. Each line contributes its bottom-most rect.
const EMPTY_LINKED_SET: ReadonlySet<number> = new Set();

function linkedUnderlineIndices(rects: HighlightRect[]): Set<number> {
  const linked = new Set<number>();
  if (rects.length === 0) return linked;
  const order = rects.map((_, i) => i).sort((a, b) => rects[a].top - rects[b].top);
  let lineStart = order[0];
  const flushLine = (lineIdxs: number[]) => {
    linked.add(lineIdxs.reduce((best, i) => (rects[i].top > rects[best].top ? i : best), lineIdxs[0]));
  };
  let current = [order[0]];
  for (let k = 1; k < order.length; k++) {
    const i = order[k];
    const sameLine = rects[i].top - rects[lineStart].top < rects[lineStart].height * 0.5;
    if (sameLine) {
      current.push(i);
    } else {
      flushLine(current);
      current = [i];
      lineStart = i;
    }
  }
  flushLine(current);
  return linked;
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

export function PdfView({
  pdfUrl,
  title,
  highlights,
  onCaptureHighlight,
  onSelectionFinalized,
  onColorHighlightClick,
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
    };
    const onMouseUp = (e: MouseEvent) => {
      isMouseDownRef.current = false;
      if (isConstrainingRef.current) return;
      const target = e.target as HTMLElement | null;
      if (!target?.closest?.('.textLayer')) return;
      const sel = window.getSelection?.();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      noteSelectionDragMove(e.clientY);

      isConstrainingRef.current = true;
      try {
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
  useEffect(() => () => {
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
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
      setFlashHighlightId(highlightId);
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
      flashTimerRef.current = window.setTimeout(() => setFlashHighlightId(null), FLASH_MS);
    },
  }));

  const pages = doc ? Array.from({ length: doc.numPages }, (_, i) => i + 1) : [];

  return (
    <div className="syflo-pdf-pane flex-1 flex flex-col min-w-0 bg-gray-100">
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
            title={S.zoomOut}
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
            title={S.zoomIn}
            data-testid="pdf-zoom-in"
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="flex items-center gap-1 text-xs text-gray-700">
          <button
            onClick={() => goToPage(currentPage - 1)}
            className="w-7 h-7 flex items-center justify-center rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100"
            title={S.previousPage}
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
            title={S.nextPage}
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
                flashHighlightId={flashHighlightId}
                transientRects={
                  transientSelection && transientSelection.pageNumber === n
                    ? transientSelection.rects
                    : null
                }
                onColorHighlightClick={onColorHighlightClick}
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
}: {
  doc: PdfDocumentHandle;
  pageNumber: number;
  zoom: number;
  highlights: Highlight[];
  flashHighlightId: string | null;
  transientRects: HighlightRect[] | null;
  onColorHighlightClick?: (highlight: Highlight, e: React.MouseEvent) => void;
  registerPage: (el: HTMLDivElement | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);

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
      {/* Colored highlights — multi-rect (one element per line) so the
          stripe hugs the text. All four rect values scale with zoom (the
          zoom-safe fix). Click opens the actions menu. A linked chat gets an
          underline on the bottom-most rect of EVERY real visual line
          (linkedUnderlineIndices) — a genuine multi-line highlight shows one
          mark per line, while a formula's baseline-split rects within one
          line still collapse to a single mark (user reports 2026-08-01). */}
      {highlights.map((h) => {
        const linkedIdxs = h.chatId ? linkedUnderlineIndices(h.rects) : EMPTY_LINKED_SET;
        return h.rects.map((r, idx) => (
          <button
            key={`${h.id}-${idx}`}
            type="button"
            data-testid={`pdf-color-highlight-${h.id}`}
            data-color={h.color}
            data-flash={flashHighlightId === h.id ? 'true' : undefined}
            data-linked={linkedIdxs.has(idx) ? 'true' : undefined}
            title={h.text}
            onClick={(e) => {
              e.stopPropagation();
              onColorHighlightClick?.(h, e);
            }}
            className={`absolute border-0 p-0 cursor-pointer rounded-[2px] ${HIGHLIGHT_BG_CLASS[h.color]} ${linkedIdxs.has(idx) ? 'border-b border-gray-900/50' : ''}`}
            style={{
              left: r.left * zoom,
              top: r.top * zoom,
              width: r.width * zoom,
              height: r.height * zoom,
              // Multiply blend keeps black text readable through the pastel
              // highlight instead of producing washed-out grey.
              mixBlendMode: 'multiply',
              zIndex: 4,
            }}
          />
        ));
      },
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
              ...({ '--flash-color': HIGHLIGHT_GLOW_HEX[h.color] } as React.CSSProperties),
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
