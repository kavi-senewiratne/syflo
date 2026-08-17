/**
 * PdfView.test.tsx
 *
 * Tests for the center-column PDF viewer (slice 03): loading a document from
 * its pdf_url, rendering one canvas per page, and the zoom controls.
 * pdf.js itself is mocked behind the loadPdfDocument wrapper module.
 */

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRef } from 'react';
import { PdfView, type PdfViewHandle } from '../components/PdfView';
import { computeTightLineRects, extractColumnAwareSelectionText } from '../pdf/selection';

const renderPage = vi.fn().mockResolvedValue(undefined);
const renderTextLayer = vi.fn().mockResolvedValue(undefined);
// Page size in PDF points — the view needs it to place citation underlines.
const getPageSize = vi.fn().mockResolvedValue({ width: 612, height: 792 });
const loadPdfDocument = vi.fn();

vi.mock('../pdf/pdfDocument', () => ({
  loadPdfDocument: (url: string) => loadPdfDocument(url),
}));

// Column-aware span filtering needs real layout (getClientRects etc.), which
// jsdom doesn't provide — stub the two boundary functions the mouseup
// handler calls so a selection test can control its geometry directly.
vi.mock('../pdf/selection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pdf/selection')>();
  return { ...actual, computeTightLineRects: vi.fn(), extractColumnAwareSelectionText: vi.fn() };
});

beforeEach(() => {
  renderPage.mockClear();
  renderTextLayer.mockClear();
  loadPdfDocument.mockReset();
  loadPdfDocument.mockResolvedValue({ numPages: 3, renderPage, renderTextLayer, getPageSize });
});

