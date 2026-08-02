/**
 * components/MathText.tsx
 *
 * Inline KaTeX rendering for short plain-text strings that may carry
 * `$…$` math: chat titles (sidebar, chat header, mindmap nodes, delete
 * dialog), source labels and the explain-popup heading. Deliberately NOT
 * a markdown pipeline (unlike ChatArea/InlineMarkdown): titles are plain
 * text, and a stray `_` or `*` in them must never turn into emphasis.
 * Only math segments are rendered; everything else stays a literal text
 * node. Display math renders inline — a one-line title has no block
 * layout.
 */

import type { ReactNode } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

// $$…$$ before $…$ so an inner `$` never splits a display span; unbalanced
// delimiters simply stay literal text (no match).
const MATH_SEGMENT = /\$\$([^$]+)\$\$|\$([^$\n]+)\$/g;

/**
 * True when the string carries renderable math. Used to switch single-line
 * clipping from `truncate` to the fade-out mask (`syflo-math-fade`):
 * text-overflow's ellipsis hides text but lets KaTeX's positioned spans
 * leak past it as stray fragments.
 */
export function hasMath(text: string): boolean {
  return /\$\$?[^$]+\$\$?|\\\(|\\\[/.test(text);
}

/**
 * Strip math delimiters for contexts that can't render KaTeX: native
 * `title=` tooltips and character-count width estimates. Keeps the LaTeX
 * body — better than hiding the formula entirely.
 */
export function plainMathText(text: string): string {
  return text.replace(/\$\$?([^$]*)\$\$?/g, '$1');
}

/**
 * Length-cap a string without cutting through a `$…$` span — a dangling
 * `$` would swallow the rest of the string once rendered. If the cut
 * lands inside a span, back off to just before its opening delimiter.
 */
export function clipMathText(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  if ((cut.match(/\$/g) || []).length % 2 === 1) {
    const idx = cut.lastIndexOf('$');
    // Backing off to before the dangling `$` empties the cut when the
    // whole string is one long `$…$` span starting at index 0 — drop the
    // lone delimiter instead of the entire text (same bug class as
    // messages.js's capTitleChars, user report 2026-07-31).
    cut = idx > 0 ? cut.slice(0, idx) : cut.replace(/\$/g, '');
  }
  return cut.trimEnd() + '…';
}

export function MathText({ text }: { text: string }) {
  // Fast path: nothing math-like in the string.
  if (!/[$\\]/.test(text)) return <>{text}</>;

  // Some models emit \(…\) / \[…\] delimiters — fold them into $-style so
  // one segment regex handles both.
  const normalized = text
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, expr) => `$$${expr}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, expr) => `$${expr}$`);

  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  MATH_SEGMENT.lastIndex = 0;
  while ((m = MATH_SEGMENT.exec(normalized))) {
    if (m.index > last) parts.push(normalized.slice(last, m.index));
    const tex = (m[1] ?? m[2] ?? '').trim();
    let html: string | null = null;
    try {
      html = katex.renderToString(tex, {
        throwOnError: false,
        strict: 'ignore',
        displayMode: false,
      });
    } catch {
      html = null; // unrecoverable parse error — keep the raw text
    }
    parts.push(
      html ? <span key={m.index} dangerouslySetInnerHTML={{ __html: html }} /> : m[0],
    );
    last = m.index + m[0].length;
  }
  if (last < normalized.length) parts.push(normalized.slice(last));
  return <>{parts}</>;
}
