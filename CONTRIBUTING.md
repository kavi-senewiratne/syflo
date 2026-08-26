# Contributing to Syflo

Thanks for looking. Syflo is a nights-and-weekends project, so the most useful
contribution is usually a small one that is easy to verify: a reproducible bug
report, a fix with a test, a mockup for a UI idea.

Before you start on something large, open a
[Discussion](https://github.com/kavi-senewiratne/syflo/discussions) or an issue
and say what you have in mind. That is not bureaucracy — it is the only way to
find out early whether a decision has already been made and written down in
[`docs/adr/`](docs/adr/).

- **Questions and ideas** → Discussions.
- **Bugs and concrete feature requests** → Issues (there are forms for both).
- **Security problems** → never a public issue; see [SECURITY.md](SECURITY.md).

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

---

## Dev setup

Node 20+ is the only prerequisite. From a fresh clone:

```bash
git clone git@github.com:kavi-senewiratne/syflo.git && cd syflo
npm install && npm --prefix backend install && npm --prefix frontend install
cp backend/.env.example backend/.env
npm --prefix backend run dev     # backend on http://localhost:3001
npm --prefix frontend run dev    # frontend on http://localhost:5173 (2nd terminal)
```

Open <http://localhost:5173> and start a chat. Three notes on that:

- The four packages (root, `backend/`, `frontend/`, `electron/`) each have their
  own `node_modules`. The root one exists for the `syflo` CLI and its tests; the
  backend and frontend run from theirs.
- The root `postinstall` normally downloads the 605 MB embedding model. It
  detects a git checkout and skips itself, so a clone never pays for it. Set
  `SYFLO_SKIP_MODEL=1` if you ever want to be sure, and see
  `scripts/download-embedding-model.js` for the other opt-outs.
- Nothing needs an API key to boot. Add a provider key in Settings → Model when
  you want real answers, or point Syflo at a local Ollama (ADR-0008). Keys live
  in the local SQLite database under `~/.syflo`, never in the repo.

### Working on the desktop app

The Electron build runs a **mirror** of `backend/` and `frontend/dist`, not the
source folders. After any backend change:

```bash
bash scripts/sync-electron-resources.sh
npm --prefix electron run dev
```

`electron/resources/` is generated and gitignored — never hand-edit a file in
there, the next sync deletes it. `npm --prefix electron run build` runs the sync
and the frontend build itself, so a full build is always consistent.

### Running the tests

```bash
cd backend  && npm test        # Jest + Supertest
cd frontend && npm test        # vitest
cd frontend && npx tsc -b      # typecheck (both tsconfigs are noEmit)
npm test                       # the `syflo` CLI and the install script (Jest, repo root)
```

CI runs all four on Linux, macOS and Windows against Node 20 and 22. Please run
at least the suite you touched before opening a pull request.

---

## House rules

Three rules, and they are the ones a pull request is most likely to trip over.

### 1. UI changes follow the mockups

`design/mockup-*.html` is the **source of truth** for the interface. If you are
changing how something looks or behaves on screen, diff your change against the
matching mockup before and after you write it.

For a *new* UI idea, build the mockup first and get it agreed in an issue or
Discussion, then implement it. It is much cheaper to argue about a static HTML
page than about a merged component.

Two constraints that come with this:

- **Every visual element adapts to the active theme.** Colour only through the
  standard token families the `:root[data-theme]` blocks in
  `frontend/src/index.css` remap — accents via `blue-*`, neutrals via `gray-*`.
  Never hardcode a brand colour or a hex value for decoration. `red-*` is
  reserved for errors and destructive actions. Check your change in all five
  themes before you call it done.
- **No emojis anywhere** — in the app, in mockups, or in UI copy. Lucide icons
  only.

### 2. Every feature needs tests — and every frontend feature is verified in the running app

A feature without tests is not finished. Neither is a frontend feature that has
only been verified by a green test run.

Drive the real app: open it in a browser, perform the actual gesture (select the
text, click the button), then read the result back **from the UI and from the
database**. In the pull request, say what you clicked and what came out. "The
tests pass" is not a verification.

This is not a style preference. Things that green tests have happily passed over
in this repo: a backend still running the old code, an exhausted provider quota,
a request that hung for minutes because nobody set a timeout, and a weaker
fallback model echoing the prompt's own example back as the answer. A mock saw
none of it.

### 3. All code is written in English

Comments, identifiers, commit messages, error messages, log lines,
documentation — English, backend and frontend alike.

The single exception is user-facing copy: `frontend/src/strings.ts` holds the EN
and DE halves side by side, kept exactly parallel, and the German must be
orthographically correct (ä/ö/ü/ß). Add a string to both halves or to neither.

---

## Where the decisions live

Read these before proposing an architectural change; a lot of the obvious ideas
have already been considered and rejected for a written reason.

- `CONTEXT.md` — the glossary. Use its terms in code, tests and pull requests.
- `docs/adr/` — the decision records. ADR-0008 governs the provider layer
  (cloud under user-owned keys, local as the private fallback), ADR-0009 the
  npm-first distribution, ADR-0012 web search.
- `CLAUDE.md` — the same conventions in short form, plus the gotchas.

If your change contradicts an ADR, that is fine — but say so, and propose the
new ADR alongside the code.

## Pull requests

- Branch from the default branch; keep the pull request to one topic.
- Say what you changed, why, and how you verified it in the running app.
- Green CI on all three platforms is required. If a platform fails for a reason
  unrelated to your change, say so in the pull request rather than retrying
  silently.
- Versioning is SemVer from 0.1.0. There is no release cadence promise, so a
  merged pull request may wait for the next free evening before it is published
  to npm.
