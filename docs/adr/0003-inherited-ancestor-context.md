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
