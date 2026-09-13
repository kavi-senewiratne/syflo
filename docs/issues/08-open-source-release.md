# Open-source release checklist

> **Reconciled 2026-08-24.** Every box below was re-checked against the working
> tree, not against memory. Evidence per item is named inline — a file that
> exists, a `grep` hit, or a command's output. What was still open on the
> previous pass and is now closed: `LICENSE`, all four community documents, the
> issue templates, the README restructure, and both GitHub Actions workflows
> (authored, never triggered — no tag has been pushed and nothing has been
> published). What is still genuinely open is unticked, and most of it is
> outside the repo: commits, untracking `design/`+`article/`, the GitHub
> settings, the first publish, and the name reservations.

All decisions from the grill session 2026-07-31. Goal: **community project**,
MIT-licensed, published from `kavi-senewiratne/syflo`, distributed via npm
(ADR-0009). Naming rule: plain **`syflo`** wherever free; **`syfloapp`** as the
fallback handle (GitHub org, X).

## Blockers — before the repo goes public

Security items fixed 2026-08-01 (TDD, `backend/tests/security.test.js`; includes
a DNS-rebinding Host guard beyond the original list). Suites green: backend
483, frontend 595 + typecheck.

- [x] **Security fix** (the OpenClaw lesson): bind the backend to `127.0.0.1`
      (`backend/server.js:93` — `app.listen(PORT)` currently binds all
      interfaces) and restrict CORS (`backend/server.js:17` — bare `cors()`
      currently lets any website read chats and stored API keys via localhost).
- [x] **Upload path traversal**: `backend/routes/messages.js:52` builds the
      multer destination from `req.params.chatId` before the chat is validated —
      an encoded `..` writes files outside `uploads/`. Validate the chat exists
      (or UUID-check the param) before multer runs.
- [x] **Electron link handling**: `electron/main.js` sets no
      `setWindowOpenHandler`/`will-navigate` guard — a link in LLM-generated
      markdown can open arbitrary sites inside app windows. Deny in-app
      navigation, route externals through `shell.openExternal`.
