const oa = require('../openalex');

// Helper: makeFetch returns a stub that matches the first route whose key
// appears as a substring of the request URL. Mirrors the helper in
// semantic-scholar.test.js so the two test files read the same way.
function makeFetch(routes) {
  return async (url) => {
    for (const [key, body] of Object.entries(routes)) {
      if (url.includes(key)) {
        if (typeof body === 'function') return body(url);
        if (body && typeof body === 'object' && '__status' in body) {
          return {
            ok: false,
            status: body.__status,
            async json() { return body.__body || {}; },
          };
        }
        return {
          ok: true,
          status: 200,
          async json() { return body; },
        };
      }
    }
    return { ok: false, status: 404, async json() { return {}; } };
  };
}

describe('abstractFromInvertedIndex', () => {
  it('rebuilds the original prose from token→positions map', () => {
    // "Hello world hello" — "hello" appears at positions 0 and 2, "world" at 1.
    const idx = { Hello: [0], world: [1], hello: [2] };
    expect(oa.abstractFromInvertedIndex(idx)).toBe('Hello world hello');
  });

  it('handles a realistic multi-word abstract', () => {
    // Sentence: "Diffusion models generate images by reversing noise."
    const idx = {
      Diffusion: [0],
      models: [1],
      generate: [2],
      images: [3],
      by: [4],
      reversing: [5],
      'noise.': [6],
    };
    expect(oa.abstractFromInvertedIndex(idx)).toBe(
      'Diffusion models generate images by reversing noise.',
    );
  });

  it('returns null on missing / empty input', () => {
    expect(oa.abstractFromInvertedIndex(null)).toBeNull();
    expect(oa.abstractFromInvertedIndex(undefined)).toBeNull();
    expect(oa.abstractFromInvertedIndex({})).toBeNull();
  });

  it('skips non-array position values defensively', () => {
    const idx = { foo: 'not-an-array', bar: [0] };
    expect(oa.abstractFromInvertedIndex(idx)).toBe('bar');
  });
});

describe('shapeFieldHierarchy', () => {
  it('returns nulls when concepts missing', () => {
    expect(oa.shapeFieldHierarchy({})).toEqual({
      field: null, subfield: null, topic: null, all: [],
    });
  });

  it('prefers primary_topic over concepts (canonical source)', () => {
    // Realistic OpenAlex payload for a robotics paper — primary_topic gives
    // us a real cluster name; concepts would otherwise produce
    // "Computer science / Artificial intelligence / Regret" noise.
    const work = {
      primary_topic: {
        display_name: 'Robot Learning and Control',
        subfield: { display_name: 'Imitation Learning' },
        field: { display_name: 'Robotics' },
        domain: { display_name: 'Physical Sciences' },
      },
      topics: [
        { display_name: 'Robot Learning and Control' }, // duplicate of primary, must be deduped
        { display_name: 'Visuomotor Manipulation' },
        { display_name: 'Behavior Cloning' },
        { display_name: 'Diffusion Models' },
      ],
      concepts: [
        // These would normally pollute the field map; primary_topic wins.
        { display_name: 'Computer science', level: 0, score: 0.99 },
        { display_name: 'Regret', level: 4, score: 0.42 },
      ],
    };
    const h = oa.shapeFieldHierarchy(work);
    expect(h.field).toBe('Robotics');
    expect(h.subfield).toBe('Imitation Learning');
    expect(h.topic).toBe('Robot Learning and Control');
    // Sibling topics make it into `all`, but the duplicate primary is dropped.
    expect(h.all).toContain('Visuomotor Manipulation');
    expect(h.all).toContain('Behavior Cloning');
    // Concepts noise stays out when primary_topic is the source.
    expect(h.all).not.toContain('Regret');
    expect(h.all).not.toContain('Computer science');
  });

  it('caps sibling topics at 7 (plus the three canonical tiers)', () => {
    const work = {
      primary_topic: {
        display_name: 'Topic',
        subfield: { display_name: 'Sub' },
        field: { display_name: 'Field' },
      },
      topics: Array.from({ length: 20 }, (_, i) => ({ display_name: `T${i}` })),
    };
    const h = oa.shapeFieldHierarchy(work);
    // 3 canonical (Field, Sub, Topic) + at most 7 siblings = 10.
    expect(h.all.length).toBeLessThanOrEqual(10);
  });

  it('falls back to filtered concepts when primary_topic is missing', () => {
    const work = {
      concepts: [
        { display_name: 'Computer science', level: 0, score: 0.99 },
        { display_name: 'Robotics', level: 1, score: 0.85 },
        { display_name: 'Reinforcement learning', level: 1, score: 0.30 },
        { display_name: 'Imitation learning', level: 2, score: 0.78 },
        { display_name: 'Diffusion model', level: 3, score: 0.66 },
      ],
    };
    const h = oa.shapeFieldHierarchy(work);
    expect(h.field).toBe('Computer science');
    expect(h.subfield).toBe('Robotics');
    expect(h.topic).toBe('Imitation learning');
    expect(h.all).toContain('Computer science');
    expect(h.all).toContain('Diffusion model');
  });

  it('drops low-confidence concepts (score < 0.3) from the fallback path', () => {
    // Without filtering, "Geodesy" at score 0.09 would slip in as cross-domain noise.
    const work = {
      concepts: [
        { display_name: 'Robotics', level: 1, score: 0.85 },
        { display_name: 'Imitation learning', level: 2, score: 0.78 },
        { display_name: 'Geodesy', level: 1, score: 0.09 },
        { display_name: 'Biology', level: 0, score: 0.11 },
      ],
    };
    const h = oa.shapeFieldHierarchy(work);
    expect(h.all).not.toContain('Geodesy');
    expect(h.all).not.toContain('Biology');
    // The high-confidence tags still survive.
    expect(h.all).toContain('Robotics');
    expect(h.all).toContain('Imitation learning');
  });

  it('tolerates a missing level (no level-2 concept available)', () => {
    const work = {
      concepts: [
        { display_name: 'Physics', level: 0, score: 0.9 },
        { display_name: 'Quantum mechanics', level: 1, score: 0.8 },
      ],
    };
    const h = oa.shapeFieldHierarchy(work);
    expect(h.field).toBe('Physics');
    expect(h.subfield).toBe('Quantum mechanics');
    expect(h.topic).toBeNull();
  });

  it('handles primary_topic with a missing subfield gracefully', () => {
    const work = {
      primary_topic: {
        display_name: 'Some Topic',
        field: { display_name: 'Computer Science' },
        // subfield omitted
      },
    };
    const h = oa.shapeFieldHierarchy(work);
    expect(h.field).toBe('Computer Science');
    expect(h.subfield).toBeNull();
    expect(h.topic).toBe('Some Topic');
  });
});

