import { describe, it, expect } from 'vitest';
import { buildLayout, PAGE_ITEM, type ScreenState } from '../keyboard/focusMap';

/**
 * Which keyboard regions exist right now (ADR-0011). A region that is not on
 * screen is skipped; a region that IS on screen is never skipped, even when it
 * has nothing in it — otherwise the map would rearrange itself the moment the
 * user makes a first highlight.
 */

const screen = (over: Partial<ScreenState> = {}): ScreenState => ({
  mindMapRows: null,
  sidebarItems: ['root', 'attention'],
  sidebarExpanded: { root: true },
  sourceHighlightIds: ['hl-1'],
  chatItems: ['m1', 'composer'],
  drawerItems: ['hl-1'],
  ...over,
});

describe('buildLayout', () => {
  it('leaves out the mind map while the chat is showing', () => {
    expect(buildLayout(screen()).map).toBeNull();
  });

  it('keeps the source region on screen when the paper has no highlights yet', () => {
    const source = buildLayout(screen({ sourceHighlightIds: [] })).columns
      .find(c => c.id === 'source');

    expect(source?.items).toEqual([PAGE_ITEM]);
  });

  it('skips the highlights drawer while it is closed', () => {
    const ids = buildLayout(screen({ drawerItems: null })).columns.map(c => c.id);

    expect(ids).toEqual(['sidebar', 'source', 'chat']);
  });

  it('skips the source region entirely when the tree has no source', () => {
    const ids = buildLayout(screen({ sourceHighlightIds: null })).columns.map(c => c.id);

    expect(ids).toEqual(['sidebar', 'chat', 'highlights']);
  });

  it('orders the columns left to right as they sit on screen', () => {
    const ids = buildLayout(screen()).columns.map(c => c.id);

    expect(ids).toEqual(['sidebar', 'source', 'chat', 'highlights']);
  });

  it('flattens the mind map generations into its item list', () => {
    const map = buildLayout(screen({ mindMapRows: [['root'], ['a', 'b']] })).map;

    expect(map).toEqual({ id: 'map', items: ['root', 'a', 'b'], rows: [['root'], ['a', 'b']] });
  });

  it('splits a dialog with a tab rail into two columns', () => {
    // The settings dialog: ↑/↓ walk the rail's tabs, → crosses into the tab's
    // page (user request 2026-09-12). The rail items also appear in menuItems
    // (they are stamped like everything else) and must not repeat in the page.
    const layout = buildLayout(
      screen({
        menuItems: ['close', 'tab-a', 'tab-b', 'field-1', 'field-2'],
        menuRows: [['close'], ['tab-a', 'field-1'], ['tab-b', 'field-2']],
        menuRail: { items: ['tab-a', 'tab-b'], rows: [['tab-a'], ['tab-b']] },
      }),
    );

    expect(layout.columns).toEqual([
      { id: 'menuRail', items: ['tab-a', 'tab-b'], rows: [['tab-a'], ['tab-b']] },
      { id: 'menu', items: ['close', 'field-1', 'field-2'], rows: [['close'], ['field-1'], ['field-2']] },
    ]);
  });
});
