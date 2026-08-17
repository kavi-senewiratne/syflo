/**
 * pdf/pdfDocument.ts
 *
 * Thin wrapper around pdf.js so components depend on a small handle
 * (numPages + renderPage + renderTextLayer) instead of the pdf.js API
 * surface. Tests mock this module; the real implementation is the only
 * place that touches pdfjs-dist.
 */

// LEGACY-Build statt dem modernen: pdf.js ≥ 6.1 setzt brandneue JS-APIs
// voraus (Map.getOrInsertComputed, Uint8Array.toHex — TC39-Proposals), die
// die Chromium-Version der Electron-Hülle noch nicht kennt. Der PDF-Upload
// scheiterte dort mit "this._requestsByChunk.getOrInsertComputed is not a
// function" (Nutzer-Report 2026-07-23). Der Legacy-Build bringt seine
// eigenen Polyfills mit — im Haupt-Bundle UND im Worker.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
// pdf.js text-layer CSS — required so the absolute-positioned text spans line
// up with the rendered canvas. Without this import, selecting text produces
// a highlight rectangle that's visually offset from the actual words.
import 'pdfjs-dist/web/pdf_viewer.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfDocumentHandle {
  numPages: number;
  /** Render a 1-based page into the canvas at the given zoom scale. */
  renderPage: (pageNumber: number, canvas: HTMLCanvasElement, scale: number) => Promise<void>;
  /**
   * Render the selectable pdf.js text layer for a page into `container`
   * (positioned absolutely over the canvas). Clears any previous content —
   * call again after a zoom change so span positions match the new scale.
   */
  renderTextLayer: (pageNumber: number, container: HTMLElement, scale: number) => Promise<void>;
  // Page size in PDF points (scale 1). Reference-link rects arrive in PDF
  // user space with the origin bottom-left, so converting them to CSS
  // coordinates needs the page height.
  getPageSize: (pageNumber: number) => Promise<{ width: number; height: number }>;
  destroy?: () => void;
}

export async function loadPdfDocument(url: string): Promise<PdfDocumentHandle> {
  // pdf.js v6 nimmt keinen nackten String mehr an — getDocument liest nur
  // noch src.url (relative URLs werden gegen window.location aufgelöst).
  const loadingTask = pdfjsLib.getDocument({ url });
  const doc = await loadingTask.promise;
  return {
    numPages: doc.numPages,
    async renderPage(pageNumber, canvas, scale) {
      // pdf.js erlaubt keine überlappenden render()-Aufrufe auf demselben
      // Canvas (StrictMode-Doppel-Effekte, schnelles Zoomen). Renders pro
      // Canvas serialisieren: der nächste wartet, bis der vorige fertig ist.
      const chained = canvas as HTMLCanvasElement & { _renderChain?: Promise<void> };
      const run = async () => {
        const page = await doc.getPage(pageNumber);
        // Render at device resolution so text stays crisp on retina displays;
        // the CSS size stays at the zoom-scaled viewport size.
        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale });
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        // pdf.js v6: render() nimmt das Canvas selbst entgegen (RenderParameters
        // verlangt `canvas`; das alte `canvasContext` allein ist ein Typfehler).
        await page.render({
          canvas,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        }).promise;
      };
      chained._renderChain = (chained._renderChain ?? Promise.resolve()).then(run, run);
      await chained._renderChain;
    },
    async getPageSize(pageNumber) {
      const page = await doc.getPage(pageNumber);
      const { width, height } = page.getViewport({ scale: 1 });
      return { width, height };
    },
    async renderTextLayer(pageNumber, container, scale) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      container.innerHTML = '';
      // `--scale-factor` is read by the pdf.js text-layer CSS to scale spans.
      // Setting this incorrectly is the classic cause of "selection highlight
      // is offset from the text" — it has to match the viewport scale exactly.
      container.style.setProperty('--scale-factor', String(scale));
      // The span font-size rule is `calc(var(--text-scale-factor) *
      // var(--font-height))`, and --text-scale-factor chains up to
      // --total-scale-factor — which pdf_viewer.css only defines under
      // `.pdfViewer .page` (the full viewer widget). Our standalone layer has
      // no such ancestor, so without these the calc() is invalid, every span
      // falls back to the inherited 16px font, and each span's box is taller
      // and wider than its canvas line (the root cause of highlights bleeding
      // into the next line and into the right margin).
      container.style.setProperty('--total-scale-factor', String(scale));
      container.style.setProperty('--user-unit', '1');
      // Used by the round() expression TextLayer.render() writes into the
      // layer's inline width/height.
      container.style.setProperty('--scale-round-x', '1px');
      container.style.setProperty('--scale-round-y', '1px');
      container.style.width = `${Math.floor(viewport.width)}px`;
      container.style.height = `${Math.floor(viewport.height)}px`;
      const textContent = await page.getTextContent();
      const layer = new pdfjsLib.TextLayer({
        textContentSource: textContent,
        container,
        viewport,
      });
      try {
        await layer.render();
      } catch (_err) {
        // Best-effort: a cancelled render (rapid zooming) leaves the layer
        // empty; the next zoom settles and re-renders it.
      }
    },
    // v6: destroy() liegt auf dem LoadingTask, nicht mehr auf dem Dokument.
    destroy: () => { void loadingTask.destroy(); },
  };
}
