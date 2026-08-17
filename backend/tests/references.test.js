/**
 * tests/references.test.js
 *
 * Unit tests for references.js — the cache and the background pass that fills
 * it: read the PDF's citation links, resolve the bibliography against
 * OpenAlex, store both, and serve them to the frontend.
 *
 * Every collaborator at the edge (pdf.js, OpenAlex) is injected, so these
 * tests exercise the real storage and the real control flow without touching
 * the network or a PDF.
 */

const path = require('path');
const fs = require('fs');
const { createDb } = require('../database');
const { prepareReferences, loadReferences, resolveReference } = require('../references');

const TEST_DB_PATH = path.join(__dirname, 'references_test.db');

let db;

beforeEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

function insertPaper(id = 'p1') {
  db.prepare(
    'INSERT INTO papers (id, title, uploaded_at, pdf_path, status) VALUES (?, ?, ?, ?, ?)',
  ).run(id, 'Attention Is All You Need', new Date().toISOString(), `/fake/${id}.pdf`, 'ready');
  return db.prepare('SELECT * FROM papers WHERE id = ?').get(id);
}

// Two citations of one work plus one of another — the shape a real paper has.
const EXTRACTED = {
  citations: [
    { page: 2, rect: [108, 714, 118, 726], anchor: 'cite.luong2015' },
    { page: 4, rect: [200, 500, 210, 512], anchor: 'cite.luong2015' },
    { page: 2, rect: [300, 714, 310, 726], anchor: 'cite.lstm' },
  ],
  references: [
    { spans: [{ page: 9, rect: [72, 700, 300, 710], text: 'Effective approaches to attention-based neural machine translation' }], anchor: 'cite.luong2015', rawText: '[24] M.-T. Luong, H. Pham, C. Manning. Effective approaches to attention-based neural machine translation. arXiv:1508.04025, 2015.' },
    { spans: [{ page: 9, rect: [72, 688, 290, 698], text: 'Long short-term memory' }], anchor: 'cite.lstm', rawText: '[13] S. Hochreiter, J. Schmidhuber. Long short-term memory. Neural Computation, 1997.' },
  ],
};

const OPENALEX_WORKS = [
  { id: 'W2', title: 'Effective Approaches to Attention-based Neural Machine Translation', authors: ['Minh-Thang Luong', 'Hieu Pham', 'Christopher D. Manning'], year: 2015, doi: null, citations: 11204 },
  { id: 'W3', title: 'Long Short-Term Memory', authors: ['Sepp Hochreiter', 'Jürgen Schmidhuber'], year: 1997, doi: '10.1162/neco.1997.9.8.1735', citations: 92640 },
];

function deps(overrides = {}) {
  return {
    extractFn: async () => EXTRACTED,
    resolveWorkFn: async () => ({ work: { id: 'W1', referenced_works: ['W2', 'W3'] } }),
    fetchReferencesFn: async () => OPENALEX_WORKS,
    ...overrides,
  };
}

