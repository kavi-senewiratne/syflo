/**
 * references.js
 *
 * The reference-link cache: what a paper cites, where it says so, and which
 * of those works Syflo can actually open.
 *
 * The pass runs ONCE per paper, in the background right after import, and
 * writes two tables (see database.js):
 *   paper_references — the bibliography, one row per distinct anchor
 *   paper_citations  — the click targets, one row per mark in the text
 *
 * Three sources feed it, in descending order of trust:
 *   1. the PDF's own link annotations   (pdf-citations.js) — exact rects
 *   2. OpenAlex `referenced_works[]`    (reference-matcher.js) — metadata
 *   3. an arXiv id or DOI printed in the row itself — the fallback that
 *      rescues the ~30 % of references OpenAlex simply does not list
 *
 * Everything here is rebuildable from the PDF, so the tables cascade away
 * with the paper and never need a migration of their own.
 */

const { randomUUID } = require('crypto');
const defaultPdfCitations = require('./pdf-citations');
const defaultOpenAlex = require('./openalex');
const defaultArxiv = require('./arxiv');
const { matchReferences } = require('./reference-matcher');
const { parseReferenceRow, toTitleCase } = require('./reference-parse');
const { findFulltext } = require('./fulltext-search');
const { missingFacts, fetchReferenceFacts } = require('./reference-facts');

/**
 * The click rects of a reference row: the WHOLE row, one box per text item.
 *
 * Underlining only the title was tried first and rejected (user decision
 * 2026-08-09): with 40 rows the marks looked scattered, since a title sits in
 * a different place in every entry. Marking the whole row gives the eye one
 * steady rhythm — and the underline is drawn a few points BELOW the baseline
 * (see PdfView) so it reads as a rule under the text, not as a strikethrough.
 */
function rowClickRects(spans) {
  return Array.isArray(spans) ? spans.map(({ page, rect, baseline }) => ({ page, rect, baseline })) : [];
}

// One statement, three writers: the pass below, the bibliography rows, and
// the geometry refresh. `baseline` is the line the mark's glyphs sit on —
// where the underline hangs from (pdf-citations.js).
const INSERT_CITATION_SQL = `
  INSERT INTO paper_citations (paper_id, reference_id, anchor, page, x0, y0, x1, y1, baseline)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/** The printed label of a bibliography row: "[24]", "(3)", "12." */
function labelOf(rawText) {
  const m = /^\s*(?:\[(\d{1,3})\]|\((\d{1,3})\)|(\d{1,3})\.)\s/.exec(rawText || '');
  if (!m) return null;
  return `[${m[1] || m[2] || m[3]}]`;
}

/**
 * Where a resolved reference can be downloaded from, or null when only a
 * landing page exists. arXiv is the one source that reliably serves a PDF at
 * a guessable URL — everything else takes the browser door.
 */
function pdfUrlFor({ arxivId }) {
  return arxivId ? `https://arxiv.org/pdf/${arxivId}` : null;
}

// Second-pass budget. A title shorter than this is too generic to search on,
// and no paper needs more lookups than this in one pass.
const MIN_LOOKUP_TITLE = 12;
const MAX_LOOKUPS = 60;
const LOOKUP_SPACING_MS = 120;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Shared with the web search, so both agree on what "the same work" means
// (title-match.js).
const { titlesMatch } = require('./title-match');

/** A 429 (or an explicit rate-limit message) — the signal to stop asking. */
function isRateLimited(err) {
  const text = String(err?.message || '');
  return /\b429\b/.test(text) || /rate.?limit/i.test(text);
}

/**
 * A raw OpenAlex work from the title lookup, shaped like the candidates
 * fetchReferences() returns — plus the open-access PDF, which is what decides
 * whether the Syflo door opens at all.
 */
function shapeLookupHit(work) {
  const pdfUrl =
    work?.best_oa_location?.pdf_url ||
    work?.primary_location?.pdf_url ||
    work?.open_access?.oa_url ||
    null;
  return {
    id: work?.id || null,
    title: work?.display_name || null,
    authors: Array.isArray(work?.authorships)
      ? work.authorships.map((a) => a?.author?.display_name).filter(Boolean).slice(0, 5)
      : [],
    year: work?.publication_year ?? null,
    citations: work?.cited_by_count ?? null,
    doi:
      typeof work?.doi === 'string'
        ? work.doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase()
        : null,
    pdfUrl,
  };
}

