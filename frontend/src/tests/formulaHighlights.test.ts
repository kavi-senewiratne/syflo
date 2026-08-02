/**
 * tests/formulaHighlights.test.ts
 *
 * A highlight that touches a KaTeX formula paints the whole `.katex` box as
 * an ELEMENT (data attributes + CSS rules in index.css) instead of leaving it
 * to ::highlight() (user report 2026-08-01: striped background, stair-stepped
 * underline). The formula's offset span is cut out of the ranges handed to the
 * Custom Highlight API so nothing is painted twice.
 *
 * jsdom has no Custom Highlight API — CSS.highlights and Highlight are stubbed
 * before the import, exactly like flashChatColor.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageHighlight } from '../types';

class FakeHighlight {
  priority = 0;
  ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}
vi.stubGlobal('Highlight', FakeHighlight);
vi.stubGlobal('CSS', { highlights: new Map<string, FakeHighlight>() });

const { paintMessageHighlights, paintFlashChatRange } = await import(
  '../chat/highlightAnchors'
);

const registry = () =>
  (CSS as unknown as { highlights: Map<string, FakeHighlight> }).highlights;

const painted = (style: string) =>
  (registry().get(style)?.ranges ?? []).map((r) => r.toString());

// "Before " (0-7) + "y=x" (7-10, the formula) + " after" (10-16)
function makeRoot(): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = 'Before <span class="katex">y=x</span> after';
  document.body.appendChild(root);
  return root;
}

const formula = (root: HTMLElement) => root.querySelector('.katex') as HTMLElement;

function highlight(over: Partial<MessageHighlight>): MessageHighlight {
  return {
    id: 'h1',
    messageId: 'm1',
    startOffset: 0,
    endOffset: 16,
    color: 'yellow',
    text: '',
    ...over,
  } as MessageHighlight;
}

describe('highlights over KaTeX formulas', () => {
  beforeEach(() => {
    registry().clear();
    document.body.innerHTML = '';
  });

  it('marks the touched formula as an element instead of painting its text', () => {
    const root = makeRoot();
    paintMessageHighlights('m1', root, [highlight({})]);

    expect(formula(root).getAttribute('data-syflo-hl')).toBe('yellow');
    // The formula's own offsets are cut out — two ranges, none of them the
    // formula's glyphs.
    expect(painted('syflo-chat-hl-yellow')).toEqual(['Before ', ' after']);
  });

  it('marks a formula the highlight only reaches into', () => {
    const root = makeRoot();
    // Ends inside the formula ("Before y" + half of it).
    paintMessageHighlights('m1', root, [highlight({ endOffset: 8 })]);

    expect(formula(root).getAttribute('data-syflo-hl')).toBe('yellow');
    expect(painted('syflo-chat-hl-yellow')).toEqual(['Before ']);
  });

  it('leaves a formula alone when the highlight stops before it', () => {
    const root = makeRoot();
    paintMessageHighlights('m1', root, [highlight({ endOffset: 7 })]);

    expect(formula(root).hasAttribute('data-syflo-hl')).toBe(false);
    expect(painted('syflo-chat-hl-yellow')).toEqual(['Before ']);
  });

  it('adds the linked-chat underline attribute for branched highlights', () => {
    const root = makeRoot();
    paintMessageHighlights('m1', root, [highlight({ childChatId: 'c9' })]);

    expect(formula(root).hasAttribute('data-syflo-hl-linked')).toBe(true);
    // …and the surrounding prose still gets the ::highlight underline layer.
    expect(painted('syflo-chat-hl-linked')).toEqual(['Before ', ' after']);
  });

  it('drops the attributes when the highlight is removed', () => {
    const root = makeRoot();
    paintMessageHighlights('m1', root, [highlight({ childChatId: 'c9' })]);
    paintMessageHighlights('m1', root, []);

    expect(formula(root).hasAttribute('data-syflo-hl')).toBe(false);
    expect(formula(root).hasAttribute('data-syflo-hl-linked')).toBe(false);
  });

  it('paints a whole formula for the drawer flash too', () => {
    const root = makeRoot();
    paintFlashChatRange('m1', root, { startOffset: 0, endOffset: 16, color: 'green' });

    expect(formula(root).getAttribute('data-syflo-hl-flash')).toBe('green');
    expect(painted('syflo-chat-hl-flash-green')).toEqual(['Before ', ' after']);

    paintFlashChatRange('m1', root, null);
    expect(formula(root).hasAttribute('data-syflo-hl-flash')).toBe(false);
  });

  it('keeps painting plain prose in one range when no formula is involved', () => {
    const root = document.createElement('div');
    root.textContent = 'plain prose only';
    document.body.appendChild(root);

    paintMessageHighlights('m1', root, [highlight({ startOffset: 6, endOffset: 11 })]);

    expect(painted('syflo-chat-hl-yellow')).toEqual(['prose']);
  });
});
