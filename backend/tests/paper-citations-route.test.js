/**
 * tests/paper-citations-route.test.js
 *
 * Integration tests for GET /api/papers/:id/citations — what the PDF view
 * asks for to make a paper's citations clickable.
 */
process.env.OPENAI_API_KEY = 'test-key-for-unit-tests';
const request = require('supertest');
const path = require('path');
const fs = require('fs');
const { createApp } = require('../server');
const { createDb } = require('../database');

const TEST_DB_PATH = path.join(__dirname, 'paper-citations-route-test.db');

let app;
let db;

beforeEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
  app = createApp(db);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

// `geometry` is the measurement the citation rows came from: it must match
// CITATION_GEOMETRY_VERSION in references.js to count as current. Anything
// lower marks a paper measured by an older rule — 0 predates the baseline
// itself (2026-08-10), 1 predates picking that baseline by nearness to the
// box's bottom edge (2026-08-11) — and the route re-measures it on read.
function insertPaper(id = 'p1', status = 'ready', geometry = 2) {
  db.prepare(
    'INSERT INTO papers (id, title, uploaded_at, pdf_path, status, references_status, citation_geometry_version) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, 'A Paper', new Date().toISOString(), `/fake/${id}.pdf`, 'ready', status, geometry);
}

function insertReference(paperId, refId, anchor, ordinal, extra = {}) {
  db.prepare(`
    INSERT INTO paper_references (id, paper_id, anchor, ordinal, raw_text, label, work_title, work_year, arxiv_id, pdf_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    refId, paperId, anchor, ordinal,
    extra.rawText || '[1] A. Smith. A paper. 2020.',
    extra.label || '[1]',
    extra.title || 'A Paper Title',
    extra.year || 2020,
    extra.arxivId || null,
    extra.pdfUrl || null,
  );
}

describe('GET /api/papers/:id/citations', () => {
  it('serves the bibliography and the click targets', async () => {
    insertPaper();
    insertReference('p1', 'r1', 'cite.smith', 0, { title: 'Layer Normalization', arxivId: '1607.06450', pdfUrl: 'https://arxiv.org/pdf/1607.06450' });
    db.prepare(
      'INSERT INTO paper_citations (paper_id, reference_id, anchor, page, x0, y0, x1, y1, baseline) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('p1', 'r1', 'cite.smith', 2, 108, 714, 118, 726, 715.1);

    const res = await request(app).get('/api/papers/p1/citations');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.references).toHaveLength(1);
    expect(res.body.references[0]).toMatchObject({
      id: 'r1',
      title: 'Layer Normalization',
      arxivId: '1607.06450',
      pdfUrl: 'https://arxiv.org/pdf/1607.06450',
    });
    expect(res.body.citations).toEqual([
      // The baseline rides along with the rect: the underline hangs off it,
      // since the rect is the PDF's link box and sits a different distance
      // below the text in every paper (measured 2026-08-10).
      { referenceId: 'r1', anchor: 'cite.smith', page: 2, rect: [108, 714, 118, 726], baseline: 715.1 },
    ]);
  });

  it('re-measures a paper whose geometry predates the baseline', async () => {
    // Papers imported before 2026-08-10 have rects but no baseline, and their
    // underlines sat visibly too low under author-year citations. Re-measuring
    // is local work on a PDF we already have, so it happens on read instead of
    // asking the reader to import the paper again (user report 2026-08-10).
    insertPaper('p5', 'ready', 0);
    insertReference('p5', 'r5', 'cite.bahdanau', 0);
    db.prepare(
      'INSERT INTO paper_citations (paper_id, reference_id, anchor, page, x0, y0, x1, y1) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('p5', 'r5', 'cite.bahdanau', 1, 300, 717, 390, 728);
    const appWithStubs = createApp(db, {
      papers: {
        extractCitationsFn: async () => ({
          citations: [{ page: 1, rect: [300, 717, 390, 728], anchor: 'cite.bahdanau', baseline: 720 }],
          references: [],
        }),
      },
    });

    // First read: the refresh is queued, so the view is told to ask again.
    const first = await request(appWithStubs).get('/api/papers/p5/citations');
    expect(first.body.status).toBe('pending');

    await new Promise((r) => setTimeout(r, 50));

    // Second read: measured geometry, and the reference row keeps its identity.
    const second = await request(appWithStubs).get('/api/papers/p5/citations');
    expect(second.body.status).toBe('ready');
    expect(second.body.citations).toEqual([
      { referenceId: 'r5', anchor: 'cite.bahdanau', page: 1, rect: [300, 717, 390, 728], baseline: 720 },
    ]);
    expect(second.body.references).toHaveLength(1);
  });

  it('re-measures once, even when a mark carries no measurable line', async () => {
    // A citation drawn over a figure has no text to measure, so its baseline
    // stays null for good. Asking "are any baselines missing?" would send such
    // a paper through pdf.js on every single read.
    insertPaper('p6', 'ready', 0);
    insertReference('p6', 'r6', 'cite.onfigure', 0);
    db.prepare(
      'INSERT INTO paper_citations (paper_id, reference_id, anchor, page, x0, y0, x1, y1) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('p6', 'r6', 'cite.onfigure', 1, 108, 400, 160, 412);
    let passes = 0;
    const appWithStubs = createApp(db, {
      papers: {
        extractCitationsFn: async () => {
          passes += 1;
          return {
            citations: [{ page: 1, rect: [108, 400, 160, 412], anchor: 'cite.onfigure', baseline: null }],
            references: [],
          };
        },
      },
    });

    await request(appWithStubs).get('/api/papers/p6/citations');
    await new Promise((r) => setTimeout(r, 50));
    const second = await request(appWithStubs).get('/api/papers/p6/citations');
    await new Promise((r) => setTimeout(r, 50));
    await request(appWithStubs).get('/api/papers/p6/citations');

    expect(passes).toBe(1);
    expect(second.body.status).toBe('ready');
    expect(second.body.citations[0].baseline).toBeNull();
  });

  it('reports the pending state so the view knows to ask again', async () => {
    insertPaper('p2', 'pending');

    const res = await request(app).get('/api/papers/p2/citations');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'pending', references: [], citations: [] });
  });

  it('404s for a paper that does not exist', async () => {
    const res = await request(app).get('/api/papers/nope/citations');

    expect(res.status).toBe(404);
  });
});

describe('POST /api/papers/:id/references/:refId/resolve', () => {
  it('looks an unresolved reference up and returns it filled in', async () => {
    insertPaper('p3');
    insertReference('p3', 'r3', 'cite.x', 0, { title: null });
    db.prepare('UPDATE paper_references SET work_title = NULL, parsed_title = ? WHERE id = ?')
      .run('Long short-term memory', 'r3');
    const appWithStubs = createApp(db, {
      papers: {
        searchArxivFn: async () => ({ results: [] }),
        lookupByTitleFn: async () => ({
          id: 'https://openalex.org/W99',
          display_name: 'Long Short-Term Memory',
          publication_year: 1997,
          cited_by_count: 92640,
          best_oa_location: { pdf_url: 'https://example.org/lstm.pdf' },
        }),
      },
    });

    const res = await request(appWithStubs).post('/api/papers/p3/references/r3/resolve');

    expect(res.status).toBe(200);
    expect(res.body.reference).toMatchObject({
      id: 'r3',
      title: 'Long Short-Term Memory',
      year: 1997,
      pdfUrl: 'https://example.org/lstm.pdf',
    });
  });

  it('404s for a reference that does not exist', async () => {
    insertPaper('p4');

    const res = await request(app).post('/api/papers/p4/references/nope/resolve');

    expect(res.status).toBe(404);
  });
});

describe('the facts behind a reference', () => {
  it('stores the citation count and the venue the reference pass already saw', async () => {
    // The bibliography match carries the full OpenAlex record; dropping its
    // citation count and venue left 33 of 171 stored references with an empty
    // fold (measured 2026-08-12).
    const extracted = {
      citations: [{ page: 1, rect: [10, 20, 30, 40], anchor: 'cite.x', baseline: 21 }],
      references: [{ anchor: 'cite.x', rawText: '[1] A. Smith. A cited work. 2021.' }],
    };
    const appWithStubs = createApp(db, {
      papers: {
        extractPdfTextFn: async () => 'text',
        extractCitationsFn: async () => extracted,
        resolveWorkFn: async () => ({ work: { id: 'W-self', referenced_works: ['W-cited'] } }),
        fetchReferencesFn: async () => [
          {
            id: 'https://openalex.org/W-cited',
            title: 'A Cited Work',
            authors: ['A. Smith'],
            year: 2021,
            doi: null,
            citations: 4210,
            venue: 'Empirical Methods in Natural Language Processing',
          },
        ],
      },
    });

    const chat = (await request(appWithStubs).post('/api/chats').send({ title: 'Root' })).body;
    const upload = await request(appWithStubs)
      .post('/api/papers')
      .field('chat_id', chat.id)
      .attach('pdf', Buffer.from('%PDF-1.4\n%%EOF\n'), 'paper.pdf');
    await new Promise((r) => setTimeout(r, 60));

    const res = await request(appWithStubs).get(`/api/papers/${upload.body.id}/citations`);

    expect(res.body.references[0]).toMatchObject({
      title: 'A Cited Work',
      citations: 4210,
      venue: 'Empirical Methods in Natural Language Processing',
    });
  });
});

describe('filling the facts in the background', () => {
  it('looks up a missing citation count and venue, and answers with them', async () => {
    // The reference is identified (it has a title) but its fold is empty —
    // the case for 118 of 171 stored references (measured 2026-08-12). The
    // card asks once when it opens; the answer replaces the row in place.
    insertPaper('pf1');
    insertReference('pf1', 'rf1', 'cite.facts', 0, { title: 'Deep Residual Learning for Image Recognition' });
    db.prepare('UPDATE paper_references SET work_citations = NULL, parsed_venue = NULL WHERE id = ?').run('rf1');
    const appWithStubs = createApp(db, {
      papers: {
        factsOpenalexByTitleFn: async () => null,
        factsLookupByTitleFn: async () => ({
          title: 'Deep Residual Learning for Image Recognition',
          citationCount: 210_000,
          venue: 'Computer Vision and Pattern Recognition',
          year: 2016,
        }),
      },
    });

    const res = await request(appWithStubs).post('/api/papers/pf1/references/rf1/resolve');

    expect(res.status).toBe(200);
    expect(res.body.reference).toMatchObject({
      citations: 210_000,
      venue: 'Computer Vision and Pattern Recognition',
    });
  });

  it('asks the second source once per reference, hit or miss', async () => {
    insertPaper('pf2');
    insertReference('pf2', 'rf2', 'cite.nofacts', 0, { title: 'A Work Nobody Indexed' });
    db.prepare('UPDATE paper_references SET work_citations = NULL, parsed_venue = NULL WHERE id = ?').run('rf2');
    let asked = 0;
    const appWithStubs = createApp(db, {
      papers: {
        factsOpenalexByTitleFn: async () => null,
        factsLookupByTitleFn: async () => {
          asked++;
          return null;
        },
      },
    });

    await request(appWithStubs).post('/api/papers/pf2/references/rf2/resolve');
    await request(appWithStubs).post('/api/papers/pf2/references/rf2/resolve');

    expect(asked).toBe(1);
  });

  it('does not ask when the facts are already there', async () => {
    insertPaper('pf3');
    insertReference('pf3', 'rf3', 'cite.complete', 0, { title: 'A Complete Work' });
    db.prepare('UPDATE paper_references SET work_citations = 7, work_venue = ?, work_year = 2020 WHERE id = ?')
      .run('NeurIPS', 'rf3');
    let asked = 0;
    const appWithStubs = createApp(db, {
      papers: {
        factsLookupByTitleFn: async () => {
          asked++;
          return null;
        },
      },
    });

    await request(appWithStubs).post('/api/papers/pf3/references/rf3/resolve');

    expect(asked).toBe(0);
  });
});

describe('POST /api/papers/:id/references/:refId/fulltext', () => {
  it('finds the free full text on the web and hands back a reference that can be opened', async () => {
    // The silent search (design/mockup-citation-card-standard.html § 04): a
    // reference the paper never linked comes back looking exactly like one it
    // did, plus the host it was found on.
    insertPaper('p5');
    insertReference('p5', 'r5', 'cite.sennrich', 0, {
      title: 'Neural Machine Translation of Rare Words with Subword Units',
      pdfUrl: null,
      arxivId: null,
    });
    const appWithStubs = createApp(db, {
      papers: {
        webSearchFn: async () => ({
          results: [
            {
              title: 'Neural Machine Translation of Rare Words with Subword Units',
              url: 'https://arxiv.org/abs/1508.07909',
            },
          ],
        }),
      },
    });

    const res = await request(appWithStubs).post('/api/papers/p5/references/r5/fulltext');

    expect(res.status).toBe(200);
    expect(res.body.reference).toMatchObject({
      id: 'r5',
      pdfUrl: 'https://arxiv.org/pdf/1508.07909',
      fulltextHost: 'arxiv.org',
    });
  });

  it('asks the web once per reference and remembers the miss', async () => {
    // A row nothing can find must not be searched again on every click — the
    // same rule the OpenAlex lookup follows (lookup_done).
    insertPaper('p6');
    insertReference('p6', 'r6', 'cite.lstm', 0, {
      title: 'Long Short-Term Memory',
      pdfUrl: null,
      arxivId: null,
    });
    let asked = 0;
    const appWithStubs = createApp(db, {
      papers: {
        webSearchFn: async () => {
          asked++;
          return { results: [] };
        },
      },
    });

    const first = await request(appWithStubs).post('/api/papers/p6/references/r6/fulltext');
    const second = await request(appWithStubs).post('/api/papers/p6/references/r6/fulltext');

    expect(first.status).toBe(200);
    expect(second.body.reference.pdfUrl).toBeNull();
    expect(asked).toBe(1);
  });

  it('never searches for a reference the paper already links', async () => {
    insertPaper('p7');
    insertReference('p7', 'r7', 'cite.linked', 0, {
      title: 'A Linked Work',
      pdfUrl: 'https://arxiv.org/pdf/1234.5678',
    });
    let asked = 0;
    const appWithStubs = createApp(db, {
      papers: {
        webSearchFn: async () => {
          asked++;
          return { results: [] };
        },
      },
    });

    const res = await request(appWithStubs).post('/api/papers/p7/references/r7/fulltext');

    expect(res.body.reference.pdfUrl).toBe('https://arxiv.org/pdf/1234.5678');
    expect(asked).toBe(0);
  });

  it('says when it is worth asking again after being shut out', async () => {
    // A search engine suspends a caller that asked too often and
    // let them back in minutes later — so a blocked search carries a time,
    // and the card counts it down and retries itself (user decision
    // 2026-08-11).
    insertPaper('p9');
    insertReference('p9', 'r9', 'cite.blocked', 0, { title: 'A Findable Work', pdfUrl: null, arxivId: null });
    const appWithStubs = createApp(db, {
      papers: {
        webSearchFn: async () => ({
          results: [],
          unresponsiveEngines: [['brave', 'Suspended: too many requests']],
        }),
      },
    });

    const res = await request(appWithStubs).post('/api/papers/p9/references/r9/fulltext');

    expect(res.body.reference.fulltextSearchFailed).toBe(true);
    const waitMs = new Date(res.body.reference.fulltextRetryAt).getTime() - Date.now();
    expect(waitMs).toBeGreaterThan(30_000);
    expect(waitMs).toBeLessThanOrEqual(5 * 60_000);
  });

  it('asks for a key instead of a wait when no search is set up', async () => {
    // W1 (design/mockup-onboarding-flow.html §06): with no Tavily key nobody
    // looked either, but there is nothing to wait FOR — so the reference comes
    // back as "search not set up" and without a retry time. A countdown here
    // would tick forever and fix nothing.
    insertPaper('p10');
    insertReference('p10', 'r10', 'cite.nokey', 0, { title: 'A Findable Work', pdfUrl: null, arxivId: null });
    const appWithStubs = createApp(db, {
      papers: {
        webSearchFn: async () => ({ provider: null, error: 'no-search-provider', results: [] }),
      },
    });

    const res = await request(appWithStubs).post('/api/papers/p10/references/r10/fulltext');

    expect(res.body.reference.fulltextSearchUnavailable).toBe(true);
    expect(res.body.reference.fulltextSearchFailed).toBeFalsy();
    expect(res.body.reference.fulltextRetryAt).toBeFalsy();
  });

  it('does not count down a wait for a key the search rejected', async () => {
    // Found in the running app 2026-08-24: a wrong key produced BOTH the
    // countdown line and the "add a key" card at once, so the card made two
    // claims that contradicted each other. Every state a person has to repair
    // is the same kind of state — no retry time.
    insertPaper('p12');
    insertReference('p12', 'r12', 'cite.badkey', 0, { title: 'A Findable Work', pdfUrl: null, arxivId: null });
    const appWithStubs = createApp(db, {
      papers: {
        webSearchFn: async () => ({ provider: 'tavily', error: 'tavily-invalid-key', results: [] }),
      },
    });

    const res = await request(appWithStubs).post('/api/papers/p12/references/r12/fulltext');

    expect(res.body.reference.fulltextRetryAt).toBeFalsy();
    expect(res.body.reference.fulltextSearchUnavailable).toBe(true);
    // The reason travels so the card can name what is wrong with the key
    // instead of repeating "no search is set up".
    expect(res.body.reference.fulltextSearchReason).toBe('tavily-invalid-key');
  });

  it('looks again once a key has been added', async () => {
    // The miss was never recorded, so the very next click searches for real —
    // that is what makes the card's "add a key" button worth pressing.
    insertPaper('p11');
    insertReference('p11', 'r11', 'cite.laterkey', 0, {
      title: 'Layer Normalization for Recurrent Neural Networks',
      pdfUrl: null,
      arxivId: null,
    });
    let key = '';
    const appWithStubs = createApp(db, {
      papers: {
        webSearchFn: async () =>
          key
            ? {
                results: [
                  {
                    title: 'Layer Normalization for Recurrent Neural Networks',
                    url: 'https://arxiv.org/abs/2222.3333',
                  },
                ],
              }
            : { provider: null, error: 'no-search-provider', results: [] },
      },
    });

    await request(appWithStubs).post('/api/papers/p11/references/r11/fulltext');
    key = 'tvly-set-by-the-card';
    const res = await request(appWithStubs).post('/api/papers/p11/references/r11/fulltext');

    expect(res.body.reference.pdfUrl).toBe('https://arxiv.org/pdf/2222.3333');
  });

  it('does not remember a miss the search backend caused', async () => {
    // A search that could not run is not "no PDF exists". Marking it done would make
    // the card lie for good after one unlucky moment.
    insertPaper('p8');
    insertReference('p8', 'r8', 'cite.down', 0, { title: 'A Findable Work', pdfUrl: null, arxivId: null });
    let asked = 0;
    const appWithStubs = createApp(db, {
      papers: {
        webSearchFn: async () => {
          asked++;
          throw new Error('ECONNREFUSED');
        },
      },
    });

    const first = await request(appWithStubs).post('/api/papers/p8/references/r8/fulltext');
    await request(appWithStubs).post('/api/papers/p8/references/r8/fulltext');

    expect(first.status).toBe(200);
    expect(first.body.reference.fulltextSearchFailed).toBe(true);
    expect(asked).toBe(2);
  });
});

describe('the reference pass runs on import', () => {
  it('fills the cache in the background after an upload', async () => {
    // The upload itself must not wait for pdf.js and OpenAlex — the reader
    // gets their PDF immediately and the underlines appear a moment later.
    const extracted = {
      citations: [{ page: 1, rect: [10, 20, 30, 40], anchor: 'cite.x' }],
      references: [{ anchor: 'cite.x', rawText: '[1] A. Smith. A cited work. arXiv:2101.00001, 2021.' }],
    };
    const appWithStubs = createApp(db, {
      papers: {
        extractPdfTextFn: async () => 'text',
        extractCitationsFn: async () => extracted,
        resolveWorkFn: async () => null,
        fetchReferencesFn: async () => [],
      },
    });

    const chat = (await request(appWithStubs).post('/api/chats').send({ title: 'Root' })).body;
    const upload = await request(appWithStubs)
      .post('/api/papers')
      .field('chat_id', chat.id)
      .attach('pdf', Buffer.from('%PDF-1.4\n%%EOF\n'), 'paper.pdf');
    expect(upload.status).toBe(201);

    // The pass is queued, not awaited — give the event loop a turn.
    await new Promise((r) => setTimeout(r, 50));

    const res = await request(appWithStubs).get(`/api/papers/${upload.body.id}/citations`);
    expect(res.body.status).toBe('ready');
    expect(res.body.references[0].arxivId).toBe('2101.00001');
    expect(res.body.citations).toHaveLength(1);
  });
});
