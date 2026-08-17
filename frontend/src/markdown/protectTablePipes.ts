/**
 * markdown/protectTablePipes.ts
 *
 * Rescues formulas that live inside a GFM table cell (user report 2026-08-06).
 *
 * The screenshot case: a model wrote
 *
 *   | Softmax-Ausgangsschicht | $O(|V| \cdot n \cdot m)$ | … |
 *
 * and the row came out shredded — `$O(`, `V`, `\cdot n \cdot m)$` sat in three
 * different cells as raw text. The reason is order of operations, not KaTeX:
 * remark-gfm splits a row at EVERY unescaped `|`, so the cardinality bars of
 * `|V|` end the cell before remark-math ever sees a `$…$` pair.
 *
 * The fix runs on the raw markdown, before the parser: inside math spans of a
 * table row, a `|` becomes `\vert` and `\|` becomes `\Vert` — the identical
 * glyphs in KaTeX, minus the character that breaks the row. Escaping to `\|`
 * instead would NOT work: micromark hands math content to KaTeX verbatim, so
 * the escape survives and `\|` renders as ‖.
 *
 * Deliberately narrow:
 *   - only lines that look like a table row (trimmed, they start with `|`);
 *   - only between `$`/`$$` delimiters, never in the surrounding prose;
 *   - never inside a span containing `\begin{`: there a `|` can be a column
 *     spec (`\begin{array}{c|c}`) where `\vert` would be a syntax error. Such
 *     a formula is beyond repair in a table cell anyway.
 * Code fences are skipped entirely — a pipe in a code block is data.
 */

// Trimmed table rows start with a pipe. Also matches the separator row
// (|---|---|), which carries no math and is left unchanged by the math scan.
const TABLE_ROW_RE = /^\s{0,3}\|/;

// Fence toggles, so a table drawn inside a ``` block stays untouched.
const FENCE_RE = /^\s{0,3}(?:```|~~~)/;

// One math span: display first (so `$$…$$` is not read as two `$…$`), then
// inline. Non-greedy, single line — a table row never spans lines.
const MATH_SPAN_RE = /\$\$[^\n]*?\$\$|\$[^\n]*?\$/g;

function pipesToVert(span: string): string {
  if (span.includes('\\begin{')) return span;
  // `\|` (‖) first, so its backslash is not consumed by the single-pipe pass.
  return span.replace(/\\\|/g, '\\Vert ').replace(/\|/g, '\\vert ');
}

export function protectTablePipes(md: string): string {
  if (!md.includes('|') || !md.includes('$')) return md;

  let inFence = false;
  return md
    .split('\n')
    .map((line) => {
      if (FENCE_RE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence || !TABLE_ROW_RE.test(line)) return line;
      return line.replace(MATH_SPAN_RE, pipesToVert);
    })
    .join('\n');
}