describe('prepareReferences', () => {
  it('stores the bibliography and every click target', async () => {
    const paper = insertPaper();

    await prepareReferences(db, paper, deps());
    const { references, citations, status } = loadReferences(db, paper.id);

    expect(status).toBe('ready');
    expect(references).toHaveLength(2);
    // Three marks in the text plus one row per reference in the bibliography.
    expect(citations).toHaveLength(5);

    const luong = references.find((r) => r.anchor === 'cite.luong2015');
    expect(luong.title).toBe('Effective Approaches to Attention-based Neural Machine Translation');
    expect(luong.year).toBe(2015);
    expect(luong.arxivId).toBe('1508.04025');

    // Both marks of the same work point at the one reference row — plus the
    // row itself in the bibliography, which is a click target too.
    const luongMarks = citations.filter((c) => c.referenceId === luong.id);
    expect(luongMarks).toHaveLength(3);
    expect(luongMarks[0]).toMatchObject({ page: 2, rect: [108, 714, 118, 726] });
  });

  it('marks the WHOLE reference row, one box per line', async () => {
    // Underlining only the title left the bibliography looking scattered —
    // a title sits somewhere different in every entry (user decision
    // 2026-08-09). The whole row gives the eye one steady rhythm; the gap
    // that keeps it from reading as a strikethrough is drawn in the view.
    const paper = insertPaper();
    const extracted = {
      citations: [],
      references: [
        {
          anchor: 'cite.lstm',
          rawText: 'S. Hochreiter. Long short-term memory. Neural Computation, 1997.',
          spans: [
            { page: 9, rect: [72, 700, 300, 710], text: 'S. Hochreiter. Long short-term memory. ' },
            { page: 9, rect: [72, 688, 240, 698], text: 'Neural Computation, 1997.' },
          ],
        },
      ],
    };

    await prepareReferences(db, paper, deps({ extractFn: async () => extracted, fetchReferencesFn: async () => [] }));
    const { citations } = loadReferences(db, paper.id);

    expect(citations).toHaveLength(2);
    expect(citations[0].rect).toEqual([72, 700, 300, 710]);
    expect(citations[1].rect).toEqual([72, 688, 240, 698]);
  });

  it('makes the reference ROW a click target too, not only the marks in the text', async () => {
    // A row of the bibliography is the same thing as "[24]" on page 2, so it
    // gets the same treatment. Without this the whole reference list stayed
    // dead (user report 2026-08-09).
    const paper = insertPaper();

    await prepareReferences(db, paper, deps());
    const { references, citations } = loadReferences(db, paper.id);

    const luong = references.find((r) => r.anchor === 'cite.luong2015');
    const onPage9 = citations.filter((c) => c.page === 9 && c.referenceId === luong.id);
    expect(onPage9).toHaveLength(1);
    expect(onPage9[0].rect).toEqual([72, 700, 300, 710]);
  });

  it('ends as "none" when the PDF carries no citation links', async () => {
    // A Word export or a scan. The UI must stop waiting instead of spinning
    // forever, so this is a finished state, not an error.
    const paper = insertPaper();

    await prepareReferences(db, paper, deps({ extractFn: async () => ({ citations: [], references: [] }) }));

    expect(loadReferences(db, paper.id).status).toBe('none');
  });

  it('still resolves a reference from its printed arXiv id when OpenAlex fails', async () => {
    // OpenAlex lists only 28 of Attention's 40 references, and the lookup can
    // fail outright. The row prints "arXiv:1508.04025" either way — enough to
    // open the paper in both doors.
    const paper = insertPaper();

    await prepareReferences(
      db,
      paper,
      deps({ resolveWorkFn: async () => { throw new Error('OpenAlex down'); } }),
    );

    const { status, references } = loadReferences(db, paper.id);
    expect(status).toBe('ready');
    const luong = references.find((r) => r.anchor === 'cite.luong2015');
    expect(luong.title).toBeNull();
    expect(luong.arxivId).toBe('1508.04025');
    expect(luong.pdfUrl).toBe('https://arxiv.org/pdf/1508.04025');
    // The printed text survives, so the UI can show the row as typeset.
    expect(luong.rawText).toContain('Luong');
    expect(luong.label).toBe('[24]');
  });

  it('records which work the paper itself is, so a citation can recognise it', async () => {
    const paper = insertPaper();

    await prepareReferences(db, paper, deps());

    const stored = db.prepare('SELECT openalex_id FROM papers WHERE id = ?').get(paper.id);
    expect(stored.openalex_id).toBe('W1');
  });

  it('keeps the printed spelling of a name OpenAlex mangled', async () => {
    // OpenAlex stores "ukasz Kaiser" for Łukasz Kaiser — it drops the Ł
    // (seen in the running app 2026-08-09). The printed row has it right, so
    // when a resolved name is just a truncated form of the printed one, the
    // page wins.
    const paper = insertPaper();
    const extracted = {
      citations: [],
      references: [
        {
          anchor: 'cite.kaiser',
          rawText: '[17] Łukasz Kaiser and Ilya Sutskever. Neural GPUs learn algorithms. In ICLR, 2016.',
        },
      ],
    };

    await prepareReferences(db, paper, {
      extractFn: async () => extracted,
      resolveWorkFn: async () => ({ work: { id: 'W1', referenced_works: ['W9'] } }),
      fetchReferencesFn: async () => [
        {
          id: 'W9',
          title: 'Neural GPUs Learn Algorithms',
          authors: ['ukasz Kaiser', 'Ilya Sutskever'],
          year: 2016,
        },
      ],
    });

    const { references } = loadReferences(db, paper.id);
    expect(references[0].authors).toEqual(['Łukasz Kaiser', 'Ilya Sutskever']);
  });

  it('parses the printed row so an unresolved reference still reads like a card', async () => {
    // OpenAlex lists only ~70 % of a bibliography. A row it does not know
    // used to reach the card as one long line of text; parsing it fills the
    // same title + meta-line layout (user report 2026-08-09).
    const paper = insertPaper();

    await prepareReferences(
      db,
      paper,
      deps({ resolveWorkFn: async () => null, lookupByTitleFn: async () => null }),
    );

    const { references } = loadReferences(db, paper.id);
    const luong = references.find((r) => r.anchor === 'cite.luong2015');
    expect(luong.title).toBeNull(); // nothing resolved it
    expect(luong.parsedTitle).toBe('Effective Approaches to Attention-Based Neural Machine Translation');
    expect(luong.parsedAuthors).toEqual(['M.-T. Luong', 'H. Pham', 'C. Manning']);
    expect(luong.parsedYear).toBe(2015);
  });

  it('does NOT search the web during the import pass', async () => {
    // Measured 2026-08-09: looking every unmatched row up on import means 40
    // to 93 requests per paper, and a handful of papers got OpenAlex to
    // rate-limit this machine for over five minutes. The pass therefore costs
    // TWO requests total, and the search moves to the moment a reader
    // actually opens the card (resolveReference below).
    const lookupByTitleFn = jest.fn();
    const paper = insertPaper();

    await prepareReferences(
      db,
      paper,
      deps({ fetchReferencesFn: async () => [], lookupByTitleFn }),
    );

    expect(lookupByTitleFn).not.toHaveBeenCalled();
    // Everything readable off the page is still there — that is what makes
    // the card look right without spending a single request.
    const { references } = loadReferences(db, paper.id);
    expect(references.every((r) => r.parsedTitle)).toBe(true);
  });
});

