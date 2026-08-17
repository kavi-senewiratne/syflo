/**
 * mathAwareText.test.ts
 *
 * A PDF stores no math — only glyphs with coordinates. pdf.js therefore
 * hands a formula over as dozens of tiny text items, and joining them with
 * a blank produces the string the user reported on 2026-08-08:
 *
 *   ˆ P ( Z 1 = z 1 , · · · , Zn = zn ) = ∏ i ˆ P ( Zi = zi | ...
 *
 * `composeMathAwareText` rebuilds a readable line from those items using
 * the one signal the characters themselves don't carry: geometry. Every
 * fixture below is real — dumped from the PDFs in `uploads/papers/` with
 * pdf.js, then converted to DOM coordinates by `run()`.
 */

import { describe, it, expect } from 'vitest';
import { composeMathAwareText, type GlyphRun } from '../pdf/mathAwareText';

// pdf.js reports items in PDF space: `y` is the BASELINE measured from the
// page bottom, and `h` the font height. DOM rects grow downwards and their
// bottom edge sits a descender below the baseline. Convert with a fixed
// page height so the fixtures can quote the dumped numbers verbatim.
const PAGE_H = 700;
function run(text: string, x: number, y: number, w: number, h: number): GlyphRun {
  return {
    text,
    left: x,
    right: x + w,
    bottom: PAGE_H - y + 0.2 * h,
    height: h,
  };
}

describe('composeMathAwareText — spacing', () => {
  it('keeps a glyph and its neighbour together when no gap separates them', () => {
    // "( Z" — pdf.js emits two items that touch exactly (right === left).
    const runs = [run('(', 135.1, 417.3, 4.2, 10.9), run('Z', 139.3, 417.3, 6.1, 10.9)];
    expect(composeMathAwareText(runs)).toBe('(Z');
  });

  it('inserts a blank where the PDF really leaves horizontal space', () => {
    // "1" ends at 149.4, "=" starts at 152.3 — a 2.9pt gap at 10.9pt type.
    const runs = [run('1', 145.4, 415.7, 4, 8), run('=', 152.3, 417.3, 8.5, 10.9)];
    expect(composeMathAwareText(runs)).toBe('₁ =');
  });

  it('never leaves a blank before a comma or a closing bracket', () => {
    const runs = [run('z', 163.2, 417.3, 4.2, 10.9), run(',', 172, 417.3, 3, 10.9)];
    expect(composeMathAwareText(runs)).toBe('z,');
  });

  it('always leaves a blank after a comma', () => {
    // The dumped gap is only 1.2pt, below the geometric threshold — the
    // punctuation rule has to carry this one.
    const runs = [run(',', 172, 417.3, 3, 10.9), run('· · ·', 176.2, 417.3, 11.4, 10.9)];
    expect(composeMathAwareText(runs)).toBe(', · · ·');
  });

  it('surrounds relational operators with blanks even when the PDF crowds them', () => {
    const runs = [
      run('zi', 291.6, 417.3, 6.4, 10.9),
      run('|', 298.6, 417.3, 3, 10.9),
      run('gi', 301.6, 417.3, 7.6, 10.9),
    ];
    expect(composeMathAwareText(runs)).toBe('zi | gi');
  });

  it('drops the zero-width spacer items pdf.js emits between runs', () => {
    const runs = [
      run('Zn', 194.3, 417.3, 10.1, 10.9),
      run(' ', 204.4, 415.7, 0.3, 0),
      run('=', 207.4, 417.3, 8.5, 10.9),
    ];
    expect(composeMathAwareText(runs)).toBe('Zn =');
  });

  it('joins separate visual lines with a single blank', () => {
    const runs = [
      run('decomposed as a product of', 90, 439.7, 130, 10.9),
      run('conditional probabilities', 90, 426.2, 110, 10.9),
    ];
    expect(composeMathAwareText(runs)).toBe(
      'decomposed as a product of conditional probabilities',
    );
  });
});

