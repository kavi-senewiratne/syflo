# Syflo

General-purpose branching-chat app: one conversation can branch into a tree of focused
sub-chats, navigable as a mind map. Formerly named **FlowTalk**; selected features were
ported from an earlier research-focused prototype (repo `syflo-2`).

## Language

**Branch**:
A sub-chat spun off from a word or selection in a parent chat. Branches form the chat tree.
_Avoid_: sub-conversation, thread, fork

**Chat tree**:
The hierarchy of a root chat and all its branches, shown in the left sidebar with
connector lines (trunk + elbows).
_Avoid_: chat list, history

**Pinned chat**:
A root chat lifted out of the sidebar's date sections into one **Pinned section** at the
top, ordered most recently pinned first (`chats.pinned_at`). Pinning is pure navigation —
it changes where a tree is listed, nothing about the tree itself. Only roots can be
pinned; the rows carry no marking of their own, the section heading does.
_Avoid_: favorite, starred, bookmark

**Category / Subcategory**:
A named container for root chats that the USER creates — the third grouping in the
sidebar, next to the two the system imposes (Pinned, and the date sections). A
**subcategory** is a category with a `parent_id`: one table, one type, so renaming,
collapsing and deleting are the same code at both levels. Nesting stops at two;
`chats.category_id` points at either level. A **filed** chat leaves the date sections.
Filing and pinning are **mutually exclusive** — they answer the same question
(where does this tree live), so filing clears the pin and pinning unfiles.
Only the positive gesture clears the other: taking a chat out of a category
does not unpin it, and unpinning does not unfile it.
Deleting a category frees its chats, never deletes them.
_Avoid_: folder, tag, label, project

**Abandoned chat**:
A root chat that is unambiguously worthless: no messages, no branches, no source, no
attachments, not pinned. The frontend deletes one when it is left; the backend sweeps
the stragglers at startup (`backend/cleanup.js`) with a 15-minute grace period, so a
dev-server restart never deletes the empty chat still open in the frontend. The
definition must stay identical in both places.
_Avoid_: empty chat (only one of the criteria), stale chat, orphan

