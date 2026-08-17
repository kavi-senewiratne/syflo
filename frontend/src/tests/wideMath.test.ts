/**
 * wideMath — eine zu breite Inline-Formel bekommt ihre eigene scrollbare Zeile
 * (Nutzerentscheid 2026-08-13, design/mockup-simply-blue-fixes.html §03,
 * Variante A).
 *
 * Gemessen am 13.08.2026 in der laufenden App: eine Inline-Formel hatte einen
 * Kasten von 146 px, ihre Tinte war 239 px breit — 93 px liefen sichtbar aus
 * der Blase heraus und die 308 px schmale Elternspalte bekam 334 px
 * Scrollbreite. `.katex-html` ist auf `max-width: 100%` begrenzt, hat aber
 * kein `overflow`; der Kasten hört also auf, die Formel nicht.
 *
 * jsdom hat kein Layout (jede Breite ist 0), deshalb ist die Entscheidung von
 * der Messung getrennt: `applyWideMath` bekommt die Breiten als Zahlen.
 */

import { describe, it, expect } from 'vitest';
import { applyWideMath, inlineFormulas, WIDE_MATH_ATTR } from '../markdown/wideMath';

function root(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

const INLINE = '<p>Text <span class="katex"><span class="katex-html">Formel</span></span> weiter</p>';
const DISPLAY =
  '<p><span class="katex-display"><span class="katex"><span class="katex-html">Formel</span></span></span></p>';

describe('inlineFormulas', () => {
  it('finds inline formulas', () => {
    expect(inlineFormulas(root(INLINE))).toHaveLength(1);
  });

  it('skips display formulas — die haben ihren eigenen Scroll-Container', () => {
    expect(inlineFormulas(root(DISPLAY))).toHaveLength(0);
  });

  it('skips a nested .katex, nur die äußerste Box zählt', () => {
    const el = root(
      '<p><span class="katex"><span class="katex-html">' +
      '<span class="katex"><span class="katex-html">x</span></span></span></span></p>',
    );
    expect(inlineFormulas(el)).toHaveLength(1);
  });
});

describe('applyWideMath', () => {
  const el = () => document.createElement('span');

  it('marks a formula whose ink is wider than the line', () => {
    const box = el();
    applyWideMath([{ el: box, ink: 239, available: 146 }]);
    expect(box.hasAttribute(WIDE_MATH_ATTR)).toBe(true);
  });

  it('leaves a formula that fits alone', () => {
    const box = el();
    applyWideMath([{ el: box, ink: 91, available: 250 }]);
    expect(box.hasAttribute(WIDE_MATH_ATTR)).toBe(false);
  });

  it('unmarks again when the column grows', () => {
    const box = el();
    box.setAttribute(WIDE_MATH_ATTR, '');
    applyWideMath([{ el: box, ink: 239, available: 400 }]);
    expect(box.hasAttribute(WIDE_MATH_ATTR)).toBe(false);
  });

  it('tolerates a sub-pixel overshoot — 1 px ist Rundung, kein Überlauf', () => {
    // Zoomstufen und fraktionale Zeilenbreiten liefern Werte wie 239,4 gegen
    // 239. Ohne Toleranz flackerte jede zweite Formel in die Blockform.
    const box = el();
    applyWideMath([{ el: box, ink: 240, available: 239.4 }]);
    expect(box.hasAttribute(WIDE_MATH_ATTR)).toBe(false);
  });

  it('ignores an unmeasurable line (available 0) statt alles zu markieren', () => {
    // Passiert bei ausgeblendeten Blasen und in jsdom: 0 heißt „nicht
    // gemessen", nicht „nichts passt hinein".
    const box = el();
    applyWideMath([{ el: box, ink: 239, available: 0 }]);
    expect(box.hasAttribute(WIDE_MATH_ATTR)).toBe(false);
  });
});
