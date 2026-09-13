/**
 * pdf-citations.js
 *
 * Reads a paper's own citation links straight out of the PDF.
 *
 * Vocabulary (CONTEXT.md): a CITATION is the mark in the running text
 * ("[13]", "(Vaswani et al., 2017)"); a REFERENCE is the row it points at in
 * the bibliography. LaTeX/hyperref emits one link annotation per cited work —
 * `[38, 24, 15]` is three separate annotations, not one — and each
 * annotation's destination is a named anchor carrying the BibTeX key
 * (`cite.hochreiter1997`) that lands on the reference row. Measured over the
 * stored corpus: 15 of 30 papers carry these anchors, 76–228 per paper.
 *
 * Reading them beats a regex over the text layer on every count: exact click
 * rects, one target per cited work, and a destination that already says which
 * reference row belongs to it.
 *
 * HOW GOOD `rawText` HAS TO BE — measured over five real papers:
 *   3bc85951 (Attention)   76 citations / 40 refs — every row clean
 *   2a554db3 (OpenVLA)    228 / 93 — 88 clean
 *   68c06684 (Gemma)      189 / 52 — 38 clean (author list printed alongside)
 *   00253992, 6ac15bb8    — figure captions and footnotes bleed in
 *
 * Chasing 100 % here is the wrong fight. `rawText` exists only to IDENTIFY a
 * row, and OpenAlex already hands us the paper's canonical bibliography via
 * `referenced_works[]` — some 40 known candidates. Matching a slightly dirty
 * row against 40 candidates (authors + year + title words) succeeds as long
 * as the real reference text is in there somewhere; the extra "Ada Lovelace"
 * in front of it costs nothing. Precision belongs in the matcher, not here.
 */

const fs = require('fs');

// pdf.js comes from the shared loader (pdfjs.js) — see there for why the
// import is dynamic and why exactly one memo is allowed to exist.
const { loadPdfjs } = require('./pdfjs');

// hyperref names its citation anchors `cite.<bibtexkey>`; other producers use
// `cite:<key>` or plain `bib<n>`. Anything else (section links, figure refs,
// the table of contents) is not a citation and is ignored.
const CITATION_ANCHOR = /^(?:cite[.:]|bib)/i;

/**
 * Where a named destination lands: `{ page, y }` in PDF user space, or null
 * when the PDF names an anchor it never defines (a stale \cite of a dropped
 * bibliography entry — rare, but it must not abort the whole extraction).
 */
async function resolveAnchor(doc, anchor) {
  let dest;
  try {
    dest = await doc.getDestination(anchor);
  } catch (_) {
    return null;
  }
  if (!Array.isArray(dest) || dest.length === 0) return null;
  let pageIndex;
  try {
    pageIndex = await doc.getPageIndex(dest[0]);
  } catch (_) {
    return null;
  }
  // [pageRef, /XYZ, left, top, zoom] — `top` is the y we want, `left` the x
  // that tells us which column the row lives in. /FitH carries the y in slot 2
  // and has no x; anything else has no usable position and is skipped.
  const kind = dest[1] && dest[1].name;
  const y = kind === 'XYZ' ? dest[3] : kind === 'FitH' ? dest[2] : null;
  if (typeof y !== 'number') return null;
  const x = kind === 'XYZ' && typeof dest[2] === 'number' ? dest[2] : null;
  return { page: pageIndex + 1, y, x };
}

/**
 * The column boundaries of a page, read off the page's own text geometry: a
 * vertical corridor that no text crosses separates two columns.
 *
 * Deriving them from the ANCHORS instead looks tempting and fails on the
 * common case — a bibliography printed beside a long author list, where no
 * anchor ever lands in the neighbouring column, so every reference row
 * swallowed the names next to it (measured on the Gemma paper).
 *
 * Returns ascending column starts; a single-column page yields one entry.
 * COLUMN_MERGE_X collapses starts that differ only by a hanging indent.
 */
const COLUMN_MERGE_X = 30;
const CORRIDOR_BIN = 4;   // page-width resolution in points
const CORRIDOR_MIN = 24;  // a gutter narrower than this is word spacing

function columnStarts(items, pageWidth) {
  const binCount = Math.ceil(pageWidth / CORRIDOR_BIN) + 1;
  const inked = new Array(binCount).fill(false);
  for (const item of items) {
    if (typeof item.str !== 'string' || !item.str.trim()) continue;
    const x0 = item.transform[4];
    const x1 = x0 + (item.width || 0);
    const from = Math.max(0, Math.floor(x0 / CORRIDOR_BIN));
    const to = Math.min(binCount - 1, Math.ceil(x1 / CORRIDOR_BIN));
    for (let b = from; b <= to; b++) inked[b] = true;
  }

  const starts = [];
  let gap = Infinity; // leading margin counts as a gutter
  for (let b = 0; b < binCount; b++) {
    if (inked[b]) {
      if (gap * CORRIDOR_BIN >= CORRIDOR_MIN) starts.push(b * CORRIDOR_BIN);
      gap = 0;
    } else {
      gap++;
    }
  }
  return starts.length ? starts : [0];
}

