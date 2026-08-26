# Syflo

A chat app built for **branching research**. Instead of one long linear
conversation, Syflo lets you spin off a side-chat from any word or passage the
model writes — creating a tree of focused sub-conversations you can navigate
visually as a mind map.

```bash
npm install -g syflo
syflo
```

That is the whole install, on macOS, Linux and Windows alike
([ADR-0009](docs/adr/0009-npm-first-distribution.md) explains why there are no
signed installers). `syflo` starts the local backend and opens the Syflo
window. Everything runs on your machine: the backend listens on `127.0.0.1`
only, and your chats, uploads and API keys live in `~/.syflo` (override with
`SYFLO_DATA_DIR`).

| Command | What it does |
| --- | --- |
| `syflo` | Backend + desktop window (Electron). |
| `syflo --browser` | Backend only, opens your default browser. |
| `syflo --port 4000` | Same, on another port (default 3001). |
| `syflo --help` | The flags above. |

**If the window doesn't appear**, use `syflo --browser`. The desktop window
needs Electron's binary, which is downloaded when the package is installed —
that download is the one step likely to fail behind a corporate proxy. Syflo
notices and opens the browser by itself, so the app works either way;
`--browser` just skips the lookup.

Ctrl-C in the terminal (or closing the window) stops the backend with it —
nothing keeps running in the background.

### The install also downloads one model file

`postinstall` fetches `bge-m3-q8_0.gguf`, **605 MB**, into `~/.syflo/models/`.
It is what makes long papers searchable: above roughly 97k tokens Syflo
switches to retrieval mode and picks the relevant passages itself, and those
embeddings always run on your own machine
([ADR-0008](docs/adr/0008-cloud-providers-user-owned-keys.md)) even when every
answer comes from a cloud model. Progress is printed while it downloads, and
`npm update` does not fetch it again.

```bash
# Don't download it (a metered connection, or you just don't want it):
SYFLO_SKIP_MODEL=1 npm install -g syflo
```

The download is also skipped automatically when `CI` is set and in a git
checkout, and it **never fails the installation**. If it does not finish — no
network, a proxy, a read-only home directory — the install still succeeds and
prints where to put the file if you want it later; re-running
`npm install -g syflo` retries. Without it, retrieval mode stays off and
everything else works as normal: a source too long for the context window is
then sent with its middle cut out instead of searched.

## Prerequisites

