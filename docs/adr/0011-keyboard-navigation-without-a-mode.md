# Keyboard navigation without a mode

Status: accepted (2026-08-10)

Syflo has no focus order. Twelve components install their own `keydown` listener,
`tabIndex` appears in three files, and nothing carries a user from the composer to
the chat tree, the source, or the highlights drawer without a mouse. The obvious
fix is a **modal navigation mode**: press Escape, arrow keys change meaning, press
Escape again to leave — the Vim shape, and the shape this feature was first
proposed in.

A mode is rejected because it is a hidden state. Arrow keys would mean "move the
caret" or "change region" depending on something the screen does not show, so it
needs a visible mode indicator to be usable. Syflo deliberately does not explain
its gestures — `/btw`'s three dismissal gestures are unexplained by design — and a
mode badge would be the first piece of UI whose only job is to describe the app's
internal state.

The mode turns out to be unnecessary. A text field and a list item are **different
focus targets**, and the browser always knows which one holds focus. That single
fact lets `←` move the caret in the composer and change region on a chat row,
without anything hidden to remember: the focus ring is the state, and it is always
on screen.

## Decision

- **Regions form an L, not a row.** The mind map lies across the top
  (`App.tsx:2270`); sidebar, source, chat and highlights drawer run left to right
  beneath it. `←` `→` move between columns, `↑` overflows upward into the map,
  `↓` drops back into the column below it.
- **Edge overflow is the one rule for both axes.** An arrow key serves the focused
  region first and leaves only when that region has nothing left to do: in the chat
  tree `←` collapses a node (`ChatTree.tsx:159`) and only a second `←` moves left;
  `↑` walks up the items and only rises into the map from the topmost one. This
  costs a second keypress in the sidebar — the only region with a hierarchy — and
  buys one rule instead of two.
- **The focus ring is the only new visual element**, and it carries no hue:
  `box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--text-strong)`. Colour is
  already spoken for — `bg-blue-50/text-blue-700` means "this chat is open"
  (`ChatTree.tsx:147`) and a coloured left bar means highlight kind, one of which
  is blue `#2563EB` (`HighlightsDrawer/index.tsx:53`). Surface and text contrast by
  definition in every theme, so the ring stays legible on the blue pill, on a blue
  highlight card, and on a dark theme's ground. No region outline, no mode badge,
  no status bar.
- **Escape keeps its twelve existing jobs and gains a thirteenth at the end of the
  chain.** It closes the topmost open thing; it clears a pending selection; and
  only when there is nothing left to close does it hand focus to the structure. Any
  printable key returns focus to the composer and types that character — the same
  silent rule `/btw` already uses. A user who never learns this loses nothing.
- **Every region defines what an item is, and none is ever empty on screen.** Map:
  a node. Sidebar: a chat row. Source: a highlight in reading order, falling back to
  **the page** when the paper has none. Chat: a message bubble, with the composer as
  the last item. Drawer: a card. Regions not on screen are skipped; regions on
  screen never are — a region that materialised on the user's first highlight would
  make the map un-memorable.
- **`↵` on a bubble selects the whole bubble** and opens the existing selection
  popup, so branching, "Ask in chat" and the five colours are all reachable without
  a mouse. The keyboard cannot select *part* of a bubble; that stays a mouse
  gesture, and the mockup says so rather than leaving it to be filed as a bug.
- **The source region and the drawer both list highlights on purpose.** The source
  holds the current page's, in reading order; the drawer holds the whole tree's,
  grouped by colour. Same objects, two questions — "what is marked here?" versus
  "what have I marked at all?"

Vocabulary in `CONTEXT.md`: **keyboard region**, **focus ring**, **edge overflow**.
Design source of truth: `design/mockup-keyboard-navigation.html`.

## How it is built

The rules live in `frontend/src/keyboard/focusMap.ts` as pure functions —
`navigate`, `interpretKey`, `buildLayout` — with no DOM and no React, so the
whole behaviour is checked in milliseconds. `keyboard/readScreen.ts` reads the
regions back **off the DOM** rather than having App assemble a second copy of
the layout that would drift; the mind map's generations come from where its
nodes actually sit, since a shared horizontal band *is* a generation.
`hooks/useKeyboardNavigation.ts` is the wire. A component opts in with one
attribute, `data-focus-item`, and its container with `data-focus-region`.

Two things only the running app showed (2026-08-10), both now covered by tests:

