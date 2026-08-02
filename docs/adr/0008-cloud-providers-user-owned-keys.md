# Cloud chat providers under user-owned keys; cloud becomes the default

Status: accepted (2026-07-25)

Syflo was built local-first — the README promised "no chat data ever leaves your
machine", and ADR-0005 rejected a YouTube API key as "the first cloud key in the app".
But local inference on the target hardware had become the dominant pain: a benchmark
(2026-07-25, qwen3.5:9b, ~4k-token prompt, Bengio 2003) measured ~75 s prefill and
~108 s per answer locally vs ~0.6 s / ~1 s on hosted free tiers — roughly 100× faster.
Speed, not privacy, was what limited daily use. We decided to open the chat-reply
layer to cloud providers without giving up the local one.

## Decision

- The provider enum grows from `{ollama, openai}` to `{ollama, gemini, groq, openai,
  anthropic}`. Every cloud provider runs under the **user's own API key** — Syflo
  never ships, proxies, or shares keys, and gains no server-side footprint. "Free"
  (Gemini/Groq free quotas) is a **cost badge on a BYO-key provider**, not a separate
  architecture. Each provider card carries a step-by-step get-a-key guide (pattern:
  the existing OpenAI guide block).
- **The default flips to cloud**: a fresh install starts on Gemini 2.5 Flash with a
  guided empty state (get-a-key card "~1 minute, no credit card") and a visible
  "fully private instead? → set up the local model" path. The local provider stays
  first-class; its promise is scoped per-provider — "chat data never leaves the
  device" — instead of app-wide. "Offline mode" as a term was explicitly rejected
  (web search, paper search and YouTube import need the network anyway).
- Provider choice stays **global**, not per tree. One → many later is a cheap
  loosening; the reverse is a painful migration (same reasoning as ADR-0002).
- A **model registry** replaces scattered assumptions: per model it records vision
  capability, thinking support, context window, a budget cap (protects free-tier
  quotas despite huge windows), and prices. It ships as a **remote JSON in the repo**
  (fetched periodically, bundled fallback, visible as-of date) so model lists and
  prices update without a release. Shortlists are curated — the "model ladder is the
  app's own opinion" philosophy extended to the cloud.
- Context budgets and the ADR-0006 full-text-vs-retrieval threshold derive from the
  **active model's** window/cap, no longer from `OLLAMA_CONTEXT_LENGTH`.
- **Text-only cloud models** (e.g. Groq gpt-oss-120b) are selectable but labeled;
  image attachments are rejected with a hint while one is active — never silently
  dropped.
- **Embeddings always run locally**, regardless of chat provider (rationale in the
  ADR-0006 addendum: deprecation-proof, free, the full document never leaves the
  device). Missing Ollama degrades to the existing full-text truncation path.
- **429 handling** joins the existing send queue: visible auto-retry honoring
  `Retry-After` ("rate limit — retrying in 24 s" in the thinking indicator), `*Failed*`
  after ~3 attempts; an exhausted **daily** quota fails fast with a switch-provider
  hint. Estimated costs (local token log × price table, labeled as estimate) are shown
  for paid providers; free tiers show a quota counter instead.
- **Privacy copy becomes per-provider one-liners**, including the uncomfortable one:
  the Gemini free tier may use prompts for training. README headline changes to "runs
  fully local if you want — cloud models optional, under your own key."

## Consequences

- The KV-cache machinery (warm-up, keep-alive, prefill ETA, prefix-shared titles and
  Explain) stays gated behind `provider === 'ollama'`; cloud providers take the
  existing cheap standalone paths. The byte-identical-prefix discipline from ADR-0003/
  0006 pays a second time in the cloud as provider-side prompt caching.
- The three "local"-scoped glossary terms and the new Local/Cloud provider terms were
  updated in CONTEXT.md during this session; strings.ts and README copy must follow at
  implementation time.
- Guardrail from the session: **no added complexity on the local path** — Ollama
  specifics stay encapsulated where they already are.

## Amendment 2026-07-25 (same day): local demoted from equal to frozen fallback

After trying the local models against real papers and YouTube transcripts, the
verdict hardened: they are too slow and too weak for Syflo's core use case. The
original Q1 decision ("local stays an equal provider") is revised to the **frozen
fallback** option: the local provider remains available and private, but its
convenience machinery is removed for simplicity —

- hardware ladder + recommended-model automation (`hardware.js`, apply-recommended,
  `model_source`),
- the in-app model download/library UI (users run `ollama pull` themselves; the
  picker lists installed vision models),
- GPU-residency warning and prefill-ETA display.

Kept: the Ollama provider itself, warm-up/keep-alive/KV-cache path (encapsulated),
dictation, SearXNG web search, and local embeddings (bge-m3). New UI must use
standard theme tokens so all five themes work unchanged.