/**
 * Run the reference pass for one paper and store the result.
 *
 * `deps` injects every edge collaborator, following the pattern
 * routes/papers.js uses for its search backends:
 *   extractFn(pdfPath)        → { citations, references }
 *   resolveWorkFn(identifiers) → { work } | null
 *   fetchReferencesFn(ids)    → candidate works
 *
 * A paper whose PDF carries no citation anchors ends as 'none', not as an
 * error: that is the honest answer for a Word export or a scan, and the UI
 * must stop waiting rather than spin forever.
 */
async function prepareReferences(db, paper, deps = {}) {
  const extractFn = deps.extractFn || defaultPdfCitations.extractCitations;
  const resolveWorkFn = deps.resolveWorkFn || defaultOpenAlex.resolveWork;
  const fetchReferencesFn = deps.fetchReferencesFn || defaultOpenAlex.fetchReferences;
  const lookupByTitleFn = deps.lookupByTitleFn || defaultOpenAlex.lookupByTitle;

  const setStatus = db.prepare('UPDATE papers SET references_status = ? WHERE id = ?');

  let extracted;
  try {
    extracted = await extractFn(paper.pdf_path);
  } catch (err) {
    console.warn(`[references] extraction failed for paper ${paper.id}: ${err.message}`);
    setStatus.run('none', paper.id);
    return;
  }

  const rows = extracted?.references || [];
  const marks = extracted?.citations || [];
  if (rows.length === 0) {
    setStatus.run('none', paper.id);
    return;
  }

  // The paper's own OpenAlex record gives us both its identity (so a citation
  // elsewhere can recognise "you already have this one") and the candidate
  // list to match its bibliography against. A failure here is survivable —
  // the rows still carry their printed arXiv ids and DOIs.
  let candidates = [];
  let selfWork = null;
  try {
    const resolved = await resolveWorkFn({ title: paper.title });
    selfWork = resolved?.work || null;
    if (selfWork?.referenced_works?.length) {
      candidates = await fetchReferencesFn(selfWork.referenced_works);
    }
  } catch (err) {
    console.warn(`[references] OpenAlex lookup failed for paper ${paper.id}: ${err.message}`);
  }

  const matched = matchReferences(rows, candidates);

  // OpenAlex mangles some names — it stores "ukasz Kaiser" for Łukasz Kaiser,
  // dropping the Ł (seen in the running app 2026-08-09). Where a resolved
  // name is merely a truncated form of one printed on the page, the page
  // wins: it is the primary source, and a name is not worth guessing at.
  for (const row of matched) {
    if (!row.work?.authors?.length) continue;
    const printed = parseReferenceRow(row.rawText).authors;
    if (!printed.length) continue;
    row.work = {
      ...row.work,
      authors: row.work.authors.map((name) => {
        const better = printed.find((p) => p !== name && p.endsWith(name) && p.length > name.length);
        return better || name;
      }),
    };
  }

  // Every row also gets read the way a person reads it, so an unresolved
  // reference still fills the card's title + meta layout instead of arriving
  // as one long printed line.
  const parsed = matched.map((row) => parseReferenceRow(row.rawText));

  const insertRef = db.prepare(`
    INSERT INTO paper_references
      (id, paper_id, anchor, ordinal, raw_text, label, work_openalex_id, work_title,
       work_authors_json, work_year, work_citations, work_venue, doi, arxiv_id, pdf_url,
       parsed_title, parsed_authors_json, parsed_venue, parsed_year)
    VALUES
      (@id, @paper_id, @anchor, @ordinal, @raw_text, @label, @work_openalex_id, @work_title,
       @work_authors_json, @work_year, @work_citations, @work_venue, @doi, @arxiv_id, @pdf_url,
       @parsed_title, @parsed_authors_json, @parsed_venue, @parsed_year)
  `);
  const insertCitation = db.prepare(INSERT_CITATION_SQL);

  const write = db.transaction(() => {
    db.prepare('DELETE FROM paper_references WHERE paper_id = ?').run(paper.id);
    db.prepare('DELETE FROM paper_citations WHERE paper_id = ?').run(paper.id);

    const idByAnchor = new Map();
    matched.forEach((row, ordinal) => {
      const id = randomUUID();
      idByAnchor.set(row.anchor, id);
      const p = parsed[ordinal];
      insertRef.run({
        id,
        paper_id: paper.id,
        anchor: row.anchor,
        ordinal,
        raw_text: row.rawText,
        label: labelOf(row.rawText),
        work_openalex_id: row.work?.id || null,
        work_title: row.work?.title || null,
        work_authors_json: row.work?.authors ? JSON.stringify(row.work.authors) : null,
        work_year: row.work?.year ?? null,
        work_citations: row.work?.citations ?? null,
        work_venue: row.work?.venue || null,
        doi: row.work?.doi || row.doi || null,
        arxiv_id: row.arxivId || null,
        // An arXiv id serves a PDF at a guessable URL; otherwise only an
        // open-access location found by the lookup will do.
        pdf_url: pdfUrlFor(row) || row.work?.pdfUrl || null,
        parsed_title: p.title,
        parsed_authors_json: p.authors.length ? JSON.stringify(p.authors) : null,
        parsed_venue: p.venue,
        parsed_year: p.year,
      });
    });

    for (const mark of marks) {
      const [x0, y0, x1, y1] = mark.rect;
      insertCitation.run(
        paper.id,
        idByAnchor.get(mark.anchor) || null,
        mark.anchor,
        mark.page,
        x0, y0, x1, y1,
        mark.baseline ?? null,
      );
    }

    // The rows of the bibliography are click targets in their own right: a
    // row IS the same reference as "[24]" on page 2, so it gets the same
    // treatment rather than a second vocabulary. Without this the whole
    // reference list stayed dead (user report 2026-08-09).
    matched.forEach((row, ordinal) => {
      const spans = rowClickRects(rows[ordinal]?.spans);
      for (const box of spans) {
        const [x0, y0, x1, y1] = box.rect;
        insertCitation.run(
          paper.id,
          idByAnchor.get(row.anchor) || null,
          row.anchor,
          box.page,
          x0, y0, x1, y1,
          box.baseline ?? null,
        );
      }
    });

    if (selfWork?.id) {
      db.prepare('UPDATE papers SET openalex_id = ? WHERE id = ?').run(selfWork.id, paper.id);
    }
    // Freshly measured, so nothing here needs the geometry refresh below.
    db.prepare('UPDATE papers SET citation_geometry_version = ? WHERE id = ?')
      .run(CITATION_GEOMETRY_VERSION, paper.id);
    setStatus.run('ready', paper.id);
  });
  write();
}

