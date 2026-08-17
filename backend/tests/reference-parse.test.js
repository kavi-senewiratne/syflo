/**
 * tests/reference-parse.test.js
 *
 * Unit tests for reference-parse.js — pulling authors, title, venue and year
 * out of a bibliography row as it is printed.
 *
 * Why this exists: OpenAlex lists only ~70 % of a paper's references, and a
 * row it does not know fell back to showing the raw line — a wall of text
 * where every other card shows a title and one meta line (user report,
 * screenshot 2026-08-09). Bibliographies follow a small number of shapes, so
 * the row can be parsed well enough to fill the same layout.
 */

const { parseReferenceRow } = require('../reference-parse');

const { toTitleCase } = require('../reference-parse');

describe('toTitleCase', () => {
  // Bibliographies print titles in sentence case; OpenAlex stores them in
  // title case. Side by side in the same card list that looked inconsistent
  // (user report 2026-08-09), so a parsed title is raised to match.
  it('capitalises the words that carry meaning', () => {
    expect(toTitleCase('A decomposable attention model')).toBe('A Decomposable Attention Model');
  });

  it('keeps small words small — but never the first or the last', () => {
    expect(toTitleCase('Neural machine translation by jointly learning to align and translate'))
      .toBe('Neural Machine Translation by Jointly Learning to Align and Translate');
    expect(toTitleCase('What is it for')).toBe('What Is It For');
  });

  it('starts fresh after a colon', () => {
    expect(toTitleCase('Outrageously large neural networks: the sparsely-gated layer'))
      .toBe('Outrageously Large Neural Networks: The Sparsely-Gated Layer');
  });

  it('leaves acronyms and names that already carry capitals alone', () => {
    expect(toTitleCase('Improving NMT models with monolingual data'))
      .toBe('Improving NMT Models With Monolingual Data');
    expect(toTitleCase('Xception: deep learning with depthwise separable convolutions'))
      .toBe('Xception: Deep Learning With Depthwise Separable Convolutions');
    expect(toTitleCase('BERT and GPT-4 compared')).toBe('BERT and GPT-4 Compared');
  });

  it('restores acronyms a bibliography printed in lowercase', () => {
    // "Learning phrase representations using rnn encoder-decoder" became
    // "Using Rnn Encoder-Decoder", which reads as a typo (user report
    // 2026-08-09).
    expect(toTitleCase('Learning phrase representations using rnn encoder-decoder'))
      .toBe('Learning Phrase Representations Using RNN Encoder-Decoder');
    expect(toTitleCase('A cnn for sentence classification'))
      .toBe('A CNN for Sentence Classification');
  });

  it('capitalises both halves of a hyphenated word', () => {
    expect(toTitleCase('Long short-term memory')).toBe('Long Short-Term Memory');
  });

  it('leaves a title that is already in title case untouched', () => {
    expect(toTitleCase('Attention Is All You Need')).toBe('Attention Is All You Need');
  });
});

