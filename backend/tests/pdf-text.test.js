/**
 * tests/pdf-text.test.js
 *
 * Unit tests for pdf-text.js: tree-root paper lookup, lazy extraction with
 * DB caching, graceful degradation on extraction failure — plus one
 * end-to-end extraction of a real minimal PDF through pdf.js.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { createDb } = require('../database');
const { extractPdfText, getTreePaperContext } = require('../pdf-text');

const TEST_DB_PATH = path.join(__dirname, 'pdf_text_test.db');

let db;

beforeEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

function insertChat(id, parentId = null, paperId = null) {
  db.prepare(
    'INSERT INTO chats (id, title, parent_id, parent_word, created_at, paper_id) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, `Chat ${id}`, parentId, parentId ? 'word' : null, new Date().toISOString(), paperId);
}

function insertPaper(id, extractedText = null) {
  db.prepare(
    'INSERT INTO papers (id, title, uploaded_at, pdf_path, status, extracted_text) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, `Paper ${id}`, new Date().toISOString(), `/fake/${id}.pdf`, 'ready', extractedText);
}

describe('getTreePaperContext', () => {
  it('returns null when the tree has no paper', async () => {
    insertChat('root');
    const extractFn = jest.fn();
    expect(await getTreePaperContext(db, 'root', extractFn)).toBeNull();
    expect(extractFn).not.toHaveBeenCalled();
  });

  it('extracts lazily and caches the text on the papers row', async () => {
    insertPaper('p1');
    insertChat('root', null, 'p1');
    const extractFn = jest.fn().mockResolvedValue('EXTRACTED TEXT');

    const first = await getTreePaperContext(db, 'root', extractFn);
    expect(first).toEqual({ paperId: 'p1', title: 'Paper p1', text: 'EXTRACTED TEXT' });
    expect(extractFn).toHaveBeenCalledWith('/fake/p1.pdf');

    // Second call must hit the cache, not the extractor.
    const second = await getTreePaperContext(db, 'root', extractFn);
    expect(second.text).toBe('EXTRACTED TEXT');
    expect(extractFn).toHaveBeenCalledTimes(1);
    const row = db.prepare('SELECT extracted_text FROM papers WHERE id = ?').get('p1');
    expect(row.extracted_text).toBe('EXTRACTED TEXT');
  });

  it('walks a branch chat up to the tree root that carries the paper', async () => {
    insertPaper('p1', 'CACHED');
    insertChat('root', null, 'p1');
    insertChat('child', 'root');
    insertChat('grandchild', 'child');
    const ctx = await getTreePaperContext(db, 'grandchild', jest.fn());
    expect(ctx).toEqual({ paperId: 'p1', title: 'Paper p1', text: 'CACHED' });
  });

  it('returns null (no throw) when extraction fails', async () => {
    insertPaper('p1');
    insertChat('root', null, 'p1');
    const extractFn = jest.fn().mockRejectedValue(new Error('corrupt PDF'));
    expect(await getTreePaperContext(db, 'root', extractFn)).toBeNull();
  });

  it('returns null for a nonexistent chat', async () => {
    expect(await getTreePaperContext(db, 'nope', jest.fn())).toBeNull();
  });

  it('re-extracts caches that were truncated by the old 40k cap', async () => {
    // Vor dem Retrieval-Modus wurde schon beim Extrahieren gekappt — solche
    // Caches enden mit dem Marker und müssen einmalig neu extrahiert werden,
    // damit lange Papers vollständig in der DB liegen.
    insertPaper('p1', 'OLD HEAD OF PAPER\n[… paper text truncated]');
    insertChat('root', null, 'p1');
    const extractFn = jest.fn().mockResolvedValue('FULL RE-EXTRACTED TEXT');

    const ctx = await getTreePaperContext(db, 'root', extractFn);

    expect(extractFn).toHaveBeenCalledWith('/fake/p1.pdf');
    expect(ctx.text).toBe('FULL RE-EXTRACTED TEXT');
    const row = db.prepare('SELECT extracted_text FROM papers WHERE id = ?').get('p1');
    expect(row.extracted_text).toBe('FULL RE-EXTRACTED TEXT');
  });

  it('keeps the truncated cache when re-extraction fails', async () => {
    insertPaper('p1', 'OLD HEAD OF PAPER\n[… paper text truncated]');
    insertChat('root', null, 'p1');
    const extractFn = jest.fn().mockRejectedValue(new Error('corrupt PDF'));

    const ctx = await getTreePaperContext(db, 'root', extractFn);

    // Besser der alte, gekappte Text als gar keiner.
    expect(ctx.text).toBe('OLD HEAD OF PAPER\n[… paper text truncated]');
  });
});

describe('extractPdfText', () => {
  it('extracts long PDFs in full — no 40k-char truncation', async () => {
    // Retrieval-Modus-Grundlage: die DB hält den VOLLTEXT; Budgets gelten
    // erst beim Prompt-Bau (messages.js), nicht bei der Extraktion.
    // Eine Zeile pro Tj — PDF-Strings haben ein Längen-Limit, ein einzelner
    // 54k-String würde still verworfen.
    const line = 'Scaling laws for neural language models on long documents.';
    const pdf = buildMinimalPdf(Array.from({ length: 900 }, () => line)); // ~54k Zeichen
    const tmp = path.join(os.tmpdir(), `syflo-pdftext-long-${process.pid}.pdf`);
    fs.writeFileSync(tmp, pdf);
    try {
      const text = await extractPdfText(tmp);
      expect(text.length).toBeGreaterThan(50_000);
      expect(text).not.toContain('[… paper text truncated]');
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('extracts text from a real minimal PDF', async () => {
    // Hand-rolled single-page PDF with Helvetica "Hello Syflo paper".
    const pdf = buildMinimalPdf('Hello Syflo paper');
    const tmp = path.join(os.tmpdir(), `syflo-pdftext-${process.pid}.pdf`);
    fs.writeFileSync(tmp, pdf);
    try {
      const text = await extractPdfText(tmp);
      expect(text).toContain('Hello Syflo paper');
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

// Build the smallest valid PDF that renders one line of text (or an array of
// lines, ~50 per page so nothing falls off the MediaBox), with a correct
// xref table (pdf.js validates offsets).
function buildMinimalPdf(text) {
  const lines = Array.isArray(text) ? text : [text];
  const LINES_PER_PAGE = 50;
  const pages = [];
  for (let i = 0; i < lines.length; i += LINES_PER_PAGE) {
    pages.push(lines.slice(i, i + LINES_PER_PAGE));
  }

  // Objekt-Layout: 1=Catalog, 2=Pages, 3=Font, danach pro Seite ein
  // Page-Objekt gefolgt von seinem Content-Stream.
  const objects = [null, null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  pages.forEach((pageLines) => {
    const pageNum = objects.length + 1;
    const contentNum = pageNum + 1;
    kids.push(`${pageNum} 0 R`);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNum} 0 R ` +
        '/Resources << /Font << /F1 3 0 R >> >> >>'
    );
    const stream =
      `BT /F1 10 Tf 12 TL 72 720 Td ` +
      pageLines.map((l) => `(${l}) Tj T*`).join(' ') +
      ` ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;

  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    body += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(body, 'latin1');
}
