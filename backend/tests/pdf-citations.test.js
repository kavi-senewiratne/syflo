/**
 * tests/pdf-citations.test.js
 *
 * Unit tests for pdf-citations.js — reading a paper's own citation links.
 *
 * Vocabulary (CONTEXT.md): a CITATION is the mark in the running text
 * ("[13]", "(Vaswani et al., 2017)"); a REFERENCE is the row it points at in
 * the bibliography. LaTeX/hyperref writes one link annotation per citation,
 * whose destination names the reference — that is what we read here.
 *
 * The tests drive a plain document stub through the injectable `openFn`
 * rather than a real PDF. Two reasons, in order of weight:
 *
 *  1. Loading the pdf.js ESM build inside Jest is unreliable — any sibling
 *     suite tearing down mid-import poisons the loader for everyone
 *     ("Provided module is not an instance of Module"), and a real-PDF
 *     version of this suite failed every other run of `npm test`.
 *  2. What is under test here is geometry — which anchor owns which text,
 *     where a column ends, where a row stops. A stub states those positions
 *     outright instead of burying them in hand-rolled PDF syntax.
 *
 * pdf.js itself is verified against real papers, not here; the measurements
 * are recorded in the module header.
 */

const { extractCitations } = require('../pdf-citations');

const PAGE_WIDTH = 612;

/**
 * A text item as pdf.js reports it: `transform[4]` is x, `transform[5]` is y
 * (origin bottom-left), `width` the advance width.
 */
function text(str, x, y, width = str.length * 5) {
  return { str, transform: [1, 0, 0, 1, x, y], width, hasEOL: true };
}

/** A link annotation pointing at a named destination. */
function link(anchor, rect) {
  return { subtype: 'Link', dest: anchor, rect };
}

/**
 * Build a document stub for `openFn`.
 *
 * pages: [{ annotations, items }]
 * dests: { anchor: [pageIndex, x, y] }
 */
function stubDocument(pages, dests) {
  const doc = {
    numPages: pages.length,
    getPage: async (n) => ({
      view: [0, 0, PAGE_WIDTH, 792],
      getAnnotations: async () => pages[n - 1].annotations || [],
      getTextContent: async () => ({ items: pages[n - 1].items || [] }),
    }),
    // pdf.js hands back [pageRef, {name}, x, y, zoom]; the page ref is opaque,
    // so the stub uses the index itself and resolves it straight back.
    getDestination: async (anchor) => {
      const d = dests[anchor];
      return d ? [d[0], { name: 'XYZ' }, d[1], d[2], null] : null;
    },
    getPageIndex: async (ref) => ref,
  };
  return async () => ({ doc, close: async () => {} });
}