describe('composeMathAwareText — subscripts and superscripts', () => {
  it('reads a smaller glyph below the baseline as a subscript', () => {
    // Bengio p.4: "Z" on the baseline, "1" 1.6pt lower at 8pt instead of 10.9pt.
    const runs = [run('Z', 139.3, 417.3, 6.1, 10.9), run('1', 145.4, 415.7, 4, 8)];
    expect(composeMathAwareText(runs)).toBe('Z₁');
  });

  it('reads a smaller glyph above the baseline as a superscript', () => {
    // BatchNorm p.3: "σ" baseline 196.1, the exponent "2" sits at 200.3.
    const runs = [run('σ', 321.2, 196.1, 5.7, 10), run('2', 327.2, 200.3, 4, 7)];
    expect(composeMathAwareText(runs)).toBe('σ²');
  });

  it('tells the exponent and the index of σ²_B apart — the case plain text cannot', () => {
    const runs = [
      run('σ', 321.2, 196.1, 5.7, 10),
      run('2', 327.2, 200.3, 4, 7),
      run('B', 326.9, 193.7, 5.3, 7),
    ];
    // No Unicode subscript exists for a capital B, so it is appended bare —
    // still an improvement over the "σ 2 B" the user saw.
    expect(composeMathAwareText(runs)).toBe('σ²B');
  });

  it('keeps a multi-glyph subscript together', () => {
    // "Zi − 1": the minus and the 1 are both set as subscripts.
    const runs = [
      run('Zi', 313.9, 417.3, 8.3, 10.9),
      run('−', 322.2, 415.7, 6.2, 8),
      run('1', 328.4, 415.7, 4, 8),
    ];
    expect(composeMathAwareText(runs)).toBe('Zi₋₁');
  });

  it('attaches the limits of a large operator without inventing blanks', () => {
    // BatchNorm p.3: ∑ with "m" above and "i =1" below.
    const runs = [
      run('m', 364.8, 208.6, 7.1, 7),
      run('∑', 361.2, 205.6, 14.4, 10),
      run('i', 361.9, 184.4, 2.8, 7),
      run('=1', 364.7, 184.4, 10.1, 7),
    ];
    expect(composeMathAwareText(runs)).toBe('∑ᵐᵢ₌₁');
  });
});

describe('composeMathAwareText — accents', () => {
  it('folds a standalone circumflex onto the letter it sits above', () => {
    // Bengio p.4 emits the hat BEFORE the P, overlapping it horizontally.
    const runs = [run('ˆ', 131, 419.5, 3.6, 10.9), run('P', 128.4, 417.3, 6.7, 10.9)];
    expect(composeMathAwareText(runs)).toBe('P̂');
  });

  it('handles a hat that already arrives as a combining mark of zero width', () => {
    // BatchNorm p.3 item 484 is U+0302 with width 0.
    const runs = [run('̂', 324.2, 166.8, 0, 10), run('x', 323.9, 166.8, 5.7, 10)];
    expect(composeMathAwareText(runs)).toBe('x̂');
  });

  it('leaves a circumflex alone when it overlaps nothing', () => {
    const runs = [run('ˆ', 131, 419.5, 3.6, 10.9), run('P', 200, 417.3, 6.7, 10.9)];
    expect(composeMathAwareText(runs)).toBe('ˆ P');
  });
});

describe('composeMathAwareText — end to end', () => {
  it('rebuilds the formula from the user report of 2026-08-08', () => {
    // Bengio p.4, items 102–124 of the real dump.
    const runs = [
      run('ˆ', 131, 419.5, 3.6, 10.9),
      run('P', 128.4, 417.3, 6.7, 10.9),
      run('(', 135.1, 417.3, 4.2, 10.9),
      run('Z', 139.3, 417.3, 6.1, 10.9),
      run('1', 145.4, 415.7, 4, 8),
      run(' ', 149.4, 415.7, 0.3, 0),
      run('=', 152.3, 417.3, 8.5, 10.9),
      run(' ', 160.8, 417.3, 0.2, 0),
      run('z', 163.2, 417.3, 4.2, 10.9),
      run('1', 167.4, 415.7, 4, 8),
      run(',', 172, 417.3, 3, 10.9),
      run(' ', 175, 417.3, 0.1, 0),
      run('· · ·', 176.2, 417.3, 11.4, 10.9),
      run(' ', 187.6, 417.3, 0.2, 0),
      run(',', 190.1, 417.3, 3, 10.9),
      run(' ', 193.1, 417.3, 0.1, 0),
      run('Zn', 194.3, 417.3, 10.1, 10.9),
      run(' ', 204.4, 415.7, 0.3, 0),
      run('=', 207.4, 417.3, 8.5, 10.9),
      run(' ', 215.8, 417.3, 0.2, 0),
      run('zn', 218.2, 417.3, 8.2, 10.9),
      run(') =', 226.9, 417.3, 15.2, 10.9),
    ];
    expect(composeMathAwareText(runs)).toBe('P̂(Z₁ = z₁, · · ·, Zn = zn) =');
  });

  it('leaves ordinary prose exactly as it was', () => {
    const runs = [
      run('all the Zi (word at i -th position), refer to', 90, 453.2, 300, 10.9),
      run('the same type of object (a word).', 90, 439.7, 220, 10.9),
    ];
    expect(composeMathAwareText(runs)).toBe(
      'all the Zi (word at i -th position), refer to the same type of object (a word).',
    );
  });

  it('returns an empty string when every run is blank', () => {
    expect(composeMathAwareText([run(' ', 10, 100, 0.3, 0)])).toBe('');
  });
});