- **Node.js 20+** — the only hard requirement.
- A provider API key (Settings → Model), *or*, for the fully local route:
  **[Ollama](https://ollama.com)** on `http://localhost:11434` with a **vision
  model** pulled, e.g. `ollama pull qwen3.5:9b` (or download it from
  Settings → Models).

Syflo talks to the model provider of **your choice**
([ADR-0008](docs/adr/0008-cloud-providers-user-owned-keys.md)): the default is
**Gemini 2.5 Flash** under your own free API key; Groq, OpenAI and Anthropic
work the same way — bring your own key, Syflo never ships or proxies one.
Prefer full privacy? Switch to the **local Ollama provider** and chat data
never leaves your device; dictation and retrieval embeddings run locally
either way.

---

## What to expect from this project

Syflo is a **nights-and-weekends project** maintained by one person. It is
useful daily and it is not a product: there is no roadmap, no release cadence,
and no promise that a good idea gets built. Versioning is SemVer from 0.1.0,
and 1.0 waits until the SQLite schema stops moving.

- **Questions** → [Discussions](https://github.com/kavi-senewiratne/syflo/discussions)
- **Bugs and concrete feature requests** → [Issues](https://github.com/kavi-senewiratne/syflo/issues)
- **Security problems** → never a public issue; see [SECURITY.md](SECURITY.md)
- **Want to contribute?** → [CONTRIBUTING.md](CONTRIBUTING.md) and the
  [Code of Conduct](CODE_OF_CONDUCT.md)

---

## Why Syflo?

A normal chat app forces every follow-up question into the same scroll. Ask
about *quantum mechanics*, get curious about *wavefunction collapse*, and now
your one chat is half quantum, half wavefunctions, half Heisenberg —
impossible to revisit, impossible to share with someone who only cares about
one branch.

Syflo treats every curious tangent as its own chat with the parent as context,
and shows the whole tree as a mind map so you can see how your thinking
branched.

## Features

### Branching from any word or passage

Right-click a word, or select a phrase, in an assistant response. A popup
appears with a one-line plain-prose definition fetched from the model. If it
is interesting, open it as a new chat to spin off a child dedicated to that
topic — the new chat starts with the parent conversation as context, so the
model already knows what "that" refers to. `/branch <topic>` does the same from
the composer, and `/btw` asks a throwaway side question without leaving the
chat.

### Inline branch links

Words you have already branched on are rendered as **blue underlined
hyperlinks** inside the original response. Click one to jump straight to that
child chat — your branches stay woven into the source text. Links are never
placed inside a formula or a code block.

### Mind map

Toggle the mind map to see the entire chat tree drawn **top-down**: the root on
top, every depth one row below the last, with the trunk running through
reserved lanes so lines never cross. Click any node to open that chat. Built on
React Flow, so you can pan, zoom and reposition freely.

### Papers, PDFs and YouTube

Attach a PDF, search for a paper, or paste a YouTube URL — one source per chat
tree ([ADR-0005](docs/adr/0005-one-source-per-tree-youtube-transcript.md)).
Selections in the PDF, in the transcript and in the chat all become highlights
you can jump back to; a citation the model quotes is clickable and scrolls the
source to the exact passage. Long sources go through retrieval mode
([ADR-0006](docs/adr/0006-retrieval-mode-for-long-sources.md)).

### Streaming responses

Replies stream token-by-token over Server-Sent Events, so you watch the answer
build. The same connection delivers the persisted message at the end, so the
optimistic UI hands off cleanly to the database state. A truncated answer can
be continued, and a failed one retried, without losing the thread.

### Dictation

Hold the microphone button (or the spacebar) to record. Transcription runs
**locally through whisper.cpp**
([ADR-0004](docs/adr/0004-on-device-whisper-dictation.md)) — no external
service — and detects German and English by itself, mixed sentences included.

### Keyboard navigation

The whole tree, the highlights and the composer are reachable without a mouse,
and without a modal "navigation mode"
([ADR-0011](docs/adr/0011-keyboard-navigation-without-a-mode.md)).

### Five themes

Every visual element adapts to the active theme, including the app icon and
the logo. English and German UI copy, switchable in Settings.

---

## Development setup

From a clone, instead of the global install:

```bash
git clone git@github.com:kavi-senewiratne/syflo.git && cd syflo
npm install && npm --prefix backend install && npm --prefix frontend install
cp backend/.env.example backend/.env
npm --prefix backend run dev     # backend on http://localhost:3001
npm --prefix frontend run dev    # frontend on http://localhost:5173 (2nd terminal)
```

Open <http://localhost:5173> and start a new chat. A clone never triggers the
605 MB model download. There is also a `start.command` in the repo root that
boots everything together if you double-click it on macOS.

[CONTRIBUTING.md](CONTRIBUTING.md) has the rest: the Electron mirror, the house
rules for UI changes and tests, and the English-only code rule.

### Running tests

```bash
cd backend  && npm test        # Jest + Supertest
cd frontend && npm test        # vitest
cd frontend && npx tsc -b      # typecheck
npm test                       # the `syflo` CLI and the install script (repo root)
```

CI runs all four on Linux, macOS and Windows against Node 20 and 22. Both
suites must be green — and every frontend change is additionally verified in
the running app — before a change counts as done.

---

## Tech stack

| Layer | Stack |
| --- | --- |
| CLI | Node, `bin/syflo.js` — spawns the backend and the Electron window |
| Backend | Node.js, Express 5, SQLite (`better-sqlite3`), OpenAI SDK against each provider's compatible endpoint |
| Models | Gemini / Groq / OpenAI / Anthropic under your own key, or local Ollama; registry in `backend/registry.json` |
| Local ML | `node-llama-cpp` for bge-m3 embeddings, whisper.cpp for dictation |
| Frontend | Vite, React 19, TypeScript, Tailwind v4, React Flow, react-markdown, KaTeX, Framer Motion, Lucide |
| Desktop | Electron (window only; the backend is a separate process) |
| Tests | Vitest + Testing Library (frontend), Jest + Supertest (backend) |

## Configuration

- **Data directory**: `~/.syflo` — database, uploads and API keys. Override
  with `SYFLO_DATA_DIR`.
- **Backend port**: `--port`, or `PORT` in `backend/.env` (default 3001).
- **Embedding model**: `~/.syflo/models/bge-m3-q8_0.gguf`, fetched during
  installation. `SYFLO_SKIP_MODEL=1` skips that download,
  `SYFLO_EMBEDDING_MODEL_DIR` puts the file somewhere else.
- **Providers & models**: curated per-provider model lists (context windows,
  budget caps, vision/thinking flags, prices with an as-of date) live in
  `backend/registry.json`; the app periodically refreshes it from the repo copy
  — no user data is involved. API keys are stored in the local SQLite settings
  and are never returned to the frontend.
- **Model**: switch provider and key in Settings → Model; switch the model
  itself from the pill in the chat composer. Local Ollama models are installed
  with `ollama pull` (vision models appear in the picker).
- **Web search**: Tavily under your own key
  ([ADR-0012](docs/adr/0012-tavily-is-the-only-web-search.md)).

## Where the decisions live

- `CONTEXT.md` — the glossary of domain terms used in code and tests.
- [`docs/adr/`](docs/adr/) — the architecture decision records.
- `design/mockup-*.html` — the source of truth for the interface.

## License

MIT — see [LICENSE](LICENSE).