describe('loadReferences', () => {
  it('parses rows that were stored before the parser existed', async () => {
    // Real report 2026-08-09: cards in the running app still showed the raw
    // printed line, because their rows had been written by an earlier import.
    // Parsing is pure text work, so the row heals itself on the next read
    // instead of waiting for a re-import.
    const paper = insertPaper();
    db.prepare(`
      INSERT INTO paper_references (id, paper_id, anchor, ordinal, raw_text, label)
      VALUES ('old', ?, 'cite.old', 0, ?, '[2]')
    `).run(
      paper.id,
      '[2] Dzmitry Bahdanau, Kyunghyun Cho, and Yoshua Bengio. Neural machine translation by jointly learning to align and translate. CoRR, abs/1409.0473, 2014.',
    );

    const { references } = loadReferences(db, paper.id);

    expect(references[0].parsedTitle).toBe(
      'Neural Machine Translation by Jointly Learning to Align and Translate',
    );
    expect(references[0].parsedAuthors).toEqual([
      'Dzmitry Bahdanau',
      'Kyunghyun Cho',
      'Yoshua Bengio',
    ]);
    // And it is written back, so the work happens once.
    const stored = db.prepare('SELECT parsed_title FROM paper_references WHERE id = ?').get('old');
    expect(stored.parsed_title).toContain('Neural Machine Translation');
  });
});