// Which measurement the stored click geometry comes from. Raise this whenever
// the rects or baselines are computed differently, and every paper re-measures
// itself from its own PDF the next time it is read.
//   1 — citations carry the baseline of the line their glyphs sit on
//       (2026-08-10); before that, the underline hung off the link box.
//   2 — that baseline is picked by nearness to the box's bottom edge, not by
//       widest overlap (2026-08-11). Where a PDF stores a line of prose as one
//       full-width text item, the line ABOVE the citation overlapped the box
//       exactly as much and won on reading order — so the underline sat under
//       ordinary words ("dependency parser", user report).
const CITATION_GEOMETRY_VERSION = 2;

// Papers being re-measured right now — polls arrive every 2.5 s and must not
// each start their own pdf.js pass.
const refreshingGeometry = new Set();

/**
 * Re-measure the click geometry of a paper whose citations were stored before
 * they carried a baseline (2026-08-10), and rewrite `paper_citations`.
 *
 * Deliberately NOT a re-run of the whole pass: the bibliography rows keep
 * their OpenAlex matches, their parsed fields and their `lookup_done` flag,
 * and no request leaves the machine — re-resolving 40–93 references would
 * have OpenAlex rate-limit us for minutes (measured 2026-08-09) for what is
 * a purely local geometry fix. Anchors are matched back to the rows that are
 * already there.
 */
