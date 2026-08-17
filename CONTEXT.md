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
pinned; the rows carry no marking of their own, the section heading does
(design/mockup-pinned-chats.html).
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
Deleting a category frees its chats, never deletes them
(design/mockup-sidebar-categories-v2.html).
_Avoid_: folder, tag, label, project

**Highlight**:
A colored, persistent marking of a text passage, created via the right-click menu.
Five colors: yellow, green, blue, pink, orange. Two kinds sharing colors and labels:
a **PDF highlight** (in the tree's PDF, anchored geometrically per page) and a
**chat highlight** (in a chat message, anchored by character offsets so it survives
reflow).
_Avoid_: annotation, marking, Markierung

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
more precise trace (design/mockup-branch-trace.html, variant A, 2026-08-09).
_Avoid_: branch marker, fork line, breadcrumb

**Parent context**:
The read-only rendering of a branch's parent chat in the center pane when the tree
has no PDF — keeps the passage the branch came from visible. With a PDF attached the
PDF keeps the center. Above it, the **ancestor chain** renders what the branch inherits.
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
full-text path — retrieval is the exception, not the default.
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
the top-8 by cosine similarity are injected in document order.
_Avoid_: passage, snippet, embedding (that's the vector, not the text)

**YouTube transcript**:
A source fetched from a YouTube video chosen via in-app search: the video's full
caption text plus its title and channel. Always qualified — a bare "transcript" is
the dictation output, not this.
_Avoid_: transcript (unqualified), video (as the source's name)

**Video overview**:
The first reply in a tree with a YouTube transcript, produced by an auto-sent visible
user message right after import. A restructuring of the video's content — sections and
key points with nothing substantive dropped — not a summary.
_Avoid_: summary (that's lossy; this isn't), auto-prompt (that's the message triggering it)

**Paper search**:
Searching external indices for a research paper from the plus menu and attaching
the found paper's PDF to the current chat.
_Avoid_: import, fetch

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

**Model ladder**:
The curated list of recommended vision models, one per machine-size class (small /
medium / large). The ladder is the app's own opinion of what is good; it is independent
of what happens to be installed.
_Avoid_: model list (unqualified), presets

**Recommended model**:
The ladder rung matching the current machine's hardware. It becomes the default
automatically once installed — unless the user has chosen a model manually; a manual
choice always wins. A recommended model that is not yet downloaded can be seen and
downloaded, but never activated before the download completes.
_Avoid_: auto model, suggested model

**Web search**:
A tool call the chat model makes against the local SearXNG instance to pull live web
results into the conversation. Not related to Paper search.
_Avoid_: search (unqualified), SearXNG search

**Thinking quote**:
An entry of the curated quote pool (`frontend/src/components/ChatArea/quotes.json`)
rotated in the thinking indicator while a reply is pending. Every quote — including
hand-added ones — must pass the curation rules in `scripts/build-quotes.mjs`:
genuinely famous author, fundamental truth (no politics, romance kitsch, or insider
humor), PG-rated, no known misattribution. Rejected quotes/authors live in
`scripts/quotes-blocklist.json` and stay excluded on rebuilds.
_Avoid_: tip (that's the feature hints), loading message

**Custom instructions**:
User-authored free text, managed in Settings, injected into the system prompt of every
chat reply (and its warm-up). Global — one text for all chat trees — and switchable
on/off without deleting the text. Does not apply to Explain, chat titles, or chat
summaries.
_Avoid_: persona, personalization, system prompt (that's the whole assembled prompt)

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
private inbox (ADR-0010) — never auto-posted as a public GitHub issue.
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
layout has hidden is not an item. An **open menu** is a region too, and while one is up
it is the only one there is.
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
