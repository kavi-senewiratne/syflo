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

**Chat summary**:
The cached ~120-word LLM summary of one chat (`chats.summary`), used as the inherited
form of grandparents+ in the ancestor context. Kept live via a staleness check on the
last covered message id; warmed up in the background when a branch is created.
_Avoid_: digest, compression

**Color label**:
A user-editable name attached to one of the five highlight colors (e.g. "Important",
"Question"), renamed inline in the right-click menu.
_Avoid_: tag, category

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
embedded via the local embedding model and cached in `source_chunks`. Per question,
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

**Vision model**:
A chat model that can read images, including text inside images (figures, screenshots,
scans). For the local provider, only vision models are offered for selection — models
without this ability are not selectable.
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

**Dictation**:
Voice input in the chat composer: while recording, speech is buffered; on stop the
whole transcript is inserted into the composer as one block. Understands German and
English — including mixed sentences — and transcribes on-device; audio never leaves
the machine.
_Avoid_: voice input (unqualified), speech-to-text (that's the mechanism, not the feature)