/** The column index an x falls into, given ascending column starts. */
function columnOf(x, starts) {
  if (starts.length <= 1 || typeof x !== 'number') return 0;
  let idx = 0;
  for (let i = 1; i < starts.length; i++) {
    // A hanging indent puts continuation lines slightly LEFT of the start.
    if (x >= starts[i] - COLUMN_MERGE_X) idx = i;
  }
  return idx;
}

/**
 * The text of one reference row: every text item on `page` that sits at or
 * below `fromY` and strictly above `toY` (the next anchor on that page, or
 * the bottom of the page). Rows are typeset top-down, so "below the anchor"
 * means a SMALLER y — PDF user space has its origin bottom-left.
 *
 * ANCHOR_SLACK absorbs the gap between where hyperref puts the anchor (the
 * row's baseline, give or take) and the baseline of the text itself.
 */
const ANCHOR_SLACK = 4;

// A numbered bibliography entry opening a line: "[12] ", "12. ". Used as the
// second row terminator — a reference nobody cites carries no anchor, and
// without this the previous row would swallow it and everything below it.
const ENTRY_OPENER = /^\s*(?:\[\d{1,3}\]|\(\d{1,3}\)|\d{1,3}\.)\s/;

// How far below a resolved destination the entry's own opener line may sit
// (see the snap step in extractCitations). One line height plus change: the
// top-edge flavour offsets by exactly one baseline-to-top distance (~10 pt),
// while the next entry's opener is at least a full entry further down.
const OPENER_SNAP = 16;

function rowTextBetween(items, fromY, toY, column, starts) {
  const parts = [];
  const used = [];
  let started = false;
  for (const item of items) {
    const y = item.transform[5];
    if (y > fromY + ANCHOR_SLACK) continue;
    if (toY !== null && y <= toY + ANCHOR_SLACK) continue;
    if (columnOf(item.transform[4], starts) !== column) continue;
    if (typeof item.str !== 'string') continue;
    // A fresh entry opener below the row we started closes it.
    if (started && y < fromY - ANCHOR_SLACK && ENTRY_OPENER.test(item.str)) break;
    if (item.str.trim()) started = true;
    parts.push(item.str);
    if (item.str.trim()) used.push(item);
    if (item.hasEOL) parts.push(' ');
  }
  return { text: parts.join('').replace(/\s+/g, ' ').trim(), items: used };
}

/**
 * Per-item geometry of a reference row: `{ page, rect, text }` for every text
 * item it is made of.
 *
 * The rows at the end of a paper are DESTINATIONS, not annotations: the PDF
 * gives them no rect of their own, so the reference list stayed dead while
 * every citation in the running text was live (user report 2026-08-09).
 *
 * Items are returned SEPARATELY rather than merged into line boxes, because
 * the caller underlines the title alone — underlining whole entries made the
 * bibliography look struck through (verified in the running app 2026-08-09),
 * and only the caller knows where the title starts, having parsed the row.
 */
function rowSpans(items, page) {
  return items.map((item) => {
    const x0 = item.transform[4];
    const y0 = item.transform[5];
    const round = (v) => Math.round(v * 100) / 100;
    return {
      page,
      rect: [round(x0), round(y0), round(x0 + (item.width || 0)), round(y0 + (item.height || 10))],
      // A text item's y IS its baseline, so a row needs no measuring — it is
      // reported alongside the rect so the caller can hang every underline,
      // citation and reference row alike, off the same line (see baselineOf).
      baseline: round(y0),
      // The line break counts as a space, exactly as it does in `rawText`.
      // Without it the joined spans read "...neural machinetranslation" and a
      // title spanning two lines could never be located in them — which left
      // 25 of 40 reference rows unmarked (measured 2026-08-09).
      text: item.hasEOL ? `${item.str} ` : item.str,
    };
  });
}

