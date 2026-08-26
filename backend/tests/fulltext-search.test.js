/**
 * fulltext-search.test.js
 *
 * The silent search (design/mockup-citation-card-standard.html § 04): a
 * reference whose PDF the paper never linked is looked up on the web, and
 * whatever comes back has to be good enough to open WITHOUT asking the
 * reader. There is no hit list to correct a bad answer — so the rules here
 * are the whole safety net.
 */

const { findFulltext } = require('../fulltext-search');

const SENNRICH = {
  title: 'Neural Machine Translation of Rare Words with Subword Units',
  authors: ['Rico Sennrich', 'Barry Haddow', 'Alexandra Birch'],
  year: 2016,
  rawText: '[27] R. Sennrich, B. Haddow, A. Birch. Neural machine translation of rare words with subword units. 2016.',
};

// A search backend that answers with a fixed result list.
const searchWith = (results) => async () => ({ results });

describe('findFulltext', () => {
  it('turns an arXiv abstract page into the PDF it stands for', async () => {
    const found = await findFulltext(SENNRICH, {
      searchFn: searchWith([
        {
          title: 'Neural Machine Translation of Rare Words with Subword Units',
          url: 'https://arxiv.org/abs/1508.07909',
          snippet: '',
        },
      ]),
    });

    expect(found).toEqual({
      url: 'https://arxiv.org/pdf/1508.07909',
      host: 'arxiv.org',
    });
  });

  it('drops a PDF whose title is a different work', async () => {
    // Without a hit list the reader cannot catch this: a wrong PDF would
    // simply become a tree titled after the right paper. Strictness IS the
    // safety net (user decision 2026-08-10).
    const found = await findFulltext(SENNRICH, {
      searchFn: searchWith([
        {
          title: 'Sequence to Sequence Learning with Neural Networks',
          url: 'https://arxiv.org/abs/1409.3215',
          snippet: '',
        },
      ]),
    });

    expect(found).toBeNull();
  });

  it('ignores a landing page, however well it matches', async () => {
    const found = await findFulltext(SENNRICH, {
      searchFn: searchWith([
        {
          title: 'Neural Machine Translation of Rare Words with Subword Units | Semantic Scholar',
          url: 'https://www.semanticscholar.org/paper/abc123',
          snippet: '',
        },
      ]),
    });

    expect(found).toBeNull();
  });

  it('prefers the source that reliably serves the real thing', async () => {
    // ResearchGate mirrors are the classic trap: a "(PDF)" title over a login
    // wall. The order of TRUSTED_HOSTS decides, not the order of the hits.
    const found = await findFulltext(SENNRICH, {
      searchFn: searchWith([
        {
          title: '(PDF) Neural Machine Translation of Rare Words with Subword Units',
          url: 'https://www.researchgate.net/publication/1.pdf',
          snippet: '',
        },
        {
          title: 'Neural Machine Translation of Rare Words with Subword Units',
          url: 'https://aclanthology.org/P16-1162.pdf',
          snippet: '',
        },
        {
          title: 'Neural Machine Translation of Rare Words with Subword Units',
          url: 'https://arxiv.org/abs/1508.07909',
          snippet: '',
        },
      ]),
    });

    expect(found).toEqual({ url: 'https://arxiv.org/pdf/1508.07909', host: 'arxiv.org' });
  });

  it('searches the printed row when nothing could be identified', async () => {
    // Nothing parsed, nothing resolved — the row itself is the query, and the
    // hit's title has to be contained IN that row (the row carries authors
    // and a year the title does not, so plain overlap would never match).
    const seen = [];
    const found = await findFulltext(
      {
        title: null,
        parsedTitle: null,
        authors: [],
        year: null,
        rawText: '[44] M. Zeiler. ADADELTA: An adaptive learning rate method. arXiv:1212.5701, 2012.',
      },
      {
        searchFn: async (q) => {
          seen.push(q);
          return {
            results: [
              {
                title: 'ADADELTA: An Adaptive Learning Rate Method',
                url: 'https://arxiv.org/abs/1212.5701',
                snippet: '',
              },
            ],
          };
        },
      },
    );

    expect(seen[0]).toContain('ADADELTA');
    expect(found).toEqual({ url: 'https://arxiv.org/pdf/1212.5701', host: 'arxiv.org' });
  });

  it('does not open a stranger just because the row was unreadable', async () => {
    // The dangerous case: nothing identified, so there is no title to compare
    // against — and a trusted host would otherwise be waved through.
    const found = await findFulltext(
      {
        title: null,
        parsedTitle: null,
        authors: [],
        year: null,
        rawText: '[44] M. Zeiler. ADADELTA: An adaptive learning rate method. arXiv:1212.5701, 2012.',
      },
      {
        searchFn: searchWith([
          {
            title: 'Attention Is All You Need',
            url: 'https://arxiv.org/abs/1706.03762',
            snippet: '',
          },
        ]),
      },
    );

    expect(found).toBeNull();
  });

  it('looks past the first handful of hits', async () => {
    // Measured against the search in use 2026-08-10: for "Deep Residual
    // Learning for Image Recognition" the arXiv page is hit number NINE —
    // behind a course slide deck, GitHub and ResearchGate. Trimming to the
    // top 8 (what the LLM search tool does, to save context) threw the only
    // usable answer away, and the card said "no full text" for a paper that
    // has been on arXiv since 2015.
    let askedFor = 0;
    const filler = Array.from({ length: 8 }, (_, i) => ({
      title: 'Deep Residual Learning for Image Recognition - Lecture Slides',
      url: `https://example.edu/slides-${i}.html`,
    }));
    const found = await findFulltext(
      { title: 'Deep Residual Learning for Image Recognition', authors: ['Kaiming He'], year: 2016, rawText: '' },
      {
        searchFn: async (_q, max) => {
          askedFor = max;
          return {
            results: [
              ...filler,
              {
                title: '[1512.03385] Deep Residual Learning for Image Recognition',
                url: 'https://arxiv.org/abs/1512.03385',
              },
            ],
          };
        },
      },
    );

    expect(askedFor).toBeGreaterThanOrEqual(20);
    expect(found).toEqual({ url: 'https://arxiv.org/pdf/1512.03385', host: 'arxiv.org' });
  });

  it('does not let an arXiv id in the title spoil the match', async () => {
    // arXiv titles come back as "[1508.07909] Real Title". The id is two more
    // words the real title never has, and on a short title that alone can
    // push the overlap under the bar.
    const found = await findFulltext(
      { title: 'Layer Normalization', authors: ['Jimmy Ba'], year: 2016, rawText: '' },
      {
        searchFn: searchWith([
          { title: '[1607.06450] Layer Normalization', url: 'https://arxiv.org/abs/1607.06450' },
        ]),
      },
    );

    expect(found).toEqual({ url: 'https://arxiv.org/pdf/1607.06450', host: 'arxiv.org' });
  });

  it('says nothing rather than something when the search itself fails', async () => {
    // A search that could not run is not "no PDF exists" — but this module's answer
    // is the same either way; the caller distinguishes the two.
    await expect(
      findFulltext(SENNRICH, {
        searchFn: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    ).rejects.toThrow();
  });
});

describe('when the search has been shut out', () => {
  // Since the search can be absent altogether (Tavily key or nothing, ADR-0012), "nothing
  // is set up" arrives as a RETURNED error instead of a throw. Caching that as
  // "this reference has no full text" would be wrong: nobody ever looked.
  it('does not report "nothing found" when no search provider is configured', async () => {
    const searchFn = async () => ({
      provider: null,
      error: 'no-search-provider',
      results: [],
    });

    await expect(
      findFulltext({ title: 'Layer Normalization' }, { searchFn }),
    ).rejects.toMatchObject({ suspended: true });
  });

  // W1 (design/mockup-onboarding-flow.html §06): "nobody has set up a search"
  // and "the search shut us out" both mean nobody looked, but only one of them
  // is fixed by waiting. The reason travels with the error so the card can ask
  // for a key instead of counting down a wait that will never help.
  it('names the reason when no search provider is configured', async () => {
    const searchFn = async () => ({
      provider: null,
      error: 'no-search-provider',
      results: [],
    });

    await expect(
      findFulltext({ title: 'Layer Normalization' }, { searchFn }),
    ).rejects.toMatchObject({ suspended: true, reason: 'no-search-provider' });
  });

  // Found in the running app 2026-08-24, after typing a wrong key into the W1
  // card: the search came back `tavily-invalid-key`, which is not
  // 'no-search-provider' — so it fell into the countdown branch and the card
  // said "Search paused — resuming in 80 s". Waiting repairs a bad key exactly
  // as little as it repairs a missing one. Every named error travels.
  it('names a rejected key and a spent allowance too', async () => {
    for (const error of ['tavily-invalid-key', 'tavily-quota-exhausted']) {
      const err = await findFulltext(
        { title: 'Layer Normalization' },
        { searchFn: async () => ({ provider: 'tavily', error, results: [] }) },
      ).catch((e) => e);

      expect(err.suspended).toBe(true);
      expect(err.reason).toBe(error);
    }
  });

  it('leaves the reason unset when the engines shut us out', async () => {
    const err = await findFulltext(SENNRICH, {
      searchFn: async () => ({
        results: [],
        unresponsiveEngines: [['brave', 'Suspended: too many requests']],
      }),
    }).catch((e) => e);

    expect(err.suspended).toBe(true);
    expect(err.reason).toBeUndefined();
  });

  it('does not report "nothing found" while every engine is suspended', async () => {
    // Measured in the running app 2026-08-10: twenty serial searches were
    // enough for the search to answer with zero results and
    //   brave: "Suspended: too many requests", duckduckgo: "CAPTCHA",
    //   google cse: "Suspended: too many requests", startpage: "CAPTCHA"
    // — sixteen references were then recorded as "no full text" although
    // nobody had actually looked. An empty answer from a search that could
    // not run is not an answer about the paper.
    await expect(
      findFulltext(SENNRICH, {
        searchFn: async () => ({
          results: [],
          unresponsiveEngines: [
            ['brave', 'Suspended: too many requests'],
            ['duckduckgo', 'CAPTCHA'],
          ],
        }),
      }),
    ).rejects.toMatchObject({ suspended: true });
  });

  it('still trusts an empty answer when the engines were healthy', async () => {
    const found = await findFulltext(SENNRICH, {
      searchFn: async () => ({ results: [], unresponsiveEngines: [] }),
    });

    expect(found).toBeNull();
  });

  it('ignores an engine that merely dropped out, as long as hits came back', async () => {
    const found = await findFulltext(SENNRICH, {
      searchFn: async () => ({
        results: [
          {
            title: 'Neural Machine Translation of Rare Words with Subword Units',
            url: 'https://arxiv.org/abs/1508.07909',
          },
        ],
        unresponsiveEngines: [['wikipedia', 'access denied']],
      }),
    });

    expect(found).toEqual({ url: 'https://arxiv.org/pdf/1508.07909', host: 'arxiv.org' });
  });
});
