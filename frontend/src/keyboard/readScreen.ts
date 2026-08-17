import type { ScreenState } from './focusMap';

/**
 * Reads the keyboard regions back off the screen (ADR-0011).
 *
 * The alternative — App assembling the item lists from its own state — would
 * be a second copy of the layout, and the two would drift the first time a
 * component decided to render a row differently. Here a component opts in with
 * one attribute and is, by construction, never out of step.
 */

/** Two nodes belong to the same generation if their tops are this close. */
const ROW_TOLERANCE_PX = 24;

export function readScreen(root: Document | HTMLElement): ScreenState {
  const sidebar = root.querySelector('[data-focus-region="sidebar"]');
  const sidebarRows = itemsIn(sidebar);

  const sidebarExpanded: Record<string, boolean> = {};
  sidebar?.querySelectorAll<HTMLElement>('[data-focus-item][data-focus-expanded]').forEach(el => {
    sidebarExpanded[el.dataset.focusItem!] = el.dataset.focusExpanded === 'true';
  });

  const map = root.querySelector('[data-focus-region="map"]');
  const menu = root.querySelector('[role="menu"]');

  // menuItemsIn stamps the ids, so rowsIn can see them afterwards — a menu's
  // colour swatches sit side by side and must answer to ← → like any other row.
  const menuItems = menu ? menuItemsIn(menu) : null;

  return {
    menuItems,
    menuRows: menu ? rowsIn(menu) : null,
    mindMapRows: map ? rowsIn(map) : null,
    sidebarItems: sidebarRows,
    sidebarRows: rowsIn(sidebar),
    sidebarExpanded,
    sourceHighlightIds: regionItems(root, 'source'),
    sourceRows: rowsOf(root, 'source'),
    chatItems: itemsIn(root.querySelector('[data-focus-region="chat"]')),
    chatRows: rowsOf(root, 'chat'),
    drawerItems: regionItems(root, 'highlights'),
    drawerRows: rowsOf(root, 'highlights'),
  };
}

/**
 * Menus join in without a single edit: every one in the app already marks
 * itself with role="menu"/"menuitem", and their test ids are stable enough to
 * name an item by.
 */
/**
 * Inside a menu, every button is an item — the app's menus are not consistent
 * about role="menuitem" (the highlight actions menu has none), and asking each
 * one to be annotated would be a rule nobody remembers. The id is stamped onto
 * the element so the rest of the machinery can address it like any other item;
 * doing it here keeps menus from needing a single edit to join in.
 */
function menuItemsIn(menu: Element): string[] {
  const selector = 'button, [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';
  return Array.from(menu.querySelectorAll<HTMLElement>(selector))
    .filter(el => isLaidOut(el))
    .map((el, i) => {
      if (!el.dataset.focusItem) el.dataset.focusItem = el.dataset.testid ?? `menu-item-${i}`;
      return el.dataset.focusItem;
    });
}

/** Null when the region is not on screen at all — absent, not empty. */
function regionItems(root: Document | HTMLElement, region: string): string[] | null {
  const el = root.querySelector(`[data-focus-region="${region}"]`);
  return el ? itemsIn(el) : null;
}

function itemsIn(region: Element | null): string[] {
  if (!region) return [];
  // Deduplicated: a highlight spanning several lines — or a formula split into
  // baseline bands — wears its id on every piece it is drawn in, and is still
  // one item (user report 2026-08-11).
  return unique(Array.from(region.querySelectorAll<HTMLElement>('[data-focus-item]'))
    // A control the layout has hidden is not an item: the model picker is
    // display:none in a narrow chat column, and a ring on it would simply
    // vanish (user report 2026-08-11). jsdom reports every box as 0×0, so the
    // tests that care stub getBoundingClientRect.
    .filter(el => isLaidOut(el))
    .map(el => el.dataset.focusItem!)
    .filter(Boolean));
}

function unique(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

function isLaidOut(el: HTMLElement): boolean {
  // checkVisibility is the browser's own answer and covers display:none,
  // visibility:hidden and content-visibility alike. jsdom does not implement
  // it — and reports every box as 0×0 — so where it is missing, everything
  // counts as laid out rather than nothing.
  return el.checkVisibility?.({ checkVisibilityCSS: true } as never) ?? true;
}

function rowsOf(root: Document | HTMLElement, region: string): string[][] | null {
  const el = root.querySelector(`[data-focus-region="${region}"]`);
  return el ? rowsIn(el) : null;
}

/**
 * A region's rows are not stored anywhere — they are visible. Items sharing a
 * horizontal band sit side by side, whether they are a generation of map nodes
 * or the composer's buttons, so reading their tops needs no bookkeeping to keep
 * in sync with the layout.
 */
function rowsIn(region: Element | null): string[][] {
  if (!region) return [];
  const elements = Array.from(region.querySelectorAll<HTMLElement>('[data-focus-item]'))
    .filter(el => isLaidOut(el));
  // A *group* can say its items are a reading sequence rather than a layout of
  // rows. Two highlights on the same line of a paper share a band but are not
  // side-by-side controls: grouping them made ← walk through them instead of
  // leaving for the sidebar (user report 2026-08-11). The PDF pane holds both
  // kinds — a toolbar that IS a row, and the marks that are not — so the mark
  // is on the group, not the region.
  const isSequence = (el: HTMLElement) => !!el.closest('[data-focus-axis="sequence"]');
  // No geometry to read (jsdom, or a region that has not been laid out yet):
  // every item is its own row, which is what most regions look like anyway.
  // Grouping them all into one row on equal tops would be a lie.
  if (elements.every(el => { const r = el.getBoundingClientRect(); return !r.width && !r.height; })) {
    return elements.map(el => [el.dataset.focusItem!]);
  }
  const nodes = elements
    .map(el => ({
      id: el.dataset.focusItem!,
      top: el.getBoundingClientRect().top,
      sequence: isSequence(el),
    }))
    .sort((a, b) => a.top - b.top);

  const rows: { top: number; ids: string[]; sequence: boolean }[] = [];
  const placed = new Set<string>();
  for (const node of nodes) {
    // Same deduplication as itemsIn: the topmost piece decides where the item
    // sits, the rest are the same item drawn again.
    if (placed.has(node.id)) continue;
    placed.add(node.id);
    const row = rows[rows.length - 1];
    const joins =
      row && !row.sequence && !node.sequence && Math.abs(node.top - row.top) <= ROW_TOLERANCE_PX;
    if (joins) row.ids.push(node.id);
    else rows.push({ top: node.top, ids: [node.id], sequence: node.sequence });
  }
  return rows.map(r => r.ids);
}

/**
 * The element wearing a given focus position. Menus are addressed through
 * their role, not a region attribute, and their items may be named by test id
 * — everything else is the plain pair of data attributes.
 */
export function findItem(region: string, item: string): HTMLElement | null {
  return findItemPieces(region, item)[0] ?? null;
}

/**
 * Every element the item is drawn in. A highlight that wraps over three lines
 * — or a formula split into baseline bands — is one item painted three times,
 * and the ring belongs on all of it, not on whichever piece came first (user
 * report 2026-08-11).
 */
export function findItemPieces(region: string, item: string): HTMLElement[] {
  const id = CSS.escape(item);
  const scope = region === 'menu' ? '[role="menu"]' : `[data-focus-region="${region}"]`;
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      `${scope} [data-focus-item="${id}"], ${scope} [data-testid="${id}"]`,
    ),
  );
}
