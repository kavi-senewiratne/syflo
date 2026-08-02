# npm-first distribution — no signed installers at launch

Status: accepted (2026-07-31)

Syflo goes open source as a community project (MIT). The obvious distribution for
an Electron desktop app is a signed installer per platform — but signing costs
money (Apple Developer $99/yr, Windows cert $200–400/yr), unsigned downloads hit
Gatekeeper/SmartScreen walls ("Syflo is damaged"), and the electron-builder config
only ever targeted macOS, leaving Linux/Windows users with nothing. Meanwhile the
target audience (researchers and developers who already run tools like OpenClaw)
installs software via npm without blinking.

## Decision

- **The primary distribution channel is npm**: `npm install -g syflo`, then `syflo`
  starts the backend and opens the **Electron window by default** (`electron` is a
  regular dependency; its npm binaries carry no quarantine attribute, so no
  Gatekeeper prompt and no signing). `syflo --browser` starts the server only and
  opens the app in the default browser — the fallback for environments where
  Electron's postinstall download fails (corporate proxies) or desktop libs are
  missing.
- All three platforms (macOS, Linux, Windows) ship through the **same command from
  day one** — no per-platform installers to build, sign, or document.
- `electron/` and its builder config **stay in the repo**: power users can build an
  unsigned .app locally (self-built apps carry no quarantine attribute either). A
  signed DMG is deferred until there is real demand; the $99 Apple fee is deferred
  with it.
- `electron/main.js` must learn to resolve frontend and backend from the installed
  npm package instead of the `extraResources` bundle.

## Considered options

- **Signed DMG + Win/Linux installers at launch** — weeks of platform work, cash
  cost, and an unsignable Windows story; rejected as the slower, more fragile path.
- **Browser-only npm CLI (no Electron)** — slimmest install (~10 MB vs ~100 MB),
  but loses the native window/dock presence the app is designed around; kept only
  as the `--browser` fallback.

## Consequences

- Node ≥ 20 becomes an install prerequisite (acceptable for the audience).
- Electron's postinstall binary download is the most likely install failure; the
  README must mention `--browser` as the escape hatch.
- The npm package name `syflo` gets claimed legitimately at first publish.
