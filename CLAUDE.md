# Syflo — repo conventions

## Language

- **All code — backend and frontend — is written in English**: comments,
  identifiers, commit messages, error messages, log lines (user request
  2026-07-25). German appears only as UI copy in the DE half of
  `frontend/src/strings.ts`.
- User-facing strings live in `frontend/src/strings.ts` with EN and DE
  kept exactly parallel; German copy must be orthographically correct
  (ä/ö/ü/ß). No emojis anywhere — Lucide icons only.

## Domain language & decisions

- `CONTEXT.md` is the glossary — use its terms in code and tests.
- `docs/adr/` records the decisions; ADR-0008 governs the provider
  layer (cloud under user-owned keys, local as private fallback).
- UI work follows `design/mockup-*.html` as the source of truth; new UI
  must use only standard theme tokens so all five themes work.
- **Every visual element must adapt to the active theme** (user rule
  2026-07-26): color ONLY via the standard token families the
  `:root[data-theme]` blocks in `frontend/src/index.css` remap — accents
  via `blue-*`, neutrals via `gray-*`. Never hardcode brand or literal
  colors (`red-*`, hex values) for decoration; `red-*` is reserved for
  errors/destructive actions, which deliberately look alike in all themes.
  Before finishing UI work, check the change in all five themes.
  (Sole exception: the per-theme logo variants in `Logo.tsx` — their
  colors are fixed brand constants of each theme's logo, documented there.)

## Testing

- Backend: `cd backend && npm test` (Jest; the script sets NODE_OPTIONS).
- Frontend: `cd frontend && npm test` (vitest) plus typecheck.
- Run the affected suite after every feature before calling it done.
- **Every frontend feature is verified in the RUNNING app, never on green
  tests alone** (user rule 2026-08-02). Drive it in a real browser —
  Playwright, or the Chrome DevTools MCP when the Playwright browser is
  already in use: open the app, perform the actual gesture (select the text,
  click the button), then read the result back from the UI *and* from the
  database. State what was clicked and what came out; "the tests pass" is not
  a verification.
  Green tests routinely pass over what the real app trips on — that day
  alone: a backend still running the old code, an exhausted provider quota
  (429), a request that hung for minutes because no timeout was set, and a
  weaker fallback model echoing the prompt's own example back as the answer.
  None of it was visible to a mock.

## Shipping to Electron

**Electron is how the app is actually used** (user rule 2026-08-02), so a
change that only lives in `backend/` or `frontend/` is not yet in the app the
user opens. The desktop build runs a MIRROR: `electron/resources/backend/`
(loaded by `main.js` via a bundled Node binary) and `frontend/dist/`. Nothing
in the running desktop app resolves back to the source folders.

After any backend change, refresh the mirror:

```bash
bash scripts/sync-electron-resources.sh
```

- That script is the single source of truth — `rsync -a --delete` from
  `backend/`, plus a copy of the system `node` binary (better-sqlite3 is a
  native module built against the system Node ABI). `electron/resources/` is
  gitignored and fully generated: NEVER hand-edit a file inside it, the next
  sync deletes the edit.
- `electron/package.json`'s `build` / `build:dir` scripts call the sync and
  the frontend build themselves, so a full `npm run build` is always
  consistent. A bare `npm run dev` in `electron/` is NOT — it serves whatever
  the mirror last received.
- A new backend dependency is installed in `backend/` as usual; the sync
  mirrors `node_modules` along with the code.
- Left unsynced, the mirror rots silently: on 2026-08-02 it was missing
  `title.js`, `routes/feedback.js`, the `parent_word_display` migration and
  the loopback/CORS security fix — the desktop app was running backend code
  from weeks earlier while the browser dev server was current.

## Gotchas

- Ollama is the only provider with warm-up/KV-cache machinery; keep it
  gated behind `provider === 'ollama'` and never add complexity to the
  local path.
- `backend/registry.json` is the model/price registry (remote-refreshed);
  update it there, not in code.