describe('resolveReference', () => {
  it('looks a reference up on demand and caches the result', async () => {
    // The reader clicked a citation nothing had resolved. ONE request, and
    // the answer is stored so the next click is free.
    const paper = insertPaper();
    const lookupByTitleFn = jest.fn(async (title) =>
      /long short-term/i.test(title)
        ? {
            id: 'https://openalex.org/W99',
            display_name: 'Long Short-Term Memory',
            publication_year: 1997,
            cited_by_count: 92640,
            doi: 'https://doi.org/10.1162/neco.1997.9.8.1735',
            authorships: [{ author: { display_name: 'Sepp Hochreiter' } }],
            best_oa_location: { pdf_url: 'https://example.org/lstm.pdf' },
          }
        : null,
    );

    await prepareReferences(db, paper, deps({ fetchReferencesFn: async () => [] }));
    const before = loadReferences(db, paper.id).references.find((r) => r.anchor === 'cite.lstm');

    const resolved = await resolveReference(db, before.id, { lookupByTitleFn });

    expect(resolved.title).toBe('Long Short-Term Memory');
    expect(resolved.year).toBe(1997);
    expect(resolved.doi).toBe('10.1162/neco.1997.9.8.1735');
    expect(resolved.pdfUrl).toBe('https://example.org/lstm.pdf');
    expect(lookupByTitleFn).toHaveBeenCalledTimes(1);

    // Cached: a second open of the same card spends nothing.
    const again = await resolveReference(db, before.id, { lookupByTitleFn });
    expect(again.title).toBe('Long Short-Term Memory');
    expect(lookupByTitleFn).toHaveBeenCalledTimes(1);
  });

  it('falls back to arXiv when OpenAlex does not know the paper', async () => {
    // The reader clicked "Search the web" and Google's FIRST hit was the paper
    // on arXiv (user report 2026-08-09) — so Syflo should run that search
    // itself. arXiv is the right second source: an open API, excellent ML/CS
    // coverage, and a hit hands back the PDF url outright, which is what opens
    // the Syflo door.
    const paper = insertPaper();
    await prepareReferences(db, paper, deps({ fetchReferencesFn: async () => [] }));
    const row = loadReferences(db, paper.id).references.find((r) => r.anchor === 'cite.lstm');

    const searchArxivFn = jest.fn(async () => ({
      results: [
        {
          id: '1606.01933',
          title: 'Long Short-Term Memory',
          authors: ['Sepp Hochreiter', 'Jürgen Schmidhuber'],
          year: 1997,
          open_access_pdf_url: 'https://arxiv.org/pdf/1606.01933',
        },
      ],
    }));

    const resolved = await resolveReference(db, row.id, {
      lookupByTitleFn: async () => null,
      searchArxivFn,
    });

    expect(resolved.title).toBe('Long Short-Term Memory');
    expect(resolved.arxivId).toBe('1606.01933');
    expect(resolved.pdfUrl).toBe('https://arxiv.org/pdf/1606.01933');
  });

  it('ignores an arXiv hit whose title is a different paper', async () => {
    // arXiv's search is generous — it answers with something for almost any
    // query. A hit only counts if its title really is the one we asked for.
    const paper = insertPaper();
    await prepareReferences(db, paper, deps({ fetchReferencesFn: async () => [] }));
    const row = loadReferences(db, paper.id).references.find((r) => r.anchor === 'cite.lstm');

    const resolved = await resolveReference(db, row.id, {
      lookupByTitleFn: async () => null,
      searchArxivFn: async () => ({
        results: [{ id: '9999.99999', title: 'Something Else Entirely', authors: [], year: 2020 }],
      }),
    });

    expect(resolved.title).toBeNull();
    expect(resolved.arxivId).toBeNull();
  });

  it('still asks arXiv when the OpenAlex lookup errors out', async () => {
    // Measured 2026-08-09: "Can Active Memory Replace Attention?" made
    // OpenAlex answer 400 — the question mark breaks its query syntax — and
    // the pass gave up right there, never trying arXiv, which has the paper.
    const paper = insertPaper();
    await prepareReferences(db, paper, deps({ fetchReferencesFn: async () => [] }));
    const row = loadReferences(db, paper.id).references.find((r) => r.anchor === 'cite.lstm');
    const searchArxivFn = jest.fn(async () => ({
      results: [{ id: '1610.08613', title: 'Long short-term memory', open_access_pdf_url: 'https://arxiv.org/pdf/1610.08613' }],
    }));

    const out = await resolveReference(db, row.id, {
      lookupByTitleFn: async () => { throw new Error('OpenAlex title search failed: 400'); },
      searchArxivFn,
    });

    expect(searchArxivFn).toHaveBeenCalled();
    expect(out.pdfUrl).toBe('https://arxiv.org/pdf/1610.08613');
  });

  it('strips punctuation that breaks a title search', async () => {
    const paper = insertPaper();
    await prepareReferences(db, paper, deps({ fetchReferencesFn: async () => [] }));
    const row = loadReferences(db, paper.id).references.find((r) => r.anchor === 'cite.lstm');
    db.prepare('UPDATE paper_references SET parsed_title = ? WHERE id = ?')
      .run('Can Active Memory Replace Attention?', row.id);
    const lookupByTitleFn = jest.fn(async () => null);

    await resolveReference(db, row.id, { lookupByTitleFn, searchArxivFn: async () => ({ results: [] }) });

    expect(lookupByTitleFn).toHaveBeenCalledWith('Can Active Memory Replace Attention');
  });

  it('remembers a miss, so a hopeless row is not searched again and again', async () => {
    const paper = insertPaper();
    const lookupByTitleFn = jest.fn(async () => null);
    // Both edges stubbed: without this the test reached the real arXiv API
    // and timed out — a network call has no business in a unit test.
    const searchArxivFn = jest.fn(async () => ({ results: [] }));
    await prepareReferences(db, paper, deps({ fetchReferencesFn: async () => [] }));
    const row = loadReferences(db, paper.id).references.find((r) => r.anchor === 'cite.lstm');

    await resolveReference(db, row.id, { lookupByTitleFn, searchArxivFn });
    await resolveReference(db, row.id, { lookupByTitleFn, searchArxivFn });

    expect(lookupByTitleFn).toHaveBeenCalledTimes(1);
    expect(searchArxivFn).toHaveBeenCalledTimes(1);
  });

  it('replaces an earlier pass instead of duplicating it', async () => {
    const paper = insertPaper();

    await prepareReferences(db, paper, deps());
    await prepareReferences(db, paper, deps());

    const { references, citations } = loadReferences(db, paper.id);
    expect(references).toHaveLength(2);
    // Three marks in the text plus one row per reference in the bibliography.
    expect(citations).toHaveLength(5);
  });
});