async function refreshCitationGeometry(db, paperId, deps = {}) {
  const extractFn = deps.extractFn || defaultPdfCitations.extractCitations;
  const paper = db.prepare('SELECT id, pdf_path FROM papers WHERE id = ?').get(paperId);
  if (!paper?.pdf_path) return;

  const extracted = await extractFn(paper.pdf_path);
  const marks = extracted?.citations || [];
  const rows = extracted?.references || [];
  const stampVersion = db.prepare('UPDATE papers SET citation_geometry_version = ? WHERE id = ?');
  if (marks.length === 0) {
    // Nothing to re-measure — a PDF whose links we can no longer read must
    // still stop asking, or every read would open it again.
    stampVersion.run(CITATION_GEOMETRY_VERSION, paperId);
    return;
  }

  const idByAnchor = new Map(
    db
      .prepare('SELECT id, anchor FROM paper_references WHERE paper_id = ?')
      .all(paperId)
      .map((r) => [r.anchor, r.id]),
  );
  const insertCitation = db.prepare(INSERT_CITATION_SQL);

  db.transaction(() => {
    db.prepare('DELETE FROM paper_citations WHERE paper_id = ?').run(paperId);
    for (const mark of marks) {
      const [x0, y0, x1, y1] = mark.rect;
      insertCitation.run(
        paperId,
        idByAnchor.get(mark.anchor) || null,
        mark.anchor,
        mark.page,
        x0, y0, x1, y1,
        mark.baseline ?? null,
      );
    }
    for (const row of rows) {
      for (const box of rowClickRects(row.spans)) {
        const [x0, y0, x1, y1] = box.rect;
        insertCitation.run(
          paperId,
          idByAnchor.get(row.anchor) || null,
          row.anchor,
          box.page,
          x0, y0, x1, y1,
          box.baseline ?? null,
        );
      }
    }
    stampVersion.run(CITATION_GEOMETRY_VERSION, paperId);
  })();
}

/**
 * Does this paper still need its geometry re-measured? Returns true while a
 * refresh is needed or running — the route then answers 'pending', so the
 * view's own polling picks the fresh rects up without a reload.
 *
 * The trigger is the paper's stored geometry VERSION, not "are the baselines
 * missing": a mark drawn over a figure has no measurable line and stays null
 * for good, and asking about the rows would send such a paper through pdf.js
 * on every single read.
 */
function ensureCitationGeometry(db, paperId, loaded, deps = {}) {
  if (loaded.status !== 'ready' || loaded.citations.length === 0) return false;
  const row = db.prepare('SELECT citation_geometry_version AS v FROM papers WHERE id = ?').get(paperId);
  if (!row || row.v >= CITATION_GEOMETRY_VERSION) return false;
  if (refreshingGeometry.has(paperId)) return true;

  refreshingGeometry.add(paperId);
  Promise.resolve()
    .then(() => refreshCitationGeometry(db, paperId, deps))
    .catch((err) => {
      // A PDF that has gone missing must not put the paper in a retry loop:
      // the reader keeps the geometry they have, only without the correction.
      console.warn(`[references] geometry refresh failed for paper ${paperId}: ${err.message}`);
      db.prepare('UPDATE papers SET citation_geometry_version = ? WHERE id = ?')
        .run(CITATION_GEOMETRY_VERSION, paperId);
    })
    .finally(() => {
      refreshingGeometry.delete(paperId);
    });
  return true;
}

/**
 * Everything the frontend needs to make a paper's citations clickable:
 * `{ status, references, citations }`. Citations come in page order so the
 * PDF view can bucket them per page without sorting.
 */
