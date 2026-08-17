/**
 * Where the focus ring goes next (ADR-0011).
 *
 * A pure function and nothing else: no DOM, no React, no scrolling. The caller
 * describes what is on screen, this decides what the key means. Everything the
 * user can feel about keyboard navigation is decided here.
 */

export type RegionId = 'menu' | 'map' | 'sidebar' | 'source' | 'chat' | 'highlights';

/** One keyboard region and the items currently inside it, in visual order. */
export interface Region {
  id: RegionId;
  items: string[];
  /**
   * Sidebar only: which items can be collapsed, and whether they are open.
   * An item absent from this map is a leaf and has nothing to collapse.
   */
  expanded?: Record<string, boolean>;
  /**
   * Mind map only: the items split into generations, top row first. The map is
   * the one region whose layout is two-dimensional, so its arrows follow what
   * it shows — left/right are siblings, up/down change depth.
   */
  rows?: string[][];
}

/**
 * What is on screen right now. The map lies across the top, the columns run
 * left to right beneath it — an L, not a row. Regions that are not on screen
 * are simply absent.
 */
export interface Layout {
  map: Region | null;
  columns: Region[];
}

export interface FocusPosition {
  region: RegionId;
  item: string;
}

/**
 * The last item focused in each region, so entering one resumes it — plus
 * `column`, the column the mind map hands focus back down to.
 */
export type FocusMemory = Partial<Record<RegionId, string>> & { column?: RegionId };

export type NavKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

export type NavResult =
  | { kind: 'move'; to: FocusPosition }
  | { kind: 'toggle'; item: string; expanded: boolean }
  | { kind: 'none' };

/** Where the focus is, and what else is open in front of it. */
export interface KeyContext {
  inComposer: boolean;
  /**
   * Something else owns Escape — a drawer, a popup, a menu, a side question.
   * It only takes Escape away; the ring keeps navigating.
   */
  escapeTaken: boolean;
  /**
   * A real modal is up (settings, feedback, a search dialog). It takes the
   * keyboard entirely — a drawer does NOT, because a drawer is a region the
   * ring can walk into (user report 2026-08-11).
   */
  modalOpen: boolean;
}

export type Command =
  | { kind: 'enterStructure' }
  | { kind: 'leaveStructure' }
  | { kind: 'returnToComposer'; text: string }
  | { kind: 'activate' }
  | { kind: 'nav'; key: NavKey }
  | { kind: 'ignore' };

const NAV_KEYS: NavKey[] = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

/**
 * A text field and an item are different focus targets, so the same key can
 * mean two things without a mode: the browser already knows which one holds
 * focus, and the focus ring shows the user.
 */
export function interpretKey(event: KeyboardEvent, ctx: KeyContext): Command {
  if (event.ctrlKey || event.metaKey || event.altKey) return { kind: 'ignore' };

  if (event.key === 'Escape') {
    // Escape keeps its twelve existing jobs; these are only the last steps of
    // the chain, reached when there is nothing left to close. The same key
    // gets the user in and back out again.
    if (ctx.escapeTaken || ctx.modalOpen) return { kind: 'ignore' };
    return ctx.inComposer ? { kind: 'enterStructure' } : { kind: 'leaveStructure' };
  }

  if (ctx.inComposer || ctx.modalOpen) return { kind: 'ignore' };

  if (NAV_KEYS.includes(event.key as NavKey)) {
    return { kind: 'nav', key: event.key as NavKey };
  }
  if (event.key === 'Enter') return { kind: 'activate' };
  // Any printable key silently hands focus back to the composer and types —
  // the same unexplained rule /btw already uses for dismissal.
  if (event.key.length === 1) return { kind: 'returnToComposer', text: event.key };

  return { kind: 'ignore' };
}

/**
 * The stand-in item for a source that carries no highlights yet. Focusing it
 * turns the page rather than jumping to a marking, and it exists only so the
 * source region is never empty while it is on screen.
 */
export const PAGE_ITEM = 'page';

/** What the app has on screen right now, in the caller's own terms. */
export interface ScreenState {
  /** Generations of map nodes, top row first — null while the chat is showing. */
  mindMapRows: string[][] | null;
  sidebarItems: string[];
  sidebarExpanded: Record<string, boolean>;
  /** Highlight ids of the visible source — null when the tree has no source. */
  sourceHighlightIds: string[] | null;
  /** Message ids, with the composer and its controls last. */
  chatItems: string[];
  /** Drawer card ids — null while the drawer is closed. */
  drawerItems: string[] | null;
  /**
   * An open menu's items — null when none is open. A menu takes the keyboard
   * to itself: while one is up it is the only region there is.
   */
  menuItems?: string[] | null;
  menuRows?: string[][] | null;
  /**
   * The same items again, grouped into visual rows. Optional: a caller that
   * only knows the order gets rows of one, which is how most regions look
   * anyway.
   */
  sidebarRows?: string[][] | null;
  sourceRows?: string[][] | null;
  chatRows?: string[][] | null;
  drawerRows?: string[][] | null;
}

