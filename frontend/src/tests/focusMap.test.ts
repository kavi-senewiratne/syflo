import { describe, it, expect } from 'vitest';
import { navigate, type Layout } from '../keyboard/focusMap';

/**
 * The rules behind keyboard navigation (ADR-0011,
 * design/mockup-keyboard-navigation.html). Everything the user can feel —
 * edge overflow, the L-shaped map, per-region memory — lives here, away from
 * the DOM, so it can be checked a thousand times in a millisecond.
 */

const layout = (over: Partial<Layout> = {}): Layout => ({
  map: null,
  columns: [
    { id: 'sidebar', items: ['root', 'attention', 'qkv'] },
    { id: 'source', items: ['hl-yellow', 'hl-blue'] },
    { id: 'chat', items: ['m1', 'm2', 'composer'] },
  ],
  ...over,
});

describe('navigate', () => {
  it('moves right out of the sidebar into the source', () => {
    const result = navigate(
      'ArrowRight',
      { region: 'sidebar', item: 'attention' },
      layout(),
      {},
    );

    expect(result).toEqual({
      kind: 'move',
      to: { region: 'source', item: 'hl-yellow' },
    });
  });

  it('collapses an expanded tree node instead of leaving the sidebar', () => {
    const result = navigate(
      'ArrowLeft',
      { region: 'sidebar', item: 'attention' },
      layout({
        columns: [
          { id: 'sidebar', items: ['root', 'attention', 'qkv'], expanded: { attention: true } },
          { id: 'source', items: ['hl-yellow'] },
        ],
      }),
      {},
    );

    expect(result).toEqual({ kind: 'toggle', item: 'attention', expanded: false });
  });

  it('leaves the sidebar leftwards once the node has nothing left to collapse', () => {
    const result = navigate(
      'ArrowLeft',
      { region: 'source', item: 'hl-blue' },
      layout(),
      {},
    );

    expect(result).toEqual({ kind: 'move', to: { region: 'sidebar', item: 'root' } });
  });

  it('expands a collapsed tree node before letting the key move on', () => {
    const result = navigate(
      'ArrowRight',
      { region: 'sidebar', item: 'attention' },
      layout({
        columns: [
          { id: 'sidebar', items: ['root', 'attention'], expanded: { attention: false } },
          { id: 'source', items: ['hl-yellow'] },
        ],
      }),
      {},
    );

    expect(result).toEqual({ kind: 'toggle', item: 'attention', expanded: true });
  });

  it('resumes the item a region was last left on', () => {
    const result = navigate(
      'ArrowRight',
      { region: 'sidebar', item: 'root' },
      layout(),
      { source: 'hl-blue' },
    );

    expect(result).toEqual({ kind: 'move', to: { region: 'source', item: 'hl-blue' } });
  });

  it('does nothing when there is no region beyond the edge', () => {
    const result = navigate(
      'ArrowLeft',
      { region: 'sidebar', item: 'root' },
      layout(),
      {},
    );

    expect(result).toEqual({ kind: 'none' });
  });

  it('rescues a ring left behind in a region that has gone away', () => {
    // Opening the highlights drawer covers the chat column, so the region the
    // ring was in stops existing under it (found in the running app,
    // 2026-08-10). The next arrow key has to land somewhere real.
    const result = navigate(
      'ArrowLeft',
      { region: 'chat', item: 'm1' },
      layout({ columns: [{ id: 'sidebar', items: ['root'] }, { id: 'highlights', items: ['hl-1'] }] }),
      {},
    );

    expect(result).toEqual({ kind: 'move', to: { region: 'sidebar', item: 'root' } });
  });

  it('walks down the items of a column', () => {
    const result = navigate('ArrowDown', { region: 'chat', item: 'm2' }, layout(), {});

    expect(result).toEqual({ kind: 'move', to: { region: 'chat', item: 'composer' } });
  });

  it('stays put at the bottom of a column', () => {
    const result = navigate('ArrowDown', { region: 'chat', item: 'composer' }, layout(), {});

    expect(result).toEqual({ kind: 'none' });
  });

  it('overflows upward into the mind map from the top item of a column', () => {
    const result = navigate(
      'ArrowUp',
      { region: 'chat', item: 'm1' },
      layout({ map: { id: 'map', items: ['n1', 'n2'], rows: [['n1'], ['n2']] } }),
      {},
    );

    expect(result).toEqual({ kind: 'move', to: { region: 'map', item: 'n1' } });
  });

  it('stays put at the top of a column when no mind map is on screen', () => {
    const result = navigate('ArrowUp', { region: 'chat', item: 'm1' }, layout(), {});

    expect(result).toEqual({ kind: 'none' });
  });
});

