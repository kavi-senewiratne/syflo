# Syflo — Visual Style Guide

> The written rules behind Syflo's UI. Domain terms live in `/CONTEXT.md`, decisions in
> `docs/adr/`. New UI is designed as a standalone HTML mockup first (variants side by
> side, one gets approved, then implementation starts — see **Mockup** in CONTEXT.md);
> the mockup pages are a local design workshop and are not part of this repo. This
> document distills what they and the running code agree on. It absorbs and supersedes
> `design/ui-vocabulary.md` (2026-08-15).
>
> Everything here is a description of what the app already does most often. New UI must
> reuse these recipes rather than inventing a neighbour that is 1 px different.

## 1. Themes and color tokens

Syflo ships five themes, applied as `data-theme` on `<html>` (`frontend/src/theme.ts`,
stored under `syflo.theme`):

| `data-theme` | Label | Character |
|---|---|---|
| `professional` | Simply Blue | Light, plain: Tailwind's default grays, pinned `#2563EB` accent, system font. |
| `mushroom-kingdom` | Mushroom Kingdom | Light storybook: cream card stock, navy 2px outlines, red accent, Baloo 2 + Press Start 2P. **Default theme.** |
| `hyrule` | Hyrule | Light parchment: sage neutrals, Sheikah-teal accent, film grain, Karla + Marcellus. |
| `ink-blue` | Ink Blue | Light, cool navy neutrals, sticker shadows, DM Sans + Space Grotesk. **Hidden** from the picker since 2026-08-13 but still valid for stored preferences (`ThemeInfo.hidden` is the supported way to retire a theme). |
| `matrix` | Matrix | The only dark theme: phosphor green on near-black, **inverted gray ramp** (`gray-50` = darkest surface, `gray-900/950` = brightest text), IBM Plex Mono. |

### The one color rule

**Every visual element adapts to the active theme.** Color only through the standard
token families that the `:root[data-theme]` blocks in `frontend/src/index.css` remap:

- **Accents via `blue-*`** — the blue scale carries whatever hue the theme's accent is
  (red in Mushroom Kingdom, teal in Hyrule, phosphor green in Matrix). Writing
  `bg-blue-600` means "the accent", never literally blue.
- **Neutrals via `gray-*`** (plus `--color-white` as the page ground).
- **`red-*` is reserved for errors and destructive actions**, which deliberately look
  alike in all themes (only Matrix re-tunes red/green/amber for its dark surfaces).
- **Never hardcode a brand color or hex value for decoration.**
- Before finishing any UI work, **check the change in all five themes.**

How it works: there is no `@theme` block — the namespace is Tailwind v4's built-in
default theme, and a Syflo theme is purely a scoped re-declaration of those variables
under `:root[data-theme='…']`. Components write plain utilities (`bg-blue-600`,
`text-gray-500`); Tailwind compiles them to `var(--color-*)`, which the theme block has
already re-pointed. Semantics stay stable across themes: white/gray → surfaces and
neutral text, blue → the accent (buttons, active states, links), red/green/amber →
status.

### Fixed product constants (the only exceptions)

- **The five highlight colors** (yellow, green, blue, pink, orange) are a highlight's
  identity and are written as literal hex, never token classes — the themes would remap
  them (Matrix turns `blue-600` phosphor green, Mushroom turns it red), and a
  highlight must stay the same color everywhere it appears.
- **The logo** (`frontend/src/components/Logo.tsx`): every theme renders the same
  branch mark in its own material; its colors and fonts are the fixed brand constants
  of each theme's logo, intentionally hardcoded. Adding a theme forces a logo variant
  (the variants live in an exhaustive `Record<ThemeId, …>`).
- **PDF highlight tints**: the PDF page is white paper in every theme, so its marks are
  theme-independent pastels.

### Shadows and radii

