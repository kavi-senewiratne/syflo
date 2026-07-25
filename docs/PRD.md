# FlowTalk — Product Requirements

> Status: rewritten 2026-07-10 after the decision to revive FlowTalk as the active
> product (see `docs/adr/0001-revive-flowtalk-port-from-syflo.md`). The previous
> content of this file was the 2026-05-22 *Syflo* pivot PRD, written here before the
> Syflo code moved to its own repo; the canonical copy of that document lives at
> `syflo/docs/PRD.md`. Canonical domain terms live in `/CONTEXT.md`.

## Vision

FlowTalk is a **general-purpose branching-chat app**. Instead of one long linear
conversation, any word or selection can spin off a focused sub-chat (a **branch**),
forming a **chat tree** the user navigates visually. Everything runs local-first on
Ollama models; no chat data leaves the machine.

FlowTalk is not a research tool. Its research-focused sibling **Syflo** (separate repo,
own roadmap) continues independently; FlowTalk selectively ports Syflo features that are
useful to a general audience.

## Features

### 1. Branching chats (existing)

Unchanged core: right-click a word in a chat → floating popup with the word, an
AI-generated definition, and an "open as new chat" branch action.

### 2. Chat tree with connector lines (port from Syflo)

The left sidebar shows the chat tree with **vertical trunk + horizontal elbow connector
lines**, ported from Syflo's `BranchTreeNode` (`PaperView.tsx`) — trunk under the parent
dot, elbow into each child row, clean termination after the last sibling. Design source
of truth: `syflo/design/mockup-paper-view.html` tree-list CSS.

### 3. PDF in a chat (port from Syflo, viewer only)

- **One PDF per chat tree** (see ADR-0002). The PDF is attached via the paperclip menu
  in the chat input.
- With a PDF open, the app shows **three columns**: left the (unchanged) sidebar with
  the chat tree, center the PDF viewer, right the active branch's chat. This deviates
  deliberately from Syflo's layout (tree+chat combined right): the tree never moves.
- Right-clicking a selection in the PDF opens the same floating popup as in chat,
  extended 1:1 from Syflo: a row of five **highlight** colors (yellow, green, blue,
  pink, orange) and inline-renamable **color labels**.
- Highlights persist server-side (per paper, multi-rect), identical to Syflo's
  `/papers/:paperId/highlights` API.
- **Not ported:** Syflo's parsing pipeline (Marker, infographic, markdown view, field
  map, Semantic Scholar enrichment). Upload stores and renders the file; nothing more.
- **Known-bug guard:** Syflo's `PdfView.tsx` normalizes highlight-rect *positions* by
  zoom but not *width/height*, so rects are only correctly sized at the zoom they were
  created at. The port normalizes all four values and adds a regression test
  (create at zoom A, verify geometry at zoom B).

### 4. Paper search from the paperclip (port from Syflo)

The paperclip menu gains a **"Research paper"** option opening a search dialog that is a
1:1 copy of Syflo's home-page search: OpenAlex + arXiv queried in parallel, merged and
deduplicated (DOI, normalized title), Semantic Scholar as outage fallback. Each result
carries an **availability** state: *open* (import directly), *manual* (free copy exists
but host blocks download), *paywalled* (Lock badge + "View publisher" external link).
Importing attaches the paper's PDF to the current chat. `blockedHosts` logic and its
tests come along unchanged.

### 5. Chat highlights, "Ask in chat" & parent context (2026-07-19)

Design source of truth: `design/mockup-chat-highlights-ask-in-chat.html` (approved
2026-07-19).

- **Chat highlights:** the PDF highlight gesture extended to chat messages — select
  text in any bubble (user or assistant, right pane or parent context), right-click,
  pick one of the same five colors in the same popup. Anchored by
  `message_id + start/end character offset` into the message's rendered plain text
  (reflow-safe, no geometry), stored in `message_highlights`
  (`/api/chats/:id/message-highlights`), painted via the CSS Custom Highlight API.
  Right-clicking an existing chat highlight opens the recolor/delete menu.
- **Ask in chat:** primary popup action on any selection (PDF or chat); "Open as new
  chat" becomes the secondary action. Drops the selection into the **current** chat's
  composer as a removable quote block (color bar = picked highlight color, neutral
  gray when none) — no branch is created. Sending prepends the quote as a markdown
  blockquote — it lands in the LLM context and renders as a styled quote in the user
  bubble.
- **Parent context:** when a branch is active (opened via "Open as new chat") and its
  tree has **no** PDF, the parent chat renders read-only in the center pane
  (highlights visible, selections and right-click work there too); the branch keeps
  the right pane. With a PDF attached, nothing changes.

### 6. Web search tool (existing)

The chat model can call a **web search** tool: a thin backend proxy
(`POST /api/search`) to a local SearXNG instance (`searxng/`, default
`localhost:8888`, top 8 results). If SearXNG is down, the tool returns a clear 503 so
the model can tell the user. This is unrelated to Paper search (feature 4) — web search
feeds the conversation, paper search attaches a PDF.

### 7. Desktop packaging (existing)

The app ships as an Electron desktop shell (`electron/`). Dev mode loads the
Vite dev server (`cd electron && npm run dev`, with `./start.command` running);
the packaged app spawns the bundled Node backend, which also serves the built
frontend same-origin on :3001 (`cd electron && npm run build`).

## Non-goals

- Multiple PDFs per chat tree (v1 constraint, ADR-0002).
- Any of Syflo's paper-analysis features (infographic, field map, journey, algorithm
  cards).
- Cloud model APIs by default — Ollama stays the default; cloud is opt-in.

## Quality bar

- Tests run after every feature before it is called done.
- UI copy is English; icons are Lucide, never emojis.
- UI changes are diffed against the relevant `design/mockup-*.html` before and after.
  For 1:1 ports the copied Syflo mockups in `design/` are the source of truth; newly
  composed surfaces (three-column PDF layout, paperclip menu, search dialog) get a
  fresh mockup approved *before* implementation.