describe('composeMathAwareText — stacked layout must never be interleaved', () => {
  // Both fixtures come from a live run against the real PDFs on 2026-08-08,
  // where sorting a whole line by x turned readable text into rubble.
  it('keeps a tall fraction as numerator-then-denominator', () => {
    // BatchNorm p.3, items 491–507: (xi − μB) over √(σ²B + ǫ). The radical
    // sits 6.4pt above the numerator's baseline but only 2.4pt to its left.
    const runs = [
      run('x', 352, 173.6, 5.7, 10),
      run('i', 357.6, 172.2, 2.8, 7),
      run('−', 363.1, 173.6, 7.7, 10),
      run('μ', 373.1, 173.6, 6, 10),
      run('B', 379.1, 172.2, 5.3, 7),
      run('√', 349.6, 167.2, 10, 10),
      run('σ', 359.5, 158.6, 5.7, 10),
      run('2', 365.5, 162, 4, 7),
      run('B', 365.2, 155.6, 5.3, 7),
      run('+', 373.3, 158.6, 7.7, 10),
      run('ǫ', 383.3, 158.6, 4, 10),
    ];
    expect(composeMathAwareText(runs)).toBe('xᵢ − μB √ σ²B + ǫ');
  });

  it('gives the sum its own upper limit, not the fraction in front of it', () => {
    // BatchNorm p.3, items 461–469: "1/m ∑ᵐᵢ₌₁". pdf.js emits the sum's upper
    // limit BEFORE the sum, so it lands in the fraction's band unless it is
    // carried over — which produced "1 mᵐ ∑ᵢ₌₁" on the first attempt.
    const runs = [
      run('1', 351.5, 202.9, 5, 10),
      run('m', 349.6, 189.4, 8.7, 10),
      run('m', 364.8, 208.6, 7.1, 7),
      run('∑', 361.2, 205.6, 14.4, 10),
      run('i', 361.9, 184.4, 2.8, 7),
      run('=1', 364.7, 184.4, 10.1, 7),
      run('x', 379.4, 196.1, 5.7, 10),
      run('i', 385.1, 194.6, 2.8, 7),
    ];
    expect(composeMathAwareText(runs)).toBe('1 m ∑ᵐᵢ₌₁ xᵢ');
  });

  it('does not reorder prose that shares a single line bucket', () => {
    // Two full text lines the caller lumped into one bucket. Reordering them
    // by x edge would splice the sentences into each other.
    const runs = [
      run('An important difference is that here we look for a', 90, 453.2, 432, 10.9),
      run('representation for words that is helpful.', 90, 439.7, 300, 10.9),
    ];
    expect(composeMathAwareText(runs)).toBe(
      'An important difference is that here we look for a representation for words that is helpful.',
    );
  });
});

describe('composeMathAwareText — known limits', () => {
  it('does not glue the two halves of a stacked fraction together', () => {
    // "1/m": numerator and denominator overlap horizontally and share the
    // full glyph height. Detecting the rule is Variant C's job; all this
    // must guarantee is that the two never collapse into "1m".
    const runs = [run('1', 351.5, 202.9, 5, 10), run('m', 349.6, 189.4, 8.7, 10)];
    expect(composeMathAwareText(runs)).toBe('1 m');
  });
});
