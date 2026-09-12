import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildLayout,
  interpretKey,
  navigate,
  type FocusMemory,
  type FocusPosition,
  type Layout,
  type RegionId,
} from '../keyboard/focusMap';
import { findItemPieces, readScreen } from '../keyboard/readScreen';

/**
 * Keyboard navigation, wired to the screen (ADR-0011).
 *
 * Components opt in with a single `data-focus-item="<id>"` attribute. This hook
 * decides which of them wears the focus ring, marks it with `data-focus-ring`
 * and scrolls it into view. Nothing else about a component changes — no new
 * props, no context, no wrapper.
 */

export interface KeyboardNavigationOptions {
  /** A drawer, popup, menu or side question owns Escape — arrows still work. */
  escapeTaken: boolean;
  /** A modal dialog is up and takes the keyboard entirely. */
  modalOpen: boolean;
  onActivate: (position: FocusPosition) => void;
  onToggleNode: (item: string, expanded: boolean) => void;
  onReturnToComposer: (text: string) => void;
}

const COLUMN_IDS: RegionId[] = ['sidebar', 'source', 'chat', 'highlights'];

/**
 * Where the very first Escape puts the ring. The app already tells the user
 * where they are — the sidebar marks the open chat with a blue pill — so the
 * ring agrees with it instead of appearing somewhere they were not looking
 * (user report 2026-08-11). Once the ring has been somewhere, it goes back
 * there.
 */
function entryPoint(layout: Layout, memory: FocusMemory): FocusPosition | null {
  const remembered = memory.column && layout.columns.find(c => c.id === memory.column);
  if (remembered) {
    const item = memory[remembered.id];
    if (item && remembered.items.includes(item)) return { region: remembered.id, item };
  }
  const active = document
    .querySelector('[data-focus-region] [data-focus-item][data-focus-active="true"]');
  const region = active?.closest('[data-focus-region]')?.getAttribute('data-focus-region');
  const item = active?.getAttribute('data-focus-item');
  if (region && item && layout.columns.some(c => c.id === region && c.items.includes(item))) {
    return { region: region as RegionId, item };
  }
  const fallback = layout.columns.find(c => c.id === 'chat') ?? layout.columns[0];
  return fallback ? { region: fallback.id, item: fallback.items[0] } : null;
}

/**
 * The ring itself: one overlay on <body>, positioned over the union of every
 * piece the focused item is drawn in. Living outside the app's panes means no
 * `overflow: hidden` can clip it and a multi-part item still reads as one
 * thing.
 */
const RING_ID = 'syflo-focus-ring';
// How long after an Enter a torn-down focus place may re-land (a chat switch
// includes a fetch, so it is generous — but short enough that an unrelated
// later disappearance keeps the old rescue path).
const RELAND_WINDOW_MS = 3000;
const RING_PADDING_PX = 3;
// The ring never touches the edge of the region it lives in. A menu entry runs
// the full width of its card, so a ring flush with the card's border read as
// clipped (user report 2026-08-11).
const RING_INSET_PX = 3;

function ringElement(): HTMLElement {
  let el = document.getElementById(RING_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = RING_ID;
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
  }
  return el;
}

/**
 * The scroller the item is actually seen through, if it has one.
 *
 * The region is the whole column — the chat region spans header, transcript AND
 * composer — so clipping to it alone let a bubble taller than the transcript
 * draw its ring straight across the input field (user report 2026-08-12). The
 * scroll container is the exact window the item is visible in, and every list
 * that scrolls has one: the transcript, the drawer's card list, the PDF pane,
 * the sidebar tree. Items in a fixed layout (mind-map nodes, menu entries) find
 * none and keep the region as their only bound.
 */
function scrollClip(el: HTMLElement): DOMRect | null {
  for (let p: HTMLElement | null = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const style = getComputedStyle(p);
    if (/^(auto|scroll|overlay)$/.test(style.overflowY) || /^(auto|scroll|overlay)$/.test(style.overflowX)) {
      return p.getBoundingClientRect();
    }
  }
  return null;
}

