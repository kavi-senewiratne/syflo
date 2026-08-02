/**
 * chat/highlightAnchors.ts
 *
 * Anchor math + paint registry for chat-text highlights
 * (design/mockup-chat-highlights-ask-in-chat.html).
 *
 * Chat highlights anchor to character offsets in a message's rendered plain
 * text (the concatenated text nodes under the bubble's content root). That
 * makes them reflow-safe: unlike the PDF's geometric rects, offsets survive
 * window resizes, column drags, and theme changes.
 *
 * Painting uses the CSS Custom Highlight API (CSS.highlights +
 * ::highlight() rules in index.css) instead of wrapping <mark> elements —
 * the markdown DOM stays untouched, so React reconciliation never fights
 * imperative wrappers. One registry entry per color; each message
 * contributes its ranges and withdraws them on unmount.
 *
 * jsdom (vitest) has no Custom Highlight API — every paint call no-ops
 * behind `supportsCustomHighlights`, while the pure offset math stays
 * testable.
 */

import type { HighlightColor, MessageHighlight } from '../types';
import { HIGHLIGHT_COLORS } from '../types';

// Style names referenced by ::highlight() rules in index.css.
const styleName = (color: HighlightColor) => `syflo-chat-hl-${color}`;

// Color-independent overlay marking highlights that link to a branched chat
// (underline, stacked on top of the color-specific background).
const LINKED_STYLE = 'syflo-chat-hl-linked';

export const supportsCustomHighlights =
  typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

// ─── Offset math (pure, testable) ───────────────────────────────────────────

// Character offset of (node, nodeOffset) within root's concatenated text.
// Range.toString() concatenates exactly the text-node data inside the range,
// which matches the TreeWalker accumulation used by rangeFromOffsets below.
export function textOffsetInRoot(root: Node, node: Node, nodeOffset: number): number {
  const r = document.createRange();
  r.selectNodeContents(root);
  r.setEnd(node, nodeOffset);
  return r.toString().length;
}

// Build a live Range spanning [startOffset, endOffset) of root's text.
// Returns null when the offsets exceed the current text (message content
// changed since the highlight was saved) — the caller simply skips painting.
export function rangeFromOffsets(root: Node, startOffset: number, endOffset: number): Range | null {
  if (startOffset < 0 || endOffset <= startOffset) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let startNode: Text | null = null;
  let startInNode = 0;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const next = pos + node.data.length;
    if (startNode === null && startOffset < next) {
      startNode = node;
      startInNode = startOffset - pos;
    }
    if (startNode !== null && endOffset <= next) {
      const range = document.createRange();
      range.setStart(startNode, startInNode);
      range.setEnd(node, endOffset - pos);
      return range;
    }
    pos = next;
    node = walker.nextNode() as Text | null;
  }
  return null;
}

// Find the highlight under a screen point (for right-click on an existing
// mark). Uses the caret position API to translate the point into a text
// offset, then scans the message's highlights for one covering it.
export function highlightAtPoint(
  root: Node,
  highlights: MessageHighlight[],
  x: number,
  y: number,
): MessageHighlight | null {
  const caret = document.caretRangeFromPoint?.(x, y);
  if (!caret || !root.contains(caret.startContainer)) return null;
  const offset = textOffsetInRoot(root, caret.startContainer, caret.startOffset);
  return (
    highlights.find((h) => h.startOffset <= offset && offset < h.endOffset) ?? null
  );
}

// ─── KaTeX formulas: paint the box, not its glyphs ──────────────────────────
//
// ::highlight() only covers the inline boxes of real TEXT nodes. A KaTeX
// formula is a stack of tiny spans whose spacing lives in `margin-right` on
// .mbin/.mrel and in empty .mspace elements — none of which carry text. So a
// highlight over a formula came out striped, and the linked-chat underline
// restarted at every sub/superscript's own .vlist baseline instead of running
// as one line (user report 2026-08-01).
//
// A formula is atomic to the reader anyway, so any highlight that touches one
// paints the WHOLE `.katex` box through element rules (see index.css) — one
// continuous background, one continuous underline — and the formula's offset
// span is CUT OUT of the ranges handed to the Custom Highlight API, so the
// glyphs are never painted twice.

