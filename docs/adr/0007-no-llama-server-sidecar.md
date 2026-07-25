# 7. No llama-server sidecar with per-tree KV snapshots — for now

Date: 2026-07-25
Status: accepted (re-evaluate on upstream fix, see "Revisit when")

## Context

TTFT on long sources is prefill: the M4 Pro processes ~300 tok/s through
qwen3.5:9b, so a 15–20k-token paper costs ~60 s of compute before the first
token. Ollama's live KV cache makes follow-ups fast (~2.6 s), but on a 24 GB
Mac there is no persistence: an app restart, a model swap (vision, embeddings)
or an idle unload throws the state away and the next question pays the full
prefill again. (Ollama's 2026 prefix-trie/snapshot cache is MLX-runner-only,
which requires ≥32 GB.) The proposed long-term fix: bundle llama.cpp's
`llama-server` for text chat and persist each tree's slot state to disk
(`/slots/0?action=save|restore`) — "one tree = one save file", restored in
~0.1 s instead of a minute of recompute.

## Decision

**Rejected for now**, based on a sandbox benchmark (bengio03a, 15.3k tokens,
M4 Pro 24 GB; scripts + raw results in `scripts/experiments/kv-snapshot-spike/`):

- Slot save/restore is **functionally broken for hybrid Gated-DeltaNet models**
  (qwen3.5): the restored state is never reused — `cache_n: 0` and a full
  ~53 s re-prefill even when restoring immediately after save, and even with a
  byte-exact raw continuation (`/apply-template` + `/completion`). Live
  positive controls worked every time (0.15–0.8 s follow-ups, 0.3 s branch
  switches), so the harness is sound: llama.cpp keeps live rewind checkpoints
  for hybrids, but **slot files do not carry them** (upstream: ggml-org/llama.cpp
  discussion #19264, issue #22384 — fixes so far cover live checkpoints only).
- Measured summary: Ollama cold 59 s / warm 2.6 s / after restart 62 s.
  llama-server cold 51 s / warm 0.15–0.8 s / after restore 53–56 s (defeats
  the purpose). Save: 571 MB in 75 ms; restore: ~0.1 s; answer quality
  equivalent (same table numbers on second-half questions).
- Secondary friction: Ollama's qwen3.5 blob is **not loadable** by vanilla
  llama.cpp (`qwen35.rope.dimension_sections`: 3 vs 4 entries) — a sidecar
  needs its own ~5.7 GB GGUF download; `--reasoning-budget 0` does not disable
  qwen3.5 thinking (only `chat_template_kwargs: {enable_thinking:false}` does).

## Consequences

Stay on Ollama and keep its **live** cache healthy instead. Shipped the same
day: import/stop/fail warm-ups (App.tsx), explain sharing the conversation
prefix (routes/explain.js + server.js wiring), tree-stable full-text-vs-
retrieval decision and flipped sacrifice order (ADR-0003 addendum), attachment
annexes moved behind the question, `OLLAMA_KEEP_ALIVE=-1` + a context-window
env guard in start.command, `RETRIEVE_K` 8→5 (ADR-0006 addendum). A byte-truncated
answer in the history provably kills the hybrid cache (82–103 s per follow-up
measured) — which is why the interrupted/failed paths now re-warm.

## Revisit when

- llama.cpp ships checkpoint-carrying slot files (watch #19264/#22384).
  Success criterion, 5 minutes to verify: `node phaseA.mjs probe` in the
  experiment folder → after restore, `cache_n > 0` and follow-up TTFT < 10 s.
- Or the Mac moves to ≥32 GB (Ollama's MLX prefix-trie cache becomes available).
- Or the model ladder moves to classic-attention models (slot restore is
  expected to work there; also unblocks q8_0 KV, see ADR-0006).