describe('PdfView', () => {
  it('loads the document from pdf_url and renders one canvas per page', async () => {
    render(<PdfView pdfUrl="/api/papers/p1/pdf" />);
    expect(loadPdfDocument).toHaveBeenCalledWith('/api/papers/p1/pdf');
    await waitFor(() => {
      expect(screen.getAllByTestId('pdf-page-canvas').length).toBe(3);
    });
    // Page indicator shows the total.
    expect(screen.getByTestId('pdf-page-indicator')).toHaveTextContent('1 / 3');
  });

  it('zooms in and out in 25% steps and re-renders pages at the new scale', async () => {
    render(<PdfView pdfUrl="/api/papers/p1/pdf" />);
    await waitFor(() => expect(screen.getAllByTestId('pdf-page-canvas').length).toBe(3));
    expect(screen.getByTestId('pdf-zoom-level')).toHaveTextContent('100%');

    renderPage.mockClear();
    fireEvent.click(screen.getByTestId('pdf-zoom-in'));
    expect(screen.getByTestId('pdf-zoom-level')).toHaveTextContent('125%');
    await waitFor(() => {
      expect(renderPage).toHaveBeenCalledWith(1, expect.anything(), 1.25);
    });

    fireEvent.click(screen.getByTestId('pdf-zoom-out'));
    fireEvent.click(screen.getByTestId('pdf-zoom-out'));
    expect(screen.getByTestId('pdf-zoom-level')).toHaveTextContent('75%');
  });

  it('does not zoom below 50% or above 300%', async () => {
    render(<PdfView pdfUrl="/api/papers/p1/pdf" />);
    await waitFor(() => expect(screen.getAllByTestId('pdf-page-canvas').length).toBe(3));
    for (let i = 0; i < 20; i++) fireEvent.click(screen.getByTestId('pdf-zoom-out'));
    expect(screen.getByTestId('pdf-zoom-level')).toHaveTextContent('50%');
    for (let i = 0; i < 20; i++) fireEvent.click(screen.getByTestId('pdf-zoom-in'));
    expect(screen.getByTestId('pdf-zoom-level')).toHaveTextContent('300%');
  });

  it('follows the scroll position in the page indicator (user report 2026-08-08: it was stuck at 1/19)', async () => {
    render(<PdfView pdfUrl="/api/papers/p1/pdf" />);
    await waitFor(() => expect(screen.getAllByTestId('pdf-page-canvas').length).toBe(3));

    const container = screen.getByTestId('pdf-scroll-container');
    container.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    const layout = (n: number, top: number) => {
      screen.getByTestId(`pdf-page-${n}`).getBoundingClientRect = () =>
        new DOMRect(0, top, 800, 800);
    };

    // Page 2 fills the viewport, page 1 has almost scrolled out.
    layout(1, -780);
    layout(2, 20);
    layout(3, 840);
    fireEvent.scroll(container);
    await waitFor(() =>
      expect(screen.getByTestId('pdf-page-indicator')).toHaveTextContent('2 / 3'),
    );

    // Scrolling on: page 3 now owns most of the viewport.
    layout(1, -1620);
    layout(2, -820);
    layout(3, -20);
    fireEvent.scroll(container);
    await waitFor(() =>
      expect(screen.getByTestId('pdf-page-indicator')).toHaveTextContent('3 / 3'),
    );

    // Back to the top.
    layout(1, 0);
    layout(2, 820);
    layout(3, 1640);
    fireEvent.scroll(container);
    await waitFor(() =>
      expect(screen.getByTestId('pdf-page-indicator')).toHaveTextContent('1 / 3'),
    );
  });

  it('rendert den selektierbaren Text-Layer für jede Seite', async () => {
    render(<PdfView pdfUrl="/api/papers/p1/pdf" />);
    await waitFor(() => expect(screen.getAllByTestId('pdf-page-canvas').length).toBe(3));
    await waitFor(() => {
      expect(renderTextLayer).toHaveBeenCalledWith(1, expect.anything(), 1);
      expect(renderTextLayer).toHaveBeenCalledWith(3, expect.anything(), 1);
    });
    expect(screen.getByTestId('pdf-text-layer-2')).toBeInTheDocument();
  });

  describe('Zitat-Unterstriche (Referenz-Links)', () => {
    // Beide Marken sitzen auf DERSELBEN Schriftlinie (baseline 720), aber der
    // Link-Kasten des Autor-Jahr-Zitats reicht tiefer — genau so, wie hyperref
    // ihn setzt (gemessen 2026-08-10: 1,07 pt vs. 3,15 pt unter der Linie).
    const citations = [
      { referenceId: 'r1', anchor: 'cite.numeric', pageNumber: 1, rect: [180, 719, 192, 728] as [number, number, number, number], baseline: 720 },
      { referenceId: 'r2', anchor: 'cite.authors', pageNumber: 1, rect: [300, 717, 390, 728] as [number, number, number, number], baseline: 720 },
    ];

    it('hängt die Linie an die Schriftlinie, nicht an den Link-Kasten', async () => {
      // Der Bug: Am Kasten aufgehängt lag der Unterstrich unter
      // "(Bahdanau et al., 2015)" rund 2 pt tiefer als unter "[38]" —
      // nebeneinander sichtbar (Nutzerreport 2026-08-10).
      render(<PdfView pdfUrl="/api/papers/p1/pdf" citations={citations} />);
      await waitFor(() => expect(screen.getByTestId('pdf-citation-cite.numeric')).toBeInTheDocument());

      const numeric = screen.getByTestId('pdf-citation-cite.numeric');
      const authors = screen.getByTestId('pdf-citation-cite.authors');
      // Seitenhöhe 792 − Grundlinie 720 + 3,5 pt Abstand.
      expect(numeric.style.top).toBe('75.5px');
      expect(authors.style.top).toBe(numeric.style.top);
    });

    it('skaliert die Linie mit dem Zoom', async () => {
      render(<PdfView pdfUrl="/api/papers/p1/pdf" citations={citations} />);
      await waitFor(() => expect(screen.getByTestId('pdf-citation-cite.numeric')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('pdf-zoom-in')); // 125 %
      expect(screen.getByTestId('pdf-citation-cite.numeric').style.top).toBe('94.375px');
      expect(screen.getByTestId('pdf-citation-cite.numeric').style.width).toBe('15px');
    });

    it('fällt auf den Kasten zurück, solange eine Marke keine Grundlinie hat', async () => {
      // Geometrie aus der Zeit vor der Messung (oder eine Marke über einer
      // Abbildung): die Unterkante des Kastens ist das Nächstbeste.
      render(
        <PdfView
          pdfUrl="/api/papers/p1/pdf"
          citations={[{ ...citations[1], baseline: null }]}
        />,
      );
      await waitFor(() => expect(screen.getByTestId('pdf-citation-cite.authors')).toBeInTheDocument());

      expect(screen.getByTestId('pdf-citation-cite.authors').style.top).toBe('78.5px');
    });
  });

  describe('Highlight-Overlays (Slice 04 — zoom-sicher)', () => {
    const highlight = {
      id: 'h1',
      paperId: 'p1',
      color: 'yellow' as const,
      text: 'imitation learning',
      pageNumber: 2,
      rects: [
        { left: 50, top: 25, width: 200, height: 12 },
        { left: 50, top: 41, width: 120, height: 12 },
      ],
      chatId: null,
      createdAt: 'x',
      updatedAt: 'x',
    };

    it('clips overlays at the page edge — stray rects never paint into the pane (user report 2026-07-25)', async () => {
      render(<PdfView pdfUrl="/api/papers/p1/pdf" highlights={[highlight]} />);
      await waitFor(() => expect(screen.getAllByTestId('pdf-color-highlight-h1').length).toBe(2));
      // The page wrapper must clip its absolutely positioned overlays: a
      // degenerate stored rect (pre-drag-band-fix data) otherwise bleeds
      // across the page edge into the pane or the neighboring column.
      expect(screen.getByTestId('pdf-page-2').className).toContain('overflow-hidden');
      // isolate: mix-blend-mode-Overlays duerfen dem Overflow-Clipping nicht
      // entkommen (Chromium-Blend-Escape, Nutzerreport 2026-07-25).
      expect(screen.getByTestId('pdf-page-2').className).toContain('isolate');
    });

    it('zeichnet ein Multi-Rect-Overlay nur auf der eigenen Seite', async () => {
      render(<PdfView pdfUrl="/api/papers/p1/pdf" highlights={[highlight]} />);
      await waitFor(() => expect(screen.getAllByTestId('pdf-color-highlight-h1').length).toBe(2));
      const page2 = screen.getByTestId('pdf-page-2');
      for (const el of screen.getAllByTestId('pdf-color-highlight-h1')) {
        expect(page2).toContainElement(el);
        expect(el.getAttribute('data-color')).toBe('yellow');
      }
    });

    it('blendet die Markierungen als GRUPPE, nicht einzeln (keine Mischfarbe bei Überlappung)', async () => {
      // Two highlights that overlap: a formula's rect is taller than its line,
      // so it reaches into the text marked below it. With multiply on each
      // rect, the overlap was painted twice and came out as a third colour —
      // measured in the running app as yellow × green = rgb(186,232,113) and
      // blue × blue = rgb(143,188,253) (user report 2026-08-11). The blend
      // belongs on the group that holds them, so an overlap is painted once.
      const other = {
        ...highlight,
        id: 'h6',
        color: 'green' as const,
        rects: [{ left: 50, top: 33, width: 200, height: 12 }], // overlaps h1's first rect
      };
      render(<PdfView pdfUrl="/api/papers/p1/pdf" highlights={[highlight, other]} />);
      await waitFor(() => expect(screen.getAllByTestId('pdf-color-highlight-h6').length).toBe(1));
      const rect = screen.getAllByTestId('pdf-color-highlight-h6')[0];
      const group = rect.parentElement as HTMLElement;
      expect(rect.style.mixBlendMode).toBe('');
      expect(group.style.mixBlendMode).toBe('multiply');
      // Every rect of every highlight hangs in that one group.
      for (const el of [
        ...screen.getAllByTestId('pdf-color-highlight-h1'),
        ...screen.getAllByTestId('pdf-color-highlight-h6'),
      ]) {
        expect(el.parentElement).toHaveStyle({ mixBlendMode: 'multiply' });
        expect(el.style.mixBlendMode).toBe('');
      }
    });

    it('skaliert ALLE VIER Rect-Werte mit dem Zoom (Regression: Syflo-Zoom-Bug)', async () => {
      render(<PdfView pdfUrl="/api/papers/p1/pdf" highlights={[highlight]} />);
      await waitFor(() => expect(screen.getAllByTestId('pdf-color-highlight-h1').length).toBe(2));

      const at100 = screen.getAllByTestId('pdf-color-highlight-h1')[0];
      expect(at100.style.left).toBe('50px');
      expect(at100.style.top).toBe('25px');
      expect(at100.style.width).toBe('200px');
      expect(at100.style.height).toBe('12px');

      fireEvent.click(screen.getByTestId('pdf-zoom-in')); // 125%
      const at125 = screen.getAllByTestId('pdf-color-highlight-h1')[0];
      expect(at125.style.left).toBe('62.5px');
      expect(at125.style.top).toBe('31.25px');
      // Der eigentliche Bug: Breite/Höhe blieben in Syflo bei 200/12 hängen.
      expect(at125.style.width).toBe('250px');
      expect(at125.style.height).toBe('15px');
    });

    it('scrollToHighlight scrollt ZUERST und glüht erst danach ~1,35 s (Drawer-Sprung)', async () => {
      // jsdom kennt Element.scrollTo nicht — stubben und Aufruf prüfen.
      const scrollTo = vi.fn();
      (HTMLElement.prototype as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo;

      const ref = createRef<PdfViewHandle>();
      render(<PdfView ref={ref} pdfUrl="/api/papers/p1/pdf" highlights={[highlight]} />);
      await waitFor(() => expect(screen.getAllByTestId('pdf-color-highlight-h1').length).toBe(2));

      act(() => ref.current!.scrollToHighlight('h1'));

      // Gescrollt wird sofort, die Seitenzahl steht sofort.
      expect(scrollTo).toHaveBeenCalled();
      expect(screen.getByTestId('pdf-page-indicator')).toHaveTextContent('2 / 3');

      // Der Glow aber NICHT: er wartet auf Scroll-Ruhe (Nutzer-Report
      // 2026-08-15 „zuerst scrollen und dann aufglühen"). Vorher stand
      // data-flash schon in dieser Zeile — genau das ist die Änderung.
      for (const el of screen.getAllByTestId('pdf-color-highlight-h1')) {
        expect(el).not.toHaveAttribute('data-flash');
      }

      // Nach drei ruhigen Frames setzt er ein. In jsdom bewegt sich
      // scrollTop nie, also greift die Ruhe-Erkennung im ersten Anlauf.
      await waitFor(() => {
        for (const el of screen.getAllByTestId('pdf-color-highlight-h1')) {
          expect(el).toHaveAttribute('data-flash', 'true');
        }
      });

      // …und erlischt nach FLASH_MS (3 × 0,45 s).
      await waitFor(
        () => {
          for (const el of screen.getAllByTestId('pdf-color-highlight-h1')) {
            expect(el).not.toHaveAttribute('data-flash');
          }
        },
        { timeout: 3000 },
      );
    });

    it('unterstreicht eine echte Zwei-Zeilen-Markierung auf BEIDEN Zeilen', async () => {
      // The fixture's two rects are a full line-height apart (gap 16 vs
      // height 12) — a genuine 2-line paragraph highlight, so both lines
      // get their own underline (user report 2026-08-01: only the last of
      // several real lines was underlined before this fix).
      const linked = { ...highlight, id: 'h2', chatId: 'chat-9' };
      render(<PdfView pdfUrl="/api/papers/p1/pdf" highlights={[highlight, linked]} />);
      await waitFor(() => expect(screen.getAllByTestId('pdf-color-highlight-h2').length).toBe(2));
      // Two pages render the same highlight in this fixture, so count per page.
      expect(screen.getAllByTestId('pdf-highlight-underline-h2')).toHaveLength(2);
      // An unlinked highlight gets no stroke at all.
      expect(screen.queryAllByTestId('pdf-highlight-underline-h1')).toHaveLength(0);
    });

    it('unterstreicht drei echte Prosazeilen einzeln (gemessene Geometrie)', async () => {
      // Real geometry, read out of the stored corpus (BatchNorm p1, "the loss
      // over a mini-batch …"): consecutive text lines keep a small positive
      // gap — 0.5 and 0.4 pt here — which is what separates them from a
      // formula's flush bands.
      const prose = {
        ...highlight,
        id: 'h4',
        chatId: 'chat-9',
        rects: [
          { left: 321.7, top: 197.1, width: 218.5, height: 11.4 },
          { left: 311.0, top: 209.0, width: 229.0, height: 11.4 },
          { left: 311.0, top: 220.9, width: 229.1, height: 11.4 },
        ],
      };
      render(<PdfView pdfUrl="/api/papers/p1/pdf" highlights={[prose]} />);
      await waitFor(() => expect(screen.getAllByTestId('pdf-color-highlight-h4').length).toBe(3));
      const strokes = screen.getAllByTestId('pdf-highlight-underline-h4');
      expect(strokes).toHaveLength(3);
      expect(strokes.map((el) => (el as HTMLElement).style.top)).toEqual([
        '208.5px',
        '220.4px',
        '232.3px',
      ]);
    });

    it('trennt eng gesetzte Textzeilen, die bündig aneinanderstoßen (Algorithmus-Kasten)', async () => {
      // Real geometry, BatchNorm p3 Algorithm 1: the two input lines are set
      // so tightly that consolidation trims them flush, exactly like formula
      // bands. What tells them apart is that they start at the same column
      // edge (343.1) at the same size (12.4 / 11.7) — so: two strokes.
      const box = {
        ...highlight,
        id: 'h5',
        chatId: 'chat-9',
        rects: [
          { left: 343.1, top: 498.5, width: 181.1, height: 12.4 },
          { left: 343.1, top: 510.8, width: 120.7, height: 11.7 },
        ],
      };
      render(<PdfView pdfUrl="/api/papers/p1/pdf" highlights={[box]} />);
      await waitFor(() => expect(screen.getAllByTestId('pdf-color-highlight-h5').length).toBe(2));
      expect(screen.getAllByTestId('pdf-highlight-underline-h5')).toHaveLength(2);
    });

    it('zieht EINEN Strich unter eine Formel, über ihre ganze Breite (gemessene Geometrie)', async () => {
      // Real geometry of the highlight in the user's screenshot (2026-08-11,
      // BatchNorm p1, "Θ₂ ← Θ₂ − α/m Σ ∂F₂(xᵢ,Θ₂)/∂Θ₂"): numerator, fraction
      // bar and denominator are three rects that consolidateLineRects has
      // trimmed FLUSH (each top equals the previous bottom). They are one
      // visual line, so one stroke — the old top-distance rule drew three, on
      // three different heights.
      const formula = {
        ...highlight,
        id: 'h3',
        chatId: 'chat-9',
        rects: [
          { left: 413.4, top: 599.6, width: 76.9, height: 12.4 },
          { left: 358.9, top: 612.0, width: 50.3, height: 6.8 },
          { left: 412.3, top: 618.8, width: 62.2, height: 12.7 },
        ],
      };
      render(<PdfView pdfUrl="/api/papers/p1/pdf" highlights={[formula]} />);
      await waitFor(() => expect(screen.getAllByTestId('pdf-color-highlight-h3').length).toBe(3));
      const strokes = screen.getAllByTestId('pdf-highlight-underline-h3');
      expect(strokes).toHaveLength(1);
      const style = (strokes[0] as HTMLElement).style;
      // Bottom of the lowest band, spanning from the leftmost to the
      // rightmost edge of the whole formula (358.9 … 490.3).
      expect(style.top).toBe('631.5px');
      expect(style.left).toBe('358.9px');
      expect(Math.round(parseFloat(style.width))).toBe(131);
    });

    it('Klick auf ein Highlight ruft onColorHighlightClick auf', async () => {
      const onColorHighlightClick = vi.fn();
      render(
        <PdfView
          pdfUrl="/api/papers/p1/pdf"
          highlights={[highlight]}
          onColorHighlightClick={onColorHighlightClick}
        />,
      );
      await waitFor(() => expect(screen.getAllByTestId('pdf-color-highlight-h1').length).toBe(2));
      fireEvent.click(screen.getAllByTestId('pdf-color-highlight-h1')[0]);
      expect(onColorHighlightClick).toHaveBeenCalledWith(highlight, expect.anything());
    });
  });

  describe('Auswahl-Erfassung beim Loslassen (mouseup, kein Rechtsklick nötig — Nutzerwunsch 2026-07-31)', () => {
    it('erfasst die Selektion und meldet sie zusammen mit der Loslass-Position', async () => {
      const onCaptureHighlight = vi.fn();
      const onSelectionFinalized = vi.fn();
      vi.mocked(computeTightLineRects).mockReturnValue({
        lines: [new DOMRect(10, 20, 100, 12)],
      } as ReturnType<typeof computeTightLineRects>);
      vi.mocked(extractColumnAwareSelectionText).mockReturnValue('imitation learning');

      render(
        <PdfView
          pdfUrl="/api/papers/p1/pdf"
          onCaptureHighlight={onCaptureHighlight}
          onSelectionFinalized={onSelectionFinalized}
        />,
      );
      await waitFor(() => expect(screen.getAllByTestId('pdf-page-canvas').length).toBe(3));

      const page1 = screen.getByTestId('pdf-page-1');
      const textLayer = screen.getByTestId('pdf-text-layer-1');
      page1.getBoundingClientRect = () => new DOMRect(0, 0, 600, 800);

      const range = document.createRange();
      range.selectNodeContents(textLayer);
      // jsdom doesn't implement Range.getClientRects — the real (unmocked)
      // constrainSelectionToColumn() calls it before this test's mocked
      // functions are reached, so stub it to a no-op empty list.
      range.getClientRects = () => [] as unknown as DOMRectList;
      vi.spyOn(window, 'getSelection').mockReturnValue({
        isCollapsed: false,
        rangeCount: 1,
        anchorNode: textLayer,
        focusNode: textLayer,
        getRangeAt: () => range,
        toString: () => 'imitation learning',
      } as unknown as Selection);

      fireEvent.mouseUp(textLayer, { clientX: 40, clientY: 50 });

      expect(onCaptureHighlight).toHaveBeenCalledWith({
        pageNumber: 1,
        text: 'imitation learning',
        rects: [{ left: 10, top: 20, width: 100, height: 12 }],
      });
      expect(onSelectionFinalized).toHaveBeenCalledWith({ clientX: 40, clientY: 50 });
    });

    it('tut nichts, wenn keine Selektion existiert', async () => {
      const onCaptureHighlight = vi.fn();
      const onSelectionFinalized = vi.fn();
      render(
        <PdfView
          pdfUrl="/api/papers/p1/pdf"
          onCaptureHighlight={onCaptureHighlight}
          onSelectionFinalized={onSelectionFinalized}
        />,
      );
      await waitFor(() => expect(screen.getAllByTestId('pdf-page-canvas').length).toBe(3));
      fireEvent.mouseUp(screen.getByTestId('pdf-text-layer-1'));
      expect(onCaptureHighlight).not.toHaveBeenCalled();
      expect(onSelectionFinalized).not.toHaveBeenCalled();
    });
  });
});
