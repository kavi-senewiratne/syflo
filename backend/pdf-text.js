/**
 * pdf-text.js
 *
 * Plain-text extraction from the tree's attached PDF, so the chat model can
 * actually answer questions about the paper (before this, the model had no
 * access to the document and hallucinated summaries).
 *
 * Extraction is lazy and cached: the first message in a tree with a bound
 * paper triggers pdf.js text extraction, the result is stored in
 * papers.extracted_text, and every later message reads the cached column.
 *
 * The DB holds the FULL text — prompt budgets are applied at prompt-build
 * time (messages.js / retrieval.js), never here. Papers that exceed the
 * context window go through the retrieval mode instead of blunt truncation.
 */

const fs = require('fs');
const path = require('path');

// Marker the old 40k cap wrote at the end of truncated texts. Such caches
// are incomplete and get re-extracted on the next access.
const LEGACY_TRUNCATION_MARKER = '[… paper text truncated]';

// pdf.js comes from the shared loader (pdfjs.js) — see there for why the
// import is dynamic and why exactly one memo is allowed to exist.
const { loadPdfjs } = require('./pdfjs');

/**
 * Extract the full plain text of a PDF file, page by page. Throws on
 * unreadable/corrupt files — callers decide how to degrade.
 */
async function extractPdfText(pdfPath) {
  const { getDocument } = await loadPdfjs();
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const task = getDocument({ data, isEvalSupported: false, useSystemFonts: true });
  const doc = await task.promise;
  try {
    const pages = [];
    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (typeof item.str === 'string') text += item.str;
        text += item.hasEOL ? '\n' : ' ';
      }
      const cleaned = text.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
      pages.push(cleaned);
    }
    return pages.join('\n\n');
  } finally {
    await task.destroy();
  }
}

/**
 * The paper bound to the chat's tree (ADR-0002: the ROOT chat carries
 * paper_id), with its text extracted-and-cached. Returns
 * `{ paperId, title, text }` or null when the tree has no paper or extraction
 * fails (a chat that works without paper context beats a 500).
 *
 * `extractFn` is injectable for tests.
 */
async function getTreePaperContext(db, chatId, extractFn = extractPdfText) {
  const getChat = db.prepare('SELECT id, parent_id, paper_id FROM chats WHERE id = ?');
  let chat = getChat.get(chatId);
  while (chat && chat.parent_id) chat = getChat.get(chat.parent_id);
  if (!chat || !chat.paper_id) return null;

  const paper = db
    .prepare('SELECT id, title, pdf_path, extracted_text FROM papers WHERE id = ?')
    .get(chat.paper_id);
  if (!paper) return null;

  const cached = typeof paper.extracted_text === 'string' ? paper.extracted_text : '';
  // Re-extract caches cut off by the old 40k cap once — the retrieval mode
  // needs the full text in the DB.
  const cacheUsable = cached.length > 0 && !cached.endsWith(LEGACY_TRUNCATION_MARKER);
  if (cacheUsable) {
    return {
      paperId: paper.id,
      title: paper.title || path.basename(paper.pdf_path),
      text: cached,
    };
  }

  try {
    const text = await extractFn(paper.pdf_path);
    if (!text || !text.trim()) return null;
    db.prepare('UPDATE papers SET extracted_text = ? WHERE id = ?').run(text, paper.id);
    return { paperId: paper.id, title: paper.title || path.basename(paper.pdf_path), text };
  } catch (err) {
    console.error(`Paper text extraction failed for ${paper.pdf_path}:`, err.message);
    // A truncated old cache is better than no paper context at all.
    if (cached.length > 0) {
      return {
        paperId: paper.id,
        title: paper.title || path.basename(paper.pdf_path),
        text: cached,
      };
    }
    return null;
  }
}

module.exports = { extractPdfText, getTreePaperContext, LEGACY_TRUNCATION_MARKER };