const FORMULA_ATTR = 'data-syflo-hl';
const FORMULA_LINKED_ATTR = 'data-syflo-hl-linked';
const FORMULA_FLASH_ATTR = 'data-syflo-hl-flash';

export interface FormulaSpan {
  el: HTMLElement;
  start: number;
  end: number;
}

function asElement(root: Node): Element | null {
  return typeof (root as Element).querySelectorAll === 'function' ? (root as Element) : null;
}

// The offset span each top-level `.katex` box occupies in root's text. Range
// text and the TreeWalker in rangeFromOffsets accumulate the same text-node
// data, so these offsets live in the same coordinate system as a highlight's.
export function formulaSpans(root: Node): FormulaSpan[] {
  const el = asElement(root);
  if (!el) return [];
  const spans: FormulaSpan[] = [];
  for (const node of Array.from(el.querySelectorAll<HTMLElement>('.katex'))) {
    // .katex-display wraps a .katex; only the outermost box gets painted.
    if (node.parentElement?.closest('.katex')) continue;
    const length = (node.textContent ?? '').length;
    if (length === 0) continue;
    const before = document.createRange();
    before.selectNodeContents(el);
    before.setEndBefore(node);
    const start = before.toString().length;
    spans.push({ el: node, start, end: start + length });
  }
  return spans;
}

const touches = (span: FormulaSpan, start: number, end: number) =>
  span.start < end && span.end > start;

// [start, end) minus every formula span — the pieces ::highlight() may paint.
export function offsetsOutsideFormulas(
  start: number,
  end: number,
  spans: FormulaSpan[],
): Array<[number, number]> {
  let pieces: Array<[number, number]> = [[start, end]];
  for (const span of spans) {
    const next: Array<[number, number]> = [];
    for (const [a, b] of pieces) {
      if (!touches(span, a, b)) {
        next.push([a, b]);
        continue;
      }
      if (a < span.start) next.push([a, span.start]);
      if (span.end < b) next.push([span.end, b]);
    }
    pieces = next;
  }
  return pieces;
}

function clearFormulaMarks(root: Node, ...attrs: string[]): void {
  const el = asElement(root);
  if (!el) return;
  const selector = attrs.map((a) => `[${a}]`).join(',');
  for (const node of Array.from(el.querySelectorAll<HTMLElement>(selector))) {
    for (const attr of attrs) node.removeAttribute(attr);
    node.style.removeProperty(UNDERLINE_VAR);
  }
}

// The linked-chat underline cannot come from `text-decoration` on the box:
// `.katex` is an inline-block, and Chromium paints no decoration across an
// atomic inline (measured 2026-08-01 on a rendered formula — the red test
// line stopped dead for the exact width of the box, and putting the rule on
// the inner .katex-html, an inline-block too, changed nothing). A 1px
// background gradient spans the whole box instead (see index.css), but it
// must sit on the LINE's baseline: the box bottom is 0.3em of padding below
// the descenders, which drew the line visibly lower than the prose one.
//
// A zero-height empty inline-block is baseline-aligned with its bottom edge
// ON the baseline — inserting one next to the formula, measuring, and
// removing it again (all inside the same layout effect, so React never sees
// it) gives the exact distance from the box bottom up to the baseline.
const UNDERLINE_VAR = '--syflo-hl-underline-bottom';
// Chromium puts a `text-underline-offset: 3px` line exactly 3px below the
// baseline — measured across 12/13/14/16/18/22/28px type, constant 3.0px, so
// the prose rule and this one meet at the same y.
const UNDERLINE_OFFSET_PX = 3;
// …plus one: in `background-position`, 100% means "container height MINUS
// image height", so a 1px line placed at 100% already sits 1px high. Keep in
// sync with background-size in index.css.
const UNDERLINE_THICKNESS_PX = 1;

function setUnderlineOffset(el: HTMLElement): void {
  const parent = el.parentNode;
  if (!parent || typeof el.getBoundingClientRect !== 'function') return;
  const probe = document.createElement('span');
  probe.style.cssText = 'display:inline-block;width:0;height:0;overflow:hidden';
  parent.insertBefore(probe, el);
  const baseline = probe.getBoundingClientRect().bottom;
  parent.removeChild(probe);
  const bottom = el.getBoundingClientRect().bottom;
  const offset = bottom - baseline - UNDERLINE_OFFSET_PX - UNDERLINE_THICKNESS_PX;
  // jsdom (and a formula not laid out yet) reports zeros — leave the CSS
  // fallback in place rather than pinning the line to a bogus offset.
  if (!Number.isFinite(offset) || bottom === 0) return;
  el.style.setProperty(UNDERLINE_VAR, `${offset}px`);
}

