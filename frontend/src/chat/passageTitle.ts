/**
 * chat/passageTitle.ts
 *
 * A branch chat must show its finished title the moment it appears in the
 * tree — never the raw passage first (user requirement 2026-08-02). For a
 * formula marked in a PDF the raw passage is rubble: the text layer flattens
 * "x̂⁽ᵏ⁾ = (x⁽ᵏ⁾ − E[x⁽ᵏ⁾]) / √Var[x⁽ᵏ⁾]" into
 * "x ( k ) = x ( k ) − E [ x ( k ) ] √ Var [ x ( k ) ]" — the fraction bar is
 * a drawn line, the superscripts are geometry, both are simply gone.
 *
 * So the title is fetched WHILE the selection popup is open (the user spends
 * a second or two reading the definition there), and the branch is created
 * with the finished result. Two guards keep it honest:
 *
 *   - `awaitTitle` waits only briefly at click time; a slow model must never
 *     hold the branch hostage.
 *   - `tidyPassage` is the fallback when nothing arrives (Ollama, no key,
 *     quota): it cannot restore a fraction bar, but it removes the spaces
 *     the text layer sprinkles between glyphs, which alone reads far better.
 */

import { api } from '../api';

/** How long the branch click waits for a title that is still in flight. */
export const TITLE_WAIT_MS = 2500;

/**
 * Cosmetic cleanup of an extracted passage — no model involved, so it can
 * never invent anything: glue the spaces that the PDF text layer puts around
 * brackets and operators, and repair hyphenation from line breaks.
 */
export function tidyPassage(passage: string): string {
  return passage
    .replace(/\s+/g, ' ')
    // "no- toriously" → "notoriously" (line-break hyphenation)
    .replace(/(\p{L})-\s+(\p{L})/gu, '$1$2')
    // "x ( k )" → "x(k)", "E [ x ]" → "E[x]"
    .replace(/\s*([([{])\s*/g, '$1')
    .replace(/\s*([)\]}])/g, '$1')
    // "√ Var" → "√Var"
    .replace(/([√∑∏∫])\s+/g, '$1')
    .trim();
}

/** A pending title lookup, started when the popup opened. */
export interface PendingTitle {
  passage: string;
  promise: Promise<string | null>;
}

/**
 * Kick off the lookup. Never rejects — a failed lookup resolves to null, so
 * no caller needs a catch.
 */
export function startPassageTitle(passage: string): PendingTitle {
  let promise: Promise<string | null>;
  try {
    promise = api.passageTitle(passage).catch(() => null);
  } catch {
    // A title is a nicety — nothing about branching may hinge on it, not
    // even an api layer that doesn't offer the call.
    promise = Promise.resolve(null);
  }
  return { passage, promise };
}

/**
 * The title to create the branch with: the model's, if it arrives within
 * `waitMs`, else the tidied passage. `pending` may belong to an older
 * selection — then it is ignored.
 */
export async function awaitTitle(
  pending: PendingTitle | null,
  passage: string,
  waitMs: number = TITLE_WAIT_MS,
): Promise<string> {
  const fallback = tidyPassage(passage) || passage;
  if (!pending || pending.passage !== passage) return fallback;
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs));
  const title = await Promise.race([pending.promise, timeout]);
  return title ?? fallback;
}
