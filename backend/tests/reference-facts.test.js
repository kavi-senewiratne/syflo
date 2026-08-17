/**
 * reference-facts.test.js
 *
 * The facts behind a reference that nobody asked for yet: where it appeared
 * and how often it has been cited.
 *
 * Measured over the stored corpus 2026-08-12: of 171 references, 118 had no
 * citation count and 50 no venue — so the card's fold was often an empty
 * promise. OpenAlex sends both and we now keep them, but OpenAlex does not
 * know every work. What it misses is looked up in the background, and the open
 * card fills in when the answer lands (user request 2026-08-12).
 */

const { missingFacts, fetchReferenceFacts } = require('../reference-facts');

const SS_HIT = {
  paperId: 'abc123',
  title: 'Self-Training PCFG Grammars with Latent Annotations Across Languages',
  year: 2009,
  citationCount: 214,
  venue: 'Conference on Empirical Methods in Natural Language Processing',
};

describe('missingFacts', () => {
  it('names only what is actually missing', () => {
    expect(missingFacts({ citations: 12, venue: 'EMNLP', year: 2009 })).toEqual([]);
    expect(missingFacts({ citations: null, venue: 'EMNLP', year: 2009 })).toEqual(['citations']);
    expect(missingFacts({ citations: 12, venue: null, year: null })).toEqual(['venue', 'year']);
  });

  it('counts zero citations as an answer, not as a gap', () => {
    // A paper cited nobody-knows-how-often and a paper cited zero times are
    // different states; asking again for the second would never stop.
    expect(missingFacts({ citations: 0, venue: 'arXiv', year: 2024 })).toEqual([]);
  });
});

describe('fetchReferenceFacts — which source is asked first', () => {
  it('asks OpenAlex by identifier before anything else', async () => {
    // Measured against the live services 2026-08-12: Semantic Scholar answers
    // 429 without an API key, while OpenAlex answers a DOI or an arXiv id
    // keylessly — and its record already carries both facts. So the keyless,
    // exact source goes first; SS is the fallback.
    const asked = [];
    const facts = await fetchReferenceFacts(
      { title: 'Long Short-Term Memory-Networks for Machine Reading', arxivId: '1601.06733', doi: null },
      {
        openalexByArxivFn: async (id) => {
          asked.push(`openalex:${id}`);
          return {
            display_name: 'Long Short-Term Memory-Networks for Machine Reading',
            cited_by_count: 1183,
            publication_year: 2016,
            primary_location: { source: { display_name: 'Empirical Methods in Natural Language Processing' } },
          };
        },
        lookupByIdFn: async () => {
          throw new Error('Semantic Scholar must not be asked while OpenAlex answers');
        },
      },
    );

    expect(asked).toEqual(['openalex:1601.06733']);
    expect(facts).toMatchObject({
      citations: 1183,
      venue: 'Empirical Methods in Natural Language Processing',
      year: 2016,
    });
  });

  it('keeps asking OpenAlex through every identifier it has', async () => {
    // Measured against live OpenAlex 2026-08-12: lookupByArxiv('1601.06733')
    // answers NULL while lookupByDoi('10.48550/arxiv.1601.06733') returns the
    // record with 190 citations. Stopping at the first empty answer left the
    // fold empty for a work OpenAlex holds.
    const asked = [];
    const facts = await fetchReferenceFacts(
      { title: 'Long Short-Term Memory-Networks for Machine Reading', arxivId: '1601.06733', doi: '10.48550/arxiv.1601.06733' },
      {
        openalexByArxivFn: async () => { asked.push('arxiv'); return null; },
        openalexByDoiFn: async () => {
          asked.push('doi');
          return { cited_by_count: 190, primary_location: { source: { display_name: 'arXiv (Cornell University)' } }, publication_year: 2016 };
        },
        lookupByIdFn: async () => { throw new Error('not needed'); },
      },
    );

    expect(asked).toEqual(['arxiv', 'doi']);
    expect(facts).toMatchObject({ citations: 190, venue: 'arXiv (Cornell University)' });
  });

  it('asks OpenAlex by title when it has no identifier for the work', async () => {
    // The title route is verified by OpenAlex itself; without it, a reference
    // with neither a DOI nor an arXiv id fell straight through to the
    // rate-limited fallback.
    const facts = await fetchReferenceFacts(
      { title: 'Xception: Deep Learning with Depthwise Separable Convolutions', arxivId: null, doi: null },
      {
        openalexByTitleFn: async () => ({
          display_name: 'Xception: Deep Learning with Depthwise Separable Convolutions',
          cited_by_count: 14_500,
          publication_year: 2017,
          primary_location: { source: { display_name: 'Computer Vision and Pattern Recognition' } },
        }),
        lookupByTitleFn: async () => { throw new Error('not needed'); },
      },
    );

    expect(facts).toMatchObject({ citations: 14_500, venue: 'Computer Vision and Pattern Recognition' });
  });

  it('falls back to the second source when OpenAlex has nothing', async () => {
    const asked = [];
    const facts = await fetchReferenceFacts(
      { title: 'Some Work', arxivId: null, doi: '10.1/xyz' },
      {
        openalexByDoiFn: async () => {
          asked.push('openalex');
          return null;
        },
        openalexByTitleFn: async () => null,
        lookupByIdFn: async (idExpr) => {
          asked.push(idExpr);
          return { citationCount: 42, venue: 'Journal of Things', year: 2011 };
        },
      },
    );

    expect(asked).toEqual(['openalex', 'DOI:10.1/xyz']);
    expect(facts).toMatchObject({ citations: 42, venue: 'Journal of Things' });
  });

  it('survives a rate-limited second source when OpenAlex answered', async () => {
    const facts = await fetchReferenceFacts(
      { title: 'Some Work', arxivId: '1601.06733', doi: null },
      {
        openalexByArxivFn: async () => ({ cited_by_count: 7, publication_year: 2016 }),
        openalexByTitleFn: async () => null,
        lookupByIdFn: async () => {
          throw new Error('Semantic Scholar id lookup failed: 429');
        },
      },
    );

    expect(facts).toMatchObject({ citations: 7 });
  });
});