function loadReferences(db, paperId) {
  const paper = db.prepare('SELECT references_status FROM papers WHERE id = ?').get(paperId);
  if (!paper) return null;

  const refRows = db
    .prepare('SELECT * FROM paper_references WHERE paper_id = ? ORDER BY ordinal')
    .all(paperId);

  // Heal rows written before the printed line was parsed: their cards still
  // showed the raw text (user report 2026-08-09). Parsing costs nothing but
  // CPU, so it happens on read and is written back once — no re-import, no
  // migration that has to guess at old data.
  const stale = refRows.filter((r) => !r.parsed_title && r.raw_text);
  if (stale.length) {
    const update = db.prepare(`
      UPDATE paper_references
         SET parsed_title = ?, parsed_authors_json = ?, parsed_venue = ?, parsed_year = ?
       WHERE id = ?
    `);
    db.transaction(() => {
      for (const row of stale) {
        const p = parseReferenceRow(row.raw_text);
        if (!p.title) continue;
        update.run(
          p.title,
          p.authors.length ? JSON.stringify(p.authors) : null,
          p.venue,
          p.year,
          row.id,
        );
        Object.assign(row, {
          parsed_title: p.title,
          parsed_authors_json: p.authors.length ? JSON.stringify(p.authors) : null,
          parsed_venue: p.venue,
          parsed_year: p.year,
        });
      }
    })();
  }
  const citationRows = db
    .prepare('SELECT * FROM paper_citations WHERE paper_id = ? ORDER BY page, id')
    .all(paperId);

  return {
    status: paper.references_status,
    references: refRows.map((r) => ({
      id: r.id,
      anchor: r.anchor,
      label: r.label,
      rawText: r.raw_text,
      openalexId: r.work_openalex_id,
      title: r.work_title,
      authors: r.work_authors_json ? JSON.parse(r.work_authors_json) : [],
      year: r.work_year,
      citations: r.work_citations,
      // The resolved venue wins over the one read off the printed row: the row
      // abbreviates ("In Proc. EMNLP"), OpenAlex spells it out.
      venue: r.work_venue || null,
      doi: r.doi,
      arxivId: r.arxiv_id,
      pdfUrl: r.pdf_url,
      // Raised on the way out, not in storage: the column keeps what the page
      // actually printed, and rows parsed before title casing existed come
      // out consistent without a migration. toTitleCase is idempotent.
      parsedTitle: toTitleCase(r.parsed_title),
      parsedAuthors: r.parsed_authors_json ? JSON.parse(r.parsed_authors_json) : [],
      // Raised on the way out, like parsedTitle — rows stored before venue
      // casing existed come out consistent. toTitleCase is idempotent.
      parsedVenue: toTitleCase(r.parsed_venue),
      parsedYear: r.parsed_year,
      // Where the silent web search found the full text — the one visible
      // trace that this PDF came from the web and not from the paper's own
      // link (design/mockup-citation-card-standard.html § 04).
      fulltextHost: r.fulltext_host ?? null,
    })),
    citations: citationRows.map((c) => ({
      referenceId: c.reference_id,
      anchor: c.anchor,
      page: c.page,
      rect: [c.x0, c.y0, c.x1, c.y1],
      // The line the underline hangs from; null on rows written before it was
      // measured (ensureCitationGeometry re-measures those).
      baseline: c.baseline ?? null,
    })),
  };
}

/**
 * Look ONE reference up on demand — the moment a reader opens its card.
 *
 * Doing this for every unmatched row at import time cost 40 to 93 requests
 * per paper and got OpenAlex to rate-limit this machine for over five minutes
 * (measured 2026-08-09). A reader opens a handful of cards, not ninety, so the
 * search belongs here: one request, cached in the row, and a miss is
 * remembered too — a row nothing can find must not be searched again on every
 * click.
 *
 * Returns the reference as `loadReferences` shapes it, or null if unknown.
 */