describe('shapeSimilar', () => {
  it('maps an OpenAlex work into the SemanticScholarSimilarPaper shape', () => {
    const work = {
      id: 'https://openalex.org/W123',
      display_name: 'A Related Paper',
      authorships: [
        { author: { display_name: 'Alice' } },
        { author: { display_name: 'Bob' } },
        { author: { display_name: 'Carol' } },
        { author: { display_name: 'Dave' } },
      ],
      publication_year: 2021,
      cited_by_count: 42,
      open_access: { is_oa: true },
      abstract_inverted_index: { Foo: [0], bar: [1] },
    };
    const s = oa.shapeSimilar(work);
    expect(s).toEqual({
      id: 'https://openalex.org/W123',
      title: 'A Related Paper',
      authors: ['Alice', 'Bob', 'Carol'], // first 3 only
      year: 2021,
      citations: 42,
      open_access: true,
      abstract: 'Foo bar',
    });
  });

  it('handles missing optional fields', () => {
    const s = oa.shapeSimilar({ id: 'x', display_name: 'Y' });
    expect(s.authors).toEqual([]);
    expect(s.open_access).toBe(false);
    expect(s.citations).toBe(0);
    expect(s.abstract).toBeNull();
  });
});

describe('lookupByArxiv', () => {
  it('calls /works with the arXiv URL form + mailto param', async () => {
    let seen;
    const fetchFn = async (url) => {
      seen = url;
      return {
        ok: true,
        status: 200,
        async json() { return { id: 'https://openalex.org/W9', display_name: 'Ross 2011' }; },
      };
    };
    const w = await oa.lookupByArxiv('1011.0686', fetchFn);
    expect(w.id).toBe('https://openalex.org/W9');
    expect(seen).toMatch(/works\/https%3A%2F%2Farxiv\.org%2Fabs%2F1011\.0686/);
    expect(seen).toMatch(/mailto=/);
  });

  it('returns null on 404', async () => {
    const fetchFn = async () => ({ ok: false, status: 404, async json() { return {}; } });
    expect(await oa.lookupByArxiv('bogus', fetchFn)).toBeNull();
  });

  it('returns null when no id is passed', async () => {
    expect(await oa.lookupByArxiv(null)).toBeNull();
    expect(await oa.lookupByArxiv('')).toBeNull();
  });
});

describe('lookupByDoi', () => {
  it('calls /works with the DOI URL form', async () => {
    let seen;
    const fetchFn = async (url) => {
      seen = url;
      return { ok: true, status: 200, async json() { return { id: 'W42', display_name: 'X' }; } };
    };
    const w = await oa.lookupByDoi('10.1109/CVPR.2017.123', fetchFn);
    expect(w.id).toBe('W42');
    expect(seen).toMatch(/works\/https%3A%2F%2Fdoi\.org%2F10\.1109/);
  });
});

describe('lookupByTitle', () => {
  it('returns the best Jaccard match above threshold', async () => {
    const fetchFn = makeFetch({
      '/works?search=': {
        results: [
          { id: 'W1', display_name: 'Totally Unrelated Work' },
          { id: 'W2', display_name: 'Diffusion Policy Visuomotor Policy Learning' },
        ],
      },
    });
    const w = await oa.lookupByTitle('Diffusion Policy Visuomotor Policy Learning', fetchFn);
    expect(w.id).toBe('W2');
  });

  it('returns null when nothing crosses the similarity threshold', async () => {
    const fetchFn = makeFetch({
      '/works?search=': {
        results: [
          { id: 'W1', display_name: 'Completely Different Topic About Cats' },
        ],
      },
    });
    expect(await oa.lookupByTitle('Diffusion Models for Image Generation', fetchFn))
      .toBeNull();
  });

  it('returns null on empty / whitespace title without a network call', async () => {
    const fetchFn = jest.fn();
    expect(await oa.lookupByTitle('  ', fetchFn)).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('throws on a non-OK / non-404 response', async () => {
    const fetchFn = async () => ({ ok: false, status: 503, async json() { return {}; } });
    await expect(oa.lookupByTitle('something', fetchFn)).rejects.toThrow(/503/);
  });
});

describe('fetchRelatedWorks', () => {
  it('issues one batched call with pipe-separated ids and returns the results', async () => {
    let seen;
    const fetchFn = async (url) => {
      seen = url;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            results: [
              { id: 'W101', display_name: 'Rel 1' },
              { id: 'W102', display_name: 'Rel 2' },
            ],
          };
        },
      };
    };
    const work = {
      id: 'W1',
      related_works: [
        'https://openalex.org/W101',
        'https://openalex.org/W102',
      ],
    };
    const r = await oa.fetchRelatedWorks(work, 6, fetchFn);
    expect(r).toHaveLength(2);
    // Filter should strip the openalex.org/ prefix and pipe-join the ids.
    expect(seen).toMatch(/filter=ids\.openalex%3AW101%7CW102/);
  });

  it('returns [] when there are no related_works', async () => {
    const fetchFn = jest.fn();
    const r = await oa.fetchRelatedWorks({ related_works: [] }, 6, fetchFn);
    expect(r).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('degrades to [] on a failed fetch', async () => {
    const fetchFn = async () => ({ ok: false, status: 500, async json() { return {}; } });
    const r = await oa.fetchRelatedWorks({ related_works: ['W1'] }, 6, fetchFn);
    expect(r).toEqual([]);
  });
});

describe('enrichPaper', () => {
  it('prefers arXiv lookup over title search', async () => {
    const calls = [];
    const fetchFn = async (url) => {
      calls.push(url);
      if (url.includes('works/https%3A%2F%2Farxiv.org')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              id: 'https://openalex.org/W9',
              display_name: 'Ross 2011',
              concepts: [
                { display_name: 'Computer science', level: 0, score: 0.99 },
                { display_name: 'Machine learning', level: 1, score: 0.85 },
              ],
              related_works: ['https://openalex.org/W11'],
            };
          },
        };
      }
      if (url.includes('filter=ids.openalex')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { results: [{ id: 'W11', display_name: 'DAgger++' }] };
          },
        };
      }
      return { ok: false, status: 404, async json() { return {}; } };
    };
    const out = await oa.enrichPaper({ title: 'irrelevant', arxivId: '1011.0686' }, { fetchFn });
    expect(out.ss_id).toBe('https://openalex.org/W9');
    expect(out.source).toBe('openalex');
    expect(out.resolved_via).toBe('arxiv');
    expect(out.fields.field).toBe('Computer science');
    expect(out.fields.subfield).toBe('Machine learning');
    expect(out.similar).toHaveLength(1);
    // Title-search endpoint must NOT have been hit.
    expect(calls.some((u) => /\/works\?search=/.test(u))).toBe(false);
  });

  it('auto-extracts arXiv id from markdown when not supplied', async () => {
    let arxivCalled = false;
    const fetchFn = async (url) => {
      if (url.includes('works/https%3A%2F%2Farxiv.org')) {
        arxivCalled = true;
        return {
          ok: true,
          status: 200,
          async json() {
            return { id: 'W9', display_name: 'Ross 2011', concepts: [], related_works: [] };
          },
        };
      }
      return { ok: false, status: 404, async json() { return {}; } };
    };
    const md = '# Title\n\narXiv:1011.0686 — Ross et al.';
    const out = await oa.enrichPaper({ title: 'Ross 2011', markdown: md }, { fetchFn });
    expect(arxivCalled).toBe(true);
    expect(out.resolved_via).toBe('arxiv');
  });

  it('falls back to title search when arXiv lookup 404s', async () => {
    const fetchFn = async (url) => {
      if (url.includes('works/https%3A%2F%2Farxiv.org')) {
        return { ok: false, status: 404, async json() { return {}; } };
      }
      if (url.includes('/works?search=')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              results: [
                {
                  id: 'W77',
                  display_name: 'My Paper',
                  concepts: [{ display_name: 'AI', level: 0, score: 1 }],
                  related_works: [],
                },
              ],
            };
          },
        };
      }
      return { ok: false, status: 404, async json() { return {}; } };
    };
    const out = await oa.enrichPaper({ title: 'My Paper', arxivId: '9999.99999' }, { fetchFn });
    expect(out.ss_id).toBe('W77');
    expect(out.resolved_via).toBe('title');
  });

  it('returns null when every resolution strategy fails', async () => {
    const fetchFn = async () => ({ ok: false, status: 404, async json() { return {}; } });
    const out = await oa.enrichPaper({ title: 'Nope', arxivId: '0000.00000' }, { fetchFn });
    expect(out).toBeNull();
  });

  it('returns null (not error blob) when fetch throws — lets the route fall back to SS', async () => {
    const fetchFn = async () => { throw new Error('network down'); };
    const out = await oa.enrichPaper({ title: 'X', arxivId: '1.1' }, { fetchFn });
    expect(out).toBeNull();
  });

  it('includes source=openalex in the shaped record', async () => {
    const fetchFn = async (url) => {
      if (url.includes('works/https%3A%2F%2Farxiv.org')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { id: 'W9', display_name: 'X', concepts: [], related_works: [] };
          },
        };
      }
      return { ok: false, status: 404, async json() { return {}; } };
    };
    const out = await oa.enrichPaper({ arxivId: '1011.0686' }, { fetchFn });
    expect(out.source).toBe('openalex');
  });

  // Regression: OpenAlex enrichment used to omit `authors` from the persisted
  // blob, so the database.js startup backfill (which prefers ss.authors over a
  // broken Marker extraction) had nothing to repair from. Result: papers like
  // "Attention Is All You Need" rendered the Marker keyword tags ". Embeddings,
  // Softmax" instead of Vaswani et al. The enrichment must now carry the full
  // authorships list.
  it('persists authors from work.authorships so the routes/migration paths can repair Marker noise', async () => {
    const fetchFn = async (url) => {
      if (url.includes('works/https%3A%2F%2Farxiv.org')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              id: 'W1',
              display_name: 'Attention Is All You Need',
              authorships: [
                { author: { display_name: 'Ashish Vaswani' } },
                { author: { display_name: 'Noam Shazeer' } },
                { author: { display_name: 'Niki Parmar' } },
                { author: null },
                { author: { display_name: '' } },
              ],
              concepts: [],
              related_works: [],
            };
          },
        };
      }
      return { ok: false, status: 404, async json() { return {}; } };
    };
    const out = await oa.enrichPaper({ arxivId: '1706.03762' }, { fetchFn });
    expect(out.authors).toEqual(['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar']);
  });

  it('returns authors as an empty array when authorships are missing', async () => {
    const fetchFn = async (url) => {
      if (url.includes('works/https%3A%2F%2Farxiv.org')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { id: 'W2', display_name: 'X', concepts: [], related_works: [] };
          },
        };
      }
      return { ok: false, status: 404, async json() { return {}; } };
    };
    const out = await oa.enrichPaper({ arxivId: '1.1' }, { fetchFn });
    expect(out.authors).toEqual([]);
  });
});

