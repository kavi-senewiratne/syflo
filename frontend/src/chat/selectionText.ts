/**
 * chat/selectionText.ts
 *
 * Clean text extraction for selections over KaTeX-rendered chat messages.
 *
 * KaTeX puts every formula into the DOM TWICE: an invisible MathML layer
 * (whose <annotation> carries the raw LaTeX source) plus the visible HTML
 * layer. Range.toString() naively concatenates all text nodes, so a selected
 * formula arrives tripled — "E(wt−n+1,…,wt)E(w_{t-n+1}, \dots, w_t)E(…)"
 * (live incident 2026-07-26).
 *
 * Implementation walks the LIVE DOM text nodes covered by the range (not a
 * cloneContents() fragment: when a selection starts or ends INSIDE a
 * formula, the clone lacks the .katex wrapper and the annotation — second
 * live incident 2026-07-26). Every formula the selection touches is
 * substituted WHOLE by its `$…$` source: half a rendered formula has no
 * meaningful textual split anyway.
 *
 * NOTE: only the TEXT is cleaned. Highlight anchor offsets stay based on the
 * raw DOM text (chat/highlightAnchors.ts) — the two representations serve
 * different purposes.
 */

/** LaTeX source of a KaTeX element, or null when the annotation is missing. */
function latexSourceOf(katexEl: Element): string | null {
  const annotation = katexEl.querySelector('annotation[encoding="application/x-tex"]');
  const src = annotation?.textContent?.trim();
  return src ? src : null;
}

/** All text nodes under `root` (or `root` itself when it is one). */
function textNodesUnder(root: Node): Text[] {
  if (root.nodeType === Node.TEXT_NODE) return [root as Text];
  const doc = root.ownerDocument;
  if (!doc) return [];
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return nodes;
}

/**
 * Returns the range's text with KaTeX formulas replaced by their `$…$`
 * (inline) / `$$…$$` (display) LaTeX source. A formula that is only grazed
 * by the selection is replaced as a whole. Falls back to the visible HTML
 * layer's text — deduplicated — when the annotation is missing.
 */
export function rangeToCleanText(range: Range): string {
  const seenKatex = new Set<Element>();
  let out = '';

  for (const node of textNodesUnder(range.commonAncestorContainer)) {
    if (!range.intersectsNode(node)) continue;
    const parent = node.parentElement;

    const katexEl = parent?.closest('.katex') ?? null;
    if (katexEl) {
      if (seenKatex.has(katexEl)) continue;
      seenKatex.add(katexEl);
      const src = latexSourceOf(katexEl);
      if (src) {
        const display = katexEl.closest('.katex-display') !== null;
        out += display ? `$$${src}$$` : `$${src}$`;
      } else {
        // No annotation: keep the visible layer once instead of all twins.
        const html = katexEl.querySelector('.katex-html');
        out += (html ?? katexEl).textContent ?? '';
      }
      continue;
    }
    // Stray MathML outside a .katex wrapper (defensive) — invisible twin.
    if (parent?.closest('.katex-mathml')) continue;

    let text = node.data;
    // Boundary text nodes contribute only their selected slice.
    if (node === range.endContainer) text = text.slice(0, range.endOffset);
    if (node === range.startContainer) text = text.slice(range.startOffset);
    out += text;
  }

  return out.replace(/\s+/g, ' ').trim();
}
