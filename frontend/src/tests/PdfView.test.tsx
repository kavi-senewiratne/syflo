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
  loadPdfDocument.mockResolvedValue({ numPages: 3, renderPage, renderTextLayer });
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

  it('rendert den selektierbaren Text-Layer für jede Seite', async () => {
    render(<PdfView pdfUrl="/api/papers/p1/pdf" />);
    await waitFor(() => expect(screen.getAllByTestId('pdf-page-canvas').length).toBe(3));
    await waitFor(() => {
      expect(renderTextLayer).toHaveBeenCalledWith(1, expect.anything(), 1);
      expect(renderTextLayer).toHaveBeenCalledWith(3, expect.anything(), 1);
    });
    expect(screen.getByTestId('pdf-text-layer-2')).toBeInTheDocument();
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

    it('scrollToHighlight scrollt zum Rect, aktualisiert die Seite und blinkt ~1,5 s (Drawer-Sprung)', async () => {
      // jsdom kennt Element.scrollTo nicht — stubben und Aufruf prüfen.
      const scrollTo = vi.fn();
      (HTMLElement.prototype as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo;

      const ref = createRef<PdfViewHandle>();
      render(<PdfView ref={ref} pdfUrl="/api/papers/p1/pdf" highlights={[highlight]} />);
      await waitFor(() => expect(screen.getAllByTestId('pdf-color-highlight-h1').length).toBe(2));

      vi.useFakeTimers();
      try {
        act(() => ref.current!.scrollToHighlight('h1'));

        expect(scrollTo).toHaveBeenCalled();
        expect(screen.getByTestId('pdf-page-indicator')).toHaveTextContent('2 / 3');
        for (const el of screen.getAllByTestId('pdf-color-highlight-h1')) {
          expect(el).toHaveAttribute('data-flash', 'true');
        }

        act(() => {
          vi.advanceTimersByTime(1600);
        });
        for (const el of screen.getAllByTestId('pdf-color-highlight-h1')) {
          expect(el).not.toHaveAttribute('data-flash');
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('markiert eine mit einem Chat verknüpfte, echte Zwei-Zeilen-Markierung auf BEIDEN Zeilen', async () => {
      // The fixture's two rects are a full line-height apart (gap 16 vs
      // height 12) — a genuine 2-line paragraph highlight, so both lines
      // get their own underline (user report 2026-08-01: only the last of
      // several real lines was underlined before this fix).
      const linked = { ...highlight, id: 'h2', chatId: 'chat-9' };
      render(<PdfView pdfUrl="/api/papers/p1/pdf" highlights={[highlight, linked]} />);
      await waitFor(() => expect(screen.getAllByTestId('pdf-color-highlight-h2').length).toBe(2));
      for (const el of screen.getAllByTestId('pdf-color-highlight-h2')) {
        expect(el).toHaveAttribute('data-linked', 'true');
        expect(el.className).toContain('border-b ');
      }
      for (const el of screen.getAllByTestId('pdf-color-highlight-h1')) {
        expect(el).not.toHaveAttribute('data-linked');
        expect(el.className).not.toContain('border-b-2');
      }
    });

    it('kollabiert Formel-Baseline-Fragmente (Rects knapp nebeneinander) zu EINER Unterstreichung', async () => {
      // Sub/superscript baseline shifts split one visual line into several
      // rects only a few px apart (well under half the line height) —
      // those must collapse into a single underline, or it scatters across
      // the glyph (original user report 2026-08-01, the "y_i = γx̃_i + β"
      // screenshot).
      const formula = {
        ...highlight,
        id: 'h3',
        chatId: 'chat-9',
        rects: [
          { left: 50, top: 25, width: 20, height: 12 },
          { left: 70, top: 27, width: 10, height: 12 }, // subscript, 2px down
          { left: 80, top: 22, width: 10, height: 12 }, // superscript, 3px up from first
        ],
      };
      render(<PdfView pdfUrl="/api/papers/p1/pdf" highlights={[formula]} />);
      await waitFor(() => expect(screen.getAllByTestId('pdf-color-highlight-h3').length).toBe(3));
      const linkedEls = screen
        .getAllByTestId('pdf-color-highlight-h3')
        .filter((el) => el.hasAttribute('data-linked'));
      expect(linkedEls).toHaveLength(1);
      expect(linkedEls[0].className).toContain('border-b ');
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