- [x] **`npm audit fix` in backend/**: 5 known vulns (high: fast-xml-parser
      entity expansion, multer DoS; moderate: qs, uuid; low: body-parser) —
      all fixed by minor bumps (audited 2026-08-01). Frontend is clean.
- [x] Hardening: serve `/uploads` with `Content-Disposition: attachment` +
      `X-Content-Type-Options: nosniff` so an uploaded HTML file can never
      execute same-origin with the app.
- [x] Commit the pending files. Done 2026-09-13: the tree is clean — the
      citation-extraction fixes landed as `fix(citations)`, the sidebar
      Kurzinfo work as `feat(sidebar)`, all suites green first (backend
      943+22, frontend typecheck + 1316, root 22).
- [x] Untrack `article/` and `design/`: done — `design/` was already
      untracked and ignored; `article/` (37 files) untracked + ignored
      2026-09-13 (`chore(release)`). Files stay on disk; **no history
      rewrite** (decided — nothing secret in history, verified 2026-07-31:
      no uploads/dbs/PDFs/.env ever committed).
- [x] Add `LICENSE` (MIT). `LICENSE` at the repo root, MIT, © 2026 Kavi
      Senewiratne; `package.json` already declared `"license": "MIT"`.
- [x] `searxng/` removed entirely (ADR-0012, 2026-08-23) — with it the last
      "FlowTalk" name in a shipped file (the container was `flowtalk-searxng`)
      and the README that needed translating.
- [x] **Nothing sensitive in the published tarball.** `npm pack --dry-run`
      (2026-08-24): 296 files, 5.6 MB packed / 9.1 MB unpacked. No `*.db`, no
      `.env` (only `backend/.env.example`, deliberately), no `uploads/`, no
      `design/`, no `article/`, no `logs/`. The `files` field grew explicit
      negations for `.env`, `**/*.db*`, `**/*.sqlite*`, `**/*.log`, `uploads/`,
      `logs/` and `backend/scripts/` — the old single `!backend/*.db*` did catch
      `backend/syflo.db.backup-…` (it stays, `tests/cli.test.js:159` pins it),
      but one pattern standing between a release and a user's database is one too
      few. Re-verified after the change: same 296 files, nothing sensitive; only
      `backend/.env.example` matches `.env`, and it holds placeholders.

## Community documents

- [x] `CONTRIBUTING.md` — dev setup in 5 commands (root/backend/frontend
      install, `.env`, both dev servers), the Electron mirror via
      `bash scripts/sync-electron-resources.sh`, and three house rules:
      mockup-first for UI, tests required **plus** verification in the running
      app, and English-only code.
- [x] `SECURITY.md` — private vulnerability reporting only, supported version
      0.1.x, and an explicitly nights-and-weekends response expectation
      (acknowledgement within a week or two), with scope and out-of-scope.
- [x] `CODE_OF_CONDUCT.md` — Contributor Covenant v2.1, text unmodified except
      the enforcement contact, which points at private vulnerability reporting
      and the issue tracker. No personal email address anywhere in it.
- [x] Issue templates (bug/feature) asking for OS, Node version, provider.
      `.github/ISSUE_TEMPLATE/bug_report.yml` and `feature_request.yml` (GitHub
      form schema), plus `config.yml` with `blank_issues_enabled: false` and
      contact links to Discussions Q&A / Ideas, the advisory form and
      `CONTRIBUTING.md`.
- [x] README: leads with `npm install -g syflo` + `syflo` in the first screen,
      `--browser` as the documented fallback, the 605 MB `bge-m3-q8_0.gguf`
      postinstall with `SYFLO_SKIP_MODEL=1` (and the automatic `CI` /
      git-checkout skips), an explicit "nights-and-weekends, no roadmap" section,
      questions → Discussions, bugs → Issues. Stale claims removed on the way:
      the mind map is top-down, not radial; dictation is local whisper.cpp
      (ADR-0004), not the browser's `SpeechRecognition`; the tech-stack table no
      longer says Ollama is the model layer.
- [x] Enable GitHub Discussions with categories "Q&A" and "Ideas". Done
      2026-09-13 via `gh api` — the default categories already carry exactly
      the slugs `q-a` and `ideas`, so `config.yml`'s links resolve.
- [x] Enable private vulnerability reporting in the repository's Security
      settings. Done 2026-09-13 (`gh api -X PUT …/private-vulnerability-reporting`).
- [ ] No Discord at launch (revisit when there are regulars). Nothing to do;
      kept here so the decision is not silently reversed.

## npm-first distribution (ADR-0009)

- [x] `syflo` CLI entry point: start backend, open Electron window by default,
      `--browser` fallback. `bin/syflo.js` + `bin/lib/launch.js` (pure plan,
      spawns separated); `package.json` `"bin": { "syflo": "./bin/syflo.js" }`;
      covered by `tests/cli.test.js`.
- [x] `electron/main.js`: resolve frontend/backend from the npm package instead
      of `extraResources`. It takes both layouts through
      `resolvePaths({ packageRoot: PACKAGE_ROOT, resourcesPath })` and honours
      `SYFLO_BACKEND_EXTERNAL=1` when the CLI already owns the backend.
- [x] Data directory outside the program folder: `backend/paths.js` resolves
      `~/.syflo` (`SYFLO_DATA_DIR` override), so `npm update` cannot take the
      database with it.
- [x] Embedding model as an install step: `scripts/download-embedding-model.js`
      (`postinstall`), 605 MB bge-m3 GGUF, four opt-outs — already present,
      `SYFLO_SKIP_MODEL`, `CI`, non-global git checkout — and it never fails the
      install. Covered by `tests/download-model.test.js`.
- [x] Commit a root `package-lock.json`. Done 2026-09-13
      (`npm install --package-lock-only --ignore-scripts`); both workflows'
      root install switched from `npm install` to `npm ci`.
- [x] First publish: `syflo@0.1.0` with npm provenance. **Published
      2026-09-13** via the tag-triggered workflow (SLSA v1 attestation on the
      registry). Third publish attempt did it: npm's granular tokens must be
      (a) unrestricted to a scope — a token limited to `@syflo` cannot touch
      the unscoped name — and (b) direct-capable: a staging-only token cannot
      CREATE a package (`E_STAGE_REQUIRED`). Once the package exists, the
      broad token can be swapped for a narrow one scoped to just `syflo`.
- [x] Create the `NPM_TOKEN` repository secret. Done 2026-09-13, piped from
      the keychain (`security find-generic-password -s npm-automation-token`)
      into `gh secret set`.

## CI & releases

- [x] GitHub Actions on every PR: full test suite as a **matrix on
      macOS / Linux / Windows** (keeps the cross-platform promise honest).
      `.github/workflows/ci.yml` — `pull_request` + push to `main`, matrix
      `ubuntu-latest`/`macos-latest`/`windows-latest` × Node 20/22,
      `fail-fast: false`. Runs the backend Jest suite, the frontend typecheck
      (`npx tsc -b`), the frontend vitest suite, the root CLI suite and the
      frontend production build. `SYFLO_SKIP_MODEL=1` and
      `ELECTRON_SKIP_BINARY_DOWNLOAD=1` at workflow level so no run pays for the
      605 MB model or Electron's binary.
- [x] Tag-triggered release workflow: tests → npm publish → GitHub Release with
      auto-generated notes. `.github/workflows/release.yml` — on `push: tags:
      ['v*']`; calls `ci.yml` via `workflow_call` (one matrix, not a copy),
      refuses a tag that disagrees with `package.json`, prints
      `npm pack --dry-run` into the log, then
      `npm publish --access public --provenance` with `id-token: write` +
      `contents: read`, and finally `gh release create --generate-notes
      --verify-tag` in a separate job holding `contents: write`.
      **Authored only — never triggered.**
- [x] Versioning: SemVer from 0.1.0; 1.0 only when the SQLite schema is stable.
      No release cadence promises. Written down where users see it (README
      "What to expect") and enforced by the tag/version check in `release.yml`.
- [x] Watch the first real CI run. Done 2026-09-13 — it took five rounds to a
      green matrix, every failure real and platform-shaped: (1) the backend
      test scripts' `NODE_OPTIONS=…` prefix is POSIX-only, so every Windows
      cell died before Jest started; (2-4) the slow Windows runners (5-13x a
      dev machine's wall clock) blew the 5 s default timeouts of a different
      suite each round — fixed at the config level, `testTimeout: 30000` in
      backend `jest.config.js` and frontend `vitest.config.ts` (plus
      testing-library `asyncUtilTimeout: 10000` in `setup.ts`); (5) a genuine
      1 ms clock race in `quota-unknown.test.js` (the test read `Date.now()`
      one line after the code under test did). A plain `npm pack --dry-run`
      re-ran clean before the tag: 298 files, 5.6 MB, nothing sensitive.

## Name reservations (outside the repo)

- [x] GitHub username renamed to `kavi-senewiratne`; syflo remote updated
      (2026-07-31; `git remote -v` still shows
      `git@github.com:kavi-senewiratne/syflo.git`). Update any CV/LinkedIn links
      still pointing at `kavinda14`.
- [ ] GitHub org `syfloapp` (name-holding only; repo stays personal — transfer
      later only if the project outgrows one maintainer; GitHub redirects on
      transfer).
- [ ] Domain `syflo.dev` (~$12/yr) — later: website, project email, Bluesky
      handle `@syflo.dev`.
- [ ] X `@syflo` if free, else `@syfloapp` — release announcements only.
- [ ] Optional long shot: politely ask the inactive owner of github.com/syflo
      (1 repo, dormant since 2020) whether they'd hand over the name.
