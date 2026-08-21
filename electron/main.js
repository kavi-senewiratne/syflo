// Syflo desktop shell.
//
// Three ways in, one window:
//  - Dev (`npm run dev` in electron/): loads the Vite dev server on :5173.
//    Backend, Ollama and Vite run outside — as usual via ./start.command.
//  - npm (`syflo`, ADR-0009): bin/syflo.js already started the backend and set
//    SYFLO_BACKEND_EXTERNAL=1, so this process only waits for that server and
//    loads it. One owner for the backend process, one place its logs appear.
//  - Packaged .app: starts the bundled Node binary with the backend itself and
//    loads http://localhost:3001. The backend also serves the built frontend
//    there (SYFLO_FRONTEND_DIR) — same-origin, so the frontend's relative /api
//    calls work without a proxy.
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

const PACKAGE_ROOT = path.join(__dirname, '..');

// Backend and frontend are located by the same function the `syflo` command
// uses (bin/lib/launch.js), so the window and the CLI can never disagree about
// where the app lives.
//
// The require is guarded because the electron-builder `files` list (owned by
// electron/package.json, deliberately untouched) does not carry bin/ into the
// .app — inside a packaged bundle the module is simply absent, and the one
// layout that matters there is the extraResources one below.
let resolvePaths;
try {
  ({ resolvePaths } = require('../bin/lib/launch'));
} catch {
  resolvePaths = ({ resourcesPath }) => ({
    layout: 'bundle',
    backendEntry: path.join(resourcesPath, 'backend', 'server.js'),
    frontendDir: path.join(resourcesPath, 'frontend'),
  });
}

const DEV_URL = 'http://localhost:5173';
// Overridable so a packaged app can be tested next to a running dev instance
// (port 3001). `syflo --port` passes the same variable through.
const BACKEND_PORT = Number(process.env.SYFLO_BACKEND_PORT) || 3001;
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;
// Set by bin/syflo.js: the backend is already running and is not ours to start
// or to kill.
const BACKEND_IS_EXTERNAL = process.env.SYFLO_BACKEND_EXTERNAL === '1';

let backendProcess = null;

// The bundled backend process. SYFLO_DATA_DIR points at a per-user writable
// place (the .app bundle is read-only on macOS).
function spawnBackend() {
  const { backendEntry, frontendDir } = resolvePaths({
    packageRoot: PACKAGE_ROOT,
    resourcesPath: process.resourcesPath,
  });
  // A bundled copy of the system Node, because better-sqlite3 is a native
  // module built against that ABI (scripts/sync-electron-resources.sh puts it
  // there). The npm route never gets here — bin/syflo.js starts the backend
  // with the Node that ran `syflo`.
  const nodePath = path.join(process.resourcesPath, 'node', 'node');
  const dataDir = app.getPath('userData');

  backendProcess = spawn(nodePath, [backendEntry], {
    env: {
      ...process.env,
      SYFLO_DATA_DIR: dataDir,
      SYFLO_FRONTEND_DIR: frontendDir,
      PORT: String(BACKEND_PORT),
    },
    // Make backend logs visible in the app's console output
    stdio: 'inherit',
  });
  backendProcess.on('exit', (code) => {
    backendProcess = null;
    if (code !== 0 && code !== null) {
      console.error(`Backend exited with code ${code}`);
    }
  });
}

function stopBackend() {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
}

