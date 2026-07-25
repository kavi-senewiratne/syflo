# Retrieval mode for sources that exceed the context window

Status: accepted (2026-07-24)

Until now the tree's source (paper PDF or YouTube transcript) was injected into the
system prompt as full text and **bluntly truncated** — first at extraction time
(40k-char cap in `pdf-text.js`), then again by the prompt budget. For long papers this
meant two things at once: ~40 s of prefill for a maximally stuffed prompt, and a model
that had literally never seen the second half of the document (conclusion included)
while claiming to answer "based on the paper".

## Decision

A source now gets one of two prompt strategies, decided per message by a single rule:

- **Full-text mode** (unchanged): the source fits into the room left after the
  ancestor context → full text in the system prompt, warm-up, KV-cache, one-time
  prefill. For short sources this is strictly faster than any retrieval, because the
  cached prefix makes follow-up questions nearly prefill-free.
- **Retrieval mode**: the source is too long → the system prompt carries a stable
  **skeleton** (beginning with title/abstract, section outline, end with the
  conclusion), and per question the top-k most relevant **source chunks** are appended
  as a separate system message **after the history**, right before the user's message.

The prompt-order trick is the heart of the design: everything stable (base rules,
custom instructions, skeleton, history) stays a byte-identical prefix — Ollama's
KV-cache and the existing warm-up machinery keep working unchanged; only the small
excerpt block (~2k tokens) is fresh prefill per question.

## Mechanics

- Extraction is now **uncapped**: `papers.extracted_text` holds the full text; old
  caches ending in the legacy truncation marker are re-extracted once on access.
- On import (upload, from-url, YouTube) a fire-and-forget hook extracts, chunks and
  embeds long sources in the background; the lazy path at prompt-build time is the
  safety net. The first question never waits for embedding.
- Chunking: paragraph boundaries, target ~800 tokens (2800 chars), hard cap 4000 chars
  (oversized single paragraphs split at sentence boundaries with a one-sentence
  overlap). Each chunk carries the most recent section heading.
- Embeddings: `nomic-embed-text` via Ollama's native `/api/embed` (~300 MB, pulled in
  the background by `start.command`). Stored as Float32 BLOBs in `source_chunks`
  (SQLite); cosine search in JS — at ~100–200 chunks per source a vector DB would be
  pure overhead. A `text_hash` column detects re-extractions and triggers a rebuild.
- Retrieval: top-8 chunks by cosine similarity, re-sorted into **document order** so
  the excerpts read like a path through the paper.
- YouTube transcripts follow the same rule (they share the source budget slot);
  their skeleton is beginning + end with minute marks.

## Degradation

Retrieval failing is never fatal, and the order of fallbacks is deliberate:
embedding unavailable or returning unusable vectors → the old full-text truncation
path (exactly the pre-ADR behavior, including the transcript truncation note);
chunk lookup failing at question time → the answer runs on the skeleton alone.
An unreachable-but-honest fallback beats a silently broken retrieval, which is why
`ensureSourceChunks` rejects empty/mismatched vector responses instead of storing them.

## Rejected

- **RAG for everything**: per-question chunk selection would invalidate the cached
  prefix on every message; for sources that fit the window, the warmed full-text
  prefix is strictly faster. Retrieval is the exception path, not the default.
- **Vector database / ANN index**: absurd at this scale; SQLite BLOBs + a JS loop.
- **Smarter truncation (keep head + conclusion, cut middle)**: strictly dominated by
  retrieval mode, which keeps the same stable skeleton AND recovers the middle.

Related runtime change (same performance session): `start.command` now exports
`OLLAMA_FLASH_ATTENTION=1` (mathematically identical attention with tiled memory
access; recent Ollama enables it by default on Metal, the export just pins it).
`OLLAMA_KV_CACHE_TYPE=q8_0` was tried and **reverted** the same day: qwen3.5 is a
hybrid-attention model, and with a quantized KV cache the Metal runner silently
falls back to 100 % CPU (measured: 33/33 GPU layers → 0, decode 27.8 → ~3 tok/s).
Reconsider only if the model ladder moves to classic-attention models.

## Addendum 2026-07-25: top-k 8 → 5

The per-question excerpt block is the only part of a retrieval-mode prompt that is
re-prefilled every turn (the skeleton and history stay cached). Dropping
`RETRIEVE_K` from 8 to 5 cuts that block by ~1.3k tokens, i.e. ~4 s per follow-up
question at the measured ~300 tok/s prefill rate (M4 Pro, benchmark
2026-07-25 in `scripts/experiments/kv-snapshot-spike/`). Holistic questions are
served by the skeleton either way; the chunks only need to carry point lookups.
