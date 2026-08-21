/**
 * launch.js — the decisions behind the `syflo` command.
 *
 * ADR-0009 makes npm the primary distribution: `npm install -g syflo`, then
 * `syflo` starts the backend and opens the Electron window; `syflo --browser`
 * starts the server only. Everything in here is a pure function so those
 * decisions can be tested without starting a single process: `bin/syflo.js`
 * turns the returned plan into spawns, and nothing else does.
 */

const fs = require('fs');
const path = require('path');

/**
 * Where the backend entry point and the built frontend live.
 *
 * Two layouts, because Syflo is started two ways:
 *  - `package`: the npm install and the git clone — both have `backend/` and
 *    `frontend/dist` directly under the package root, so one branch covers
 *    development and `npm install -g syflo` alike.
 *  - `bundle`: the electron-builder .app, where `extraResources` flattens the
 *    frontend build to `<Resources>/frontend` and mirrors the backend to
 *    `<Resources>/backend`. That path predates npm and must keep working, so it
 *    is an extra place to look, not a replacement.
 *
 * Pure: `exists` is injectable and nothing is created. The caller gets found /
 * not-found flags and decides what to do about a missing piece.
 */
function resolvePaths({ packageRoot, resourcesPath = null, exists = fs.existsSync } = {}) {
  const candidates = [];
  if (resourcesPath) {
    candidates.push({
      layout: 'bundle',
      backendEntry: path.join(resourcesPath, 'backend', 'server.js'),
      frontendDir: path.join(resourcesPath, 'frontend'),
      // Inside a packaged .app the Electron main script IS the running process,
      // so there is nothing to point a launcher at.
      electronMain: null,
    });
  }
  candidates.push({
    layout: 'package',
    backendEntry: path.join(packageRoot, 'backend', 'server.js'),
    frontendDir: path.join(packageRoot, 'frontend', 'dist'),
    electronMain: path.join(packageRoot, 'electron', 'main.js'),
  });

  // The backend entry decides which layout we are in: it is the one file both
  // layouts must have, and the frontend build may legitimately be missing (a
  // fresh clone that never ran `npm run build`).
  const chosen = candidates.find((c) => exists(c.backendEntry)) || candidates[candidates.length - 1];
  const frontendIndex = path.join(chosen.frontendDir, 'index.html');

  return {
    layout: chosen.layout,
    backendEntry: chosen.backendEntry,
    frontendDir: chosen.frontendDir,
    frontendIndex,
    electronMain: chosen.electronMain,
    backendFound: exists(chosen.backendEntry),
    frontendFound: exists(frontendIndex),
    electronMainFound: Boolean(chosen.electronMain) && exists(chosen.electronMain),
  };
}

/**
 * The Electron binary of the `electron` dependency, or null.
 *
 * `require('electron')` outside a running Electron process returns the path to
 * the downloaded binary — but the module resolves even when the postinstall
 * download failed (ADR-0009: the most likely install failure), so the file has
 * to be checked too. Anything unexpected means "no window available", never a
 * crash: the browser route still works.
 */
function resolveElectronBinary({ exists = fs.existsSync, req = require } = {}) {
  try {
    const binary = req('electron');
    return typeof binary === 'string' && exists(binary) ? binary : null;
  } catch {
    return null;
  }
}

// The backend is a single-user local server: it binds loopback only (see the
// comment above `app.listen` in backend/server.js), and the launcher must not
// widen that. It is the URL the window and the browser are pointed at, too.
const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_PORT = 3001;

/**
 * Turn `argv` into a plan: what to start, on which port, with which binaries.
 *
 * Pure — no spawning, no probing beyond the injected `exists`. `bin/syflo.js`
 * executes the plan; the tests read it.
 */
function buildLaunchPlan(argv = [], deps = {}) {
  const {
    packageRoot,
    resourcesPath = null,
    exists = fs.existsSync,
    resolveElectron = resolveElectronBinary,
    // The backend is a child process, and it must run on the SAME Node that ran
    // `syflo`: better-sqlite3 is a native module compiled against one ABI, and
    // it was installed by this Node. A bare "node" would take whatever is first
    // on PATH — a different version, or nothing at all when npm's own Node is
    // not on the PATH of the shell that launched us.
    execPath = process.execPath,
  } = deps;

  const args = parseArgs(argv);
  if (args.help) return { mode: 'help' };

  const paths = resolvePaths({ packageRoot, resourcesPath, exists });
  const port = args.port || DEFAULT_PORT;
  const base = {
    port,
    host: LOOPBACK_HOST,
    url: `http://localhost:${port}`,
    nodeBinary: execPath,
    backendEntry: paths.backendEntry,
    frontendDir: paths.frontendDir,
  };

  // Both failures are fatal before anything is started: a window (or a browser
  // tab) on a server that cannot serve the app is worse than a clear message.
  if (!paths.backendFound) {
    return {
      mode: 'error',
      reason: 'backend-missing',
      detail: `Backend entry point not found: ${paths.backendEntry}`,
      ...base,
    };
  }
  if (!paths.frontendFound) {
    return {
      mode: 'error',
      reason: 'frontend-missing',
      detail: `Frontend build not found: ${paths.frontendIndex}`,
      ...base,
    };
  }

  // An explicit --browser is a choice: no reason, nothing to warn about.
  if (args.browser) return { mode: 'browser', ...base };

  // Electron is the default window, but never a hard requirement. ADR-0009
  // expects its postinstall binary download to be the most common install
  // failure (corporate proxies), so a missing Electron degrades to the browser
  // automatically — carrying the reason, so `syflo` can tell the user that
  // `--browser` skips the pointless lookup next time.
  const electronBinary = resolveElectron();
  if (!electronBinary) {
    return { mode: 'browser', ...base, fallbackFrom: 'electron', reason: 'electron-missing' };
  }
  if (!paths.electronMainFound) {
    return { mode: 'browser', ...base, fallbackFrom: 'electron', reason: 'electron-main-missing' };
  }
  return { mode: 'electron', ...base, electronBinary, electronMain: paths.electronMain };
}

// Deliberately hand-rolled: the flag surface is three flags wide, and ADR-0009
// allows exactly one new dependency (electron) — not an argument parser.
function parseArgs(argv) {
  const args = { help: false, browser: false, port: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--browser') args.browser = true;
    else if (arg === '--port') {
      args.port = Number(argv[i + 1]) || null;
      i += 1;
    } else if (arg.startsWith('--port=')) {
      args.port = Number(arg.slice('--port='.length)) || null;
    }
  }
  return args;
}

// Printed by `syflo --help`. Lives here so the flags and their documentation
// are written in one place.
const HELP_TEXT = `Syflo — branching research chats, local-first.

Usage: syflo [options]

Options:
  --browser        Start the backend only and open the default browser.
                   Use this when Electron's binary download failed.
  --port <number>  Port for the local backend (default ${DEFAULT_PORT}).
  -h, --help       Show this help.

The backend listens on ${LOOPBACK_HOST} only; chats, uploads and API keys
live in ~/.syflo (override with SYFLO_DATA_DIR).`;

module.exports = {
  resolvePaths,
  buildLaunchPlan,
  resolveElectronBinary,
  HELP_TEXT,
  DEFAULT_PORT,
  LOOPBACK_HOST,
};
