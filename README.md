# Syflo

A chat app built for **branching research**. Instead of one long linear
conversation, Syflo lets you spin off a side-chat from any word the
model writes — creating a tree of focused sub-conversations you can
navigate visually as a mind map.

Syflo talks to the model provider of **your choice** (ADR-0008): the
default is **Gemini 2.5 Flash** under your own free API key; Groq,
OpenAI and Anthropic work the same way — bring your own key, Syflo
never ships or proxies one. Prefer full privacy? Switch to the
**local Ollama provider** and chat data never leaves your device;
dictation, web search and retrieval embeddings run locally either way.

---

## Why Syflo?

A normal chat app forces every follow-up question into the same scroll.
Ask about *quantum mechanics*, get curious about *wavefunction collapse*,
and now your one chat is half quantum, half wavefunctions, half
Heisenberg — impossible to revisit, impossible to share with someone
who only cares about one branch.

Syflo treats every curious tangent as its own chat with the parent
as context, and shows the whole tree as a mind map so you can see how
your thinking branched.

---

## Features

### Branching from any word

Right-click any word or phrase in an assistant response. A popup
appears with a one-line plain-prose definition fetched from the model.
If the word is interesting, click **Open as new chat** to spin off a
child chat dedicated to that topic — the new chat starts with the
parent conversation as context, so the model already knows what
"that" refers to.

### Inline branch links

Words you've already branched on are rendered as **blue underlined
hyperlinks** inside the original response. Click one to jump straight
to that child chat — your branches stay woven into the source text.

### Radial mind map

Toggle the mind map view from the sidebar to see the entire chat tree
laid out radially: the root chat at the center, top-level branches in
a circle around it, and grandchildren fanning out from each branch.
Click any node to open that chat. Built on **React Flow**, so you can
pan, zoom, and reposition nodes freely.

### Streaming responses

AI replies stream token-by-token via Server-Sent Events, so you see the
answer building in real time. The same streaming connection delivers
the persisted message at the end, so the optimistic UI hands off
cleanly to the database state.

### Voice input

The composer has a microphone button (hold to record). Live transcript
preview shows what's being recognized; release to commit it to the
input box. Uses the browser's built-in `SpeechRecognition` API — no
external service.

### Sidebar chat tree

Two-level navigation: a flat list of root chats by default, expanding
to show one root and all its descendants when you click a chat.
Hovering a row reveals a delete button; deletion goes through a
confirmation dialog so a stray click can't lose work.

### Word definition popup

Right-clicking on a word produces a clean dictionary-style popup with
a 1–2 sentence plain-text definition (no markdown, no example
sentences). The popup also exposes the *Open as new chat* button so
you can branch immediately if the definition raises more questions.

---

## Tech stack

| Layer | Stack |
| --- | --- |
| Backend | Node.js, Express, SQLite (`better-sqlite3`), OpenAI SDK pointed at local Ollama |
| Model | Ollama running a vision model — hardware-recommended (e.g. `qwen3.5:9b`), switchable from the composer |
| Frontend | Vite, React 19, TypeScript, Tailwind v4, React Flow, react-markdown, Framer Motion |
| Tests | Vitest + Testing Library (frontend), Jest + Supertest (backend) |

---

## Prerequisites

- **Node.js 20+**
- **[Ollama](https://ollama.com)** running locally on `http://localhost:11434`
- A **vision model** pulled, e.g. `ollama pull qwen3.5:9b` (or download it from Settings → Models)

---

## Setup

```bash
git clone git@github.com:kavinda14/syflo.git
cd syflo

# Backend
cd backend
npm install
cp .env.example .env   # adjust if needed
node server.js         # starts on http://localhost:3001

# Frontend (in a separate terminal)
cd frontend
npm install
npm run dev            # starts on http://localhost:5173
```

Open `http://localhost:5173` and start a new chat.

There's also a `start.command` script in the repo root that boots
backend + frontend together if you double-click it on macOS.

---

## API

All endpoints live under `/api`. The Vite dev server proxies them to
the backend on port 3001.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/chats/tree` | The full chat hierarchy with children nested. Used by the sidebar and mind map. |
| `GET` | `/api/chats/:id` | One chat with its messages and direct child chats. |
| `POST` | `/api/chats` | Create a chat. Pass `parent_id` and `parent_word` to branch. |
| `DELETE` | `/api/chats/:id` | Delete a chat (recursively deletes children). |
| `POST` | `/api/chats/:id/messages` | Send a user message. Returns SSE stream of the assistant's response. |
| `POST` | `/api/explain` | One-shot prompt for a word definition. Body: `{ word, context? }`. |

---

## Project layout

```
syflo/
├── backend/
│   ├── server.js           # Express app factory + listen
│   ├── database.js         # SQLite setup
│   ├── routes/
│   │   ├── chats.js        # tree, CRUD
│   │   ├── messages.js     # streaming SSE endpoint
│   │   └── explain.js      # word-definition endpoint
│   └── tests/              # Jest + Supertest
└── frontend/
    └── src/
        ├── App.tsx                       # state + orchestration
        ├── api/                          # fetch client
        ├── components/
        │   ├── Sidebar/                  # chat tree + delete confirmation
        │   ├── ChatArea/                 # messages + composer
        │   ├── MindMap/                  # radial React-Flow layout
        │   └── FloatingPopup/            # right-click word popup
        ├── hooks/useVoiceInput.ts
        └── tests/                        # Vitest + Testing Library
```

---

## Running tests

```bash
# Frontend (Vitest)
cd frontend && npm test

# Backend (Jest)
cd backend && npm test
```

The backend suite currently has 430+ tests; the frontend runs on
vitest — both must be green before a change counts as done.

---

## Configuration

- **Backend port**: set `PORT` in `backend/.env` (default 3001).
- **Providers & models**: curated per-provider model lists (context
  windows, budget caps, vision/thinking flags, prices with an as-of
  date) live in `backend/registry.json`; the app periodically refreshes
  it from the repo copy — no user data is involved. API keys are stored
  in the local SQLite settings and are never returned to the frontend.
- **Model**: switch provider and key in Settings → Model; switch the
  model itself from the pill in the chat composer. Local Ollama models
  are installed with `ollama pull` (vision models appear in the picker).

---

## License

No license file yet — add one before sharing publicly if you want
others to be able to fork and contribute.
