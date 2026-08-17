/**
 * Which layer owns the Escape key.
 *
 * Every dialog that covers the app carries `data-overlay` on its root and
 * closes itself on Escape. Anything BELOW that layer — the /btw panel, for
 * one — has to keep its hands off the same press, or closing the settings
 * silently costs the user the answer they were reading (bug 2026-08-09).
 *
 * The check runs during the same keydown, before React has re-rendered, so
 * the dialog closing on this very press is still in the DOM: one Escape
 * closes the dialog, the next one reaches the panel underneath.
 */
export const OVERLAY_MARKER = 'data-overlay';

export function isOverlayOpen(): boolean {
  return document.querySelector(`[${OVERLAY_MARKER}]`) !== null;
}