describe('parseReferenceRow', () => {
  it('splits the classic "authors. title. In venue, year." shape', () => {
    const parsed = parseReferenceRow(
      '[27] Ankur Parikh, Oscar Täckström, Dipanjan Das, and Jakob Uszkoreit. A decomposable attention model. In Empirical Methods in Natural Language Processing, 2016.',
    );

    expect(parsed.title).toBe('A Decomposable Attention Model');
    expect(parsed.authors).toEqual([
      'Ankur Parikh',
      'Oscar Täckström',
      'Dipanjan Das',
      'Jakob Uszkoreit',
    ]);
    expect(parsed.venue).toBe('Empirical Methods in Natural Language Processing');
    expect(parsed.year).toBe(2016);
  });

  it('does not mistake an initial for the end of the author list', () => {
    // "M.-T." and "H." end in a period but continue the same segment.
    const parsed = parseReferenceRow(
      '[24] M.-T. Luong, H. Pham, and C. Manning. Effective approaches to attention-based neural machine translation. arXiv:1508.04025, 2015.',
    );

    expect(parsed.authors).toEqual(['M.-T. Luong', 'H. Pham', 'C. Manning']);
    expect(parsed.title).toBe('Effective Approaches to Attention-Based Neural Machine Translation');
    expect(parsed.year).toBe(2015);
  });

  it('handles an arXiv preprint row with no venue', () => {
    const parsed = parseReferenceRow(
      '[1] Jimmy Lei Ba, Jamie Ryan Kiros, and Geoffrey E Hinton. Layer normalization. arXiv preprint arXiv:1607.06450, 2016.',
    );

    expect(parsed.title).toBe('Layer Normalization');
    expect(parsed.authors).toEqual(['Jimmy Lei Ba', 'Jamie Ryan Kiros', 'Geoffrey E Hinton']);
    expect(parsed.year).toBe(2016);
  });

  it('keeps "et al." inside the author segment', () => {
    const parsed = parseReferenceRow(
      '[9] Yonghui Wu et al. Google\'s neural machine translation system. CoRR, abs/1609.08144, 2016.',
    );

    expect(parsed.authors).toEqual(['Yonghui Wu et al.']);
    expect(parsed.title).toBe("Google's Neural Machine Translation System");
    expect(parsed.year).toBe(2016);
  });

  it('reads a journal row with volume and pages', () => {
    const parsed = parseReferenceRow(
      '[13] Sepp Hochreiter and Jürgen Schmidhuber. Long short-term memory. Neural Computation, 9(8):1735–1780, 1997.',
    );

    expect(parsed.authors).toEqual(['Sepp Hochreiter', 'Jürgen Schmidhuber']);
    expect(parsed.title).toBe('Long Short-Term Memory');
    expect(parsed.venue).toBe('Neural Computation');
    expect(parsed.year).toBe(1997);
  });

  it('ends a title at a question mark, not only at a period', () => {
    // Real miss: "[16] Łukasz Kaiser and Samy Bengio. Can active memory
    // replace attention? In NeurIPS, 2016." was the one row of Attention that
    // came out with no title at all.
    const parsed = parseReferenceRow(
      '[16] Łukasz Kaiser and Samy Bengio. Can active memory replace attention? In Advances in Neural Information Processing Systems, 2016.',
    );

    expect(parsed.title).toBe('Can Active Memory Replace Attention?');
    expect(parsed.authors).toEqual(['Łukasz Kaiser', 'Samy Bengio']);
    expect(parsed.year).toBe(2016);
  });

  it('recognises a single author written with initials', () => {
    // "S. Hochreiter. Long short-term memory." parsed to nothing: the
    // single-name pattern expected lowercase letters right after the first
    // capital, so an initial fell through (found 2026-08-09).
    const parsed = parseReferenceRow('S. Hochreiter. Long short-term memory. Neural Computation, 1997.');

    expect(parsed.authors).toEqual(['S. Hochreiter']);
    expect(parsed.title).toBe('Long Short-Term Memory');
  });

  it('title-cases the venue too', () => {
    // "Neural computation" showed up beside "Long Short-Term Memory" in the
    // running app — the title was raised, the venue was not (verified
    // 2026-08-09).
    const parsed = parseReferenceRow(
      '[13] Sepp Hochreiter and Jürgen Schmidhuber. Long short-term memory. Neural computation, 9(8):1735–1780, 1997.',
    );

    expect(parsed.venue).toBe('Neural Computation');
  });

  it('strips page numbers off the venue', () => {
    // "Advances in Neural Information Processing Systems, pages 3104–3112"
    // is a venue with bookkeeping stuck to it — the page range belongs to the
    // printed row, not on a card (user report 2026-08-09).
    const parsed = parseReferenceRow(
      '[36] Ilya Sutskever, Oriol Vinyals, and Quoc V. Le. Sequence to sequence learning with neural networks. In Advances in Neural Information Processing Systems, pages 3104–3112, 2014.',
    );

    expect(parsed.venue).toBe('Advances in Neural Information Processing Systems');
    expect(parsed.title).toBe('Sequence to Sequence Learning With Neural Networks');
    expect(parsed.year).toBe(2014);
  });

  it('gives back nothing it cannot see, rather than guessing', () => {
    // A row that survived extraction as a fragment. Better an honest null
    // than a title invented from half a sentence.
    const parsed = parseReferenceRow('Springer, 2016. 1');

    expect(parsed.title).toBeNull();
    expect(parsed.authors).toEqual([]);
    expect(parsed.year).toBe(2016);
  });

  it('survives an empty or missing row', () => {
    expect(parseReferenceRow('')).toEqual({ authors: [], title: null, venue: null, year: null });
    expect(parseReferenceRow(null)).toEqual({ authors: [], title: null, venue: null, year: null });
  });
});