- The mind map and the sidebar key their items by the **same chat ids**, so a
  document-wide `querySelector` always found the sidebar row: the ring looked
  stuck in the sidebar while the focus was really walking the map. The lookup
  is scoped to the region.
- `inComposer` was derived from this hook's own state, so clicking into the
  composer while the ring was out in the structure left the arrows captured.
  The browser is asked instead (`document.activeElement`), and Escape now
  blurs the composer when it hands focus to the structure — leaving the
  composer has to mean leaving it.
- The highlights drawer's **overlay** variant covers the chat column whole, so
  `ChatArea` drops its `data-focus-region` while it is up, `navigate` rescues a
  ring whose region has vanished, and the paint effect re-validates on every
  render rather than only when the focus changes — otherwise a ring sat
  stranded behind the drawer.
- The listener runs in the **capture phase**. React flushes state synchronously
  for a discrete event like `keydown`, so a listener running after the drawer's
  own already saw `overlayOpen === false`: one Escape both closed the drawer
  and entered the structure, skipping a step of the chain. Running first means
  the chain is read as the user sees it.

## Revised after first use (2026-08-11)

Five things the design got wrong, all found by using it rather than testing it:

- **Everything interactive is an item, not just the obvious lists.** The
  composer's own controls (attach, mic, model, send) and the collapsed
  sidebar's rail buttons had no anchor, so arrows walked past them. The rail
  was the worse case: it dropped the sidebar out of the focus map entirely, and
  `←` out of the PDF hit a wall.
- **A control the layout has hidden is not an item.** The model picker is
  `display:none` in a narrow chat column; a ring on it vanished. `readScreen`
  asks the browser via `checkVisibility()`.
- **The first Escape starts where the app already says the user is.** The
  sidebar marks the open chat with a blue pill; the ring now agrees with it
  instead of appearing in the chat region, which read as landing nowhere. Once
  the ring has been somewhere, Escape returns it there.
- **An item taller than the window keeps its ring off screen.** A PDF page under
  `scrollIntoView({block:'nearest'})` left the user unable to see where they
  were; tall items scroll to `'start'` instead.
- **`tab` had to go** — see the considered options below.

A second round the same day, after the first was in use:

- **A region is rows, not a list — and mostly rows of one.** Items sharing a
  horizontal band are walked with `←` `→`, and only at the ends does the key
  overflow out of the region. That is how the composer's attach/mic/model/send
  behave, and the sidebar's header and footer buttons. The mind map stops being
  a special case: its generations are the same rule, so `inMap` is gone.
- **`↵` presses whatever is a `<button>`**, in any region, instead of three
  separate prefix rules for rail-, composer- and drawer- items.
- **A drawer is a region, not a modal.** Owning Escape and freezing the
  keyboard were the same flag, so while the highlights drawer was open the ring
  could not be moved at all. Split into `escapeTaken` (a drawer, popup, menu or
  side question owns Escape — arrows still work) and `modalOpen` (a dialog
  takes the keyboard entirely).
- **The source's items are a reading sequence, not rows.** Two highlights on
  one line of a paper share a horizontal band, so the new row rule made `←`
  walk sideways through them instead of leaving for the sidebar. The region
  says so itself with `data-focus-axis="sequence"`.
- **An open menu is a region, and while it is up it is the only one.** Menus
  join in without a single edit: `readScreen` finds any `[role="menu"]` and
  treats every button inside it as an item, stamping an id on. A menu usually
  opens without App re-rendering, so a `MutationObserver` moves the ring into
  it the moment it appears rather than one keypress later — and the DOM, not a
  prop, decides that a menu owns Escape.
- **Escape gets the user out again**, not only in. The same key that hands
  focus to the structure puts the ring away when nothing is left to close.
- **The ring is ONE overlay on `<body>`, not a shadow on the item.** An item
  can be drawn in several pieces — a formula is stored as three bands
  (superscript, main line, subscript), a highlight wraps over lines — and one
  box per piece read as three things instead of one. The overlay spans the
  union of the pieces, follows scrolling in viewport coordinates, and cannot be
  clipped by an `overflow: hidden` ancestor. `data-focus-ring` stays on every
  piece as a marker but draws nothing.
- **A ring must never move what it marks.** The rule carried
  `position: relative`, to lift the ring above its neighbours. PDF highlights
  are placed absolutely from stored rects, so that one declaration tore every
  mark out of its position and dropped it at the foot of its page — which also
  stretched the page from 792px to 816px. `z-index` alone does the lifting
  wherever the element is positioned already, which was every case that needed
  it. `border-radius` went the same way: box-shadow already follows the
  element's own radius, and forcing 6px reshaped thin marks into pills.
