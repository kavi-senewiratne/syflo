import { describe, it, expect, afterEach } from 'vitest';
import { readScreen } from '../keyboard/readScreen';
import { PAGE_ITEM } from '../keyboard/focusMap';

/**
 * The screen tells the keyboard what is on it (ADR-0011). Regions announce
 * themselves with `data-focus-region`, items with `data-focus-item` — so the
 * item lists are never a second, drifting copy of the layout, they are read
 * back off the layout itself.
 */

const html = (markup: string) => {
  document.body.innerHTML = markup;
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('readScreen', () => {
  it('reads a region’s items in the order they sit on screen', () => {
    html(`
      <div data-focus-region="sidebar">
        <div data-focus-item="root"></div>
        <div data-focus-item="attention"></div>
      </div>
      <div data-focus-region="chat"><div data-focus-item="m1"></div></div>
    `);

    expect(readScreen(document).sidebarItems).toEqual(['root', 'attention']);
  });

  it('reports a region that is not rendered as absent, not as empty', () => {
    html(`<div data-focus-region="sidebar"><div data-focus-item="root"></div></div>`);

    expect(readScreen(document).drawerItems).toBeNull();
    expect(readScreen(document).sourceHighlightIds).toBeNull();
    expect(readScreen(document).mindMapRows).toBeNull();
  });

  it('reports a rendered source with no highlights as empty, so it keeps its place', () => {
    html(`<div data-focus-region="source"><div data-focus-item="${PAGE_ITEM}"></div></div>`);

    expect(readScreen(document).sourceHighlightIds).toEqual([PAGE_ITEM]);
  });

  it('picks up which tree nodes are expanded', () => {
    html(`
      <div data-focus-region="sidebar">
        <div data-focus-item="root" data-focus-expanded="true"></div>
        <div data-focus-item="attention" data-focus-expanded="false"></div>
        <div data-focus-item="qkv"></div>
      </div>
    `);

    expect(readScreen(document).sidebarExpanded).toEqual({ root: true, attention: false });
  });

  it('leaves out a control the layout has hidden', () => {
    // The model picker is display:none in a narrow chat column, and a ring on
    // it would simply vanish (user report 2026-08-11).
    html(`
      <div data-focus-region="chat">
        <div data-focus-item="m1"></div>
        <button data-focus-item="composer-model" style="display:none"></button>
        <button data-focus-item="composer-send"></button>
      </div>
    `);
    // jsdom has no checkVisibility; stand in for the browser's answer.
    document.querySelectorAll('[data-focus-item]').forEach(el => {
      (el as HTMLElement).checkVisibility = () => (el as HTMLElement).style.display !== 'none';
    });

    expect(readScreen(document).chatItems).toEqual(['m1', 'composer-send']);
  });

  it('counts a highlight once, however many pieces it is drawn in', () => {
    // A formula highlight is drawn as one rect per baseline band, so its id
    // appears on several elements. It is still one place in the text (user
    // report 2026-08-11).
    html(`
      <div data-focus-region="source">
        <div data-focus-item="hl-formula"></div>
        <div data-focus-item="hl-formula"></div>
        <div data-focus-item="hl-next"></div>
      </div>
    `);

    expect(readScreen(document).sourceHighlightIds).toEqual(['hl-formula', 'hl-next']);
  });

  it('makes an open menu a region of its own, ahead of everything else', () => {
    // Every menu in the app carries role="menu"/"menuitem" already, so this
    // costs a menu nothing to join in — and while one is open it is the only
    // thing the arrows may touch (user request 2026-08-11).
    html(`
      <div data-focus-region="sidebar"><div data-focus-item="root"></div></div>
      <div role="menu" data-testid="attach-menu">
        <button role="menuitem" data-testid="attach-menu-files">Media</button>
        <button role="menuitem" data-testid="attach-menu-upload-pdf">PDF</button>
        <button>A plain button, with no role at all</button>
      </div>
    `);

    const screen = readScreen(document);
    expect(screen.menuItems).toEqual([
      'attach-menu-files',
      'attach-menu-upload-pdf',
      'menu-item-2',
    ]);
  });

  it('keeps a reading sequence one item per step, however the marks happen to sit', () => {
    // Two highlights on the same line of a paper are not a row of controls —
    // they are two places in a text. Grouping them made ← walk sideways
    // through them instead of leaving for the sidebar (user report
    // 2026-08-11).
    html(`
      <div data-focus-region="source">
        <div data-focus-item="pdf-zoom-out" data-test-top="10"></div>
        <div data-focus-item="pdf-zoom-in" data-test-top="10"></div>
        <div data-focus-axis="sequence">
          <div data-focus-item="hl-1" data-test-top="100"></div>
          <div data-focus-item="hl-2" data-test-top="100"></div>
          <div data-focus-item="hl-3" data-test-top="400"></div>
        </div>
      </div>
    `);
    document.querySelectorAll('[data-test-top]').forEach(el => {
      const top = Number((el as HTMLElement).dataset.testTop);
      (el as HTMLElement).getBoundingClientRect = () => ({ top, width: 120, height: 12 }) as DOMRect;
    });

    // The toolbar above them is an ordinary row and keeps its left/right.
    expect(readScreen(document).sourceRows).toEqual([
      ['pdf-zoom-out', 'pdf-zoom-in'],
      ['hl-1'],
      ['hl-2'],
      ['hl-3'],
    ]);
  });

  it('groups mind map nodes into generations by where they sit vertically', () => {
    html(`
      <div data-focus-region="map">
        <div data-focus-item="root" data-test-top="0"></div>
        <div data-focus-item="a" data-test-top="200"></div>
        <div data-focus-item="b" data-test-top="204"></div>
      </div>
    `);
    // jsdom has no layout, so the reader falls back to this stand-in. Size
    // matters as well as position: with no geometry at all, every item is its
    // own row rather than all of them sharing top 0.
    document.querySelectorAll('[data-test-top]').forEach(el => {
      const top = Number((el as HTMLElement).dataset.testTop);
      (el as HTMLElement).getBoundingClientRect = () =>
        ({ top, width: 220, height: 60 }) as DOMRect;
    });

    expect(readScreen(document).mindMapRows).toEqual([['root'], ['a', 'b']]);
  });
});