async function resolveReference(db, referenceId, deps = {}) {
  const lookupByTitleFn = deps.lookupByTitleFn || defaultOpenAlex.lookupByTitle;
  const searchArxivFn = deps.searchArxivFn || defaultArxiv.searchPapers;
  const row = db.prepare('SELECT * FROM paper_references WHERE id = ?').get(referenceId);
  if (!row) return null;

  const shape = () => {
    const all = loadReferences(db, row.paper_id);
    return all ? all.references.find((r) => r.id === referenceId) || null : null;
  };

  // Already known — from the bibliography match, an earlier lookup, or a
  // previous miss (lookup_done). Nothing left to identify, but the fold may
  // still be empty, and THAT is worth one background lookup.
  if (row.work_title || row.lookup_done) {
    await fillReferenceFacts(db, row, {
      openalexByTitleFn: deps.factsOpenalexByTitleFn,
      lookupByIdFn: deps.factsLookupByIdFn,
      lookupByTitleFn: deps.factsLookupByTitleFn,
    });
    return shape();
  }

  const title = row.parsed_title;
  const markDone = db.prepare('UPDATE paper_references SET lookup_done = 1 WHERE id = ?');
  if (!title || title.length < MIN_LOOKUP_TITLE) {
    markDone.run(referenceId);
    return shape();
  }

  // Punctuation a title carries but a search query cannot: OpenAlex answers
  // 400 to "Can Active Memory Replace Attention?" — the question mark breaks
  // its query syntax (measured 2026-08-09).
  const query = title.replace(/[?!:;"'’“”]/g, ' ').replace(/\s+/g, ' ').trim();

  let work = null;
  let lookupFailed = false;
  try {
    const hit = await lookupByTitleFn(query);
    if (hit) work = shapeLookupHit(hit);
  } catch (err) {
    console.warn(`[references] lookup failed for "${query.slice(0, 40)}": ${err.message}`);
    // One source failing must not stop the other — that 400 above cost us a
    // paper arXiv had all along.
    lookupFailed = true;
  }

  // Second source: arXiv. The reader clicked "Search the web" and Google's
  // first hit was the paper on arXiv (user report 2026-08-09) — so Syflo runs
  // that search itself. Open API, excellent ML/CS coverage, and a hit hands
  // back the PDF url outright, which is exactly what opens the Syflo door.
  // Also worth asking when OpenAlex knew the work but not where to read it.
  if (!work || !work.pdfUrl) {
    try {
      const found = await searchArxivFn(query, 3);
      const hits = Array.isArray(found) ? found : found?.results || [];
      // arXiv answers something for almost any query, so a hit counts only if
      // its title really is the one we asked for.
      const match = hits.find((h) => titlesMatch(title, h?.title));
      if (match) {
        work = {
          id: work?.id || null,
          title: work?.title || match.title,
          authors: work?.authors?.length ? work.authors : match.authors || [],
          year: work?.year ?? match.year ?? null,
          citations: work?.citations ?? null,
          doi: work?.doi || null,
          pdfUrl: match.open_access_pdf_url || (match.id ? `https://arxiv.org/pdf/${match.id}` : null),
          arxivId: match.id || null,
        };
      }
    } catch (err) {
      console.warn(`[references] arXiv search failed for "${title.slice(0, 40)}": ${err.message}`);
    }
  }

  if (!work) {
    // A transient failure is NOT a miss: leave lookup_done unset so the next
    // click tries again.
    if (!lookupFailed) markDone.run(referenceId);
    return shape();
  }
  db.prepare(`
    UPDATE paper_references
       SET work_openalex_id = ?, work_title = ?, work_authors_json = ?, work_year = ?,
           work_citations = ?, doi = COALESCE(?, doi), pdf_url = COALESCE(pdf_url, ?),
           arxiv_id = COALESCE(arxiv_id, ?), lookup_done = 1
     WHERE id = ?
  `).run(
    work.id,
    work.title,
    work.authors.length ? JSON.stringify(work.authors) : null,
    work.year,
    work.citations,
    work.doi,
    work.pdfUrl,
    work.arxivId || null,
    referenceId,
  );
  // Freshly identified — the record may still have left gaps.
  await fillReferenceFacts(
    db,
    db.prepare('SELECT * FROM paper_references WHERE id = ?').get(referenceId),
    {
      openalexByTitleFn: deps.factsOpenalexByTitleFn,
      lookupByIdFn: deps.factsLookupByIdFn,
      lookupByTitleFn: deps.factsLookupByTitleFn,
    },
  );
  return shape();
}

/**
 * Fill in the full text of ONE reference from the open web, if it needs one
 * (design/mockup-citation-card-standard.html § 04).
 *
 * The paper links a PDF for barely a third of its references (53 of 149,
 * measured 2026-08-10); the rest used to end in "No downloadable PDF
 * available". SearXNG already runs locally, so the gap can be closed without
 * asking the reader anything — and, crucially, WITHOUT showing them a hit
 * list: what this finds becomes `pdfUrl`, and the card then looks exactly
 * like one whose PDF the paper did link (user decision 2026-08-10).
 *
 * Costs at most one web request per reference, ever: a hit and a miss are
 * both remembered in `fulltext_done`. A failure of the search backend is
 * neither — SearXNG being down is not "no PDF exists", so the next click
 * tries again.
 *
 * Returns the reference as `loadReferences` shapes it (plus `fulltextHost`
 * and `fulltextSearchFailed`), or null if the reference is unknown.
 */
/**
 * Fill in a reference's missing facts — citation count, venue, year — from the
 * second source, once (design/mockup-citation-card-standard.html § 03).
 *
 * The reference pass keeps whatever OpenAlex sent, but OpenAlex does not know
 * every work: 118 of 171 stored references had no citation count and 50 no
 * venue (measured 2026-08-12), so the card's fold was often an empty promise.
 * This runs when a card opens, in the background, and the open card fills in
 * when the answer lands.
 *
 * `facts_done` remembers a miss as well as a hit — the same economy as
 * `lookup_done` and `fulltext_done`. Nothing here is load-bearing: a failure
 * is silent, and a reference with no facts is perfectly readable.
 */
async function fillReferenceFacts(db, row, deps = {}) {
  if (row.facts_done) return;
  const gaps = missingFacts({
    citations: row.work_citations,
    venue: row.work_venue || row.parsed_venue,
    year: row.work_year ?? row.parsed_year,
  });
  if (gaps.length === 0) return;

  let facts = null;
  try {
    facts = await fetchReferenceFacts(
      {
        title: row.work_title || row.parsed_title,
        arxivId: row.arxiv_id,
        doi: row.doi,
      },
      deps,
    );
  } catch (err) {
    // A source that is down is not an answer: leave facts_done unset so the
    // next click tries again.
    console.warn(`[references] facts lookup failed for ${row.id}: ${err.message}`);
    return;
  }

  db.prepare(`
    UPDATE paper_references
       SET work_citations = COALESCE(work_citations, ?),
           work_venue = COALESCE(work_venue, ?),
           work_year = COALESCE(work_year, ?),
           facts_done = 1
     WHERE id = ?
  `).run(facts?.citations ?? null, facts?.venue ?? null, facts?.year ?? null, row.id);
}

// How long to wait before trying a blocked search again. 90 s is the app's
// existing short-cooldown figure (the quota cards count exactly this down),
// and one idiom beats a second one that means the same thing.
const SEARCH_COOLDOWN_MS = 90 * 1000;

async function ensureFulltext(db, referenceId, deps = {}) {
  const searchFn = deps.webSearchFn;
  const row = db.prepare('SELECT * FROM paper_references WHERE id = ?').get(referenceId);
  if (!row) return null;

  const shape = (extra = {}) => {
    const all = loadReferences(db, row.paper_id);
    const found = all ? all.references.find((r) => r.id === referenceId) || null : null;
    return found ? { ...found, ...extra } : null;
  };

  // Already has a door, or has already been asked about — nothing to spend.
  if (row.pdf_url || row.fulltext_done || !searchFn) return shape();

  const reference = {
    title: row.work_title,
    parsedTitle: row.parsed_title,
    authors: row.work_authors_json ? JSON.parse(row.work_authors_json) : [],
    year: row.work_year ?? row.parsed_year,
    rawText: row.raw_text,
  };

  let found = null;
  try {
    found = await findFulltext(reference, { searchFn });
  } catch (err) {
    console.warn(`[references] full-text search failed for ${referenceId}: ${err.message}`);
    // Shut out for asking too often? Then waiting IS the fix, so the card is
    // told when to try again and does it itself (user decision 2026-08-11).
    // The engines never say how long they will keep us out, so this is a flat
    // guess — long enough to matter, short enough that a reader might still
    // be looking at the same card.
    const retryAt = err.suspended
      ? new Date(Date.now() + SEARCH_COOLDOWN_MS).toISOString()
      : null;
    return shape({ fulltextSearchFailed: true, fulltextRetryAt: retryAt });
  }

  db.prepare(`
    UPDATE paper_references
       SET fulltext_url = ?, fulltext_host = ?, fulltext_done = 1,
           pdf_url = COALESCE(pdf_url, ?)
     WHERE id = ?
  `).run(found?.url || null, found?.host || null, found?.url || null, referenceId);

  return shape();
}

module.exports = {
  prepareReferences,
  loadReferences,
  resolveReference,
  ensureFulltext,
  ensureCitationGeometry,
  refreshCitationGeometry,
  labelOf,
  pdfUrlFor,
};