describe('fetchSubfieldTopics', () => {
  it('queries /topics with subfield.id filter sorted by works_count', async () => {
    let seen;
    const fetchFn = async (url) => {
      seen = url;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            results: [
              { id: 'T100', display_name: 'Robot Manipulation' },
              { id: 'T101', display_name: 'Visuomotor Control' },
            ],
          };
        },
      };
    };
    const out = await oa.fetchSubfieldTopics('S456', 8, fetchFn);
    expect(seen).toMatch(/\/topics\?filter=subfield\.id%3AS456/);
    // OpenAlex accepts the colon literal in query strings; Node's
    // encodeURIComponent leaves it unencoded. Either form is valid.
    expect(seen).toMatch(/sort=works_count(?::|%3A)desc/);
    expect(seen).toMatch(/per-page=8/);
    expect(out).toEqual([
      { id: 'T100', display_name: 'Robot Manipulation' },
      { id: 'T101', display_name: 'Visuomotor Control' },
    ]);
  });

  it('accepts a full openalex.org URL form as the subfield id', async () => {
    let seen;
    const fetchFn = async (url) => {
      seen = url;
      return { ok: true, status: 200, async json() { return { results: [] }; } };
    };
    await oa.fetchSubfieldTopics('https://openalex.org/subfields/S456', 5, fetchFn);
    expect(seen).toMatch(/subfield\.id%3AS456/);
  });

  it('degrades to [] when OpenAlex returns non-OK or throws', async () => {
    const fetchFail = async () => ({ ok: false, status: 500, async json() { return {}; } });
    expect(await oa.fetchSubfieldTopics('S1', 5, fetchFail)).toEqual([]);
    const fetchThrow = async () => { throw new Error('boom'); };
    expect(await oa.fetchSubfieldTopics('S1', 5, fetchThrow)).toEqual([]);
  });

  it('returns [] without hitting the network for an empty subfield id', async () => {
    const fetchFn = jest.fn();
    expect(await oa.fetchSubfieldTopics(null, 5, fetchFn)).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('fetchSubfieldCount / fetchTopicCount (counter hints, I3)', () => {
  beforeEach(() => {
    // Caches persist between tests in the module — wipe so the
    // "uses cache on second call" assertion is isolated.
    oa.__resetCounterCaches();
  });

  it('fetchSubfieldCount returns meta.count for a field id', async () => {
    let seen;
    const fetchFn = async (url) => {
      seen = url;
      return {
        ok: true,
        status: 200,
        async json() {
          // OpenAlex /subfields response — only `meta.count` matters here.
          return { meta: { count: 14 }, results: [] };
        },
      };
    };
    const count = await oa.fetchSubfieldCount('F123', fetchFn);
    expect(count).toBe(14);
    expect(seen).toMatch(/\/subfields\?filter=field\.id%3AF123/);
    expect(seen).toMatch(/per-page=1/);
    expect(seen).toMatch(/mailto=/);
  });

  it('fetchTopicCount returns meta.count for a subfield id', async () => {
    let seen;
    const fetchFn = async (url) => {
      seen = url;
      return {
        ok: true,
        status: 200,
        async json() {
          return { meta: { count: 6 }, results: [] };
        },
      };
    };
    const count = await oa.fetchTopicCount('S456', fetchFn);
    expect(count).toBe(6);
    expect(seen).toMatch(/\/topics\?filter=subfield\.id%3AS456/);
    expect(seen).toMatch(/per-page=1/);
  });

  it('accepts the full openalex.org URL form for the id', async () => {
    let seen;
    const fetchFn = async (url) => {
      seen = url;
      return { ok: true, status: 200, async json() { return { meta: { count: 7 } }; } };
    };
    await oa.fetchSubfieldCount('https://openalex.org/fields/F1', fetchFn);
    // URL form should be normalised to the bare F-id in the filter.
    expect(seen).toMatch(/field\.id%3AF1/);
  });

  it('returns null on non-OK or thrown — never crashes the caller', async () => {
    const failFn = async () => ({ ok: false, status: 429, async json() { return {}; } });
    expect(await oa.fetchSubfieldCount('F1', failFn)).toBeNull();
    const throwFn = async () => { throw new Error('network blip'); };
    expect(await oa.fetchTopicCount('S1', throwFn)).toBeNull();
  });

  it('returns null for an empty/missing id without making a network call', async () => {
    const fetchFn = jest.fn();
    expect(await oa.fetchSubfieldCount(null, fetchFn)).toBeNull();
    expect(await oa.fetchTopicCount('', fetchFn)).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('caches the count so a second call does not hit the network', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      return { ok: true, status: 200, async json() { return { meta: { count: 14 } }; } };
    };
    expect(await oa.fetchSubfieldCount('F999', fetchFn)).toBe(14);
    expect(await oa.fetchSubfieldCount('F999', fetchFn)).toBe(14);
    expect(calls).toBe(1);
  });
});

describe('enrichPaper counter hints (I3)', () => {
  beforeEach(() => oa.__resetCounterCaches());

  it('propagates subfieldCount + topicCount + siblingCount into the fields shape', async () => {
    const fetchFn = async (url) => {
      if (url.includes('works/https%3A%2F%2Farxiv.org')) {
        return {
          ok: true, status: 200,
          async json() {
            return {
              id: 'W1',
              display_name: 'X',
              primary_topic: {
                display_name: 'Topic',
                subfield: { id: 'https://openalex.org/subfields/S1', display_name: 'Sub' },
                field: { id: 'https://openalex.org/fields/F1', display_name: 'Field' },
              },
              topics: [
                { display_name: 'Sib A' },
                { display_name: 'Sib B' },
                { display_name: 'Sib C' },
              ],
              related_works: [],
            };
          },
        };
      }
      if (url.includes('/subfields?filter=field.id')) {
        return { ok: true, status: 200, async json() { return { meta: { count: 14 } }; } };
      }
      // Counter call (no sort=) for topic-count; padding call (sort=works_count)
      // also matches this branch but we don't expect it to fire here because
      // the paper already has 3 siblings (≥ MIN_SIBLINGS_BEFORE_PADDING).
      if (url.includes('/topics?filter=subfield.id')) {
        return { ok: true, status: 200, async json() { return { meta: { count: 6 } }; } };
      }
      return { ok: false, status: 404, async json() { return {}; } };
    };
    const out = await oa.enrichPaper({ arxivId: '1.1' }, { fetchFn });
    expect(out.fields.subfieldCount).toBe(14);
    expect(out.fields.topicCount).toBe(6);
    // siblings = `all` minus the three canonical tier names. The shape has
    // 3 sibling topics ("Sib A/B/C") so siblingCount should equal 3.
    expect(out.fields.siblingCount).toBe(3);
  });

  it('omits subfieldCount/topicCount when the counter lookups 429 — still emits siblingCount', async () => {
    const fetchFn = async (url) => {
      if (url.includes('works/https%3A%2F%2Farxiv.org')) {
        return {
          ok: true, status: 200,
          async json() {
            return {
              id: 'W1', display_name: 'X',
              primary_topic: {
                display_name: 'T',
                subfield: { id: 'S1', display_name: 'Sub' },
                field: { id: 'F1', display_name: 'Fld' },
              },
              topics: [{ display_name: 'A' }],
              related_works: [],
            };
          },
        };
      }
      // Every counter / padding endpoint 429s. The padding endpoint
      // returning a non-OK is fine: padFieldHierarchyWithSubfield treats
      // [] as "no extras".
      return { ok: false, status: 429, async json() { return {}; } };
    };
    const out = await oa.enrichPaper({ arxivId: '1.1' }, { fetchFn });
    expect(out).not.toBeNull();
    expect(out.fields.subfieldCount).toBeUndefined();
    expect(out.fields.topicCount).toBeUndefined();
    // siblingCount is computed locally so it's always present even if the
    // network blew up — it's just 1 here (one Sib topic in `all`).
    expect(typeof out.fields.siblingCount).toBe('number');
  });

  it('fires the two counter lookups in parallel (single tick gap)', async () => {
    // Track the order events happen at. If we issued the calls sequentially
    // we'd see subfields-start → subfields-end → topics-start → topics-end.
    // In parallel both starts come before either end.
    const events = [];
    const fetchFn = async (url) => {
      if (url.includes('works/https%3A%2F%2Farxiv.org')) {
        return {
          ok: true, status: 200,
          async json() {
            return {
              id: 'W1', display_name: 'X',
              primary_topic: {
                display_name: 'T',
                subfield: { id: 'S1', display_name: 'Sub' },
                field: { id: 'F1', display_name: 'Fld' },
              },
              topics: [],
              related_works: [],
            };
          },
        };
      }
      if (url.includes('/subfields?filter=field.id')) {
        events.push('subfield-start');
        await new Promise((r) => setTimeout(r, 5));
        events.push('subfield-end');
        return { ok: true, status: 200, async json() { return { meta: { count: 1 } }; } };
      }
      // Padding (sort=works_count) returns [] so we don't get sucked into
      // that codepath; the bare counter URL has no sort= and matches the
      // count endpoint we care about.
      if (url.includes('/topics?filter=subfield.id') && !url.includes('sort=')) {
        events.push('topic-start');
        await new Promise((r) => setTimeout(r, 5));
        events.push('topic-end');
        return { ok: true, status: 200, async json() { return { meta: { count: 1 } }; } };
      }
      return { ok: false, status: 404, async json() { return {}; } };
    };
    await oa.enrichPaper({ arxivId: '1.1' }, { fetchFn });
    // Both starts come before either end — proves parallel issuance.
    const firstEnd = events.indexOf('subfield-end') < events.indexOf('topic-end')
      ? events.indexOf('subfield-end') : events.indexOf('topic-end');
    expect(events.indexOf('subfield-start')).toBeLessThan(firstEnd);
    expect(events.indexOf('topic-start')).toBeLessThan(firstEnd);
  });
});

describe('padFieldHierarchyWithSubfield', () => {
  it('appends extra topics until the chip strip hits the minimum (5)', () => {
    // Boltzmann-style paper: only 1 native sibling, mockup wants 5+.
    const fields = {
      field: 'Computer Science',
      subfield: 'Machine Learning',
      topic: 'Boltzmann Generators',
      all: ['Computer Science', 'Machine Learning', 'Boltzmann Generators', 'Normalizing Flows'],
    };
    const extras = [
      { id: 'T1', display_name: 'Generative Models' },
      { id: 'T2', display_name: 'Variational Inference' },
      { id: 'T3', display_name: 'Diffusion Models' },
      { id: 'T4', display_name: 'Sampling Methods' },
      // This 5th extra should also slot in — total sibling count target is
      // MAX_SIBLINGS=7, so we keep filling until either we run out or hit 7.
      { id: 'T5', display_name: 'Energy-Based Models' },
    ];
    const padded = oa.padFieldHierarchyWithSubfield(fields, extras);
    expect(padded.all).toContain('Normalizing Flows'); // original sibling kept
    expect(padded.all).toContain('Generative Models');
    expect(padded.all).toContain('Variational Inference');
    // Three canonical tiers always come first.
    expect(padded.all.slice(0, 3)).toEqual([
      'Computer Science', 'Machine Learning', 'Boltzmann Generators',
    ]);
    // Total chip count = 3 tiers + up to 7 siblings.
    expect(padded.all.length).toBeLessThanOrEqual(10);
  });

  it('does not duplicate a chip the paper already has', () => {
    const fields = {
      field: 'A', subfield: 'B', topic: 'C',
      all: ['A', 'B', 'C', 'Normalizing Flows'],
    };
    const extras = [
      { id: 'T1', display_name: 'Normalizing Flows' }, // duplicate
      { id: 'T2', display_name: 'New Topic' },
    ];
    const padded = oa.padFieldHierarchyWithSubfield(fields, extras);
    // Each display_name appears at most once.
    const counts = padded.all.reduce((m, n) => ({ ...m, [n]: (m[n] || 0) + 1 }), {});
    for (const n of Object.keys(counts)) expect(counts[n]).toBe(1);
    expect(padded.all).toContain('New Topic');
  });

  it('skips the padding pass when the paper already has >=5 siblings', () => {
    const fields = {
      field: 'F', subfield: 'S', topic: 'T',
      all: ['F', 'S', 'T', 's1', 's2', 's3', 's4', 's5'], // 5 siblings already
    };
    const extras = [{ id: 'T1', display_name: 'extra' }];
    const padded = oa.padFieldHierarchyWithSubfield(fields, extras);
    expect(padded.all).not.toContain('extra');
    expect(padded.all).toEqual(fields.all);
  });

  it('returns the fields unchanged when no extras are available', () => {
    const fields = { field: 'F', subfield: 'S', topic: 'T', all: ['F', 'S', 'T'] };
    expect(oa.padFieldHierarchyWithSubfield(fields, [])).toEqual(fields);
    expect(oa.padFieldHierarchyWithSubfield(fields, null)).toEqual(fields);
  });
});

describe('padFieldHierarchyWithSubfield noise filter (I2)', () => {
  // Realistic reproduction of the Boltzmann-Generators field map. OpenAlex's
  // AI subfield is poorly curated — the top-by-works_count topics include
  // cross-domain noise like "Geochemistry and Geologic Mapping" that has
  // nothing to do with a generative-models paper.
  //
  // The filter keeps padding topics whose content-words overlap with the
  // canonical tiers. With subfield "Artificial Intelligence" + topic
  // "Reinforcement Learning in Robotics", topics that mention any of
  // "artificial", "intelligence", "reinforcement", "learning", "robotics"
  // survive; the rest get dropped.
  const aiFields = {
    field: 'Computer Science',
    subfield: 'Artificial Intelligence',
    topic: 'Reinforcement Learning in Robotics',
    all: ['Computer Science', 'Artificial Intelligence', 'Reinforcement Learning in Robotics'],
  };

  it('drops "Geochemistry and Geologic Mapping" — no shared content-word', () => {
    // Need ≥5 filter-surviving topics or we'd fall through to the unfiltered
    // pad. Six "robotics" / "learning" matches + two pure-noise topics
    // exercises the noise-rejection path.
    const extras = [
      { id: 'T1', display_name: 'Educational Robotics and Engineering' },
      { id: 'T2', display_name: 'Reinforcement Learning and Applications' },
      { id: 'T3', display_name: 'Geochemistry and Geologic Mapping' },
      { id: 'T4', display_name: 'Computational Physics and Python Applications' },
      { id: 'T5', display_name: 'Machine Learning in Health Records' },
      { id: 'T6', display_name: 'Robotics Manipulation Research' },
      { id: 'T7', display_name: 'Robotics Path Planning' },
      { id: 'T8', display_name: 'Learning Theory Foundations' },
    ];
    const padded = oa.padFieldHierarchyWithSubfield(aiFields, extras);
    expect(padded.all).not.toContain('Geochemistry and Geologic Mapping');
    expect(padded.all).not.toContain('Computational Physics and Python Applications');
    expect(padded.paddingFiltered).toBe(true);
  });

  it('keeps "Educational Robotics and Engineering" — shares "Robotics"', () => {
    const extras = [
      { id: 'T1', display_name: 'Educational Robotics and Engineering' },
      { id: 'T2', display_name: 'Reinforcement Learning and Applications' },
      { id: 'T3', display_name: 'Machine Learning in Health Records' },
      { id: 'T4', display_name: 'Robotics Manipulation Research' },
      { id: 'T5', display_name: 'Learning Optimization Methods' },
      { id: 'T6', display_name: 'Geochemistry and Geologic Mapping' },
    ];
    const padded = oa.padFieldHierarchyWithSubfield(aiFields, extras);
    expect(padded.all).toContain('Educational Robotics and Engineering');
    expect(padded.all).toContain('Reinforcement Learning and Applications');
    expect(padded.paddingFiltered).toBe(true);
  });

  it('falls back to unfiltered pad when too few topics survive the filter', () => {
    // Only one extra would survive ("Robotics Manipulation Research"); below
    // the MIN_SIBLINGS_BEFORE_PADDING (5) threshold → fall back to unfiltered
    // so the UI isn't anemic, but flag `paddingFiltered: false` so callers
    // can tell.
    const extras = [
      { id: 'T1', display_name: 'Robotics Manipulation Research' },
      { id: 'T2', display_name: 'Geochemistry and Geologic Mapping' },
      { id: 'T3', display_name: 'Computational Physics and Python Applications' },
      { id: 'T4', display_name: 'Coastal Erosion Studies' },
      { id: 'T5', display_name: 'Forest Soil Properties' },
    ];
    const padded = oa.padFieldHierarchyWithSubfield(aiFields, extras);
    expect(padded.paddingFiltered).toBe(false);
    // Noisy topics make it back in via the fallback so the chip strip stays
    // populated rather than dropping to 1 sibling.
    expect(padded.all).toContain('Geochemistry and Geologic Mapping');
  });
});

describe('applyFieldOverrides (I1)', () => {
  const decisionSciences = {
    field: 'Decision Sciences',
    subfield: 'Management Science and Operations Research',
    topic: 'Advanced Bandit Algorithms Research',
    all: [
      'Decision Sciences',
      'Management Science and Operations Research',
      'Advanced Bandit Algorithms Research',
    ],
  };

  it('returns input untouched when nothing triggers an override', () => {
    const out = oa.applyFieldOverrides(decisionSciences, {});
    expect(out).toEqual(decisionSciences);
    expect(out.fieldOverrideSource).toBeUndefined();
  });

  it('SS s2FieldsOfStudy upgrades generic OpenAlex field to Computer Science', () => {
    const s2 = [
      { category: 'Computer Science', source: 's2-fos-model', score: 0.95 },
      { category: 'Machine Learning', source: 's2-fos-model', score: 0.88 },
    ];
    const out = oa.applyFieldOverrides(decisionSciences, { s2Fields: s2 });
    expect(out.field).toBe('Computer Science');
    // SS exposed a more specific category — overlay onto subfield.
    expect(out.subfield).toBe('Machine Learning');
    expect(out.fieldOverrideSource).toBe('s2');
    // Original topic preserved.
    expect(out.topic).toBe('Advanced Bandit Algorithms Research');
    // First three chips reflect the override.
    expect(out.all.slice(0, 3)).toEqual([
      'Computer Science',
      'Machine Learning',
      'Advanced Bandit Algorithms Research',
    ]);
  });

  it('does NOT trigger SS override when OpenAlex field is already specific', () => {
    const robotics = {
      field: 'Robotics',
      subfield: 'Imitation Learning',
      topic: 'Robot Learning and Control',
      all: ['Robotics', 'Imitation Learning', 'Robot Learning and Control'],
    };
    const s2 = [{ category: 'Computer Science', score: 0.99 }];
    const out = oa.applyFieldOverrides(robotics, { s2Fields: s2 });
    // No change: OpenAlex's "Robotics" is more granular than SS's "CS".
    expect(out.field).toBe('Robotics');
    expect(out.fieldOverrideSource).toBeUndefined();
  });

  it('venue override forces CS/AI even when OpenAlex picked a specific (wrong) field', () => {
    // Even a non-generic field gets steamrolled when a known CS venue is in
    // play — the venue is a ground-truth signal that beats topic clustering.
    const robotics = {
      field: 'Robotics',
      subfield: 'Imitation Learning',
      topic: 'Robot Learning and Control',
      all: ['Robotics', 'Imitation Learning', 'Robot Learning and Control'],
    };
    const out = oa.applyFieldOverrides(robotics, { venueName: 'AISTATS' });
    expect(out.field).toBe('Computer Science');
    expect(out.subfield).toBe('Artificial Intelligence');
    expect(out.fieldOverrideSource).toBe('venue');
  });

  it('venue override beats SS override when both signals fire', () => {
    const s2 = [{ category: 'Computer Science', score: 0.9 }, { category: 'Mathematics', score: 0.6 }];
    const out = oa.applyFieldOverrides(decisionSciences, {
      venueName: 'Proceedings of the 14th International Conference on AISTATS',
      s2Fields: s2,
    });
    expect(out.fieldOverrideSource).toBe('venue');
    expect(out.subfield).toBe('Artificial Intelligence');
  });

  it('matches venue acronyms by word-boundary (avoids "Practical" matching "ACL")', () => {
    expect(oa.isCsVenue('Practical Reinforcement Learning')).toBe(false);
    expect(oa.isCsVenue('Proceedings of ACL 2023')).toBe(true);
    expect(oa.isCsVenue('NeurIPS Workshop on Robot Learning')).toBe(true);
    expect(oa.isCsVenue(null)).toBe(false);
  });

  it('ignores low-confidence SS categories below the 0.5 floor', () => {
    const s2 = [
      { category: 'Computer Science', score: 0.2 }, // below floor → ignored
      { category: 'Geodesy', score: 0.95 },
    ];
    const out = oa.applyFieldOverrides(decisionSciences, { s2Fields: s2 });
    // No "Computer Science" tag above floor → no override.
    expect(out.field).toBe('Decision Sciences');
  });
});

describe('enrichPaper field-override integration (I1)', () => {
  it('venue=AISTATS forces CS/AI regardless of OpenAlex primary_topic', async () => {
    // DAgger-style: OpenAlex's primary_topic is "Bandit Algorithms" →
    // "Decision Sciences"; venue "AISTATS" should override.
    const fetchFn = async (url) => {
      if (url.includes('works/https%3A%2F%2Farxiv.org')) {
        return {
          ok: true, status: 200,
          async json() {
            return {
              id: 'https://openalex.org/W1931877416',
              display_name: 'A Reduction of Imitation Learning and Structured Prediction',
              primary_topic: {
                display_name: 'Advanced Bandit Algorithms Research',
                subfield: { id: 'S111', display_name: 'Management Science and Operations Research' },
                field: { display_name: 'Decision Sciences' },
              },
              primary_location: {
                source: { display_name: 'Proceedings of AISTATS' },
              },
              topics: [],
              related_works: [],
            };
          },
        };
      }
      return { ok: false, status: 404, async json() { return {}; } };
    };
    const out = await oa.enrichPaper(
      { title: 'DAgger', arxivId: '1011.0686' },
      { fetchFn },
    );
    expect(out).not.toBeNull();
    expect(out.fields.field).toBe('Computer Science');
    expect(out.fields.subfield).toBe('Artificial Intelligence');
    expect(out.fields.fieldOverrideSource).toBe('venue');
  });

  it('lazy-fetches SS s2FieldsOfStudy only when OpenAlex field is generic', async () => {
    // Generic field ("Decision Sciences") + no CS venue → SS lookup fires.
    let ssCalled = false;
    const fetchFn = async (url) => {
      if (url.includes('works/https%3A%2F%2Farxiv.org') && url.includes('2222')) {
        return {
          ok: true, status: 200,
          async json() {
            return {
              id: 'W42',
              display_name: 'Some bandit paper',
              primary_topic: {
                display_name: 'Bandits',
                subfield: { id: 'S1', display_name: 'Operations Research' },
                field: { display_name: 'Decision Sciences' },
              },
              primary_location: { source: { display_name: 'Some journal' } },
              topics: [],
              related_works: [],
            };
          },
        };
      }
      // Semantic Scholar arXiv lookup — pretend the paper is in CS/ML.
      // (The arXiv id colon is URL-encoded to %3A by the SS helper, so we
      // match on the host substring rather than the prefixed id form.)
      if (url.includes('semanticscholar.org')) {
        ssCalled = true;
        return {
          ok: true, status: 200,
          headers: { get: () => null },
          async json() {
            return {
              paperId: 'ss-42',
              title: 'Some bandit paper',
              s2FieldsOfStudy: [
                { category: 'Computer Science', score: 0.97 },
                { category: 'Machine Learning', score: 0.88 },
              ],
            };
          },
        };
      }
      return { ok: false, status: 404, headers: { get: () => null }, async json() { return {}; } };
    };
    const out = await oa.enrichPaper({ title: 't', arxivId: '2222' }, { fetchFn });
    expect(ssCalled).toBe(true);
    expect(out.fields.field).toBe('Computer Science');
    expect(out.fields.subfield).toBe('Machine Learning');
    expect(out.fields.fieldOverrideSource).toBe('s2');
  });

  it('skips SS lookup when OpenAlex field is already specific (no extra round-trip)', async () => {
    let ssCalled = false;
    const fetchFn = async (url) => {
      if (url.includes('works/https%3A%2F%2Farxiv.org')) {
        return {
          ok: true, status: 200,
          async json() {
            return {
              id: 'W1',
              display_name: 'Robotics paper',
              primary_topic: {
                display_name: 'Robot Learning',
                subfield: { id: 'S1', display_name: 'Imitation Learning' },
                field: { display_name: 'Robotics' },
              },
              topics: [], related_works: [],
            };
          },
        };
      }
      if (url.includes('semanticscholar.org')) {
        ssCalled = true;
        return { ok: true, status: 200, headers: { get: () => null }, async json() { return {}; } };
      }
      return { ok: false, status: 404, headers: { get: () => null }, async json() { return {}; } };
    };
    const out = await oa.enrichPaper({ arxivId: '1.1' }, { fetchFn });
    expect(out.fields.field).toBe('Robotics');
    expect(ssCalled).toBe(false);
  });
});

describe('fetchReferences (batched references resolver)', () => {
  it('shapes resolved works into reference rows preserving citation order', async () => {
    const fetchFn = async (url) => {
      expect(url).toMatch(/filter=ids\.openalex%3AW1%7CW2/);
      return {
        ok: true,
        status: 200,
        async json() {
          // Note: returned in opposite order — fetchReferences must re-order
          // to match the input citation order (W1, W2).
          return {
            results: [
              {
                id: 'https://openalex.org/W2',
                display_name: 'Second Cited',
                publication_year: 2020,
                doi: 'https://doi.org/10.1/two',
                authorships: [{ author: { display_name: 'Bob' } }],
              },
              {
                id: 'https://openalex.org/W1',
                display_name: 'First Cited',
                publication_year: 2018,
                doi: 'https://doi.org/10.1/ONE',
                authorships: [{ author: { display_name: 'Alice' } }],
              },
            ],
          };
        },
      };
    };
    const refs = await oa.fetchReferences(
      ['https://openalex.org/W1', 'https://openalex.org/W2'],
      fetchFn,
    );
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({
      id: 'https://openalex.org/W1',
      title: 'First Cited',
      year: 2018,
      doi: '10.1/one', // normalised lowercase, bare slug
      authors: ['Alice'],
    });
    expect(refs[1].id).toBe('https://openalex.org/W2');
  });

  it('keeps the citation count and the venue OpenAlex already sent', async () => {
    // Measured over the stored corpus 2026-08-12: 33 references carried an
    // OpenAlex id and NO citation count, and not one carried a venue — while
    // both sat in the very response we had just parsed. The card then showed
    // an empty fold for a work OpenAlex knows everything about.
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          results: [
            {
              id: 'https://openalex.org/W1',
              display_name: 'Attention Is All You Need',
              publication_year: 2017,
              cited_by_count: 143_000,
              primary_location: { source: { display_name: 'Neural Information Processing Systems' } },
              authorships: [{ author: { display_name: 'Ashish Vaswani' } }],
            },
          ],
        };
      },
    });

    const [ref] = await oa.fetchReferences(['W1'], fetchFn);

    expect(ref).toMatchObject({
      citations: 143_000,
      venue: 'Neural Information Processing Systems',
    });
  });

  it('returns [] when given no references', async () => {
    const fetchFn = jest.fn();
    expect(await oa.fetchReferences([], fetchFn)).toEqual([]);
    expect(await oa.fetchReferences(null, fetchFn)).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('batches calls when there are more than 50 references', async () => {
    const seen = [];
    const fetchFn = async (url) => {
      seen.push(url);
      // Echo back a single placeholder result so the function has something
      // to merge — we're really just asserting batching behaviour.
      return {
        ok: true,
        status: 200,
        async json() { return { results: [] }; },
      };
    };
    const ids = Array.from({ length: 75 }, (_, i) => `W${i + 1}`);
    await oa.fetchReferences(ids, fetchFn);
    expect(seen).toHaveLength(2); // 50 + 25
    expect(seen[0]).toMatch(/per-page=50/);
    expect(seen[1]).toMatch(/per-page=25/);
  });

  it('degrades to a partial list when one batch fails', async () => {
    let batch = 0;
    const fetchFn = async (url) => {
      batch += 1;
      if (batch === 1) {
        // First batch succeeds.
        return {
          ok: true, status: 200,
          async json() { return { results: [{ id: 'W1', display_name: 'OK' }] }; },
        };
      }
      // Second batch fails.
      return { ok: false, status: 502, async json() { return {}; } };
    };
    const ids = Array.from({ length: 60 }, (_, i) => `W${i + 1}`);
    const out = await oa.fetchReferences(ids, fetchFn);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('W1');
  });
});

