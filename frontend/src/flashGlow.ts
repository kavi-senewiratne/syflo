/**
 * The jump glow, in ONE place for every surface.
 *
 * Until now each surface glowed with the means it happened to have:
 *   - PDF: the marks are real elements, so a group of rects carries a
 *     `drop-shadow` around their shared silhouette — the whole passage lights
 *     up as one shape.
 *   - Chat: the mark is not an element at all (it is painted on a Range via
 *     `::highlight()`, which allows neither `box-shadow` nor `outline`), so
 *     the glow was a per-glyph `text-shadow` plus a 3 px underline.
 *   - Transcript / chapters: real spans, but styled after the chat.
 * The result was two different signals. On a light bubble the chat's lift goes
 * almost white, the glyph shadow disappears under it, and what is left moving
 * is the hard underline — "im Chat glüht einfach nur der Unterstrich auf"
 * (user report 2026-08-16), while the same jump into the PDF lights the whole
 * marked passage.
 *
 * This module gives the PDF's signal to everything: measure the target's
 * client rects, draw them into one group, and let that group's `drop-shadow`
 * run around the silhouette. The rects themselves stay invisible — they are
 * only the shape the halo is cut from (see `.syflo-hl-flash-group` in
 * index.css for why white + multiply, and black + screen in the dark theme).
 *
 * Two details are load-bearing:
 *   1. `position: absolute` on <body>, NOT `position: fixed`. A fixed element
 *      creates a stacking context, and a stacking context ISOLATES blending:
 *      the white rects would then have nothing to multiply with and would
 *      paint as white boxes over the text. Absolute + `z-index: auto` keeps
 *      the group blending against the page. The document never scrolls
 *      (html/body are `overflow: hidden`), so viewport rects can be used
 *      as-is.
 *   2. The rects are re-measured every frame. A jump usually ends with a
 *      smooth scroll still settling, and the chat re-renders while the glow
 *      runs — a snapshot would leave the halo behind on empty ground.
 */
import type { HighlightColor } from './types';

/** 3 × 0.45 s — the shared beat of every flash (index.css). */
export const FLASH_GLOW_MS = 1350;

/**
 * Saturated twin of each pastel: the halo's color. Same values the PDF has
 * used since 2026-07-21 (HIGHLIGHT_GLOW_HEX in PdfView) — a jump into a chat
 * and a jump into the page must glow in the same tone.
 */
export const FLASH_GLOW_HEX: Record<HighlightColor, string> = {
  yellow: '#CA8A04',
  green: '#16A34A',
  blue: '#2563EB',
  pink: '#DB2777',
  orange: '#EA580C',
};

/** Anything that can report its own boxes: a Range or an Element. */
export type GlowTarget = { getClientRects(): DOMRectList };

type Box = { left: number; top: number; width: number; height: number };

/**
 * The scroller a node lives in — the glow is clipped to it so a halo never
 * paints over the column next door while the list is still moving.
 */
export function scrollParentOf(node: Node | null): Element | null {
  let el: Element | null = node instanceof Element ? node : (node?.parentElement ?? null);
  while (el && el !== document.body) {
    const style = getComputedStyle(el);
    if (/(auto|scroll)/.test(`${style.overflowY} ${style.overflowX}`)) return el;
    el = el.parentElement;
  }
  return null;
}

export function showFlashGlow(opts: {
  /** Re-read every frame, so a rebuilt DOM or a moving list stays covered. */
  targets: () => GlowTarget[];
  color: HighlightColor;
  /** Clipping frame, usually the scroller. Omitted = the whole viewport. */
  clip?: Element | null;
  durationMs?: number;
}): () => void {
  if (typeof document === 'undefined' || typeof requestAnimationFrame !== 'function') {
    return () => {};
  }

  const layer = document.createElement('div');
  layer.setAttribute('aria-hidden', 'true');
  layer.setAttribute('data-syflo-flash-glow', opts.color);
  layer.style.cssText = 'position:absolute;overflow:hidden;pointer-events:none;';

  const group = document.createElement('div');
  group.className = 'syflo-hl-flash-group';
  group.style.cssText = 'position:absolute;inset:0;';
  group.style.setProperty('--flash-color', FLASH_GLOW_HEX[opts.color]);
  layer.appendChild(group);
  document.body.appendChild(layer);

  let raf = 0;
  const draw = () => {
    const frame: Box = opts.clip
      ? opts.clip.getBoundingClientRect()
      : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    layer.style.left = `${frame.left}px`;
    layer.style.top = `${frame.top}px`;
    layer.style.width = `${frame.width}px`;
    layer.style.height = `${frame.height}px`;

    const boxes: Box[] = [];
    for (const target of opts.targets()) {
      // jsdom kennt getClientRects auf einem Range nicht — dort bleibt der
      // Halo leer, statt den Aufruf zu sprengen.
      if (typeof target.getClientRects !== 'function') continue;
      for (const rect of Array.from(target.getClientRects())) {
        // Collapsed rects (an empty line fragment, a zero-width Range end)
        // would add a dot of halo where there is no text.
        if (rect.width > 0.5 && rect.height > 0.5) boxes.push(rect);
      }
    }
    while (group.childElementCount > boxes.length) group.lastElementChild!.remove();
    while (group.childElementCount < boxes.length) {
      const rect = document.createElement('div');
      rect.style.cssText = 'position:absolute;border-radius:2px;';
      group.appendChild(rect);
    }
    boxes.forEach((box, i) => {
      const el = group.children[i] as HTMLElement;
      el.style.left = `${box.left - frame.left}px`;
      el.style.top = `${box.top - frame.top}px`;
      el.style.width = `${box.width}px`;
      el.style.height = `${box.height}px`;
    });

    raf = requestAnimationFrame(draw);
  };
  draw();

  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    window.clearTimeout(timer);
    layer.remove();
  };
  const timer = window.setTimeout(stop, opts.durationMs ?? FLASH_GLOW_MS);
  return stop;
}