describe('fetchReferenceFacts', () => {
  it('fills the gaps from the second source', async () => {
    const facts = await fetchReferenceFacts(
      { title: 'Self-training PCFG grammars with latent annotations across languages', arxivId: null, doi: null },
      { openalexByTitleFn: async () => null, lookupByTitleFn: async () => SS_HIT },
    );

    expect(facts).toEqual({ citations: 214, venue: 'Conference on Empirical Methods in Natural Language Processing', year: 2009 });
  });

  it('goes by identifier when there is one, instead of searching a title', async () => {
    // A DOI or an arXiv id is exact; a title search is a guess that can land
    // on a different paper with a similar name.
    const asked = [];
    const facts = await fetchReferenceFacts(
      { title: 'Layer Normalization', arxivId: '1607.06450', doi: null },
      {
        openalexByArxivFn: async () => null,
        openalexByTitleFn: async () => null,
        lookupByIdFn: async (idExpr) => {
          asked.push(idExpr);
          return { citationCount: 9000, venue: 'arXiv', year: 2016 };
        },
        lookupByTitleFn: async () => {
          throw new Error('must not search by title when an id exists');
        },
      },
    );

    expect(asked).toEqual(['arXiv:1607.06450']);
    expect(facts).toMatchObject({ citations: 9000, venue: 'arXiv' });
  });

  it('refuses a hit whose title is a different work', async () => {
    // Same rule as the full-text search: without a hit list to correct it, a
    // wrong answer would silently become a fact on the card.
    const facts = await fetchReferenceFacts(
      { title: 'Neural Machine Translation of Rare Words with Subword Units', arxivId: null, doi: null },
      {
        openalexByTitleFn: async () => null,
        lookupByTitleFn: async () => ({ title: 'Attention Is All You Need', citationCount: 143000, venue: 'NeurIPS' }),
      },
    );

    expect(facts).toBeNull();
  });

  it('answers null when the source knows nothing', async () => {
    const facts = await fetchReferenceFacts(
      { title: 'A Work Nobody Indexed', arxivId: null, doi: null },
      { openalexByTitleFn: async () => null, lookupByTitleFn: async () => null },
    );

    expect(facts).toBeNull();
  });

  it('has nothing to search for without a title or an identifier', async () => {
    const asked = [];
    const facts = await fetchReferenceFacts(
      { title: null, arxivId: null, doi: null },
      { openalexByTitleFn: async () => null, lookupByTitleFn: async (t) => { asked.push(t); return SS_HIT; } },
    );

    expect(asked).toEqual([]);
    expect(facts).toBeNull();
  });
});
