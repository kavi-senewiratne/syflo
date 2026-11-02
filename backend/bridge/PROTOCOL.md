# Syflo bridge protocol (ADR-0013)

`bridge.js` is generated (`node bridge/build-bridge.js`) from `anchor.js` + `bridge-core.js` and
served at `/__syflo/bridge.js`. It is injected as
`<script src="/__syflo/bridge.js" data-token="TOKEN" [data-parent-origin="ORIGIN"] [data-source-url="URL"]>`.
`data-source-url` is the web address of a URL import; relative links resolve against it.
A test fails when `bridge.js` is stale.

## Envelope and trust

- Page -> parent: `window.parent.postMessage({ source: 'syflo-bridge', token, type, ... }, parentOrigin || '*')`.
  The parent must check `event.source === iframe.contentWindow`, `event.origin` (the source's own
  origin `src-<id>.localhost:<port>`) and `data.token`.
- Parent -> page: `{ token, type, ... }`. The page accepts a command only when
  `event.source === window.parent`, `data.token` equals its `data-token` (a missing token
  accepts nothing) and, if `data-parent-origin` is set, `event.origin` matches it.
- The parent may send `hello` at any time (e.g. on iframe `load`): the page answers with
  `ready`, `outline` and `section` again, so a late listener misses nothing.

## Page -> parent

| type | fields | when |
| --- | --- | --- |
| `ready` | - | on load and on `hello` |
| `outline` | `sections: [{ level: 1-3, heading }]` | on load and on `hello`; index in this list = `index` of `scroll-to-section` / `section` |
| `selection` | `text`, `anchor {exact,prefix,suffix}`, `rect` | mouseup / shift+arrow with a non-empty selection; `text` = `anchor.exact` (formulas as TeX); `rect` in iframe viewport coords |
| `selection-cleared` | - | the selection collapsed after a `selection` |
| `highlight-click` | `id`, `rect` | a painted highlight was clicked (not a drag-select) |
| `section` | `heading`, `index` | current section (last h1-h3 above 25% viewport height) changed; `index -1`, `heading ''` = before the first heading; throttled 100 ms |
| `highlights-painted` | `resolved: [id]`, `missing: [id]` | after every `set-highlights` and every late-DOM repaint; `missing` = anchor no longer found |
| `anchor-not-found` | `anchor` | `scroll-to-anchor` could not resolve |
| `open-link` | `url` | a link to another page was clicked; the bridge blocked the navigation (the snapshot is one page) and the parent opens `url` in the system browser. In-page `#` anchors and `javascript:` links are not reported. A relative link without `data-source-url` is blocked and not reported |

## Parent -> page

| type | fields | effect |
| --- | --- | --- |
| `set-highlights` | `highlights: [{ id, color, anchor }]` | repaint all (replaces). `color`: yellow, green, blue, pink, orange |
| `scroll-to-anchor` | `anchor` | scroll the quote to the center and flash it (1.4 s) |
| `scroll-to-section` | `index` | scroll that heading to the top |
| `clear-selection` | - | drop the page selection |
| `hello` | - | re-announce (see above) |

## Painting

- CSS Custom Highlight API when present (`::highlight(syflo-hl-<color>)`), else `<mark data-syflo-hl="id" data-color>`
  wrappers. Formula elements (`mjx-container`, `math`, `.katex`) are never entered; in the fallback
  they get `data-syflo-hl-atom="<color>"`.
- Colors are fixed rgba literals (deep tone at 36-42 % opacity), identical in every Syflo theme and readable on light
  and dark pages (ADR-0013 decision 10).
- A MutationObserver re-resolves and repaints (250 ms debounce) after late DOM changes such as MathJax typesetting.

## Quote anchor (`anchor.js`)

`{ exact, prefix, suffix }` over the text model: visible text in reading order, whitespace collapsed to single spaces,
block boundaries as a space, script/style/noscript/canvas/svg/template skipped, each formula ONE token whose text is its
TeX (`<script type="math/tex">` sibling, `data-tex`, `<annotation encoding="application/x-tex">`, `aria-label`, visible
text). `prefix`/`suffix` are up to 32 characters of that text. Resolution picks the occurrence whose context matches best,
falls back to a whitespace-insensitive search, and returns null when the text is gone.
