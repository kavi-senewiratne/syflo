// Schmale, explizite Brücke zwischen Renderer und Hauptprozess (contextBridge,
// contextIsolation bleibt an): Das Frontend meldet jeden Theme-Wechsel, damit
// Dock-Icon und Schreibtisch-Launcher mitziehen (Nutzerwunsch 2026-07-23).
// Im normalen Browser existiert window.syfloDesktop nicht — theme.ts ruft es
// deshalb nur optional auf.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('syfloDesktop', {
  setTheme: (id) => ipcRenderer.send('syflo:set-theme', String(id)),
});
