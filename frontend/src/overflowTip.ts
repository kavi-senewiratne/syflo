/**
 * overflowTip.ts
 *
 * The untruncated title of a sidebar row, in the app's own Kurzinfo bubble.
 *
 * The rows used to carry the native `title` attribute, but Chromium only pops
 * that up after about a second of stillness and in the running app it often
 * never appeared at all — the same finding that created `data-tip` for icon
 * buttons (index.css, user report 2026-08-11; asked for on the rows
 * 2026-09-12). So the rows join the data-tip design instead.
 *
 * Armed per hover, not statically: whether a label overflows depends on the
 * sidebar's width at this moment, and a bubble that repeats a fully visible
 * title is noise (the Kurzinfo doctrine). On mouseenter the row's label —
 * the child marked `data-overflow-label` — is measured, and only a genuinely
 * cut label arms the bubble. Imperative on purpose, like data-tip itself
 * ("CSS-only … no wrapper component, no state"): the render helpers in the
 * sidebar are plain functions, not components, and may not call hooks.
 */

import type { MouseEvent } from 'react';

const TIP_ATTRS = ['data-tip', 'data-tip-below', 'data-tip-start', 'data-tip-wrap'];

/**
 * Spread onto a row whose label may be cut: `{...overflowTip(fullTitle)}`.
 * Pass undefined (e.g. while the row is being renamed) to keep it silent.
 */
export function overflowTip(tip: string | undefined) {
  return {
    onMouseEnter: (e: MouseEvent<HTMLElement>) => {
      const row = e.currentTarget;
      const label = row.querySelector('[data-overflow-label]');
      // The +1 forgives sub-pixel rounding between the two measures.
      const cut = !!tip && !!label && label.scrollWidth > label.clientWidth + 1;
      if (cut) {
        row.setAttribute('data-tip', tip);
        // Below + start: the rows hug the sidebar's left edge, and a centered
        // bubble above the row would clip at the scroll container's top for
        // the first rows.
        row.setAttribute('data-tip-below', '');
        row.setAttribute('data-tip-start', '');
        row.setAttribute('data-tip-wrap', '');
      } else {
        for (const a of TIP_ATTRS) row.removeAttribute(a);
      }
    },
  };
}