// Polls a URL until it answers (or returns false after the timeout).
function waitFor(url, tries = 60, intervalMs = 500) {
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

// Dock icon and desktop launcher follow the app theme (user request
// 2026-07-23). ink-blue/mushroom-kingdom/matrix/hyrule are pixel-exact 1024px
// captures of the dock tiles from design/mockup-logo-icons-round6.html (96px
// tile cloned into a zoom-8.33 wrapper, omitBackground; user request
// 2026-07-24: "every pixel as in the mockup"). professional renders from
// design/app-icon-professional.svg.
const THEME_IDS = ['professional', 'mushroom-kingdom', 'hyrule', 'ink-blue', 'matrix'];

function themeIconPath(id) {
  const themed = path.join(__dirname, 'assets', `icon-${id}.png`);
  return fs.existsSync(themed) ? themed : path.join(__dirname, 'assets', 'icon.png');
}

// Set the Finder icon of the desktop launcher (Syflo.app) via NSWorkspace —
// applies immediately, no Finder restart. Best effort: with no launcher on the
// desktop (or if osascript fails) nothing happens at all.
function setDesktopLauncherIcon(iconPng) {
  const launcher = path.join(app.getPath('home'), 'Desktop', 'Syflo.app');
  if (!fs.existsSync(launcher)) return;
  const jxa = `
    ObjC.import("AppKit");
    const img = $.NSImage.alloc.initWithContentsOfFile(${JSON.stringify(iconPng)});
    $.NSWorkspace.sharedWorkspace.setIconForFileOptions(img, ${JSON.stringify(launcher)}, 0);
  `;
  execFile('osascript', ['-l', 'JavaScript', '-e', jxa], (err) => {
    if (err) console.error('Desktop-Launcher-Icon:', err.message);
  });
}

ipcMain.on('syflo:set-theme', (_event, id) => {
  if (process.platform !== 'darwin' || !THEME_IDS.includes(id)) return;
  const icon = themeIconPath(id);
  try {
    app.dock.setIcon(icon);
  } catch (err) {
    console.error('Dock-Icon:', err.message);
  }
  setDesktopLauncherIcon(icon);
});

async function createWindow() {
  const win = new BrowserWindow({
    title: 'Syflo',
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.once('ready-to-show', () => win.show());

  // Links in LLM-generated markdown must never open arbitrary web content
  // inside the app shell: new windows are denied and handed to the system
  // browser; in-window navigation is confined to the app's own origins.
  const isAppUrl = (url) => url.startsWith(BACKEND_URL) || url.startsWith(DEV_URL);
  const isWebUrl = (url) => /^https?:\/\//.test(url);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url) && !isAppUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (isWebUrl(url)) shell.openExternal(url);
  });

  if (app.isPackaged || BACKEND_IS_EXTERNAL) {
    // Only the packaged app owns the backend; under `syflo` the CLI does.
    if (!BACKEND_IS_EXTERNAL) spawnBackend();
    const up = await waitFor(`${BACKEND_URL}/api/chats`);
    if (!up) {
      dialog.showErrorBox(
        'Syflo',
        `The backend did not start (${BACKEND_URL} is not answering).`
      );
      app.quit();
      return;
    }
    await win.loadURL(BACKEND_URL);
  } else {
    const up = await waitFor(DEV_URL, 20);
    if (!up) {
      dialog.showErrorBox(
        'Syflo (dev)',
        `The Vite dev server (${DEV_URL}) is not answering.\nRun ./start.command first.`
      );
      app.quit();
      return;
    }
    await win.loadURL(DEV_URL);
  }
}

// Started from npm the app is `electron main.js`, so the process name — window
// menu, dock label, app.getPath('userData') — would read "Electron". Only the
// electron-builder .app gets the name from its own package.json.
if (!app.isPackaged) app.setName('Syflo');

app.whenReady().then(() => {
  // Unpackaged (`electron .`, and the npm route too) the dock would otherwise
  // show the default Electron atom: assets/icon.icns only applies to the .app
  // packaged by electron-builder. setIcon needs PNG/JPEG — icon.png is the
  // 1024px derivation of that same icns (sips -s format png icon.icns).
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock.setIcon(path.join(__dirname, 'assets', 'icon.png'));
  }
  createWindow();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Window closed = app closed (instead of the usual macOS behaviour of staying
// alive): otherwise the bundled backend would keep running invisibly and hold
// port 3001.
app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', stopBackend);