describe('enrichPaper subfield-topic padding integration', () => {
  it('pads a sparse Field Map with subfield topics so siblings hit the minimum', async () => {
    // Simulate a paper like "Boltzmann generators" that has very few native
    // `topics[]` entries — the resolver should reach out to /topics and pad.
    const fetchFn = async (url) => {
      if (url.includes('works/https%3A%2F%2Farxiv.org')) {
        return {
          ok: true, status: 200,
          async json() {
            return {
              id: 'https://openalex.org/WBolt',
              display_name: 'Boltzmann Generators',
              primary_topic: {
                display_name: 'Boltzmann Generators',
                subfield: { id: 'https://openalex.org/subfields/S123', display_name: 'Machine Learning' },
                field: { display_name: 'Computer Science' },
              },
              topics: [
                { display_name: 'Boltzmann Generators' }, // dup of primary
                { display_name: 'Normalizing Flows' }, // only 1 real sibling
              ],
              related_works: [],
            };
          },
        };
      }
      if (url.includes('/topics?filter=subfield')) {
        return {
          ok: true, status: 200,
          async json() {
            return {
              results: [
                { id: 'T1', display_name: 'Generative Models' },
                { id: 'T2', display_name: 'Variational Inference' },
                { id: 'T3', display_name: 'Diffusion Models' },
                { id: 'T4', display_name: 'Sampling Methods' },
              ],
            };
          },
        };
      }
      return { ok: false, status: 404, async json() { return {}; } };
    };
    const out = await oa.enrichPaper(
      { title: 'Boltzmann Generators', arxivId: '1812.01729' },
      { fetchFn },
    );
    expect(out).not.toBeNull();
    // Padded — sibling chip strip now includes generative-models siblings.
    expect(out.fields.all).toContain('Generative Models');
    expect(out.fields.all).toContain('Diffusion Models');
    // Original 1-sibling content preserved.
    expect(out.fields.all).toContain('Normalizing Flows');
    // Canonical tiers first.
    expect(out.fields.all.slice(0, 3)).toEqual([
      'Computer Science', 'Machine Learning', 'Boltzmann Generators',
    ]);
  });

  it('does NOT trigger the padding call when the paper already has enough siblings', async () => {
    let topicCallCount = 0;
    const fetchFn = async (url) => {
      // The padding endpoint is the sorted /topics query (sort=works_count).
      // The counter endpoint hits the same /topics resource but without
      // sort=, so we narrow the match to the padding variant.
      if (url.includes('/topics?filter=subfield') && url.includes('sort=works_count')) {
        topicCallCount += 1;
        return { ok: true, status: 200, async json() { return { results: [] }; } };
      }
      if (url.includes('works/https%3A%2F%2Farxiv.org')) {
        return {
          ok: true, status: 200,
          async json() {
            return {
              id: 'W1',
              display_name: 'Rich paper',
              primary_topic: {
                display_name: 'Topic',
                subfield: { id: 'S1', display_name: 'Sub' },
                field: { display_name: 'Field' },
              },
              topics: Array.from({ length: 6 }, (_, i) => ({ display_name: `T${i}` })),
              related_works: [],
            };
          },
        };
      }
      return { ok: false, status: 404, async json() { return {}; } };
    };
    await oa.enrichPaper({ arxivId: '1.1' }, { fetchFn });
    expect(topicCallCount).toBe(0);
  });
});

