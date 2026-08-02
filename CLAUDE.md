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

## Gotchas

- The Electron bundle carries a COPY of the backend under
  `electron/resources/backend/` — sync changed backend files there.
- Ollama is the only provider with warm-up/KV-cache machinery; keep it
  gated behind `provider === 'ollama'` and never add complexity to the
  local path.
- `backend/registry.json` is the model/price registry (remote-refreshed);
  update it there, not in code.