Elevation is themed as **hard offset shadows, no blur**: the Tailwind `shadow-*`
utilities are redirected to `4px 4px 0 var(--syflo-shadow-ink)` for elements and
`6px 6px 0` for cards/overlays/modals, with the ink color set per theme. The
`--radius-*` ramp is also per theme (Matrix is nearly square at 2–8px, the playful
themes round up to 13–22px) — so `rounded-xl` means "card-round in this theme's
idiom", not a fixed pixel value.

### Matrix specifics worth knowing

- The gray ramp is inverted; **never assume `gray-50` is light.** A wash like
  `bg-gray-50` is a dark surface there.
- IBM Plex Mono ships no 700 weight, so **brightness substitutes for font-weight**:
  headings and `strong` step up the ramp and glow instead of getting bolder.
- The destructive button keeps its standard markup (`bg-red-600 text-white`); the theme
  restyles that literal class for the dark ground. Don't invent a Matrix-only variant.

## 2. Typography

- Body and display faces are theme properties, loaded self-hosted via `@fontsource/*`
  (never a CDN). Two semantic slots exist that themes restyle: **`.font-serif` is "the
  display face"** and **`.uppercase` is "a section label"** (themes adjust its size and
  letter-spacing). Use them for those roles; don't expect them to literally mean serif
  or uppercase styling alone.
- There is no global type scale in CSS — sizes are utilities per the ladder in §3.
- **Math**: KaTeX letters inherit the theme font (symbols and accents keep KaTeX's own
  fonts — UI faces lack ∑ √ big-paren glyphs); inline math is padded by
  `--syflo-math-italic-correction: 0.1em` because none of the five theme fonts ships a
  true italic and the synthesized oblique overhangs its box. Titles render through
  `MathText`, deliberately **not** a markdown pipeline: a stray `_` or `*` in a title
  must never turn into emphasis. Single-line clipping of math uses the fade mask
  (`syflo-math-fade`), not `truncate` — `text-overflow` lets KaTeX's positioned spans
  leak past the ellipsis.

## 3. The size ladder

Extracted from the running code by counting occurrences; new UI picks from these rungs.

- **Text**: `text-[10px]` badges · `11px` footnotes · `11.5px` subtitles · `12px`
  buttons · `12.5px` pill labels · `13px` row titles and card bodies · `text-sm` (14px)
  headings.
- **Radii**: `rounded-md` buttons · `rounded-lg` rows/chips · `rounded-xl` cards/menus ·
  `rounded-2xl` popups/dialogs · `rounded-full` badges/pills.
- **Lucide icon sizes**: `9–10` in badges · `11` in buttons next to 12px labels ·
  `12–14` in menu rows · `15` in card headers and popup close buttons · `16` in dialog
  headers. `strokeWidth` stays default except tiny check marks in color swatches
  (`3`–`3.5`).

## 4. Component recipes

### Buttons

| Role | Recipe |
|---|---|
| **Card action** (EVERY clickable action in a chat bubble or chat-area card — user decision 2026-09-12) | `inline-flex items-center gap-1 rounded-md border border-blue-100 bg-blue-50 px-2 py-0.5 text-[12px] font-semibold text-blue-700 transition-colors hover:bg-blue-100` — exported as `CARD_ACTION_BTN` (plus `_LINK` / `_DISABLEABLE`) in `components/ChatArea/cardActionButton.ts`; never restyle inline |
| **Quiet blue door** (popup/card footers) | `flex items-center justify-center gap-2 w-full px-3 py-2 rounded-lg text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 transition-colors` |
| **Filled primary** (dialogs only) | `text-sm font-semibold px-3.5 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50` |
| **Filled on a card in the transcript** | `h-7 px-3 rounded-lg bg-blue-700 text-white text-xs font-semibold hover:bg-blue-800` — blue-700, not 600: measured against each theme's `white`, 600 fails contrast in Hyrule/Mushroom |
| **Destructive, primary** | `px-4 py-2 rounded-lg text-sm font-medium text-white bg-red-600 hover:bg-red-700` |
| **Destructive, quiet** (e.g. Remove key) | `px-3 py-2 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50` |
| **Error surface** | `text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg border border-red-100` |
| **Icon button** | `p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors` |