describe('shapeSearchResult', () => {
  // Realistic-ish work object — mirrors what OpenAlex returns for the
  // Dec-MCTS paper (journal-only, has OA via Sage). Shape covers every
  // field the SearchResult contract needs.
  const decMcts = {
    id: 'https://openalex.org/W2741809807',
    display_name: 'Dec-MCTS: Decentralized planning for multi-robot active perception',
    publication_year: 2018,
    cited_by_count: 256,
    doi: 'https://doi.org/10.1177/0278364918755924',
    authorships: [
      { author: { display_name: 'Graeme Best' } },
      { author: { display_name: 'Oliver M. Cliff' } },
    ],
    open_access: { is_oa: true, oa_url: 'https://journals.sagepub.com/doi/pdf/10.1177/0278364918755924' },
    best_oa_location: { pdf_url: 'https://journals.sagepub.com/doi/pdf/10.1177/0278364918755924' },
    abstract_inverted_index: { Dec: [0], MCTS: [1], paper: [2] },
  };

  it('maps the canonical fields of a journal paper', () => {
    const out = oa.shapeSearchResult(decMcts);
    expect(out.id).toBe('https://openalex.org/W2741809807');
    expect(out.title).toContain('Dec-MCTS');
    expect(out.authors).toEqual(['Graeme Best', 'Oliver M. Cliff']);
    expect(out.year).toBe(2018);
    expect(out.citations).toBe(256);
    expect(out.open_access_pdf_url).toContain('sagepub');
    expect(out.abstract).toBe('Dec MCTS paper');
  });

  it('normalizes DOI to lowercase bare slug for cross-backend dedup', () => {
    const out = oa.shapeSearchResult(decMcts);
    // No https://doi.org/ prefix, lowercased.
    expect(out.doi).toBe('10.1177/0278364918755924');
  });

  it('falls back to primary_location.pdf_url then open_access.oa_url', () => {
    const noBest = { ...decMcts, best_oa_location: null, primary_location: { pdf_url: 'https://primary/p.pdf' } };
    expect(oa.shapeSearchResult(noBest).open_access_pdf_url).toBe('https://primary/p.pdf');

    const onlyOa = { ...decMcts, best_oa_location: null, primary_location: null };
    expect(oa.shapeSearchResult(onlyOa).open_access_pdf_url).toContain('sagepub');
  });

  it('returns nulls/zeros for missing optional fields rather than undefined', () => {
    const stripped = { id: 'W1', display_name: 'Some title' };
    const out = oa.shapeSearchResult(stripped);
    expect(out.authors).toEqual([]);
    expect(out.year).toBeNull();
    expect(out.citations).toBe(0);
    expect(out.open_access_pdf_url).toBeNull();
    expect(out.abstract).toBeNull();
    expect(out.doi).toBeNull();
  });
});