/**
 * Inside the mind map the arrows follow what the layout shows: a row is a
 * generation, so left/right are siblings and up/down change depth. Decision
 * 2026-08-10 — the general "arrows follow the region's own axis" reading.
 */
describe('navigate inside the mind map', () => {
  const withMap = (): Layout => ({
    map: {
      id: 'map',
      items: ['root', 'attention', 'ffn', 'qkv'],
      rows: [['root'], ['attention', 'ffn'], ['qkv']],
    },
    columns: [
      { id: 'sidebar', items: ['root', 'attention'] },
      { id: 'chat', items: ['m1', 'composer'] },
    ],
  });

  it('moves between siblings of the same generation', () => {
    const result = navigate('ArrowRight', { region: 'map', item: 'attention' }, withMap(), {});

    expect(result).toEqual({ kind: 'move', to: { region: 'map', item: 'ffn' } });
  });

  it('stays put at the end of a generation — no region lies beside the map', () => {
    const result = navigate('ArrowRight', { region: 'map', item: 'ffn' }, withMap(), {});

    expect(result).toEqual({ kind: 'none' });
  });

  it('changes generation with up and down', () => {
    const result = navigate('ArrowDown', { region: 'map', item: 'root' }, withMap(), {});

    expect(result).toEqual({ kind: 'move', to: { region: 'map', item: 'attention' } });
  });

  it('drops out of the bottom generation into the column it came from', () => {
    const result = navigate(
      'ArrowDown',
      { region: 'map', item: 'qkv' },
      withMap(),
      { column: 'chat', chat: 'composer' },
    );

    expect(result).toEqual({ kind: 'move', to: { region: 'chat', item: 'composer' } });
  });

  it('drops into the first column when it has no column to return to', () => {
    const result = navigate('ArrowDown', { region: 'map', item: 'qkv' }, withMap(), {});

    expect(result).toEqual({ kind: 'move', to: { region: 'sidebar', item: 'root' } });
  });
});

describe('navigate when the screen has changed underneath', () => {
  it('rescues a ring left on a mind map node that no longer exists', () => {
    const result = navigate(
      'ArrowDown',
      { region: 'map', item: 'deleted-branch' },
      {
        map: { id: 'map', items: ['root', 'a'], rows: [['root'], ['a']] },
        columns: [{ id: 'chat', items: ['m1'] }],
      },
      {},
    );

    expect(result).toEqual({ kind: 'move', to: { region: 'map', item: 'root' } });
  });
});

/**
 * A region is not a list, it is rows — mostly rows of one. Where a region puts
 * several controls side by side (the composer's attach/mic/model/send, the
 * sidebar's header buttons), left/right walk them and only overflow out of the
 * region at the ends (user report 2026-08-11). Same rule the mind map already
 * used; it stops being a special case.
 */
describe('navigate across a row of controls inside a column', () => {
  const withControls = (): Layout => ({
    map: null,
    columns: [
      { id: 'sidebar', items: ['root'] },
      {
        id: 'chat',
        items: ['m1', 'attach', 'composer', 'mic', 'send'],
        rows: [['m1'], ['attach'], ['composer'], ['mic', 'send']],
      },
    ],
  });

  it('walks the controls of one row with left and right', () => {
    const result = navigate('ArrowRight', { region: 'chat', item: 'mic' }, withControls(), {});

    expect(result).toEqual({ kind: 'move', to: { region: 'chat', item: 'send' } });
  });

  it('leaves the region only once the row has no control left', () => {
    const result = navigate('ArrowLeft', { region: 'chat', item: 'mic' }, withControls(), {});

    expect(result).toEqual({ kind: 'move', to: { region: 'sidebar', item: 'root' } });
  });

  it('keeps the horizontal place when changing row', () => {
    const result = navigate('ArrowUp', { region: 'chat', item: 'send' }, withControls(), {});

    expect(result).toEqual({ kind: 'move', to: { region: 'chat', item: 'composer' } });
  });
});
