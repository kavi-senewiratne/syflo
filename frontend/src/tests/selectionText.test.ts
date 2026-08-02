/**
 * tests/selectionText.test.ts
 *
 * rangeToCleanText: selections over KaTeX-rendered content must yield the
 * LaTeX source ($…$) instead of the tripled DOM text (MathML text +
 * annotation + HTML layer — live incident 2026-07-26).
 */
import { describe, it, expect } from 'vitest';
import { rangeToCleanText } from '../chat/selectionText';

/** Minimal replica of KaTeX's DOM: mathml twin (with annotation) + html layer. */
function katexSpan(latex: string, rendered: string): string {
  return (
    '<span class="katex">' +
    '<span class="katex-mathml"><math><semantics><mrow></mrow>' +
    `<annotation encoding="application/x-tex">${latex}</annotation>` +
    `</semantics></math>${rendered}</span>` +
    `<span class="katex-html" aria-hidden="true">${rendered}</span>` +
    '</span>'
  );
}

function rangeOver(html: string): Range {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  const range = document.createRange();
  range.selectNodeContents(host);
  return range;
}

describe('rangeToCleanText', () => {
  it('replaces a KaTeX element with its $…$ source', () => {
    const range = rangeOver(
      `Energie ${katexSpan('E(w_{t-n+1}, \\dots, w_t)', 'E(wt−n+1,…,wt)')} vereinfacht OOV.`,
    );
    expect(rangeToCleanText(range)).toBe('Energie $E(w_{t-n+1}, \\dots, w_t)$ vereinfacht OOV.');
  });

  it('does NOT triple the formula like Range.toString() does', () => {
    const range = rangeOver(`${katexSpan('w_t', 'wt')}`);
    // The naive capture contains the rendered text twice plus the source.
    expect(range.toString()).toContain('wt');
    expect(range.toString()).toContain('w_t');
    expect(rangeToCleanText(range)).toBe('$w_t$');
  });

  it('wraps display math in $$…$$', () => {
    const range = rangeOver(
      `<span class="katex-display">${katexSpan('\\frac{a}{b}', 'a/b')}</span>`,
    );
    expect(rangeToCleanText(range)).toBe('$$\\frac{a}{b}$$');
  });

  it('falls back to the visible layer when the annotation is missing (partial selection)', () => {
    const broken =
      '<span class="katex">' +
      '<span class="katex-mathml">wt</span>' +
      '<span class="katex-html" aria-hidden="true">wt</span>' +
      '</span>';
    const range = rangeOver(`vor ${broken} nach`);
    expect(rangeToCleanText(range)).toBe('vor wt nach');
  });

  it('leaves plain text untouched', () => {
    const range = rangeOver('nur normaler Text ohne Formeln');
    expect(rangeToCleanText(range)).toBe('nur normaler Text ohne Formeln');
  });

  it('substitutes the WHOLE formula when the selection starts inside it (live incident 2026-07-26)', () => {
    // The user dragged from inside the rendered formula: the range starts in
    // a text node of .katex-html — cloneContents would lose the .katex
    // wrapper and the annotation.
    const host = document.createElement('div');
    host.innerHTML =
      `${katexSpan('\\hat{P}(w_t) = \\sum_i e^{y_i}', 'P^(wt)=∑ieyi')} vereinfacht OOV.`;
    document.body.appendChild(host);

    const htmlLayer = host.querySelector('.katex-html')!;
    const innerTextNode = htmlLayer.firstChild!; // "P^(wt)=∑ieyi"
    const after = host.lastChild!; // " vereinfacht OOV."

    const range = document.createRange();
    range.setStart(innerTextNode, 3); // mitten in der Formel
    range.setEnd(after, after.textContent!.length);

    expect(rangeToCleanText(range)).toBe('$\\hat{P}(w_t) = \\sum_i e^{y_i}$ vereinfacht OOV.');
  });

  it('slices boundary text nodes to the selected part only', () => {
    const host = document.createElement('div');
    host.innerHTML = `Anfang und ${katexSpan('w_t', 'wt')} Ende hier`;
    document.body.appendChild(host);

    const first = host.firstChild!; // "Anfang und "
    const last = host.lastChild!; // " Ende hier"
    const range = document.createRange();
    range.setStart(first, 'Anfang '.length);
    range.setEnd(last, ' Ende'.length);

    expect(rangeToCleanText(range)).toBe('und $w_t$ Ende');
  });
});