describe('searchPapers', () => {
  it('returns empty results without hitting the network on an empty query', async () => {
    const fetchFn = jest.fn();
    const out = await oa.searchPapers('', 5, fetchFn);
    expect(out).toEqual({ results: [], rate_limited: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('forwards the query to /works?search=... and maps each hit', async () => {
    const fetchFn = jest.fn(async (url) => {
      expect(url).toContain('search=Dec-MCTS');
      expect(url).toContain('per-page=20');
      // Polite-pool opt-in must always be present.
      expect(url).toContain('mailto=');
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            results: [
              {
                id: 'https://openalex.org/W2741809807',
                display_name: 'Dec-MCTS: Decentralized planning',
                publication_year: 2018, cited_by_count: 200,
                doi: 'https://doi.org/10.1177/0278364918755924',
                authorships: [{ author: { display_name: 'Best' } }],
                open_access: { is_oa: true, oa_url: 'https://sage/p.pdf' },
              },
            ],
          };
        },
      };
    });
    const out = await oa.searchPapers('Dec-MCTS', 20, fetchFn);
    expect(out.rate_limited).toBe(false);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({
      title: 'Dec-MCTS: Decentralized planning',
      year: 2018,
      doi: '10.1177/0278364918755924',
    });
  });

  it('drops hits with no title (defensive)', async () => {
    const fetchFn = async () => ({
      ok: true, status: 200,
      async json() {
        return {
          results: [
            { id: 'W1', display_name: null },
            { id: 'W2', display_name: 'Has title' },
          ],
        };
      },
    });
    const out = await oa.searchPapers('foo', 5, fetchFn);
    expect(out.results).toHaveLength(1);
    expect(out.results[0].title).toBe('Has title');
  });

  it('throws on a non-OK response so the route falls back to arXiv-only', async () => {
    const fetchFn = async () => ({ ok: false, status: 503, async json() { return {}; } });
    await expect(oa.searchPapers('foo', 5, fetchFn)).rejects.toThrow(/503/);
  });
});
