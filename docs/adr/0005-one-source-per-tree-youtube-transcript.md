# One source per chat tree; YouTube transcript as a second source kind

Status: accepted (2026-07-23)

ADR-0002's "one PDF per chat tree" is generalized to "one **source** per chat tree":
a tree is a conversation about one thing, and that thing is now either a paper (PDF)
or a **YouTube transcript**. Attaching a second source of either kind triggers the same
start-a-new-tree prompt as a second PDF does today. We kept the one-source rule because
the context budget (~40k chars at a 16k-token window) cannot carry two full sources
without mutilating both; loosening later stays a cheap additive change.

A YouTube transcript is fetched entirely on-device infrastructure: video search goes
through the local SearXNG instance (no API key, no quota), transcript + title + channel
come from YouTube's InnerTube API via `youtubei.js` (pure npm, no shipped binary).
Amended 2026-07-24: SearXNG's YouTube engine never emits the upload date, so the search
additionally runs a parallel InnerTube search and merges YouTube's relative date
("9 months ago") into the results by video id; hits the two rankings disagree on get
their date fetched per video via `getInfo` — best-effort only; SearXNG remains the
single hard dependency of the search.
Videos without any caption track fail with a clear error; transcribing audio with the
local Whisper stack was deliberately deferred. We rejected the official YouTube Data API
(first cloud key in the app) and yt-dlp (a binary to ship and keep current in the
Electron build) for the same local-first reason.

The raw transcript is stored in full with coarse minute marks and injected into the
system prompt in the same budget slot as paper text — trimmed first when space runs out,
with an explicit note telling the model from which minute the transcript is cut off, so
it says "I can't see that part" instead of hallucinating.
Amended 2026-07-24 (ADR-0006): transcripts that exceed the window now use retrieval
mode (skeleton + per-question excerpts); the trim-with-truncation-note path remains as
the fallback when the embedding model is unavailable. It is a tree-bound source, not
a message attachment: attachments are capped at 64 KB and invisible to later branches,
while the whole point is asking follow-up questions anywhere in the tree.

Import auto-sends one visible user message, written in the caption track's language
(amended 2026-07-24: written in the **App language** chosen in Settings — the caption
track's language no longer decides it), asking the model to **restructure** the video — sections and key points, explicitly not
a summary. Its reply is the **Video overview**, an ordinary streamed chat message. We
chose this over a read-only structured document in the center pane because a chat
message inherits every existing affordance for free: highlights, branching from a word,
Ask in chat, summaries. The source stays visible via a banner on every chat of the tree
(title, channel, duration, link); clicking it opens the raw transcript.