Conventions: disabled always pairs `disabled:opacity-50` with a neutralized hover
(`disabled:hover:bg-<own surface>`) so the button doesn't *look* clickable; every
spinner state carries `aria-busy`. **A disabled button never carries an explanation** —
that's a sentence pretending to be a control; the reason goes in text above, and the
door either exists or doesn't. **A waiting button re-enables itself** (countdown in the
label) — never clickable before clicking can work. And **a surface that animates while
idle is lying**: nothing spins unless work is happening.

### The popup shell (floating cards: selection popup, citation card)

One shell, deliberately shared: `bg-white rounded-2xl shadow-2xl border border-gray-100
overflow-hidden`, a header with a 10px uppercase overline above the title, and a
`gray-50` footer whose buttons are **stacked, full-width and all the same quiet blue —
same surface, same color; order alone communicates priority** (decision 2026-07-20). A
filled button inside the shell was tried and looked like another app's control.

- **The state lives in the door**: a paywalled work reads "No free PDF", an imported
  one "Go to tree", a downloading one shows a spinner in a button that keeps its place
  and size — only icon and label change, the button never jumps.
- **Fixed width** (384px for the citation card): a window that keeps its size beats one
  that fits its content — two clicks in a row must not open two differently sized
  windows.
- Position is clamped against the **measured** height (ResizeObserver), because a card
  cut off at the bottom edge loses its doors.
- `role="menu"` (or `role="dialog"`) is the single wiring point for keyboard
  navigation (ADR-0011) — no popup needs bespoke key handling.

### Cards under an answer bubble (continue, search wish, seam warning, fail/quota)

- **Under the answer, never instead of it** — when real content exists, the card is a
  caveat, not a replacement. Only the `*Failed*` / `*Interrupted*` markers replace
  content, and they get the quiet gray error line + retry button.
- Shared base: `mt-2 flex flex-col items-start gap-2 text-[12.5px] text-gray-400`, an
  italic message line with a 13px icon, then a button row from the table above.
- **One card per bubble**: two cards would fight for the same click (the seam warning
  hides while a continuation still streams).
- **Never a frame inside the frame**: four of five themes give the bubble its own
  border + hard offset shadow, so a bordered card inside it reads as a window inside a
  window. Fix by dropping the second frame, not restyling it — a footer marks itself
  with a wash of the accent (`blue-100/40` is the only token wash that separates from
  the bubble in all five themes), no border, no shadow.
- Cards use standard grays for their TEXT so all themes can recolor them; their
  buttons wear the accent pill. **There is no gray secondary button in a card**
  (user decision 2026-09-12): the gray twin that used to mark secondary exits read
  as unthemed next to the accent — gray stays gray in every theme, while `blue-*`
  is exactly what the themes remap. Order alone communicates priority, same rule
  as the popup shell.
- Card copy: honest and minimal — one line naming the culprit, exits that actually lead
  out, at most one footnote. **Never two sentences in one paragraph**: the second is
  always a different kind of claim, so it gets its own line and the darker gray.

### Kurzinfo (data-tip)

- **The native `title` attribute is dead in this app**: Chromium pops it up only after
  a second of stillness and in the running app it often never appeared (2026-08-11,
  again 2026-09-12) — and it never matches the theme. The replacement is the CSS-only
  `data-tip` bubble in `index.css` (ink `gray-900` on paper `gray-50`, which every
  theme remaps — Matrix inverts to light-on-dark automatically).
- Icon-only controls carry `data-tip` directly. **Not every icon**: a control sitting
  beside the value it changes explains itself and shows nothing.
- Truncated row labels (sidebar chats, categories) get the bubble via
  `overflowTip(fullTitle)` from `src/overflowTip.ts`, spread onto the row with the
  label span marked `data-overflow-label`: it measures on hover and arms
  `data-tip` + `data-tip-below/-start/-wrap` **only while the text really is cut** —
  a bubble repeating a fully visible label is noise. `data-tip-wrap` is the
  long-text variant (wraps, `max-width: 14rem`); never use nowrap bubbles for titles.