export function buildLayout(screen: ScreenState): Layout {
  // An open menu is the whole map while it lasts. Anything else would let the
  // ring wander out from under a menu that is still covering the screen.
  if (screen.menuItems?.length) {
    return {
      map: null,
      columns: [{ id: 'menu', items: screen.menuItems, rows: screen.menuRows ?? undefined }],
    };
  }

  const columns: Region[] = [
    {
      id: 'sidebar',
      items: screen.sidebarItems,
      expanded: screen.sidebarExpanded,
      rows: screen.sidebarRows ?? undefined,
    },
  ];
  if (screen.sourceHighlightIds) {
    columns.push({
      id: 'source',
      items: screen.sourceHighlightIds.length ? screen.sourceHighlightIds : [PAGE_ITEM],
      rows: screen.sourceHighlightIds.length ? screen.sourceRows ?? undefined : undefined,
    });
  }
  columns.push({ id: 'chat', items: screen.chatItems, rows: screen.chatRows ?? undefined });
  if (screen.drawerItems) {
    columns.push({ id: 'highlights', items: screen.drawerItems, rows: screen.drawerRows ?? undefined });
  }

  return {
    map: screen.mindMapRows
      ? { id: 'map', items: screen.mindMapRows.flat(), rows: screen.mindMapRows }
      : null,
    columns: columns.filter(c => c.items.length > 0),
  };
}

export function navigate(
  key: NavKey,
  from: FocusPosition,
  layout: Layout,
  memory: FocusMemory,
): NavResult {
  const isMap = from.region === 'map';
  const index = layout.columns.findIndex(c => c.id === from.region);
  const region = isMap ? layout.map : layout.columns[index];

  // The region the ring was in can vanish under the user — the highlights
  // drawer covers the chat column whole. Land somewhere real instead of
  // navigating from a place that is no longer there.
  if (!region) return reenter(layout, memory);

  // Every region is rows, mostly rows of one. Where several controls sit side
  // by side — the composer's buttons, the sidebar's header, a generation of
  // map nodes — left/right walk them first.
  const rows = region.rows ?? region.items.map(item => [item]);
  const row = rows.findIndex(r => r.includes(from.item));
  if (row === -1) {
    return rows[0]?.[0]
      ? { kind: 'move', to: { region: region.id, item: rows[0][0] } }
      : reenter(layout, memory);
  }
  const at = rows[row].indexOf(from.item);

  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const next = rows[row + (key === 'ArrowDown' ? 1 : -1)];
    // Land on the control nearest the one being left, so the ring keeps its
    // horizontal place instead of snapping back to the start of the row.
    if (next) {
      return { kind: 'move', to: { region: region.id, item: next[Math.min(at, next.length - 1)] } };
    }
    // Edge overflow, vertical: up out of a column rises into the map, down out
    // of the map drops back into the columns. Nothing else overflows.
    if (key === 'ArrowUp' && !isMap && layout.map) {
      return { kind: 'move', to: { region: 'map', item: enter(layout.map, memory) } };
    }
    if (key === 'ArrowDown' && isMap) {
      const back = layout.columns.find(c => c.id === memory.column) ?? layout.columns[0];
      return back
        ? { kind: 'move', to: { region: back.id, item: enter(back, memory) } }
        : { kind: 'none' };
    }
    return { kind: 'none' };
  }

  const step = key === 'ArrowLeft' ? -1 : 1;
  const sibling = rows[row][at + step];
  if (sibling) return { kind: 'move', to: { region: region.id, item: sibling } };

  // Edge overflow: a tree node that can still collapse or expand keeps the key.
  const expanded = region.expanded?.[from.item];
  if (key === 'ArrowLeft' && expanded === true) {
    return { kind: 'toggle', item: from.item, expanded: false };
  }
  if (key === 'ArrowRight' && expanded === false) {
    return { kind: 'toggle', item: from.item, expanded: true };
  }

  // No region lies beside the map — it spans the full width.
  if (isMap) return { kind: 'none' };
  const nextRegion = layout.columns[index + step];
  if (!nextRegion) return { kind: 'none' };
  return { kind: 'move', to: { region: nextRegion.id, item: enter(nextRegion, memory) } };
}

/** Nothing under the ring is real any more — start over in the first region. */
function reenter(layout: Layout, memory: FocusMemory): NavResult {
  const first = layout.columns[0];
  return first
    ? { kind: 'move', to: { region: first.id, item: enter(first, memory) } }
    : { kind: 'none' };
}

/** Entering a region resumes the item it was last left on, if it still exists. */
function enter(region: Region, memory: FocusMemory): string {
  const remembered = memory[region.id];
  return remembered && region.items.includes(remembered) ? remembered : region.items[0];
}
