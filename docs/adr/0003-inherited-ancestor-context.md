# Inherited ancestor context for branches

Status: accepted (2026-07-20)

A branch chat inherits conversational context from its whole ancestor path up to the
root — never from sibling branches. The fidelity is hybrid: the direct parent chat goes
into the system prompt verbatim, grandparents and higher as cached ~120-word summaries,
plus the `parent_word` chain as a one-line thread. We chose this over "direct parent
only" (breaks as soon as the parent refers to something further up) and over "everything
verbatim" (multiple full transcripts on top of up to 40k chars of paper text would
drown a local 11B model).

Summaries are a pure cache (`chats.summary`), kept live: `chats.summary_last_message_id`
stores the last covered message; a mismatch means stale, regenerate. Creating a branch
warms the ancestor chain's summaries in the background (branching is the earliest signal
they will be needed); the lazy path at message time is the correctness fallback. The
summarizer is whatever chat model is configured — no separate model.

Budgets are character-based (matching `MAX_PAPER_CHARS`), not token-based. An over-long
parent transcript is hybridized recursively: cached summary + the last ~10 messages
verbatim. If the total still exceeds the budget, the sacrifice order is: paper text
first, then ancestor summaries oldest-first — the parent transcript is never touched,
because conversational proximity is what drill-down questions live on.

The UI shows exactly what the model inherits (mockup section 04 in
`design/mockup-chat-highlights-ask-in-chat.html`): the chain line plus one collapsible
summary card per grandparent+ above the parent-context pane. Display = prompt, so a bad
answer caused by a bad summary is diagnosable at a glance.

## Addendum 2026-07-25: sacrifice order flipped (summaries before source)

The original sacrifice order (paper text first, then summaries) predates the KV-cache
work and optimized purely for answer quality. Measurements on the hybrid-attention
qwen3.5 (`scripts/experiments/kv-snapshot-spike/`) showed that any byte change to the
source block invalidates the expensive tree-wide shared prefix — a branch then pays
the full ~60 s source prefill again instead of a cache hit. Two coupled changes:

1. `applyContextBudget` now drops ancestor summaries (oldest first) BEFORE touching
   the source, which stays byte-identical whenever anything else can yield; the
   parent transcript remains untouchable.
2. The full-text-vs-retrieval decision (ADR-0006) no longer subtracts ancestor
   context (`sourceRoom = MAX_SYSTEM_CONTEXT_CHARS`, messages.js) — a source keeps
   the same representation across the whole tree instead of flipping modes per node.

## Addendum 2026-07-26: selection surroundings for PDF-selection branches

The PDF text layer flattens math notation — a selection of ℝ^m arrives as the two
bare letters "Rm", and the branch prompt's old wording ("exploring the term … from a
previous conversation") sent the model looking for the symbol in the wrong place
(live incident: the model asked the user which symbol they meant).

Decision (variant "capture at source", chosen over server-side reconstruction):

1. The frontend already computes the selection surroundings for the popup's explain
   call (`contextAroundSelection`, ±2 text-layer spans, ≤400 chars). "Open as new
   chat" now passes them to `POST /api/chats`, stored as `chats.parent_context`
   (nullable; only ever set together with `parent_word`).
2. For branches with `parent_context` the system prompt switches to PDF-selection
   wording: it cites the surroundings and warns that PDF extraction flattens
   superscripts/blackboard letters, asking the model to infer the intended notation.
3. Chat-selection branches are unchanged: `parent_word` already carries the full
   selected passage, and "from a previous conversation" is true there.

Server-side reconstruction (locating the highlight text in the cached page text) was
rejected: fuzzy-matching flattened formula glyphs is unreliable — it would re-import
the very extraction problem the change works around.
