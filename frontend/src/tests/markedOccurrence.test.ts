/**
 * markedOccurrence — which occurrence of a branch word carries the highlight?
 *
 * A branch born from a marked passage links ONLY that passage (user decision
 * 2026-08-13, design/mockup-simply-blue-fixes.html §04 variant A). The mark
 * lives in rendered-text offsets, the link is written into raw markdown — so
 * the two meet on an ORDINAL: "the n-th match in the message".
 *
 * The counting has to mirror insertBranchLinks exactly: formulas and code are
 * locked there and are therefore skipped here as well.
 */

import { describe, it, expect } from 'vitest';
import { markedOccurrenceIndex } from '../chat/markedOccurrence';

// Builds a content root the way the markdown pipeline would render it.
function root(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

// Character offset of a substring in the root's rendered text — the same
// coordinate system a MessageHighlight's startOffset lives in.
const offsetOf = (el: HTMLElement, needle: string, nth = 0): number => {
  const text = el.textContent ?? '';
  let at = -1;
  for (let i = 0; i <= nth; i++) at = text.indexOf(needle, at + 1);
  return at;
};

describe('markedOccurrenceIndex', () => {
  it('finds the first occurrence', () => {
    const el = root('<p>Backpropagation als Leaky Abstraction.</p><p>Eine Leaky Abstraction lügt.</p>');
    expect(markedOccurrenceIndex(el, 'Leaky Abstraction', offsetOf(el, 'Leaky Abstraction', 0))).toBe(0);
  });

  it('finds a later occurrence', () => {
    const el = root('<p>Backpropagation als Leaky Abstraction.</p><p>Eine Leaky Abstraction lügt.</p>');
    expect(markedOccurrenceIndex(el, 'Leaky Abstraction', offsetOf(el, 'Leaky Abstraction', 1))).toBe(1);
  });

  it('counts case-insensitively, like the link insertion does', () => {
    // Achtung: textContent klebt Absätze OHNE Trennzeichen aneinander — genau
    // wie die Offsets der Markierungen. Der Punkt am Absatzende ist deshalb
    // kein Zierrat: ohne ihn wäre "abstractiondie" ein Wort und der erste
    // Treffer gar keiner (an genau dieser Stelle ist der Test erst gescheitert).
    const el = root('<p>eine leaky abstraction.</p><p>die Leaky Abstraction</p>');
    expect(markedOccurrenceIndex(el, 'Leaky Abstraction', offsetOf(el, 'Leaky Abstraction'))).toBe(1);
  });

  it('ignores occurrences inside code — insertBranchLinks locks those', () => {
    const el = root('<p>vgl. <code>Leaky Abstraction</code> im Log</p><p>eine Leaky Abstraction</p>');
    // Der Treffer im <code> zählt nicht: die Markierung im Fließtext ist die
    // ERSTE offene Stelle, obwohl im Text zwei Treffer davor liegen.
    expect(markedOccurrenceIndex(el, 'Leaky Abstraction', offsetOf(el, 'Leaky Abstraction', 1))).toBe(0);
  });

  it('ignores the text KaTeX duplicates into .katex-mathml', () => {
    // Echte KaTeX-Struktur: die Formel steht dreimal im textContent (HTML,
    // MathML, LaTeX-Quelle). insertBranchLinks sperrt Mathe komplett.
    const el = root(
      '<p>Der Term <span class="katex"><span class="katex-mathml">Vx</span>' +
      '<span class="katex-html">Vx</span></span> und dann V hier</p>',
    );
    expect(markedOccurrenceIndex(el, 'V', offsetOf(el, 'V hier'))).toBe(0);
  });

  it('returns null when the offset does not sit on the word', () => {
    const el = root('<p>Backpropagation als Leaky Abstraction.</p>');
    expect(markedOccurrenceIndex(el, 'Leaky Abstraction', 0)).toBeNull();
  });

  it('returns null for an offset past the end of the text', () => {
    const el = root('<p>kurz</p>');
    expect(markedOccurrenceIndex(el, 'kurz', 999)).toBeNull();
  });

  it('tolerates a mark that starts a few characters into the word', () => {
    // Der Nutzer markiert von Hand; das Wort-Snap fasst auf ganze Wörter, aber
    // ein Offset mitten IM Wort darf nicht zu "kein Treffer" führen — der
    // Treffer, der den Offset überdeckt, gilt.
    const el = root('<p>eine Leaky Abstraction hier</p>');
    const inside = offsetOf(el, 'Leaky Abstraction') + 3;
    expect(markedOccurrenceIndex(el, 'Leaky Abstraction', inside)).toBe(0);
  });
});