// ─── Paint registry (Custom Highlight API) ──────────────────────────────────

// message id → color → live ranges currently painted for that message.
const rangesByMessage = new Map<string, Map<HighlightColor, Range[]>>();
// message id → live ranges of highlights linked to a branched chat, painted
// as a second, color-independent layer stacked on the background above.
const linkedRangesByMessage = new Map<string, Range[]>();

function repaint(color: HighlightColor) {
  if (!supportsCustomHighlights) return;
  const all: Range[] = [];
  for (const perColor of rangesByMessage.values()) {
    const ranges = perColor.get(color);
    if (ranges) all.push(...ranges);
  }
  if (all.length === 0) {
    CSS.highlights.delete(styleName(color));
  } else {
    CSS.highlights.set(styleName(color), new Highlight(...all));
  }
}

function repaintLinked() {
  if (!supportsCustomHighlights) return;
  const all: Range[] = [];
  for (const ranges of linkedRangesByMessage.values()) all.push(...ranges);
  if (all.length === 0) {
    CSS.highlights.delete(LINKED_STYLE);
  } else {
    CSS.highlights.set(LINKED_STYLE, new Highlight(...all));
  }
}

// (Re)paint one message's highlights against its current content root.
// Called from a layout effect after every content change, so ranges never
// point at detached text nodes.
export function paintMessageHighlights(
  messageId: string,
  root: Node,
  highlights: MessageHighlight[],
): void {
  if (!supportsCustomHighlights) return;
  const perColor = new Map<HighlightColor, Range[]>();
  const linked: Range[] = [];
  // Formula boxes are marked from scratch on every repaint — a highlight the
  // user just deleted must not leave its color behind on the element.
  const spans = formulaSpans(root);
  clearFormulaMarks(root, FORMULA_ATTR, FORMULA_LINKED_ATTR);
  for (const h of highlights) {
    if (h.messageId !== messageId) continue;
    for (const span of spans) {
      if (!touches(span, h.startOffset, h.endOffset)) continue;
      span.el.setAttribute(FORMULA_ATTR, h.color);
      if (h.childChatId) {
        span.el.setAttribute(FORMULA_LINKED_ATTR, '');
        setUnderlineOffset(span.el);
      }
    }
    for (const [start, end] of offsetsOutsideFormulas(h.startOffset, h.endOffset, spans)) {
      const range = rangeFromOffsets(root, start, end);
      if (!range) continue;
      const list = perColor.get(h.color);
      if (list) list.push(range);
      else perColor.set(h.color, [range]);
      if (h.childChatId) linked.push(range);
    }
  }
  rangesByMessage.set(messageId, perColor);
  linkedRangesByMessage.set(messageId, linked);
  for (const color of HIGHLIGHT_COLORS) repaint(color);
  repaintLinked();
}

export function clearMessageHighlights(messageId: string): void {
  if (!supportsCustomHighlights) return;
  linkedRangesByMessage.delete(messageId);
  repaintLinked();
  if (!rangesByMessage.delete(messageId)) return;
  for (const color of HIGHLIGHT_COLORS) repaint(color);
}

// ─── Pending selection (popup open) ─────────────────────────────────────────
// Solange das Auswahl-Popup offen ist, soll die Textstelle exakt wie die
// native Browser-Selektion aussehen (Chromium malt ::highlight() nur über
// die Inline-Box — mit Lücken zwischen den Zeilen und ohne das Leading —,
// die Selektion dagegen über die volle Zeilenhöhe). Deshalb zweistufig:
//
//   1. Bevorzugt wird die NATIVE Selektion wiederhergestellt — das Öffnen
//      des Popups rendert die Bubble neu, der Markdown-DOM wird ersetzt und
//      die Selektion des Nutzers stirbt dabei. Der Paint-Effekt baut sie aus
//      den Offsets gegen den frischen DOM wieder auf → pixelgleicher Look.
//   2. Kollabiert die Selektion wirklich (Klick/Tippen im Popup), springt
//      ::highlight(syflo-chat-hl-pending) als Fallback ein, damit das Zitat
//      sichtbar bleibt, bis eine Aktion erfolgt oder das Popup schließt.
//
// Es gibt höchstens EINE pending Selektion app-weit; der Besitzer ist die
// Nachricht, in der sie erfasst wurde.

