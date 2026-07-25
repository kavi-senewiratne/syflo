// Syflo-Desktop-Hülle.
//
// Zwei Betriebsarten:
//  - Dev (npm run dev): lädt den Vite-Dev-Server auf :5173. Backend, Ollama
//    und Vite laufen extern — wie gewohnt über ./start.command.
//  - Gepackt (.app): startet den gebündelten Node-Binary mit dem Backend und
//    lädt http://localhost:3001. Das Backend liefert dort auch das gebaute
//    Frontend aus (SYFLO_FRONTEND_DIR) — same-origin, damit die relativen
//    /api-Aufrufe des Frontends ohne Proxy funktionieren.
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

const DEV_URL = 'http://localhost:5173';
// Übersteuerbar, damit eine gepackte App neben einer laufenden
// Dev-Instanz (Port 3001) getestet werden kann.
const BACKEND_PORT = Number(process.env.SYFLO_BACKEND_PORT) || 3001;
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;

let backendProcess = null;

// Der gebündelte Backend-Prozess. SYFLO_DATA_DIR zeigt auf einen
// beschreibbaren Ort pro Nutzer (das .app-Bundle ist auf macOS read-only).
function spawnBackend() {
  const nodePath = path.join(process.resourcesPath, 'node', 'node');
  const serverPath = path.join(process.resourcesPath, 'backend', 'server.js');
  const frontendDir = path.join(process.resourcesPath, 'frontend');
  const dataDir = app.getPath('userData');

  backendProcess = spawn(nodePath, [serverPath], {
    env: {
      ...process.env,
      SYFLO_DATA_DIR: dataDir,
      SYFLO_FRONTEND_DIR: frontendDir,
      PORT: String(BACKEND_PORT),
    },
    // Backend-Logs im Konsolen-Output der App sichtbar machen
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

// Pollt eine URL, bis sie antwortet (oder gibt false nach Timeout zurück).
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

// Dock-Icon und Schreibtisch-Launcher folgen dem App-Theme (Nutzerwunsch
// 2026-07-23). ink-blue/mushroom-kingdom/matrix/hyrule sind pixelgenaue
// 1024er-Captures der Dock-Kacheln aus design/mockup-logo-icons-round6.html
// (96px-Kachel in Zoom-8.33-Wrapper geklont, omitBackground; Nutzerwunsch
// 2026-07-24: "jeder Pixel wie im Mockup"). professional rendert aus
// design/app-icon-professional.svg.
const THEME_IDS = ['professional', 'mushroom-kingdom', 'hyrule', 'ink-blue', 'matrix'];

function themeIconPath(id) {
  const themed = path.join(__dirname, 'assets', `icon-${id}.png`);
  return fs.existsSync(themed) ? themed : path.join(__dirname, 'assets', 'icon.png');
}

// Finder-Icon des Desktop-Launchers (Syflo.app) per NSWorkspace setzen —
// aktualisiert sofort, ohne Finder-Neustart. Best effort: ohne Launcher auf
// dem Schreibtisch (oder wenn osascript scheitert) passiert einfach nichts.
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

  if (app.isPackaged) {
    spawnBackend();
    const up = await waitFor(`${BACKEND_URL}/api/chats`);
    if (!up) {
      dialog.showErrorBox(
        'Syflo',
        'Das Backend ist nicht gestartet (Port 3001 antwortet nicht).'
      );
      app.quit();
      return;
    }
    await win.loadURL(BACKEND_URL);
  } else {
    const up = await waitFor(DEV_URL, 20);
    if (!up) {
      dialog.showErrorBox(
        'Syflo (Dev)',
        `Der Vite-Dev-Server (${DEV_URL}) antwortet nicht.\nBitte zuerst ./start.command ausführen.`
      );
      app.quit();
      return;
    }
    await win.loadURL(DEV_URL);
  }
}

app.whenReady().then(() => {
  // Im Dev-Modus (`electron .`) zeigt das Dock sonst das Standard-Electron-
  // Atom: assets/icon.icns greift nur für die von electron-builder gepackte
  // .app. setIcon braucht PNG/JPEG — icon.png ist die 1024er-Ableitung aus
  // derselben icns (sips -s format png icon.icns --out icon.png).
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock.setIcon(path.join(__dirname, 'assets', 'icon.png'));
  }
  createWindow();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Fenster zu = App zu (statt macOS-üblichem Weiterlaufen): sonst bliebe das
// gebündelte Backend unsichtbar aktiv und hielte Port 3001 besetzt.
app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', stopBackend);