/**
 * The BASELINE the glyphs of a citation sit on, in PDF user space — or null
 * when no text of the page falls inside the link box (an image-only mark).
 *
 * A link annotation is NOT a text box: hyperref sizes it per paper, and its
 * bottom edge is a different distance from the baseline in every one.
 * Measured over the stored corpus 2026-08-10, annotation bottom → baseline:
 *   3bc85951 (Attention, "[38]")            1.07 pt, box 8.8 pt tall
 *   2a554db3 (OpenVLA, "[2, 3]")            1.08 pt, box 8.8 pt tall
 *   00e8141a ("(Bahdanau et al., 2015)")    3.15 pt, box 10.9 pt tall
 * A rule hung from the box therefore drifted a visible 2 pt lower under
 * author-year citations than under numeric ones (user report 2026-08-10).
 * Hung from the baseline it sits the same distance under every mark.
 *
 * Among the lines that reach into the box, the one whose baseline sits
 * CLOSEST TO ITS BOTTOM EDGE wins. A link box hugs the line it marks — its
 * bottom is 1 to 4 pt under that baseline — while a neighbouring line is a
 * whole line-height away.
 *
 * Horizontal overlap alone is not enough, and was the earlier rule: many PDFs
 * store a line of prose as ONE text item spanning the full column, so the
 * citation's own line and the line above it overlap a 66 pt box by exactly
 * the same 66 pt. The tie then went to reading order — the line above — and
 * the underline landed under "dependency parser", which is not a reference
 * (Structured Attention Networks p. 4, user report 2026-08-11). Overlap
 * survives as the tie-breaker, for the rare box that hugs nothing.
 */
const BASELINE_SLACK = 3;

function baselineOf(rect, items) {
  const [x0, y0, x1, y1] = rect;
  let best = null;
  for (const item of items || []) {
    if (typeof item.str !== 'string' || !item.str.trim()) continue;
    const by = item.transform[5];
    if (by < y0 - BASELINE_SLACK || by > y1 + BASELINE_SLACK) continue;
    const ix0 = item.transform[4];
    const overlap = Math.min(ix0 + (item.width || 0), x1) - Math.max(ix0, x0);
    if (overlap <= 0) continue;
    // How far this line's baseline floats above the box's bottom edge.
    const lift = by - y0;
    const better =
      !best || lift < best.lift - 0.01 || (Math.abs(lift - best.lift) <= 0.01 && overlap > best.overlap);
    if (better) best = { lift, overlap, y: by };
  }
  return best ? Math.round(best.y * 100) / 100 : null;
}

/**
 * Extract every citation link of a PDF, plus the reference row each one
 * points at.
 *
 * Returns:
 *   citations:  [{ page, rect, anchor }] in reading order — page by page, and
 *               within a page in the order the PDF lists its annotations.
 *               `rect` is PDF user space ([x0, y0, x1, y1], origin
 *               bottom-left); the frontend scales it to its current zoom.
 *   references: [{ anchor, rawText, rects }] in bibliography order — one per
 *               DISTINCT anchor, since a work cited five times has five
 *               citations but one row. `spans` is the row's own geometry, one
 *               entry per text item, so the caller can make the bibliography
 *               clickable — and underline just the title within it.
 *
 * A PDF without citation anchors yields two empty lists; that is the normal
 * answer for a Word export or a scan, not an error.
 *
 * `openFn` is injectable, following the pattern routes/papers.js already uses
 * for its search backends. Tests drive the geometry through a plain document
 * stub instead of pdf.js: loading the ESM build inside Jest is unreliable —
 * a sibling suite tearing down mid-import breaks the loader for everyone
 * ("Provided module is not an instance of Module"), and it made this suite
 * fail every other run. The real pdf.js path is verified against actual
 * papers instead (see the measurements above).
 */
async function openPdf(pdfPath) {
  // Read the file BEFORE importing pdf.js: a missing or unreadable path must
  // fail without ever touching the ESM loader. Background passes fire after
  // the request is done, and an import that lands after teardown breaks the
  // loader for the whole process (see the note in loadPdfjs).
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const { getDocument } = await loadPdfjs();
  // destroy() lives on the loading task, not the document (pdf.js v6).
  const task = getDocument({ data, isEvalSupported: false, useSystemFonts: true });
  return { doc: await task.promise, close: () => task.destroy() };
}