**Highlight**:
A colored, persistent marking of a text passage, created via the right-click menu.
Five colors: yellow, green, blue, pink, orange. Four kinds sharing colors, labels and
gestures: a **PDF highlight** (in the tree's PDF, anchored geometrically per page), a
**chat highlight** (in a chat message, anchored by character offsets so it survives
reflow), a **transcript highlight** (in a YouTube transcript block, anchored by
offsets plus the block's `start_seconds` — read from the block, never chosen), and a
**chapter highlight** (offsets into the Video overview text the chapter list renders;
`transcript_highlights.source` separates the last two). One gesture on every surface:
clicking an existing highlight opens the recolor/delete actions menu — the linked
chat is a menu item, never the click itself (parity decision 2026-09-10).
_Avoid_: annotation, marking, Markierung, mark (UI shorthand for the video kinds)

**Ask in chat**:
The popup action on a selection (PDF or chat text) that drops the selection into the
**current** chat's composer as a removable **composer quote** — no branch is created
(branching stays "Open as new chat"); sending renders the quote as a blockquote above
the question.
_Avoid_: quote to chat, reply with quote

**Side question** (`/btw`):
A question asked with the `/btw` composer command that **never enters the transcript**.
Its answer folds out above the input field as the **btw panel** — part of the composer,
not a message — and is discarded by the first keystroke, Escape, or the panel's ×, none
of which the UI explains. The panel belongs to its **chat**, not to the screen: opening
another branch leaves it behind and coming back finds it there; a reload clears every
side question, because none ever reaches the database. Two actions make one permanent:
**Keep in chat** appends question and answer as ordinary messages at the end of the
thread, **Make a branch** opens a branch whose parent quote is the question, so the
**answer is its first bubble**. The panel is labelled `/btw` in both languages — it is
named after the command, not translated.
_Avoid_: aside message, temporary message, scratch chat

**Topic branch** (`/branch`):
A branch created by typing `/branch <topic>` in the composer instead of selecting a
passage. It has **no `parent_word` and no highlight kind** — its header shows the parent
link alone and its map node carries no colour bar. The topic is asked verbatim as the
branch's first message, and the branch's title comes from the same `passage-title` call
the selection popup uses. Where it hangs is chosen before Enter: the composer chip names
the parent — the current chat by default, changeable to the root or any chat of the same
tree via the **branch target** picker. Never crosses into another tree (ADR-0002).
_Avoid_: manual branch, empty branch, quick branch

**Branch trace**:
The mark a branch leaves in the chat it was opened from. A branch from a **selection**
already has one — its coloured passage, which carries `message_highlights.child_chat_id`.
For the two commands **without** a passage, `/btw` and `/branch`, the trace is a
**branch line**: a divider in the parent transcript, drawn right after
`chats.branch_anchor_message_id` — the last message that existed when the command was
sent — carrying a pill with the command name and the branch title. A click opens the
branch; from inside the branch, the header link walks back and makes the line glow.
An anchor that resolves to nothing (empty chat, deleted message) floats its line to the
top of the transcript. Selection branches deliberately get no line: their passage is the
more precise trace (decision 2026-08-09).
_Avoid_: branch marker, fork line, breadcrumb

**Parent context**:
The read-only rendering of a branch's parent chat in the center pane when the tree
has no source — keeps the passage the branch came from visible. With a source attached
the source keeps the center: the PDF viewer, or the Video pane. Above it, the
**ancestor chain** renders what the branch inherits.
_Avoid_: context view (unqualified), preview pane

**Ancestor context**:
The conversational context a branch inherits from its path to the root (ADR-0003):
the direct parent verbatim, grandparents+ as cached **chat summaries**, plus the
`parent_word` chain. Never includes sibling branches.
_Avoid_: parent context (that's the UI pane), history injection

**Selection surroundings**:
The text-layer lines around a PDF selection (±2 spans, ≤400 chars), captured at
selection time and stored as `chats.parent_context` when a branch is opened from a
PDF selection (decision 2026-07-26). Needed because PDF text extraction flattens
math notation ("Rm" for ℝ^m); the branch prompt cites the surroundings and warns the
model about the flattening. Chat-selection branches don't carry it — their
`parent_word` is already the full selected passage.
_Avoid_: selection context (too close to ancestor context), snippet

**Chat summary**:
The cached ~120-word LLM summary of one chat (`chats.summary`), used as the inherited
form of grandparents+ in the ancestor context. Kept live via a staleness check on the
last covered message id; warmed up in the background when a branch is created.
_Avoid_: digest, compression

**Color label**:
A user-editable name attached to one of the five highlight colors (e.g. "Important",
"Question"), renamed inline in the right-click menu.
_Avoid_: tag, category

**Highlight kind**:
The color (and thus color label) of the highlight a branch was opened from — carried
into the chat tree as `highlight_color` and shown as the color bar on the left edge of
a mind-map node. Branches opened without a highlight have none; that is not a sixth
kind. It is the only lens the map colors by (decision 2026-08-02: "source section" and
"status" were dropped).
_Avoid_: highlight type, category, lens (that's the mechanism, not the value)

**Outcome line**:
The mind-map node's second line: 4–8 words on what the conversation established,
stored in `chats.outcome`. Written by the title call that already runs after the first
answer, so it costs no extra LLM round — and the answer travels inside that
instruction, because on cloud providers the call is that single message and nothing
else. While a branch has a real answer but no outcome yet, the node shows a
same-height placeholder; a freshly opened branch — or one whose only answer ended in a
`*Failed*`/`*Interrupted*` marker — shows the title alone. If the line never arrived
(quota, timeout, a model that skipped it), the next answer in that branch asks again
with an outcome-only call, and `scripts/backfill-outcomes.js` fills in branches nobody
revisits.
_Avoid_: gist (that's `summary_display.gist`, the context banner's), summary, result

**Kind filter**:
The chip row above the mind map — "All" plus one chip per highlight kind that occurs,
multi-select, stored per tree in `localStorage`. Filtered-out branches fade, they never
disappear: hiding intermediate nodes would break the tree into floating islands.
The highlights drawer wears the same chips.
_Avoid_: lens switch, colour-by (that switch was dropped)

**Source**:
The one external document a chat tree is about, bound to the tree's root — today either
a paper (PDF) or a YouTube transcript. A tree has at most one source (ADR-0002,
generalized); adding a second one prompts starting a new tree.
_Avoid_: attachment (that's message-level), document (unqualified)

**Retrieval mode**:
The prompt strategy for a source that exceeds the context window (ADR-0006): the
system prompt carries the source's **skeleton**, and per question the most relevant
**source chunks** are appended after the history. Sources that fit stay on the
full-text path — retrieval is the exception, not the default — and the Video overview
never uses it (decision 2026-08-20).
_Avoid_: RAG (implementation jargon), search mode

**Skeleton**:
The stable, per-source-identical stand-in for a long source in the system prompt:
beginning (title/abstract), section outline, end (conclusion). Exists so the KV-cache
prefix survives every question in retrieval mode.
_Avoid_: summary (it's verbatim material, not a rewrite), outline (that's one part of it)

**Source chunk**:
A paragraph-aligned piece of a source (~800 tokens, with its section heading),
embedded via the local embedding model — embeddings always run locally, regardless of
the chat provider — and cached in `source_chunks`. The cache is stamped with the
embedding model that produced it; a mismatch triggers a rebuild. Per question,
the top-5 by cosine similarity are injected in document order (8 → 5, addendum
2026-07-25).
_Avoid_: passage, snippet, embedding (that's the vector, not the text)

**YouTube transcript**:
A source fetched from a YouTube video chosen via in-app search: the video's full
caption text plus its title and channel. Always qualified — a bare "transcript" is
the dictation output, not this.
_Avoid_: transcript (unqualified), video (as the source's name)

**Video overview**:
The first reply in a tree with a YouTube transcript, produced by an auto-sent visible
user message right after import. A restructuring of the video's content — sections and
key points with nothing substantive dropped — not a summary. Always answered from the
full transcript: `overview: true` switches retrieval mode off and lifts the token
budget cap (decision 2026-08-20); the section count scales with video length. Long
videos are written over several self-continuation rounds; custom instructions are
excluded (the user's settings text surfaced between two chapters, 2026-09-04).
_Avoid_: summary (that's lossy; this isn't), auto-prompt (that's the message triggering it)

**Video pane**:
The center pane of a tree with a YouTube transcript: the embedded player, the
transcript as timestamped blocks, and the chapter list — with highlights on both
texts (`frontend/src/components/VideoPane`). Replaced the earlier transcript drawer
and video banner.
_Avoid_: transcript drawer, video banner (both removed), player (that's one part of it)

**Chapter**:
One section of the Video overview as a navigable object: a `##` heading carrying a
`[m:ss - m:ss]` range, plus one bold **key point**. Chapters are not a second model
call — they are parsed out of the overview message itself
(`frontend/src/markdown/chapters.ts`; `parseChapterHeading` accepts every heading
shape real models have produced, kept in step with `backend/overview-progress.js`).
Shown as the chapter list under the player; markable as chapter highlights.
_Avoid_: section (unqualified), timeline entry

**Time link**:
A timestamp in an overview or reply made clickable to seek the player — added by
post-processing (`frontend/src/markdown/timeLinks.ts`), not by a prompt rule, so old
overviews turn clickable too.
_Avoid_: deep link, seek button

**Overview coverage**:
How far into the video the overview actually reaches, judged from the answer's own
time ranges plus `messages.covered_until_seconds` — how much transcript the model was
even shown. Catches two failure shapes: an overview that stops short shows "ends at X
of Y" with a continue path, and one whose transcript was cut says so. Exists because
a model can stop cleanly (`finish=stop`) after a quarter of a long video — nothing is
truncated, yet the reader gets a fragment with no hint.
_Avoid_: progress, completeness

**Paper search**:
Searching external indices for a research paper from the plus menu and attaching
the found paper's PDF to the current chat.
_Avoid_: import, fetch

**Citation card**:
The card a clicked citation opens — a citation mark in the paper's running text and a
row of its reference list open the same card. Four lines and two doors: title, one
meta line, two lines of context, then the actions; the state lives in the door ("No
free PDF", "Go to tree", a spinner). Backed by a one-time background pass per paper
(`backend/references.js`) that writes `paper_references` (the bibliography) and
`paper_citations` (the click targets); a tree opened through the card records its
origin (`chats.cited_from_chat_id` + `cited_ref_label`).
_Avoid_: reference popup, footnote, bibliography entry (that opens the same card)

**Plus menu**:
The attach menu opened by the round + button in the chat composer, offering
"Media", "PDF", "Research paper", and "YouTube Transcript". The paperclip appears
only as an item icon.
_Avoid_: paperclip menu

**Availability**:
A paper-search result's PDF status: *open* (importable), *manual* (a free copy exists
but its host blocks automated download), *paywalled* (no free copy; only a publisher
link is offered).
_Avoid_: access status, lock state

**Cloud provider**:
A chat-reply provider that runs on an external service using the user's own API key —
Syflo never ships, proxies, or shares keys. Some cloud providers include a free quota
("Free" cost badge); that is a pricing property, not a separate kind of provider. Every
cloud provider comes with a step-by-step in-app guide for obtaining its key.
_Avoid_: free provider (as a category), remote model

**Local provider**:
The chat-reply provider that runs models on the user's own machine. Its promise is
privacy — chat content (source, questions, answers) never leaves the device. That it
also happens to work without internet (for PDF trees, without web search) is a side
effect, not the promise.
_Avoid_: offline mode, offline provider

**Vision model**:
A chat model that can read images, including text inside images (figures, screenshots,
scans). For the local provider, only vision models are offered for selection — models
without this ability are not selectable. Cloud providers may offer text-only models;
those are labeled as such, and image attachments are rejected with a hint while one is
active — never silently dropped.
_Avoid_: multimodal model (unqualified), OCR model

**Failover ladder**:
The shared, ordered list of provider/model candidates a reply walks down when the
current choice cannot answer (quota, retirement, outage) — one implementation
(`backend/quota.js`) used by chat replies, Explain, titles and `/btw`. Each rung can
sit in a **cooldown** whose kind says why it is skipped: `daily` (until the provider's
reset), `minute`, `retired` (24 h), `unknown`. The ladder never steps onto a paid rung
on its own (decision 2026-07-30).
_Avoid_: model ladder (the removed hardware-recommendation feature — ADR-0008
amendment 2026-07-25 froze local to a plain `ollama pull` fallback), fallback chain

**Retired model**:
A model its provider has shut off. `RETIRED_MODELS` (`backend/database.js`) is the
list; its migration moves a stored model choice onto the named successor, because
removing the model from the registry alone left the picker selecting a 404 (Groq's
Llama retirement, 2026-09-04). The picker marks a retired choice with a "no longer
available" badge; the next retirement is a line in that list.
_Avoid_: deprecated model, removed model

**Web search**:
A tool call the chat model makes against Tavily, under the user's own key
(ADR-0012), to pull live web results into the conversation. The tool is always
offered — key or no key (2026-08-25); a search that cannot run reaches the UI as a
named failure state (`no-search-provider`, `tavily-invalid-key`,
`tavily-quota-exhausted`) instead of being silently dropped. Settings show a stored
key only as its **key fingerprint** (`tvly-…seCS` — first five plus last four
characters): the frontend learns THAT a key exists, never the key. Not related to
Paper search.
_Avoid_: search (unqualified), SearXNG search (removed 2026-08-23), Tavily search

**Search wish**:
The record that the model called web_search and the search could not run, persisted
per message (`messages.search_wish_query` / `search_wish_error`) for deterministic
causes only — no key, invalid key; an exhausted quota is deliberately transient
because Tavily resets monthly. Rendered as the **search-wish card** under the answer,
never instead of it — the answer is real, it is just older than the question. The
card can save a key and re-ask; the re-ask carries a **search nudge** naming the
wished query, because the model otherwise copies its own refusal from one turn up.
The stored user message stays raw.
_Avoid_: failed search (the answer didn't fail), search error (that's the cause field)

**Truncated answer**:
An answer whose provider stopped mid-thought — `finish_reason` length/content-filter,
or a missing finish chunk — flagged as `messages.truncated` and persisted, because
half an answer reads like a whole one. Normally healed invisibly by
self-continuation; the "Continue writing" card under the bubble is the fallback, not
the normal path. Continuations extend the same message: one answer never becomes two
bubbles.
_Avoid_: incomplete answer, cut transcript (that's overview coverage), aborted
(that's the *Interrupted* marker)

**Self-continuation**:
The loop that finishes a truncated answer without being asked: rounds continue until
a round adds nothing, a round fails, or the round cap is hit (flat for chat answers,
video-length-scaled for the overview). Each round is overlap-stitched onto the
existing text at the **seam** (`backend/continuation.js`).
_Avoid_: auto-continue (the UI never names it), retry (that's for failures)

**Seam suspect**:
A continuation whose seam could not be verified — no overlap, the existing text ends
mid-sentence, and the new text starts with a word character — so words may be missing
at the join. The first suspect round is discarded and retried once; a second is kept
but flagged (`messages.seam_suspect`) and shown with a warning card whose way out is
Regenerate, never more continuing.
_Avoid_: bad seam, glitch, corruption

**Retryable marker**:
One of two fixed strings stored *as* the message content when there is no answer:
`*Failed*` (generation failed; offers retry) and `*Interrupted*` (the user hit stop).
UI states living in the content column — but they are filtered out of every prompt,
and the next question may replace them in place. Also the reason such a branch shows
no outcome line.
_Avoid_: error message (it's a state, not text from anyone), placeholder

**Thinking quote**:
An entry of the curated quote pool (`frontend/src/components/ChatArea/quotes.json`)
rotated in the thinking indicator while a reply is pending — each line is a 50/50
coin flip between a feature tip and a quote; quotes circulate in an active pool of 50
and retire after three showings. Every quote — including
hand-added ones — must pass the curation rules in `scripts/build-quotes.mjs`:
genuinely famous author, fundamental truth (no politics, romance kitsch, or insider
humor), PG-rated, no known misattribution. Rejected quotes/authors live in
`scripts/quotes-blocklist.json` and stay excluded on rebuilds.
_Avoid_: tip (that's the feature hints), loading message

**Custom instructions**:
User-authored free text, managed in Settings, injected into the system prompt of every
chat reply (and its warm-up). Global — one text for all chat trees — and switchable
on/off without deleting the text. Does not apply to Explain, chat titles, chat
summaries, or the Video overview including its continuation rounds (2026-09-04).
_Avoid_: persona, personalization, system prompt (that's the whole assembled prompt)

**Mockup**:
A standalone HTML page that proposes new UI before any of it is implemented. Anything
visually new starts as a mockup: variants are built side by side under neutral labels
(A/B/C — the page argues, the maintainer decides), one is approved, and only then does
implementation begin, checked against the approved page. The written rules distilled
from the mockups live in `docs/STYLE.md`; the mockup pages themselves are a local
design workshop and are not part of the published repo.
_Avoid_: prototype (mockups are static pages, not wired), wireframe, design file

**Syflo**:
This product (formerly **FlowTalk**; repo renamed 2026-07-18). Not to be confused with
the earlier research-focused prototype living in repo `syflo-2`, from which selected
features were ported.
_Avoid_: SciFlow, Ciflow (voice-transcript artifacts), FlowTalk (old name)

**App language**:
The language (German or English) the UI chrome, every auto-sent message (e.g. the
auto-prompt that produces the Video overview), and Explain answers are written in;
chosen in Settings. Does not change the reply language of the user's own conversation
— that stays mirrored to the user's message — and does not affect Dictation, which
always auto-detects.
_Avoid_: locale (technical term), UI language (too narrow — it also governs auto-sent
messages), language (unqualified)

**Feedback**:
A short text message (kind: Bug / Idea / Question, plus optional reply-to
email) sent from the sidebar button or the `/feedback` composer command to a
private inbox (ADR-0010) — never auto-posted as a public GitHub issue. Sent straight
from the browser (Web3Forms; the backend only supplies the key); when sending fails,
the dialog offers the public issue tracker as the manual fallback.
_Avoid_: bug report (too narrow — also covers ideas/questions), issue (that's
the public GitHub artifact the maintainer may create afterward)

**Keyboard region**:
One of the areas the keyboard moves between: the mind map lying across the top, then
sidebar, source, chat and highlights drawer left to right — an **L**, not a row. Each
region is one stop and remembers the item last focused in it. A region that is not on
screen is skipped; a region that is on screen is never skipped, even when empty (a paper
with no highlights falls back to focusing the page). Everything interactive inside a
region is an item — message bubbles and chat rows, but equally the composer's attach,
mic, model and send buttons and the collapsed sidebar's rail buttons. A control the
layout has hidden is not an item. A **takeover surface** — an open menu or a dialog —
is a region too, and while one is up it is the only one there is; its form fields are
items (Enter focuses them for typing), and a dialog that declares a tab rail splits
into two regions, rail and page, with `←` `→` crossing between them.
_Avoid_: pane, panel (that's the drawer), landmark, column (the map isn't one)

**Focus ring**:
The single neutral outline marking where the keyboard is — one shape around the whole
item even when the item is painted in several pieces (a formula's bands, a highlight
wrapping over lines) — the only visual element keyboard
navigation adds, and the **only** one: `Tab` no longer moves the browser's own focus
inside the app, because two indicators read as two places the keyboard was. Its first
appearance is on whatever the app already marks as current (the open chat's row);
afterwards it returns to wherever it was left. It carries no hue of its own, because colour is already spoken for:
a blue fill means "this chat is open" and a coloured left bar means highlight kind, one
of which is blue. Fill, bar and ring are three separate channels and can all be true of
one row at once.
_Avoid_: selection (that's text or the open chat), highlight, active state, cursor

**Edge overflow**:
The single rule that lets arrow keys mean two things without a mode: an arrow key serves
the focused region first, and only once that region has nothing left to do does it leave
for the neighbour. A region is **rows** — mostly rows of one, but the composer's
buttons and the sidebar's header sit side by side — so `←` `→` walk the row first,
then collapse a tree node, and only then cross into the neighbouring region; `↑` `↓`
change row and only then rise into the mind map. Same rule on both axes, and the mind
map's generations are not a special case, they are just a region with wide rows.
_Avoid_: fallthrough, bubbling (that's the DOM's), wrap-around (it never wraps)

**Dictation**:
Voice input in the chat composer: while recording, speech is buffered; on stop the
whole transcript is inserted into the composer as one block. Understands German and
English — including mixed sentences — and transcribes on-device; audio never leaves
the machine.
_Avoid_: voice input (unqualified), speech-to-text (that's the mechanism, not the feature)
