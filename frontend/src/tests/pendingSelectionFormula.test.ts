/**
 * tests/pendingSelectionFormula.test.ts
 *
 * User report 2026-08-08: the blue pending selection came out STRIPED over a
 * formula ("0,5 × 0,5 = 0,25") — KaTeX keeps its spacing in margins and empty
 * .mspace spans, which carry no text, so neither the native selection nor
 * ::highlight() paints them.
 *
 * Saved highlights already solve this by painting the whole `.katex` box as an
 * element (formulaHighlights.test.ts). The pending selection now does the
 * same: the box is marked with data-syflo-hl-pending, its offsets are cut out
 * of the painted ranges, and the native selection — which cannot be split into
 * pieces — is stepped aside so it never stripes on top.
 *
 * jsdom has no Custom Highlight API — CSS.highlights and Highlight are stubbed
 * before the import, exactly like formulaHighlights.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

class FakeHighlight {
  priority = 0;
  ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}
vi.stubGlobal('Highlight', FakeHighlight);
vi.stubGlobal('CSS', { highlights: new Map<string, FakeHighlight>() });

const { paintPendingChatSelection, clearPendingChatSelection } = await import(
  '../chat/highlightAnchors'
);

const registry = () =>
  (CSS as unknown as { highlights: Map<string, FakeHighlight> }).highlights;
const PENDING = 'syflo-chat-hl-pending';

const painted = () => (registry().get(PENDING)?.ranges ?? []).map((r) => r.toString());
const selectionText = () => window.getSelection()?.toString() ?? '';

// "Chancen: " (0-9) + "0,5×0,5=0,25" (9-21, the formula) + " (25%)." (21-28)
function makeRoot(): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = 'Chancen: <span class="katex">0,5×0,5=0,25</span> (25%).';
  document.body.appendChild(root);
  return root;
}

const formula = (root: HTMLElement) => root.querySelector('.katex') as HTMLElement;

describe('pending selection over KaTeX formulas', () => {
  beforeEach(() => {
    registry().clear();
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = '';
  });

  it('marks the touched formula as an element and cuts it out of the ranges', () => {
    const root = makeRoot();
    paintPendingChatSelection('m1', root, { startOffset: 0, endOffset: 28 });

    expect(formula(root).hasAttribute('data-syflo-hl-pending')).toBe(true);
    expect(painted()).toEqual(['Chancen: ', ' (25%).']);
  });

  it('steps the native selection aside so it cannot stripe on top', () => {
    const root = makeRoot();
    paintPendingChatSelection('m1', root, { startOffset: 0, endOffset: 28 });

    // The native selection cannot be split around the formula (Chromium keeps
    // exactly one range), so the highlight path owns the paint here.
    expect(selectionText()).toBe('');
    expect(registry().has(PENDING)).toBe(true);
  });

  it('marks a formula the selection only reaches into', () => {
    const root = makeRoot();
    paintPendingChatSelection('m1', root, { startOffset: 0, endOffset: 12 });

    expect(formula(root).hasAttribute('data-syflo-hl-pending')).toBe(true);
    expect(painted()).toEqual(['Chancen: ']);
  });

  it('leaves the formula alone when the selection stops before it', () => {
    const root = makeRoot();
    paintPendingChatSelection('m1', root, { startOffset: 0, endOffset: 9 });

    expect(formula(root).hasAttribute('data-syflo-hl-pending')).toBe(false);
    // No formula involved → the native selection keeps its full-line-height look.
    expect(selectionText()).toBe('Chancen: ');
    expect(registry().has(PENDING)).toBe(false);
  });

  it('drops the attribute when the popup closes', () => {
    const root = makeRoot();
    paintPendingChatSelection('m1', root, { startOffset: 0, endOffset: 28 });
    paintPendingChatSelection('m1', root, null);

    expect(formula(root).hasAttribute('data-syflo-hl-pending')).toBe(false);
    expect(registry().has(PENDING)).toBe(false);
  });

  it('drops the attribute on unmount too', () => {
    const root = makeRoot();
    paintPendingChatSelection('m1', root, { startOffset: 0, endOffset: 28 });
    clearPendingChatSelection('m1');

    expect(formula(root).hasAttribute('data-syflo-hl-pending')).toBe(false);
    expect(registry().has(PENDING)).toBe(false);
  });

  it('keeps the formula painted after a click collapses the selection', () => {
    const root = makeRoot();
    paintPendingChatSelection('m1', root, { startOffset: 0, endOffset: 28 });

    document.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    document.dispatchEvent(new Event('selectionchange'));
    document.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));

    expect(formula(root).hasAttribute('data-syflo-hl-pending')).toBe(true);
    expect(painted()).toEqual(['Chancen: ', ' (25%).']);
  });
});
