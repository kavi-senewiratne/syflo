# Open-source release checklist

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
- [ ] Commit the ~128 pending files (model flow, cost tiers, branch header …).
- [ ] Untrack `article/` and `design/`: `git rm -r --cached` + `.gitignore`
      entries. Files stay on disk; **no history rewrite** (decided — nothing
      secret in history, verified 2026-07-31: no uploads/dbs/PDFs/.env ever
      committed).
- [ ] Add `LICENSE` (MIT).
- [ ] Translate `searxng/README.md` to English; drop remaining "FlowTalk"
      mentions.

## Community documents

- [ ] `CONTRIBUTING.md` — dev setup in ~5 commands, plus the two house rules:
      mockup-first for UI changes, tests required for every feature.
- [ ] `SECURITY.md` — report vulnerabilities privately via GitHub's private
      vulnerability reporting, not public issues.
- [ ] `CODE_OF_CONDUCT.md` — Contributor Covenant, unmodified.
- [ ] Issue templates (bug/feature) asking for OS, Node version, provider.
- [ ] README: lead with the npm install story; add the expectations line
      ("nights-and-weekends project, no roadmap promises"); questions →
      Discussions, bugs → Issues.
- [ ] Enable GitHub Discussions with categories "Q&A" and "Ideas".
      No Discord at launch (revisit when there are regulars).

## npm-first distribution (ADR-0009)

- [ ] `syflo` CLI entry point: start backend, open Electron window by default,
      `--browser` fallback.
- [ ] `electron/main.js`: resolve frontend/backend from the npm package instead
      of `extraResources`.
- [ ] First publish: `syflo@0.1.0` with npm provenance.

## CI & releases

- [ ] GitHub Actions on every PR: full test suite as a **matrix on
      macOS / Linux / Windows** (keeps the cross-platform promise honest).
- [ ] Tag-triggered release workflow: tests → npm publish → GitHub Release with
      auto-generated notes.
- [ ] Versioning: SemVer from 0.1.0; 1.0 only when the SQLite schema is stable.
      No release cadence promises.

## Name reservations (outside the repo)

- [x] GitHub username renamed to `kavi-senewiratne`; syflo remote updated
      (2026-07-31). Update any CV/LinkedIn links still pointing at `kavinda14`.
- [ ] GitHub org `syfloapp` (name-holding only; repo stays personal — transfer
      later only if the project outgrows one maintainer; GitHub redirects on
      transfer).
- [ ] Domain `syflo.dev` (~$12/yr) — later: website, project email, Bluesky
      handle `@syflo.dev`.
- [ ] X `@syflo` if free, else `@syfloapp` — release announcements only.
- [ ] Optional long shot: politely ask the inactive owner of github.com/syflo
      (1 repo, dormant since 2020) whether they'd hand over the name.