const PENDING_STYLE = 'syflo-chat-hl-pending';
let pendingOwner: string | null = null;
let pendingRange: Range | null = null;

// Links-Drag-Tracking: während der Nutzer eine NEUE Auswahl aufzieht, darf
// die Wiederherstellung nicht dazwischenfunken.
let leftMouseDown = false;
let listenersInstalled = false;
function installPendingListeners(): void {
  if (listenersInstalled || typeof document === 'undefined') return;
  listenersInstalled = true;
  document.addEventListener('mousedown', (e) => {
    if (e.button === 0) leftMouseDown = true;
  });
  document.addEventListener('mouseup', (e) => {
    if (e.button === 0) {
      leftMouseDown = false;
      // Klick fertig (Nutzer-Report 2026-07-22, 2. Runde): ein Klick in den
      // Text kollabiert die Selektion und ließ das Zitat dauerhaft auf den
      // ::highlight-Fallback (Inline-Box-Look) degradieren — außerhalb der
      // React-Commits malt niemand neu. Jetzt wird die native Selektion
      // direkt nach dem Klick wiederhergestellt.
      tryShowPending();
    }
  });
  // Kollabiert die Selektion zwischen zwei React-Commits (mousedown im
  // Popup), sofort reagieren — sonst wäre das Zitat für die Dauer der
  // Popup-Interaktion unmarkiert.
  document.addEventListener('selectionchange', tryShowPending);
}

// Steht der Fokus in einem Eingabefeld, würde removeAllRanges/addRange dem
// Nutzer den Caret klauen (z. B. beim Tippen der Frage im Popup).
function isTextEntryFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

// Überschneidet sich die live Selektion mit der pending Range? Dann zeigt
// die native Selektion das Zitat bereits an.
function liveSelectionShowsPending(range: Range): boolean {
  const live = window.getSelection?.();
  if (!live || live.rangeCount === 0 || live.isCollapsed) return false;
  try {
    const lr = live.getRangeAt(0);
    return (
      lr.compareBoundaryPoints(Range.END_TO_START, range) < 0 &&
      lr.compareBoundaryPoints(Range.START_TO_END, range) > 0
    );
  } catch (_err) {
    return false;
  }
}

// Kern der Zweistufigkeit: native Selektion zeigen, wo immer möglich —
// ::highlight-Fallback nur, wenn das Wiederherstellen gerade stören würde
// (Maus-Drag, Fokus im Eingabefeld, fremde Selektion). Läuft aus den
// Paint-Effekten UND aus den globalen Listenern (mouseup/selectionchange),
// damit auch Klicks ZWISCHEN React-Commits den Image-1-Look zurückholen.
function tryShowPending(): void {
  if (!pendingRange) return;
  const live = window.getSelection?.();
  if (live && liveSelectionShowsPending(pendingRange)) {
    // Die Selektion zeigt das Zitat bereits — nichts doppelt malen (der
    // Fallback-Stil unter der halbtransparenten Selektion verdunkelt sie).
    CSS.highlights.delete(PENDING_STYLE);
    return;
  }
  const collapsed = !live || live.rangeCount === 0 || live.isCollapsed;
  if (live && collapsed && !leftMouseDown && !isTextEntryFocused()) {
    try {
      live.removeAllRanges();
      live.addRange(pendingRange);
      CSS.highlights.delete(PENDING_STYLE);
      return;
    } catch (_err) {
      // Range zwischen Aufbau und addRange detached (Re-Render-Rennen) —
      // unten greift der Fallback-Stil.
    }
  }
  // Nutzer hat woanders selektiert, tippt gerade oder zieht mit der Maus:
  // Selektion nicht klauen, Fallback-Stil zeigt das Zitat weiter an.
  CSS.highlights.set(PENDING_STYLE, new Highlight(pendingRange));
}