async function extractCitations(pdfPath, { openFn = openPdf } = {}) {
  const { doc, close } = await openFn(pdfPath);
  const citations = [];
  const references = [];
  try {
    // Column starts are per page and come from the page's text, and a row
    // ends where the next anchor in the SAME column begins — not merely the
    // next one on the page. The same text also carries the baselines the
    // citations are measured against, so the cache is filled here and reused
    // by both passes.
    const textByPage = new Map();
    const startsByPage = new Map();
    const loadPage = async (page) => {
      if (!textByPage.has(page)) {
        const pageProxy = await doc.getPage(page);
        const items = (await pageProxy.getTextContent()).items;
        textByPage.set(page, items);
        const [, , width] = pageProxy.view;
        startsByPage.set(page, columnStarts(items, width));
      }
    };

    for (let page = 1; page <= doc.numPages; page++) {
      const pageProxy = await doc.getPage(page);
      const annotations = await pageProxy.getAnnotations({ intent: 'display' });
      const marks = [];
      for (const a of annotations) {
        if (a.subtype !== 'Link') continue;
        // Only named destinations carry the BibTeX key. An explicit array
        // destination or an external URL is not a citation anchor.
        if (typeof a.dest !== 'string' || !CITATION_ANCHOR.test(a.dest)) continue;
        marks.push({ page, rect: a.rect.map(Number), anchor: a.dest });
      }
      if (marks.length === 0) continue;
      await loadPage(page);
      const items = textByPage.get(page);
      for (const mark of marks) {
        mark.baseline = baselineOf(mark.rect, items);
        citations.push(mark);
      }
    }

    // Every anchor, once, in the order the bibliography prints them: resolve
    // each to a page + y, then group by page and walk top-down so each row
    // ends where the next one begins.
    const anchors = [...new Set(citations.map((c) => c.anchor))];
    const located = [];
    for (const anchor of anchors) {
      const at = await resolveAnchor(doc, anchor);
      if (at) located.push({ anchor, ...at });
    }
    for (const page of new Set(located.map((l) => l.page))) await loadPage(page);
    for (const l of located) l.column = columnOf(l.x, startsByPage.get(l.page));

    // Some PDFs put the destination at the TOP EDGE of the entry, a full line
    // height above the first line's baseline (Annual Reviews, measured on the
    // Safe Learning in Robotics review 2026-09-12: dest y 248, baseline 238).
    // ANCHOR_SLACK is 4 pt, so the entry's own "53. " line then matched the
    // ENTRY_OPENER terminator and cut every row to whatever sat between the
    // anchors — the PREVIOUS entry's overflow line ("matica 103:461–471").
    // Snap each anchor down to its entry's opener baseline.
    //
    // WHICH opener is the entry's own is ambiguous per anchor: with a uniform
    // line pitch, the top edge of entry N is exactly the baseline of the line
    // above it — and when the entry above is a single line, that baseline is
    // itself an opener (measured on the same paper: cite.astorm2011's dest at
    // 349.4 saw both Khalil's opener at 349.39 and its own at 339.5). Per
    // DOCUMENT the dest→opener offset is one constant though — ~0 for the
    // baseline flavour, one line pitch for the top-edge flavour — so every
    // anchor votes with its candidate offsets and each then snaps to the
    // opener nearest the median. A bibliography without numbered openers
    // casts no votes and keeps the resolved y, which is the flavour that
    // already worked.
    const candidatesOf = (l) => {
      const items = textByPage.get(l.page);
      const starts = startsByPage.get(l.page);
      const found = [];
      for (const item of items) {
        if (typeof item.str !== 'string' || !ENTRY_OPENER.test(item.str)) continue;
        if (columnOf(item.transform[4], starts) !== l.column) continue;
        const by = item.transform[5];
        if (by > l.y + ANCHOR_SLACK || by < l.y - OPENER_SNAP) continue;
        found.push({ y: by, offset: l.y - by });
      }
      return found;
    };
    const votes = located.flatMap((l) => candidatesOf(l).map((c) => c.offset)).sort((a, b) => a - b);
    if (votes.length) {
      // Lower-middle median, and ties broken toward the SMALLER offset: with
      // one anchor sitting on its own opener and the next entry's opener also
      // in the window (offsets 0 and 12), the vote must land on 0 — the
      // baseline flavour — not on the entry below.
      const median = votes[Math.floor((votes.length - 1) / 2)];
      for (const l of located) {
        let best = null;
        for (const c of candidatesOf(l)) {
          const better =
            best === null ||
            Math.abs(c.offset - median) < Math.abs(best.offset - median) - 0.01 ||
            (Math.abs(Math.abs(c.offset - median) - Math.abs(best.offset - median)) <= 0.01 &&
              c.offset < best.offset);
          if (better) best = c;
        }
        if (best !== null) l.y = best.y;
      }
    }

    located.sort((a, b) => (a.page - b.page) || (a.column - b.column) || (b.y - a.y));

    for (let i = 0; i < located.length; i++) {
      const { anchor, page, y, column } = located[i];
      const next = located[i + 1];
      const sameColumn = next && next.page === page && next.column === column;
      const row = rowTextBetween(
        textByPage.get(page),
        y,
        sameColumn ? next.y : null,
        column,
        startsByPage.get(page),
      );
      if (row.text) {
        references.push({ anchor, rawText: row.text, spans: rowSpans(row.items, page) });
      }
    }
  } finally {
    await close();
  }
  return { citations, references };
}

module.exports = { extractCitations };