### Menus

- Shell: `fixed z-50 bg-white rounded-xl shadow-2xl border border-gray-100
  overflow-hidden`, clamped to the viewport.
- **Width is a minimum, never fixed** (`minWidth` + `width: max-content`): the menu
  sizes to its longest action — a fixed width wrapped German labels in Matrix's wide
  monospace. Rows carry `whitespace-nowrap`.
- Behavior: closes on Escape and outside click (attach the `mousedown` listener on the
  next tick so the opening click doesn't immediately close it); recolor swatches keep
  the menu open for comparing; an action that doesn't apply is **hidden, not
  disabled**; delete needs no confirmation when redoing is faster than a modal dance.

### Dialogs

- Overlay `fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4`
  (click closes); panel `role="dialog" aria-modal="true"` +
  `bg-white rounded-2xl shadow-2xl w-full max-w-xl overflow-hidden` (narrow dialogs
  `max-w-md`); header `px-5 py-4 border-b border-gray-100` with a `text-base
  font-semibold` title and the standard icon close button.
- **Escape closes — like every other transient surface in the app.** No exceptions;
  a dialog without an Escape path dead-ends the keyboard journey.
- **Fixed body height** for tabbed dialogs (content scrolls internally) so the modal
  doesn't jump between tabs. The tab rail auto-sizes (`min-w-40 max-w-56`) because
  fixed widths overflow in the wide theme fonts; it declares `data-keyboard-rail` so
  ↑/↓ walk the tabs and → crosses into the page. The focus ring enters a dialog on the
  active tab — the same "here you are" convention as the sidebar's open chat row.

### Chips and badges

- **Chips are pill-shaped and border-less** when they carry content (attachments,
  queued model): `inline-flex items-center gap-…, rounded-full bg-gray-100 …`.
  Filter chips are the exception: `rounded-full border px-2.5 py-[3px] text-[11px]`,
  where **active = accent border + bold (`border-blue-600 text-blue-700 font-bold`),
  never a filled surface** — fills collide with the highlight dot colors. While "All"
  is active nothing fades: a bar of grayed chips reads as "everything is off".
- **Badges**: `inline-flex items-center gap-1 rounded-full border px-1.5 py-px
  text-[10px] font-semibold whitespace-nowrap`. The color family is the state's
  meaning: **gray = "we do not know", amber = "there is a wait to sit out"**, green =
  saved/OK, blue = an action to take. A row carrying a state badge is a row that cannot
  be used right now — membership and badge come from the same source so they can't
  disagree; group headlines stay neutral (a colored headline would double the alarm).
  A badge never repeats what its label already says (no check icon next to "saved").
- Key fingerprints: a stored API key shows as a chip (`font-mono`, `tvly-…seCS`) whose
  only exit is Remove — an editable "replace" field next to a stored key reads as "no
  key here".

### Drop-ups and layering

`components/Popover.tsx` is the one portal layer for drop-ups: **it does position
only — the caller keeps the optics** and passes its own class recipe. It exists because
in-pane `absolute` panels get clipped by `overflow-hidden` columns. Z-order is part of
position: in-pane layers z-10…30, popovers z-40, menus/dialogs/popups z-50, focus ring
z-60.

## 5. Icons

- **Lucide only — no emojis anywhere**: in the app, in mockups, in UI copy.
- Sizes per the ladder (§3); icons in flex rows carry `shrink-0` (plus `mt-0.5` with
  `items-start`); decorative icons are `aria-hidden`, meaningful ones carry an
  `aria-label` ("the icon replaces a '·' separator — the eye jumps straight to 'who'
  or 'when'").
- App-wide icon vocabulary: `Info` (13px) = a hint/aside; `Clock` = the one countdown
  idiom; `Loader2` + `animate-spin` + `aria-busy` = every spinner; each slash command
  keeps its own icon (a shared one would mute the line). Lucide carries no brand
  icons — use the closest generic (`TvMinimalPlay` for YouTube).

## 6. Copy and i18n

- All user-facing strings live in `frontend/src/strings.ts`: `en` is the source of the
  types, `de: Strings` forces every new line to exist in both languages; strings with
  values are functions (`truncatedAtMark(mark)`); plurals are ternaries in place —
  deliberately no i18n framework at two locales. German copy must be orthographically
  correct (ä/ö/ü/ß).
- **The reader is owed the consequence, not the cause**: "Search paused", not "Too many
  requests". **Numbers and limits, never a recommendation**: "1000 searches a month
  free" is a fact the reader can weigh; "recommended" would be deciding for them.
- Command names (`/btw`, `/branch`) are never translated — the label teaches the
  trigger. Silent gestures (Escape, the first keystroke) are never explained in the UI.

## 7. Motion

- **One flash beat everywhere: 3 × 0.45 s ease-in-out** (jump flashes, highlight
  pulses, focus-ring glow). If the beat changes, it changes for all of them.
- **The pulse brightens, never darkens**: flashes lift the resting tone toward white
  (via the token, so Matrix brightens from its own dark tints) instead of dipping to a
  saturated dark peak.
- Jump halos are one overlay group on `<body>` whose `drop-shadow` runs around the
  target's shared silhouette; light themes blend white × `multiply`, Matrix flips to
  black × `screen`. The flash color for element jumps is `var(--color-blue-600)` — the
  theme's accent, so the flash is red in Mushroom and green in Matrix.
- `prefers-reduced-motion` is honored for every looping animation.

## 8. Keyboard and focus (ADR-0011)

- Keyboard navigation adds exactly one visual element: the **focus ring** — a single
  fixed overlay (`2px white halo + 1px gray-900 ring, radius 7`), one shape around the
  whole item even when the item is painted in pieces. **It carries no hue on purpose**:
  color is already spoken for (blue fill = "this chat is open", colored bar = highlight
  kind). Buttons drop the browser's native ring; text fields keep theirs — there the
  ring is the caret's home.
- New interactive UI joins the system declaratively: `data-focus-item` on items,
  `role="menu"` / `role="dialog"` on takeover surfaces, `data-keyboard-rail` on a tab
  column. No component wires its own key handling.

## 9. CSS mechanics and traps

- **The cascade-layers trap**: Tailwind v4 puts its utilities in `@layer utilities`,
  and *unlayered CSS beats any layer regardless of specificity*. Every top-level rule
  in `index.css` silently overrides utilities. The themes exploit this deliberately
  (restyling literal classes like `.border-gray-200`); everyone else must beware —
  never add an unlayered reset or broad rule without excluding what Tailwind already
  positions (`:not(.absolute):not(.fixed):not(.sticky)`).
- `!important` is reserved for beating **inline styles** (and one documented
  specificity fight) — never for winning against layers.
- The chat-bubble skins key on `.bg-gray-100.select-text` / `.prose.select-text`,
  never bare `.prose` — otherwise every embedded `prose` block (the `/btw` fold-out)
  grows a bubble inside a bubble.
- Styling that themes must override lives in `index.css` under a `.syflo-*` class, not
  inline in the component.
- **A theme's `.font-serif` override sets the family, never a `font-size`**: being
  unlayered, a fixed size there beats every `text-*` utility on the element — Mushroom
  Kingdom's 22px blew the citation card's 13px raw-text fallback up to display size
  (fixed 2026-09-12). A place that wants a display size sets its own class
  (`.syflo-empty-title`).

## 10. Verifying UI work

Green tests are not verification. Every frontend change is checked in the **running
app** (real browser, real gesture, read the result from the UI and the database) — and
**in all five themes** before it's done. The theme most likely to break an assumption
is Matrix: dark ground, inverted grays, wide monospace labels.