function hiddenClip(el: HTMLElement): DOMRect | null {
  for (let p: HTMLElement | null = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const style = getComputedStyle(p);
    if (/hidden|clip/.test(style.overflowX) || /hidden|clip/.test(style.overflowY)) {
      return p.getBoundingClientRect();
    }
  }
  return null;
}

function drawRing(pieces: readonly HTMLElement[]): void {
  const rects = pieces.map(p => p.getBoundingClientRect()).filter(r => r.width > 0 || r.height > 0);
  if (rects.length === 0) return hideRing();
  let left = Math.min(...rects.map(r => r.left)) - RING_PADDING_PX;
  let top = Math.min(...rects.map(r => r.top)) - RING_PADDING_PX;
  let right = Math.max(...rects.map(r => r.right)) + RING_PADDING_PX;
  let bottom = Math.max(...rects.map(r => r.bottom)) + RING_PADDING_PX;

  // Clipped to the region it belongs to. The overlay lives on <body> so no
  // pane can cut it off — which also means nothing stops it from spilling
  // across a neighbour: a highlight scrolled half out of the PDF pane drew its
  // ring over the sidebar (user report 2026-08-11).
  const region = (pieces[0].closest('[data-focus-region], [role="menu"], [role="dialog"]') as HTMLElement | null)
    ?.getBoundingClientRect();
  // A hidden-overflow ancestor clips the item just like a scroller does — the
  // branch header's quote span is wider than its `truncate` div, and without
  // this bound the ring ran on over the header's buttons (user report
  // 2026-09-12).
  for (const bounds of [region, scrollClip(pieces[0]), hiddenClip(pieces[0])]) {
    if (!bounds) continue;
    left = Math.max(left, bounds.left + RING_INSET_PX);
    top = Math.max(top, bounds.top + RING_INSET_PX);
    right = Math.min(right, bounds.right - RING_INSET_PX);
    bottom = Math.min(bottom, bounds.bottom - RING_INSET_PX);
  }
  // And never outside the window itself. A popover wider than its column —
  // the model picker in a narrow chat column — hangs past the viewport edge,
  // and the ring inside it went with it (user report 2026-08-11).
  left = Math.max(left, RING_INSET_PX);
  top = Math.max(top, RING_INSET_PX);
  right = Math.min(right, window.innerWidth - RING_INSET_PX);
  bottom = Math.min(bottom, window.innerHeight - RING_INSET_PX);

  if (right <= left || bottom <= top) return hideRing();

  const el = ringElement();
  // Only touch the style when the geometry really moved — this runs once per
  // frame while the ring is up.
  const next = `${Math.round(left)},${Math.round(top)},${Math.round(right - left)},${Math.round(bottom - top)}`;
  if (el.dataset.geometry !== next) {
    el.dataset.geometry = next;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${right - left}px`;
    el.style.height = `${bottom - top}px`;
  }
  el.dataset.visible = 'true';
}

/**
 * Bring the WHOLE item into view, not just its first piece. A formula's first
 * band is its superscript, so scrolling that alone left the ring's lower edge
 * under the pane's horizontal scrollbar (user report 2026-08-11). Scrolling
 * the lowest piece and then the highest one costs two minimal `nearest`
 * scrolls and always ends with both edges clear — `scroll-margin` in index.css
 * supplies the gap.
 */
function scrollIntoView(pieces: readonly HTMLElement[]): void {
  const ordered = [...pieces].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (!first) return;
  // A box that HIDES its overflow is not a window the user can scroll back,
  // but scrollIntoView still scrolls it programmatically: the branch header's
  // truncated quote is wider than its `truncate` div, so ringing it shoved the
  // "Branched from" label out of the box — and it stayed out (user report
  // 2026-09-12). Snapshot every hidden-overflow ancestor and put it back.
  const restore = snapshotHiddenScrollers(first);
  // An item taller than the window it is seen through — a PDF page, or a
  // transcript block of 463 px in a 230 px list (measured 2026-08-17) — never
  // fits, so show its top. The window is the SCROLLER where there is one: the
  // viewport is far taller than the video pane's list, so measuring against it
  // left a tall block scrolled to the middle and the ring drew a straight line
  // through its text at both edges (user report with picture 2026-08-17).
  const union = last.getBoundingClientRect().bottom - first.getBoundingClientRect().top;
  const seenThrough = scrollClip(first)?.height ?? window.innerHeight;
  if (union > seenThrough * 0.9) {
    first.scrollIntoView({ block: 'start' });
    restore();
    return;
  }
  last.scrollIntoView({ block: 'nearest' });
  first.scrollIntoView({ block: 'nearest' });
  restore();
}

function snapshotHiddenScrollers(el: HTMLElement): () => void {
  const saved: Array<{ el: HTMLElement; left: number; top: number }> = [];
  for (let p: HTMLElement | null = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const style = getComputedStyle(p);
    if (/hidden|clip/.test(style.overflowX) || /hidden|clip/.test(style.overflowY)) {
      saved.push({ el: p, left: p.scrollLeft, top: p.scrollTop });
    }
  }
  return () => {
    for (const s of saved) {
      if (s.el.scrollLeft !== s.left) s.el.scrollLeft = s.left;
      if (s.el.scrollTop !== s.top) s.el.scrollTop = s.top;
    }
  };
}

function hideRing(): void {
  const el = document.getElementById(RING_ID);
  if (el) delete el.dataset.visible;
}

/**
 * Pulse the ring when it first appears (user request 2026-08-12): the moment
 * navigation mode goes on, the eye has to find a thin outline somewhere on a
 * full screen. The same glow already answers "where did I land?" after a jump
 * out of the highlights drawer, so the app says it the same way here. Only on
 * entering — an arrow key moves the ring, and a moving outline needs no
 * announcement.
 *
 * The beat itself lives in index.css (`#syflo-focus-ring[data-glow]`) and is
 * deliberately the SAME as the jump flash: three quick pulses of 0.45s
 * (2026-08-15). It used to be four slow ones of 0.75s — three seconds, for a
 * gesture meant to echo a 1.35s one. There is no JS timer here on purpose:
 * the attribute may stay, the animation ends by itself.
 *
 * Called from the frame loop, once the ring exists AND is visible: an animation
 * on a `display: none` element never runs. Clearing the attribute and reading a
 * layout property restarts the animation if it is somehow still going.
 *
 * The attribute is taken off again as soon as the pulse has run. Leaving it on
 * — "the animation ends by itself" — was true only as long as the ring stayed
 * on screen: a `display: none` and back RESTARTS a CSS animation, so every
 * step through the transcript lit the ring up again (user report 2026-08-17).
 */
function glowRing(): void {
  const el = document.getElementById(RING_ID);
  if (!el || !el.dataset.visible) return;
  delete el.dataset.glow;
  void el.offsetWidth;
  el.addEventListener('animationend', () => { delete el.dataset.glow; }, { once: true });
  el.dataset.glow = 'true';
}

/** Anything that swallows arrow keys for a caret of its own. */
function isTextField(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'INPUT' ||
    el.isContentEditable
  );
}

export function useKeyboardNavigation(options: KeyboardNavigationOptions): FocusPosition | null {
  const [focus, setFocus] = useState<FocusPosition | null>(null);
  const memory = useRef<FocusMemory>({});
  // The elements currently wearing the ring marker, so clearing them costs no
  // document query.
  const painted = useRef<HTMLElement[]>([]);
  // Set when the ring is about to come out for the first time; the frame loop
  // spends it as soon as the ring is on screen (see glowRing).
  const glowPending = useRef(false);
  // Which device made the last move. The menu takeover below needs it: a
  // pointerdown always comes BEFORE the menu a mouse gesture opens, so this is
  // false by the time that menu appears, and true for a menu opened with Enter.
  const lastInputWasKey = useRef(false);
  // When Enter last pressed something. An activation may tear down the place
  // the ring was in — "Open linked chat" closes its menu AND switches chats —
  // and inside this window the ring re-lands on the first message instead of
  // dying, so the keyboard journey continues (user request 2026-09-12). Kept
  // short so an unrelated later disappearance cannot teleport the ring.
  const activatedAt = useRef(0);

  // Read through a ref so the window listener is installed once and still sees
  // the current screen — re-binding it on every render would drop keystrokes
  // mid-stream.
  const latest = useRef(options);
  latest.current = options;
  const focusRef = useRef(focus);
  focusRef.current = focus;

  const remember = useCallback((position: FocusPosition) => {
    memory.current[position.region] = position.item;
    if (COLUMN_IDS.includes(position.region)) memory.current.column = position.region;
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      lastInputWasKey.current = true;
      const { modalOpen } = latest.current;
      // An open menu owns Escape, and the DOM already says so — asking it
      // beats asking every component that can open one to remember to report
      // it (user report 2026-08-11: Escape dropped the ring instead of
      // closing the attach menu).
      const escapeTaken = latest.current.escapeTaken || !!document.querySelector('[role="menu"]');
      // Ask the browser where the focus is rather than trusting this hook's
      // own state: a user who clicks into the composer while the ring is out
      // in the structure must get their arrow keys back (found in the running
      // app, 2026-08-10). The ring goes with them.
      const typing = isTextField(document.activeElement);
      const position = typing ? null : focusRef.current;
      // Typing in the MAIN composer puts the ring away — the user left the
      // structure. Typing in a dialog's field must NOT: the ring holds the
      // user's place there, and dropping it left nothing to restore when the
      // dialog closed (user report 2026-09-12).
      if (typing && focusRef.current && !modalOpen) setFocus(null);

      // One focus indicator, not two. The browser's own Tab ring competed with
      // this one and read as a second place the keyboard was (user report
      // 2026-08-11). Text fields and open overlays keep it — a settings form
      // still needs Tab to move between its fields.
      if (event.key === 'Tab' && !typing && !modalOpen) {
        event.preventDefault();
        return;
      }
      const command = interpretKey(event, { inComposer: !position, escapeTaken, modalOpen });
      if (command.kind === 'ignore') return;

      // Read the regions off the screen at press time, so the keyboard can
      // never disagree with what is actually rendered.
      const layout = buildLayout(readScreen(document));

      if (command.kind === 'enterStructure') {
        const next = entryPoint(layout, memory.current);
        if (!next) return;
        event.preventDefault();
        // Leaving the composer means leaving it: the text field must give up
        // the caret, or the next arrow key would still be moving it.
        (document.activeElement as HTMLElement | null)?.blur?.();
        remember(next);
        glowPending.current = true;
        setFocus(next);
        return;
      }

      if (command.kind === 'leaveStructure') {
        event.preventDefault();
        setFocus(null);
        return;
      }

      if (!position) return;
      event.preventDefault();

      if (command.kind === 'returnToComposer') {
        setFocus(null);
        latest.current.onReturnToComposer(command.text);
        return;
      }
      if (command.kind === 'activate') {
        activatedAt.current = Date.now();
        latest.current.onActivate(position);
        return;
      }

      const result = navigate(command.key, position, layout, memory.current);
      if (result.kind === 'toggle') {
        latest.current.onToggleNode(result.item, result.expanded);
      } else if (result.kind === 'move') {
        remember(result.to);
        setFocus(result.to);
      }
    };

    // Capture phase, deliberately. React flushes state synchronously for a
    // discrete event like keydown, so a listener running AFTER the drawer's
    // would already see `overlayOpen === false` and one Escape would both
    // close the drawer and enter the structure — two steps of the chain in one
    // press (found in the running app, 2026-08-10). Running first means the
    // chain is read as the user sees it.
    const onPointerDown = () => {
      lastInputWasKey.current = false;
      // The mouse took over — a pending keyboard re-landing would now fight it.
      activatedAt.current = 0;
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [remember]);

  // The ring is placed in viewport coordinates, so it has to follow whatever
  // moves the item underneath it. Scrolling fires events; panning the mind map
  // does NOT — React Flow moves its canvas with a CSS transform, so the ring
  // lagged ~20px behind the node after a drag (user report 2026-08-12). A
  // frame loop catches every cause at once: scroll, pan, zoom, transitions.
  // It only runs while a ring is on screen, and only writes when the geometry
  // actually changed.
  useEffect(() => {
    if (!focus) return;
    let frame = 0;
    const follow = () => {
      const current = focusRef.current;
      if (current) drawRing(findItemPieces(current.region, current.item));
      if (glowPending.current) {
        glowPending.current = false;
        glowRing();
      }
      frame = requestAnimationFrame(follow);
    };
    frame = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(frame);
  }, [focus]);

  // A menu usually opens without App re-rendering — the state lives in the
  // component that owns the button. Watch the document instead, so the ring
  // follows the menu the moment it appears rather than one keypress later.
  const [domVersion, setDomVersion] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(records => {
      // The focused item can be torn out by a component re-rendering on its
      // own — the sidebar swapping its tree for the root list ("Alle Chats")
      // commits no App render, so the rescue in the paint effect below never
      // ran and the ring silently died (user report 2026-09-12). Nudge it.
      const current = focusRef.current;
      const focusSel = current ? `[data-focus-item="${CSS.escape(current.item)}"]` : null;
      const touches = records.some(r =>
        [...r.addedNodes, ...r.removedNodes].some(n => {
          if (!(n instanceof HTMLElement)) return false;
          if (n.matches('[role="menu"]') || n.querySelector('[role="menu"]')) return true;
          return !!focusSel && (n.matches(focusSel) || !!n.querySelector(focusSel));
        }),
      );
      if (touches) setDomVersion(v => v + 1);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  // Paint the ring. Done straight on the DOM rather than through props so that
  // adopting keyboard navigation costs a component one attribute and nothing
  // else.
  // Deliberately without a dependency list: a region can disappear under the
  // ring without the focus changing — opening the highlights drawer covers the
  // chat column — and the ring would then sit on an element nobody can see
  // (found in the running app, 2026-08-10). Re-validating is one querySelector.
  useEffect(() => {
    // Clear via the remembered elements, not a document-wide query: this
    // effect runs on EVERY render — a streaming answer renders many times a
    // second — and sweeping the document each time is work for nothing.
    painted.current.forEach(el => el.removeAttribute('data-focus-ring'));
    painted.current = [];
    if (!focus) {
      hideRing();
      return;
    }
    // Scoped to the region: the mind map and the sidebar key their items by
    // the same chat ids, so a document-wide lookup always painted the sidebar
    // row and the ring looked stuck (found in the running app, 2026-08-10).
    const pieces = findItemPieces(focus.region, focus.item);
    const el = pieces[0];
    if (!el) {
      // The item is gone. The ring must survive every keyboard activation —
      // it leaves the screen only through Escape (user request 2026-09-12).
      // First choice: stay in the same region — "Alle Chats" swaps the tree
      // for the root list, so land on the row marked as the open chat; in the
      // chat column the first MESSAGE beats the header controls that precede
      // it in the DOM.
      const winActive = Date.now() - activatedAt.current < RELAND_WINDOW_MS;
      hideRing();
      const region = document.querySelector(`[data-focus-region="${focus.region}"]`);
      const replacement =
        region?.querySelector<HTMLElement>('[data-focus-active="true"]') ??
        (focus.region === 'chat'
          ? region?.querySelector<HTMLElement>('[data-testid^="message-row-"][data-focus-item]')
          : null) ??
        region?.querySelector<HTMLElement>('[data-focus-item]');
      let to: FocusPosition | null = replacement?.dataset.focusItem
        ? { region: focus.region, item: replacement.dataset.focusItem }
        : null;
      // The region itself is gone (a closed dialog or menu). First choice:
      // back to the remembered place in the column it came from — the very
      // button that opened it. Checked BEFORE the chat fallback: Enter inside
      // a dialog re-opens the window, and closing it a moment later teleported
      // the ring into the chat instead of back to the opener. Where a menu
      // action switched chats, the remembered item is gone with the old chat
      // and this hands over to the chat fallback below.
      if (!to) {
        const col = memory.current.column;
        const rem = col ? memory.current[col] : undefined;
        if (col && rem && document.querySelector(
          `[data-focus-region="${col}"] [data-focus-item="${CSS.escape(rem)}"]`,
        )) {
          to = { region: col, item: rem };
        }
      }
      // "Open linked chat" closes its menu AND switches chats. After a fresh
      // Enter the journey continues on the first message of the (new) chat;
      // while that chat is still loading, keep the position and let a later
      // render retry — this effect runs on every one. The window is not spent
      // on a landing: the first one can hit the OLD chat's message a render
      // before the switch replaces it, and the second tear-down must still
      // re-land. It simply expires.
      if (!to && winActive) {
        const first = document.querySelector<HTMLElement>(
          '[data-focus-region="chat"] [data-testid^="message-row-"][data-focus-item]',
        );
        if (first?.dataset.focusItem) {
          to = { region: 'chat', item: first.dataset.focusItem };
        } else {
          // No chat either — the button that vanished opened something that
          // replaced it (the highlights drawer covers the chat column whole).
          // Continue in the first region that exists, the drawer before the
          // sidebar: the user just opened it and wants to be inside.
          for (const id of ['highlights', 'source', 'sidebar'] as const) {
            const item = document.querySelector<HTMLElement>(
              `[data-focus-region="${id}"] [data-focus-item]`,
            )?.dataset.focusItem;
            if (item) {
              to = { region: id, item };
              break;
            }
          }
          // Nothing on screen yet — keep the position, a later render retries.
          if (!to) return;
        }
      }
      if (to && winActive) {
        remember(to);
        // The re-landing is a jump the eye has to find — same glow as
        // entering the structure.
        glowPending.current = true;
      }
      setFocus(to);
      return;
    }
    // A menu that just opened takes the ring with it — the user pressed a
    // button expecting to land inside what it opened.
    //
    // Only when a KEY opened it. The selection popup is a menu too, and a mouse
    // drag across the PDF opens it: with the ring out in the structure, it
    // suddenly jumped into that popup, which the user never asked for and had
    // no way to predict (user report 2026-08-12). A pointerdown always precedes
    // a mouse-opened menu, so `lastInputWasKey` is already false here; Enter's
    // synthetic click is not a pointer event, so a keyboard-opened menu still
    // takes the ring. Arrow keys reach the popup either way — while it is open
    // it is the only region, so the next press walks straight into it.
    if (focus.region !== 'menu' && focus.region !== 'menuRail' && lastInputWasKey.current) {
      const layout = buildLayout(readScreen(document));
      const first = layout.columns[0];
      if ((first?.id === 'menu' || first?.id === 'menuRail') && first.items[0]) {
        // Enter on the element the dialog marks as "here you are" — the
        // settings dialog stamps its ACTIVE tab, the way the sidebar marks
        // the open chat (user request 2026-09-12). Menus without one start
        // on their first entry, as before.
        const surface = document.querySelector('[role="menu"], [role="dialog"]');
        const active = surface?.querySelector<HTMLElement>('[data-focus-active="true"]')
          ?.dataset.focusItem;
        const item = active && layout.columns.some(c => c.items.includes(active))
          ? active
          : first.items[0];
        const region = layout.columns.find(c => c.items.includes(item))?.id ?? first.id;
        hideRing();
        setFocus({ region, item });
        return;
      }
    }
    pieces.forEach(piece => piece.setAttribute('data-focus-ring', 'true'));
    painted.current = pieces;
    // ONE outline around the whole item, not one per piece. A formula is
    // stored as several bands, and three separate boxes read as three things
    // rather than one (user report 2026-08-11). Drawn as a single overlay on
    // <body>, which also frees it from every `overflow: hidden` ancestor that
    // used to clip it.
    // Scroll FIRST, measure after. Drawn the other way round, the ring was
    // placed on the item's old position — outside the list it lives in, so
    // `drawRing` hid it — and only came back on the next frame, once the scroll
    // had happened. That flicker is what made the ring glow at every step
    // through the transcript: display:none and back restarts the animation
    // (user report 2026-08-17).
    scrollIntoView(pieces);
    drawRing(pieces);
    // domVersion is read so a menu appearing re-runs this effect.
    void domVersion;
  });

  return focus;
}
