#!/usr/bin/env node
/**
 * `syflo` — the command `npm install -g syflo` puts on the PATH (ADR-0009).
 *
 * This file is the only place that starts processes. Every decision it acts on
 * comes from bin/lib/launch.js, which is pure and tested; what remains here is
 * spawning, waiting and cleaning up.
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const { buildLaunchPlan, HELP_TEXT } = require('./lib/launch');

const PACKAGE_ROOT = path.join(__dirname, '..');

// Why the fallback happened, in the words the user needs to act on.
const FALLBACK_MESSAGES = {
  'electron-missing':
    "Electron is not available (its postinstall download often fails behind a proxy).\nOpening Syflo in your browser instead — pass --browser to skip this check.",
  'electron-main-missing':
    'The Electron shell is missing from this installation.\nOpening Syflo in your browser instead — pass --browser to skip this check.',
};

function openInBrowser(url) {
  // No dependency for three one-liners. Detached and ignored: the opener is a
  // fire-and-forget helper, and its exit must not look like Syflo exiting.
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {
    console.log(`Could not open a browser automatically. Open ${url} yourself.`);
  });
  child.unref();
}

// Polls until the backend answers, so the window never loads a dead port.
function waitForBackend(url, tries = 120, intervalMs = 250) {
  return new Promise((resolve) => {
    const attempt = (remaining) => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => {
        if (remaining <= 1) return resolve(false);
        setTimeout(() => attempt(remaining - 1), intervalMs);
      });
    };
    attempt(tries);
  });
}

async function main() {
  const plan = buildLaunchPlan(process.argv.slice(2), { packageRoot: PACKAGE_ROOT });

  if (plan.mode === 'help') {
    console.log(HELP_TEXT);
    return;
  }
  if (plan.mode === 'error') {
    console.error(`syflo: ${plan.detail}`);
    if (plan.reason === 'frontend-missing') {
      console.error('Run `npm run build` in frontend/, or reinstall syflo.');
    }
    process.exitCode = 1;
    return;
  }
  if (plan.reason) console.log(FALLBACK_MESSAGES[plan.reason] || plan.reason);

  // The backend runs on the Node that ran this command (native better-sqlite3),
  // serves the built frontend same-origin (SYFLO_FRONTEND_DIR), and keeps its
  // data where backend/paths.js puts it — SYFLO_DATA_DIR is deliberately not
  // set here, so ~/.syflo stays the one place chats live.
  const backend = spawn(plan.nodeBinary, [plan.backendEntry], {
    env: {
      ...process.env,
      PORT: String(plan.port),
      SYFLO_FRONTEND_DIR: plan.frontendDir,
    },
    stdio: 'inherit',
  });

  let shuttingDown = false;
  let electron = null;
  // Ctrl-C (or a `kill`) must take the whole session with it: an orphaned
  // server holds the port and the database lock, and an orphaned window would
  // be left staring at a backend that is gone — measured, not assumed: on the
  // first run the window outlived the killed CLI.
  const shutdown = () => {
    shuttingDown = true;
    if (electron && !electron.killed) electron.kill();
    if (!backend.killed) backend.kill();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  backend.on('exit', (code) => {
    if (!shuttingDown && code) {
      console.error(`syflo: the backend exited with code ${code}`);
      process.exit(code);
    }
  });

  const up = await waitForBackend(`${plan.url}/api/chats`);
  if (!up) {
    console.error(`syflo: the backend did not answer on ${plan.url}`);
    shutdown();
    process.exitCode = 1;
    return;
  }

  if (plan.mode === 'browser') {
    console.log(`Syflo is running on ${plan.url} — press Ctrl-C to stop.`);
    openInBrowser(plan.url);
    return;
  }

  // Electron owns the window only; the backend above is ours, so main.js is
  // told not to start one of its own.
  electron = spawn(plan.electronBinary, [plan.electronMain], {
    env: {
      ...process.env,
      SYFLO_BACKEND_EXTERNAL: '1',
      SYFLO_BACKEND_PORT: String(plan.port),
    },
    stdio: 'inherit',
  });
  electron.on('error', (err) => {
    console.error(`syflo: could not start Electron (${err.message}). Try --browser.`);
    shutdown();
    process.exitCode = 1;
  });
  // Closing the window ends the session: no invisible backend left behind.
  electron.on('exit', (code) => {
    shutdown();
    process.exitCode = code || 0;
  });
}

main().catch((err) => {
  console.error(`syflo: ${err.stack || err.message}`);
  process.exitCode = 1;
});