describe('extractCitations', () => {
  it('reports one citation per link annotation, with its page, rect and anchor', async () => {
    const openFn = stubDocument(
      [
        {
          annotations: [
            link('cite.smith2020', [108, 714, 118, 726]),
            link('cite.jones2019', [300, 714, 310, 726]),
            // Not a citation: an internal jump to a figure.
            { subtype: 'Link', dest: 'figure.3', rect: [400, 714, 410, 726] },
            // Not a citation: an outbound URL.
            { subtype: 'Link', url: 'https://example.org', rect: [500, 714, 510, 726] },
          ],
          items: [text('Recurrent models factor computation [1], as does ByteNet [2].', 72, 720)],
        },
        { items: [text('[1] A. Smith. A paper. 2020.', 72, 720)] },
      ],
      { 'cite.smith2020': [1, 72, 720] },
    );

    const { citations } = await extractCitations('/ignored.pdf', { openFn });

    expect(citations).toHaveLength(2);
    expect(citations[0]).toMatchObject({ page: 1, anchor: 'cite.smith2020' });
    expect(citations[0].rect).toEqual([108, 714, 118, 726]);
    expect(citations[1]).toMatchObject({ page: 1, anchor: 'cite.jones2019' });
  });

  it('reads the reference row each anchor lands on', async () => {
    const openFn = stubDocument(
      [
        {
          annotations: [
            link('cite.smith2020', [108, 714, 118, 726]),
            link('cite.jones2019', [300, 714, 310, 726]),
          ],
          items: [text('Computation [1], as does ByteNet [2].', 72, 720)],
        },
        {
          items: [
            text('References', 72, 720),
            text('[1] A. Smith. Attention over memory. NeurIPS, 2020.', 72, 708),
            text('[2] B. Jones. Another fine paper. ICML, 2019.', 72, 696),
          ],
        },
      ],
      { 'cite.smith2020': [1, 72, 708], 'cite.jones2019': [1, 72, 696] },
    );

    const { references } = await extractCitations('/ignored.pdf', { openFn });

    expect(references).toHaveLength(2);
    expect(references[0]).toMatchObject({
      anchor: 'cite.smith2020',
      rawText: '[1] A. Smith. Attention over memory. NeurIPS, 2020.',
    });
    expect(references[1].rawText).toBe('[2] B. Jones. Another fine paper. ICML, 2019.');
  });

  it('keeps a two-column bibliography in its own column', async () => {
    // Most papers print references in two columns. Rows sharing a baseline
    // across the gutter must not bleed into each other.
    const openFn = stubDocument(
      [
        {
          annotations: [
            link('cite.left1', [108, 714, 118, 726]),
            link('cite.left2', [130, 714, 140, 726]),
            link('cite.right1', [160, 714, 170, 726]),
            link('cite.right2', [190, 714, 200, 726]),
          ],
          items: [text('Citing [1], [2], [3] and [4].', 72, 720)],
        },
        {
          items: [
            text('[1] Left column, first row.', 72, 720, 130),
            text('[3] Right column, first row.', 320, 720, 130),
            text('[2] Left column, second row.', 72, 708, 130),
            text('[4] Right column, second.', 320, 708, 130),
          ],
        },
      ],
      {
        'cite.left1': [1, 72, 720],
        'cite.left2': [1, 72, 708],
        'cite.right1': [1, 320, 720],
        'cite.right2': [1, 320, 708],
      },
    );

    const { references } = await extractCitations('/ignored.pdf', { openFn });
    const byAnchor = Object.fromEntries(references.map((r) => [r.anchor, r.rawText]));

    expect(byAnchor['cite.left1']).toBe('[1] Left column, first row.');
    expect(byAnchor['cite.left2']).toBe('[2] Left column, second row.');
    expect(byAnchor['cite.right1']).toBe('[3] Right column, first row.');
    expect(byAnchor['cite.right2']).toBe('[4] Right column, second.');
  });

  it('ignores a neighbouring column that carries no anchors at all', async () => {
    // Real failure (Gemma paper): the bibliography sits in one column with a
    // long author list printed beside it. No anchor ever lands in that column,
    // so the columns must come from the page's own text geometry — an empty
    // corridor between two blocks — not from where the anchors happen to sit.
    const openFn = stubDocument(
      [
        {
          annotations: [
            link('cite.one', [108, 714, 118, 726]),
            link('cite.two', [160, 714, 170, 726]),
          ],
          items: [text('Cited here [1] and there [2].', 72, 720)],
        },
        {
          items: [
            text('Ada Lovelace', 72, 720, 70),
            text('[1] A. Smith. First work. 2020.', 330, 720, 150),
            text('Grace Hopper', 72, 708, 70),
            text('[2] B. Jones. Second work. 2019.', 330, 708, 150),
            text('Alan Turing', 72, 696, 70),
          ],
        },
      ],
      { 'cite.one': [1, 330, 720], 'cite.two': [1, 330, 708] },
    );

    const { references } = await extractCitations('/ignored.pdf', { openFn });

    expect(references[0].rawText).toBe('[1] A. Smith. First work. 2020.');
    expect(references[1].rawText).toBe('[2] B. Jones. Second work. 2019.');
  });

  it('ends a reference row at the next numbered entry, even without an anchor', async () => {
    // A reference nobody cites carries no anchor. Without a second guard the
    // previous row would swallow it — and everything after it, to the page
    // foot — so a fresh "[n]" opening a line closes the row too.
    const openFn = stubDocument(
      [
        {
          annotations: [link('cite.only', [108, 714, 118, 726])],
          items: [text('Only the first work is cited [1].', 72, 720)],
        },
        {
          items: [
            text('[1] A. Smith. The cited paper. 2020.', 72, 720, 170),
            text('[2] B. Jones. Never cited in the text. 2019.', 72, 708, 170),
          ],
        },
      ],
      { 'cite.only': [1, 72, 720] },
    );

    const { references } = await extractCitations('/ignored.pdf', { openFn });

    expect(references).toHaveLength(1);
    expect(references[0].rawText).toBe('[1] A. Smith. The cited paper. 2020.');
  });

  it('reports where each reference row sits, so the list is clickable too', async () => {
    // The rows at the end of the paper are DESTINATIONS, not annotations, so
    // they carry no rect of their own — and the reference list stayed dead
    // while every citation in the text was live (user report 2026-08-09).
    // Their geometry has to come from the text items that make up the row.
    const openFn = stubDocument(
      [
        {
          annotations: [link('cite.smith2020', [108, 714, 118, 726])],
          items: [text('Computation [1].', 72, 720)],
        },
        {
          items: [
            text('[1] A. Smith. Attention over memory. NeurIPS, 2020.', 72, 708, 230),
            text('[2] B. Jones. Another one. ICML, 2019.', 72, 696, 180),
          ],
        },
      ],
      { 'cite.smith2020': [1, 72, 708] },
    );

    const { references } = await extractCitations('/ignored.pdf', { openFn });

    // One entry per text item, with the text — the caller locates the title
    // inside it and underlines only that.
    expect(references[0].spans).toEqual([
      // The trailing space is the line break: without it, joining the spans
      // runs the last word of one line into the first of the next.
      {
        page: 2,
        rect: [72, 708, 302, 718],
        // A text item's y IS its baseline — that is where the underline hangs.
        baseline: 708,
        text: '[1] A. Smith. Attention over memory. NeurIPS, 2020. ',
      },
    ]);
  });

  it('measures each citation against the line its glyphs sit on', async () => {
    // The link box is not a text box: hyperref sizes it per paper, so its
    // bottom edge sits a different distance below the baseline in a numeric
    // paper than in an author-year one (1.07 pt vs 3.15 pt, measured
    // 2026-08-10) — and an underline hung off the box drifted with it (user
    // report 2026-08-10). Both boxes below sit over text on baseline 720.
    const openFn = stubDocument(
      [
        {
          annotations: [
            // Numeric mark: a tight box, bottom 1 pt under the baseline.
            link('cite.numeric', [180, 719, 192, 728]),
            // Author-year mark: a taller box, bottom 3 pt under the baseline.
            link('cite.authors', [300, 717, 390, 728]),
          ],
          items: [
            text('Shown in', 72, 720, 100),
            text('[38]', 180, 720, 12),
            text('and in', 250, 720, 40),
            text('(Bahdanau et al., 2015)', 300, 720, 90),
          ],
        },
      ],
      {},
    );

    const { citations } = await extractCitations('/ignored.pdf', { openFn });

    expect(citations.map((c) => c.baseline)).toEqual([720, 720]);
  });

  it('measures a citation against the text it actually covers, not the line below', async () => {
    // A link box reaches into the following line often enough that the lowest
    // baseline inside it is the wrong answer. The widest horizontal OVERLAP
    // says which text the mark is made of.
    const openFn = stubDocument(
      [
        {
          annotations: [link('cite.overlap', [300, 707, 390, 728])],
          items: [
            text('(Bahdanau et al., 2015)', 300, 720, 90),
            text('the next line of prose', 72, 708, 200),
          ],
        },
      ],
      {},
    );

    const { citations } = await extractCitations('/ignored.pdf', { openFn });

    expect(citations[0].baseline).toBe(720);
  });

  it('picks the line the box hugs when a full-width line above overlaps just as much', async () => {
    // Measured in the running app 2026-08-11 (Structured Attention Networks,
    // page 4): the link box for "(Smith & Eisner, 2008)" is x 110.3–176.0,
    // y 141.6–153.9. Both the citation's own line (baseline 145.5) and the
    // line ABOVE it (baseline 156.4) are single text items spanning the whole
    // column, so both overlap the box by exactly 65.7 pt. The tie went to
    // whichever came first in reading order — the line above — and the
    // underline appeared under "dependency parser", which is not a reference
    // at all (user report 2026-08-11).
    //
    // A link box hugs its own line: its bottom sits 1–4 pt under that
    // baseline. Nearness to the bottom edge is what decides.
    const openFn = stubDocument(
      [
        {
          annotations: [link('cite.smith2008', [110.3, 141.6, 176, 153.9])],
          items: [
            text('A dependency parser can be partially formalized as', 108, 156.4, 396),
            text('(Smith & Eisner, 2008): latent variables', 108, 145.5, 164.7),
          ],
        },
      ],
      {},
    );

    const { citations } = await extractCitations('/ignored.pdf', { openFn });

    expect(citations[0].baseline).toBe(145.5);
  });

  it('leaves the baseline null when no text falls inside the link box', async () => {
    // A mark drawn over an image carries no measurable line; the view then
    // falls back to the rect rather than placing the rule at random.
    const openFn = stubDocument(
      [
        {
          annotations: [link('cite.onfigure', [108, 400, 160, 412])],
          items: [text('Prose far above the figure.', 72, 720)],
        },
      ],
      {},
    );

    const { citations } = await extractCitations('/ignored.pdf', { openFn });

    expect(citations[0].baseline).toBeNull();
  });

  it('skips an anchor the PDF never defines', async () => {
    // A stale \cite of a dropped bibliography entry: the citation still counts
    // as a click target, but there is no row behind it.
    const openFn = stubDocument(
      [
        {
          annotations: [link('cite.ghost', [108, 714, 118, 726])],
          items: [text('A dangling citation [9].', 72, 720)],
        },
      ],
      {},
    );

    const { citations, references } = await extractCitations('/ignored.pdf', { openFn });

    expect(citations).toHaveLength(1);
    expect(references).toEqual([]);
  });
});
