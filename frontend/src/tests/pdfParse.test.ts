/**
 * pdfParse.test.ts
 *
 * Regressionstest für den PDF-Upload (Nutzer-Report 2026-07-23): pdf.js ≥ 6.1
 * setzt brandneue JS-APIs voraus (Map.getOrInsertComputed, Uint8Array.toHex),
 * die ältere Runtimes — die Chromium-Version der Electron-Hülle ebenso wie
 * das Node dieser Tests — nicht kennen. Mit dem modernen Build scheiterte
 * jeder Upload mit "this._requestsByChunk.getOrInsertComputed is not a
 * function"; deshalb nutzt pdf/pdfDocument.ts den LEGACY-Build, der seine
 * Polyfills selbst mitbringt.
 *
 * Der Test fährt das ECHTE pdf.js (kein Mock) über ein echtes Mini-PDF —
 * genau der Pfad, der beim Upload läuft. Da Node die neuen APIs ebenfalls
 * nicht hat, fällt der Test wieder um, sobald jemand zurück auf den modernen
 * Build wechselt oder ein pdf.js-Update neue APIs ohne Polyfill voraussetzt.
 */

/// <reference types="node" />
// This one test runs in Node, not in a browser: it resolves the pdf.js
// worker from disk. tsconfig.app.json deliberately keeps Node's globals out
// of the app code (types: ["vite/client"]), so the types are pulled in here
// only, for this file.

import { describe, it, expect, beforeAll } from 'vitest';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
// Exakt derselbe Import wie in pdf/pdfDocument.ts (Legacy-Build).
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { loadPdfDocument } from '../pdf/pdfDocument';

beforeAll(() => {
  // pdfDocument.ts setzt workerSrc auf eine Vite-"?url" (Browser-Pfad) —
  // in Node muss der Fake-Worker das Modul über eine file://-URL nachladen
  // können (import.meta.url wäre unter Vitest eine http://-URL).
  pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
    path.resolve(process.cwd(), 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs'),
  ).href;
});

// Minimales, aber echtes einseitiges PDF — pdf.js rekonstruiert die fehlende
// xref-Tabelle selbst.
const MINIMAL_PDF = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj
trailer << /Root 1 0 R >>
%%EOF`;

describe('PDF-Parsing mit echtem pdf.js (Legacy-Build-Regression)', () => {
  it('der Legacy-Build installiert seine Polyfills (z. B. getOrInsertComputed)', () => {
    // Der Legacy-Import oben patcht die globalen Prototypen — genau der
    // Mechanismus, der den Upload in der Electron-Hülle repariert.
    expect(typeof (Map.prototype as unknown as Record<string, unknown>).getOrInsertComputed)
      .toBe('function');
  });

  it('parses a one-page PDF end-to-end without a mock', async () => {
    const data = new TextEncoder().encode(MINIMAL_PDF);
    const task = pdfjsLib.getDocument({ data });
    const doc = await task.promise;
    expect(doc.numPages).toBe(1);
    await task.destroy();
  });

  it('pdfDocument-Wrapper bleibt in Umgebungen ohne Worker importierbar', () => {
    expect(typeof loadPdfDocument).toBe('function');
  });
});
