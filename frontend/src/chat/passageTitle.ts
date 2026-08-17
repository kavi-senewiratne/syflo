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

import katex from 'katex';
import { api } from '../api';

/**
 * Can KaTeX actually render every `$…$` span in here? Models invent macros:
 * gemini-flash-lite returned `\\E[x(k)]` and `\\Var[x(k)]` for the
 * normalization formula (measured 2026-08-02), which KaTeX draws as RED
 * error text. A title that renders red is worse than the raw passage, so an
 * unrenderable result is dropped and the fallback takes over.
 */
export function mathRenders(text: string): boolean {
  const spans = text.match(/\$\$?[^$]+\$\$?/g) || [];
  return spans.every((span) => {
    const expr = span.replace(/^\$\$?/, '').replace(/\$\$?$/, '');
    try {
      katex.renderToString(expr, { throwOnError: true, displayMode: false });
      return true;
    } catch {
      return false;
    }
  });
}

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

/** What the lookup yields: a short title, and the passage with math restored. */
export interface PassageTitle {
  title: string | null;
  quote: string | null;
}

/** A pending lookup, started when the popup opened. */
export interface PendingTitle {
  passage: string;
  promise: Promise<PassageTitle>;
}

/**
 * Kick off the lookup. Never rejects — a failed lookup resolves to null, so
 * no caller needs a catch.
 */
const NOTHING: PassageTitle = { title: null, quote: null };

export function startPassageTitle(passage: string): PendingTitle {
  let promise: Promise<PassageTitle>;
  try {
    promise = api.passageTitle(passage).then(
      (r) => r ?? NOTHING,
      () => NOTHING,
    );
  } catch {
    // A title is a nicety — nothing about branching may hinge on it, not
    // even an api layer that doesn't offer the call.
    promise = Promise.resolve(NOTHING);
  }
  return { passage, promise };
}

/**
 * What to create the branch with: the model's title and restored quote if
 * they arrive within `waitMs`, else the tidied passage as the title and no
 * quote (the UI then falls back to the verbatim parent_word). `pending` may
 * belong to an older selection — then it is ignored.
 */
export async function awaitTitle(
  pending: PendingTitle | null,
  passage: string,
  waitMs: number = TITLE_WAIT_MS,
): Promise<{ title: string; quote: string | null }> {
  const fallback = tidyPassage(passage) || passage;
  if (!pending || pending.passage !== passage) return { title: fallback, quote: null };
  const timeout = new Promise<PassageTitle>((resolve) => setTimeout(() => resolve(NOTHING), waitMs));
  const result = await Promise.race([pending.promise, timeout]);
  // Only accept math the renderer can actually draw.
  const title = result.title && mathRenders(result.title) ? result.title : fallback;
  const quote = result.quote && mathRenders(result.quote) ? result.quote : null;
  return { title, quote };
}