// Pending-Zustand komplett fallen lassen (Popup zu / Aktion erfolgt /
// Unmount). WICHTIG: die programmatisch wiederhergestellte native Selektion
// mit abräumen — bleibt sie liegen, erfasst der nächste Rechtsklick den
// ALTEN Text (Nutzer-Report 2026-07-22, 2. Runde). Fremde Selektionen
// (kein Überlappen mit der Pending-Range) bleiben unangetastet.
function dropPending(): void {
  const live = window.getSelection?.();
  if (pendingRange && live && liveSelectionShowsPending(pendingRange)) {
    live.removeAllRanges();
  }
  pendingOwner = null;
  pendingRange = null;
  CSS.highlights.delete(PENDING_STYLE);
}

// Jede Bubble ruft das in ihrem Paint-Effekt auf: der Besitzer malt seine
// Range (jedes Commit neu, gegen den aktuellen DOM), alle anderen räumen nur
// dann auf, wenn sie zuvor Besitzer waren.
export function paintPendingChatSelection(
  messageId: string,
  root: Node,
  sel: { startOffset: number; endOffset: number } | null,
): void {
  if (!supportsCustomHighlights) return;
  if (!sel) {
    if (pendingOwner === messageId) dropPending();
    return;
  }
  installPendingListeners();
  pendingOwner = messageId;
  pendingRange = rangeFromOffsets(root, sel.startOffset, sel.endOffset);
  if (!pendingRange) {
    CSS.highlights.delete(PENDING_STYLE);
    return;
  }
  tryShowPending();
}

export function clearPendingChatSelection(messageId: string): void {
  if (!supportsCustomHighlights) return;
  if (pendingOwner !== messageId) return;
  dropPending();
}

// ─── Sprung-Flash (Highlights-Drawer) ────────────────────────────────────────
// Nach einem Drawer-Sprung blinkt die MARKIERUNG selbst auf, nicht die ganze
// Bubble (Nutzerkorrektur 2026-07-22) — und zwar in IHRER Farbe, wie beim
// PDF (Nutzerkorrektur 2026-07-22, 2. Runde): pro Farbe ein eigener Stil
// ::highlight(syflo-chat-hl-flash-<farbe>) in index.css. Das Blinken taktet
// ChatArea per State-Toggle, weil ::highlight()-Pseudoelemente nicht
// animierbar sind. priority hebt den Flash über die Farb-Stile, egal in
// welcher Reihenfolge registriert wurde.

const flashStyleName = (color: HighlightColor) => `syflo-chat-hl-flash-${color}`;
let flashOwner: string | null = null;
let flashStyle: string | null = null;

export function paintFlashChatRange(
  messageId: string,
  root: Node,
  sel: { startOffset: number; endOffset: number; color: HighlightColor } | null,
): void {
  if (!supportsCustomHighlights) return;
  clearFormulaMarks(root, FORMULA_FLASH_ATTR);
  if (!sel) {
    if (flashOwner === messageId) {
      flashOwner = null;
      if (flashStyle) CSS.highlights.delete(flashStyle);
      flashStyle = null;
    }
    return;
  }
  flashOwner = messageId;
  const style = flashStyleName(sel.color);
  if (flashStyle && flashStyle !== style) CSS.highlights.delete(flashStyle);
  // Same formula treatment as the static highlights: the box flashes as one
  // element, the prose around it as ranges.
  const spans = formulaSpans(root);
  const ranges: Range[] = [];
  for (const span of spans) {
    if (touches(span, sel.startOffset, sel.endOffset)) {
      span.el.setAttribute(FORMULA_FLASH_ATTR, sel.color);
    }
  }
  for (const [start, end] of offsetsOutsideFormulas(sel.startOffset, sel.endOffset, spans)) {
    const range = rangeFromOffsets(root, start, end);
    if (range) ranges.push(range);
  }
  if (ranges.length > 0) {
    const highlight = new Highlight(...ranges);
    highlight.priority = 2;
    CSS.highlights.set(style, highlight);
    flashStyle = style;
  } else {
    CSS.highlights.delete(style);
    flashStyle = null;
  }
}

export function clearFlashChatRange(messageId: string): void {
  if (!supportsCustomHighlights) return;
  if (flashOwner !== messageId) return;
  flashOwner = null;
  if (flashStyle) CSS.highlights.delete(flashStyle);
  flashStyle = null;
}