- **Chrome's own focus ring had to go too.** A clicked button kept it, drawn in
  the macOS accent colour — gold, on the user's machine — which was the second
  indicator all over again. `button:focus{outline:none}`; text fields keep
  theirs.

## Revised for the video source (2026-08-17)

The middle column had been read as "the PDF pane" rather than "the source", so a
tree whose source is a YouTube video had no `source` region at all: the ring
walked from the sidebar straight into the chat and the player, its chapters and
its transcript were unreachable without a mouse (user report).

- **The region is the source, whatever the source is.** `VideoPane` carries
  `data-focus-region="source"` exactly as `PdfView` does, and a tree has one
  source (ADR-0005), so the two never compete.
- **What an item is, in a video:** the view switch (Chapters / Transcript), every
  chapter, every transcript block, and the "continue the overview" button — the
  things a reader acts on. The marks inside a block are not items of their own;
  the block they live in is, and `↵` on it does what a click does: jump the
  player there. The switch and the list are one region, so `←` `→` walk the two
  buttons and `↑` `↓` walk the list, which carries `data-focus-axis="sequence"`
  for the same reason the PDF's marks do.
- **`role="button"` is a control too.** `↵` pressed real `<button>`s only, and
  the chapters and transcript blocks have to be divs — text inside a `<button>`
  cannot be dragged over in Chrome, and those rows must be both selectable and
  clickable. The whole column was dead under `↵` until the check followed the
  role rather than the tag.
- **"Taller than the window" means taller than the SCROLLER.** The rule that
  shows a too-tall item's top measured the viewport, so a 463 px transcript block
  in a 230 px list counted as small on a 900 px screen, was scrolled to the
  middle, and the ring — clipped to the list at both ends — drew a straight line
  through the text (user report with picture). Measured against the list, the top
  edge is always real and only the far end is cut, which is what a PDF page has
  always looked like.

- **The glow announces the entry, and nothing else — so it has to be let go
  of.** `data-glow` stayed on the overlay forever ("the animation ends by
  itself"), which held only while the ring stayed on screen: a `display: none`
  and back RESTARTS a CSS animation. And every arrow step did exactly that,
  because the ring was drawn on the item's OLD position, found it outside the
  list and hid, then reappeared a frame later once the scroll had happened. So
  walking the transcript lit the ring up at every step (user report). Two fixes,
  both needed: scroll first and measure after, and drop `data-glow` on
  `animationend`. Measured before: `visible=true → REMOVED → true` per keypress;
  after: one `visible=true` for the whole walk.

One boundary stays and belongs to the browser, not to this design: while the
YouTube player itself has the focus — after the reader clicks Play inside it —
every key belongs to that cross-origin frame, Escape included. A click anywhere
in the app hands the keyboard back.

## Considered options

- **A modal navigation mode** (the original proposal) — arrow keys reinterpreted
  after Escape. Rejected: it is a hidden state, and making it visible requires a
  mode indicator, which is UI whose only content is the app's own internals.
- **A blue focus ring**, matching the app's accent family. Rejected: blue already
  carries two meanings on the very rows the ring lands on, so it would say nothing
  new and blur the two it collided with.
- **A region-level outline** alongside the item ring. Rejected: it is a second new
  UI element carrying no information the item ring doesn't already give. Its one
  genuine use — an empty region — was removed instead by giving every on-screen
  region a fallback item.
- **`Alt+↑/↓` to reach the mind map** instead of edge overflow. Rejected: those
  keys are already bound to question navigation (`QuestionNav`), and a modifier
  nobody guesses is not discoverable.
- **Treating the source as not a region at all**, jumping straight from sidebar to
  chat and leaving the PDF to the drawer. Rejected: it would leave the largest thing
  on screen untouchable from the keyboard, and the L would have a hole in the middle.
- **`shift`+arrows for character-level selection inside a bubble** — the complete
  answer, and the web standard. Rejected as a separate project: it hands `←` `→`
  back to the caret inside a bubble, reintroducing exactly the ambiguity this design
  exists to remove.
- **`tab` as the region switch** (the plain roving-tabindex reading). Rejected
  after use: leaving `tab` at its browser default gave the app **two** focus
  indicators, and users read them as two places the keyboard was. `tab` is now
  suppressed inside the app — but only outside text fields and open overlays,
  so a settings form still tabs between its fields.
