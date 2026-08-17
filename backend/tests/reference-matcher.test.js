/**
 * tests/reference-matcher.test.js
 *
 * Unit tests for reference-matcher.js — pairing the reference rows read out
 * of a PDF with the canonical works OpenAlex lists in `referenced_works[]`.
 *
 * This is where precision lives. `pdf-citations.js` deliberately returns
 * slightly dirty rows (a neighbouring author list, a figure caption bleeding
 * in); the matcher has to see through that, because it only ever compares
 * against the ~40 works the paper actually cites.
 */

const { matchReferences } = require('../reference-matcher');

// A slice of the real Attention Is All You Need bibliography.
const CANDIDATES = [
  { id: 'W1', title: 'Layer Normalization', authors: ['Jimmy Lei Ba', 'Jamie Ryan Kiros', 'Geoffrey E. Hinton'], year: 2016, doi: null },
  { id: 'W2', title: 'Neural Machine Translation by Jointly Learning to Align and Translate', authors: ['Dzmitry Bahdanau', 'Kyunghyun Cho', 'Yoshua Bengio'], year: 2014, doi: null },
  { id: 'W3', title: 'Long Short-Term Memory', authors: ['Sepp Hochreiter', 'Jürgen Schmidhuber'], year: 1997, doi: '10.1162/neco.1997.9.8.1735' },
];

describe('matchReferences', () => {
  it('pairs a printed row with the work it names', async () => {
    const rows = [
      {
        anchor: 'cite.layernorm2016',
        rawText: '[1] Jimmy Lei Ba, Jamie Ryan Kiros, and Geoffrey E Hinton. Layer normalization. arXiv preprint arXiv:1607.06450, 2016.',
      },
    ];

    const matched = matchReferences(rows, CANDIDATES);

    expect(matched).toHaveLength(1);
    expect(matched[0].anchor).toBe('cite.layernorm2016');
    expect(matched[0].work).toMatchObject({ id: 'W1', title: 'Layer Normalization' });
  });

  it('never hands the same work to two rows', async () => {
    // A dirty row can drag the neighbouring reference in with it, so two rows
    // may point at the same best candidate. One printed row is one work — the
    // stronger row keeps it, the weaker one must look elsewhere or stay
    // unresolved, otherwise a real reference silently disappears.
    const rows = [
      {
        anchor: 'cite.a',
        rawText: '[1] Jimmy Lei Ba, Jamie Ryan Kiros, and Geoffrey E Hinton. Layer normalization. 2016.',
      },
      {
        anchor: 'cite.b',
        // Bleed: the tail of row 1 got glued onto row 2.
        rawText: 'Layer normalization. 2016. [2] Sepp Hochreiter and Jürgen Schmidhuber. Long short-term memory. Neural Computation, 1997.',
      },
    ];

    const matched = matchReferences(rows, CANDIDATES);

    expect(matched[0].work.id).toBe('W1');
    expect(matched[1].work.id).toBe('W3');
  });

  it('reads an arXiv id out of the printed row', async () => {
    // OpenAlex knows only 28 of this paper's 40 references — "Layer
    // Normalization" is missing from `referenced_works` entirely. But the row
    // prints "arXiv:1607.06450", an exact identifier that needs no lookup and
    // is enough to open the paper in both doors.
    const rows = [
      {
        anchor: 'cite.layernorm2016',
        rawText: '[1] Jimmy Lei Ba, Jamie Ryan Kiros, and Geoffrey E Hinton. Layer normalization. arXiv preprint arXiv:1607.06450, 2016.',
      },
    ];

    const matched = matchReferences(rows, []);

    expect(matched[0].work).toBeNull();
    expect(matched[0].arxivId).toBe('1607.06450');
  });

  it('reads the "abs/1409.0473" form of an arXiv id', async () => {
    // Older bibliographies cite preprints as "CoRR, abs/1409.0473" — the same
    // identifier, spelled differently. Without it the reference looked
    // unopenable although its PDF is one URL away (user report 2026-08-09).
    const rows = [
      {
        anchor: 'cite.bahdanau',
        rawText: '[2] D. Bahdanau, K. Cho, Y. Bengio. Neural machine translation by jointly learning to align and translate. CoRR, abs/1409.0473, 2014.',
      },
    ];

    const matched = matchReferences(rows, []);

    expect(matched[0].arxivId).toBe('1409.0473');
  });

  it('reads a DOI out of the printed row', async () => {
    const rows = [
      {
        anchor: 'cite.lstm',
        rawText: '[13] S. Hochreiter and J. Schmidhuber. Long short-term memory. Neural Computation, 9(8):1735–1780, 1997. doi:10.1162/neco.1997.9.8.1735.',
      },
    ];

    const matched = matchReferences(rows, []);

    expect(matched[0].doi).toBe('10.1162/neco.1997.9.8.1735');
  });

  it('leaves a row unresolved when no work fits', async () => {
    const rows = [
      {
        anchor: 'cite.ghost',
        rawText: '[9] R. Sennrich, B. Haddow, A. Birch. Improving neural machine translation models with monolingual data. Technical report, 2015.',
      },
    ];

    const matched = matchReferences(rows, CANDIDATES);

    expect(matched[0].work).toBeNull();
    expect(matched[0].rawText).toContain('Sennrich');
  });
});
