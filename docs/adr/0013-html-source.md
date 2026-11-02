# HTML as a third source kind

Status: accepted (2026-09-29). Extends ADR-0002 / ADR-0005: one **source** per chat tree is now a
PDF, a YouTube transcript or an **HTML source**.

The motivating case is a 1 MB self-contained lecture (`underactuated-lernpfad.html`,
generated with Claude): MathJax formulas, 11 `<canvas>` diagrams, a quiz that keeps its
progress in `localStorage`, ~530k characters of visible text. The user wants to read and
study it like a PDF — select, Ask in chat, branch, highlight.

## Decisions

1. **Live display, not a re-render.** The page runs in an `<iframe>`, so quizzes and
   canvases stay interactive. We rejected sanitizing and re-rendering as chat-style text:
   it would have made highlights easy but killed the interactive parts.
2. **A bridge from day one.** The backend injects a small script when it serves the file.
   It reports selections to Syflo via `postMessage`, paints stored highlights, scrolls
   to a quote and reports the current section. Messages are checked by origin plus a
   per-source token, so the page cannot forge events. The iframe gets no
   `allow-top-navigation`.
3. **Snapshot, not a live link.** Upload stores a copy, like a PDF. Re-generating the
   lecture and uploading it again yields a new source; highlights never dangle.
   Consequently **a link out of the page never navigates the frame** (2026-09-30):
   the snapshot is one page, the bridge and the marks would be lost, and most sites
   refuse to be framed anyway (a blank error page with no way back). The bridge blocks
   the click and reports `open-link`; Syflo opens the address in the system browser,
   the door every external link in the app takes. In-page `#` anchors keep scrolling.
   Relative links of a URL import resolve against the imported address
   (`data-source-url` on the bridge tag); relative links in an uploaded file go nowhere.
4. **One origin per source.** The backend serves each source from its own host
   (`src-<id>.localhost:<port>`), with `allow-scripts allow-same-origin` on the iframe.
   To the browser this is a different site than Syflo, so the page gets a real
   `localStorage` (quiz progress works) and no access to Syflo's chats or keys. We
   rejected an origin-less sandbox: it blocks `localStorage` and would need a shim.
5. **Quote anchors.** A highlight stores the exact text plus surrounding context and is
   re-found on open — not character offsets (the DOM shifts after MathJax typesets or a
   quiz reveals text). Formulas count as atomic tokens carrying their TeX. The quote is
   also what the chat receives as the selection.
6. **The chat reads the visible text only**, in reading order, formulas as TeX, cut into
   sections by heading. Script and `application/json` payloads (the 185 KB `quizdata`)
   are excluded. It exceeds the window, so ADR-0006 retrieval mode applies; section
   headings feed the skeleton.
7. **Freeze network resources at upload.** Scripts, stylesheets, images and what a
   stylesheet loads (fonts, `@import`) are downloaded and embedded into the copy, so the
   source works offline for good. Plain `<a href>` links are left alone. A resource that
   cannot be fetched does not block the upload: the source is created and a warning card
   lists each resource with its **exact reason** (no internet, timed out, HTTP 404,
   too large, blocked local address) and a "Try again" action. Addresses on loopback or
   private ranges are never fetched (SSRF guard).
8. **Same upload gesture as PDFs.** The existing attach control ("Upload file") accepts
   `.html` next to PDFs and routes by type; there is no new button. Drag & drop stays a
   message attachment for every kind, as it is for PDFs.
9. **Outline.** Syflo derives a clickable outline from h1–h3 that scrolls the iframe and
   tracks the current section. Its look goes through a mockup first.
10. **No theming of the page.** It keeps its own design in all five themes; we do not
    filter or invert it. Highlight colors are drawn at fixed opacity so they stay visible
    on light and dark pages.

## Web pages

A URL import reuses the same pipeline and ends as an ordinary HTML source. The page is
rendered first, because many pages build their content with JavaScript and a raw fetch
would return an empty shell (amended 2026-09-29: the earlier "raw HTML only" decision
assumed Chromium would be a new dependency — but `syflo` already ships Electron).

- **Renderer.** The Electron main process opens the URL in a hidden, sandboxed
  `BrowserWindow` (no Node integration, no preload, a throw-away in-memory partition,
  permissions and downloads denied), waits for load plus a settled DOM with a timeout,
  and hands the serialized DOM back. The backend is a separate process and asks main
  for it over a local channel; it never opens a window itself.
- **Same guards as decision 7.** Navigation and sub-requests to loopback or private
  addresses are refused (SSRF), including redirects.
- **Scripts.** A rendered page is stored without its `<script>` tags: its DOM is already
  built, and scripts would build it a second time inside the source iframe. (Raw-HTML
  fallback pages keep their scripts — there they are the only thing that builds the page.)
- **Fallback.** Without Electron (browser dev mode) the backend fetches the raw HTML.
- **Failure.** Only pages that really show nothing (login wall, paywall, captcha) end
  with too little text. That is a limit of the page, not a fault, so it is a quiet gray
  hint line with an Info icon plus one accent-pill exit, "Upload HTML file" — not the
  red error surface (red is reserved for real errors, STYLE.md).

## Consequences

- One `sources`-style kind check now has three branches; the retrieval, skeleton and
  citation code must accept a section-based source that has neither pages nor timestamps.
- The static file server for source origins is new attack surface: it must serve only
  stored copies, never paths outside the source's folder.
- Multi-file pages (relative assets) are out of scope; only single files and whatever
  the freezer can inline.
