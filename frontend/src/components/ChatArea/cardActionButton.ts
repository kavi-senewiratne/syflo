/**
 * components/ChatArea/cardActionButton.ts
 *
 * THE one style for a clickable action inside a chat bubble or chat-area card
 * (user decision 2026-09-12): the blue accent pill the quota/fail cards and
 * the Tavily search card established. The earlier two-tier scheme — blue for
 * the primary exit, a gray twin for secondary ones — read as unthemed next to
 * it: gray-200/gray-500 look the same in every theme, while blue-* is exactly
 * what the `:root[data-theme]` blocks remap. So every action in a card wears
 * the accent, and the themes recolor all of them together.
 *
 * Documented in docs/STYLE.md ("Aktionen in Chat-Karten") — change both
 * together.
 */
export const CARD_ACTION_BTN =
  'inline-flex items-center gap-1 rounded-md border border-blue-100 bg-blue-50 px-2 py-0.5 text-[12px] font-semibold text-blue-700 transition-colors hover:bg-blue-100';

/** The same pill on an <a>: markdown's link underline stays off. */
export const CARD_ACTION_LINK = `${CARD_ACTION_BTN} no-underline`;

/** The same pill where the button can be disabled (countdown retry). */
export const CARD_ACTION_BTN_DISABLEABLE = `${CARD_ACTION_BTN} disabled:opacity-55 disabled:cursor-default disabled:hover:bg-blue-50`;
