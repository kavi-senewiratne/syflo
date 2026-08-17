/**
 * theme.ts
 *
 * App-wide color themes. The actual palettes live in index.css as
 * `:root[data-theme="…"]` blocks that override Tailwind v4's `--color-*`
 * variables — components keep their normal utility classes and re-color
 * automatically. "professional" is the untouched default palette, so it
 * has no CSS block at all.
 *
 * The theme is purely a frontend preference: stored in localStorage and
 * applied as a `data-theme` attribute on <html>. Design source of truth:
 * design/mockup-fun-themes-v3.html
 */

export type ThemeId =
  | 'professional'
  | 'mushroom-kingdom'
  | 'hyrule'
  | 'ink-blue'
  | 'matrix';

export interface ThemeInfo {
  id: ThemeId;
  label: string;
  // Three representative colors shown as swatch dots in the picker:
  // [app background, accent, neutral/text]
  swatches: [string, string, string];
  // Hides an entry from the picker without removing it from THEMES (a stored
  // hidden theme stays valid). The default theme was hidden on 2026-07-23 and
  // offered again on 2026-08-12 — nothing uses the flag right now, but it
  // stays as the supported way to retire a theme.
  hidden?: boolean;
}

export const THEMES: ThemeInfo[] = [
  // Label-Historie: "Professional" → "Basic" (2026-07-20) → "Simply Blue"
  // (2026-08-13). Die ID bleibt für immer `professional` — sie steht in den
  // localStorage-Prefs der Nutzer und in den Dateinamen der Icons.
  { id: 'professional', label: 'Simply Blue', swatches: ['#FFFFFF', '#2563EB', '#6B7280'] },
  { id: 'mushroom-kingdom', label: 'Mushroom Kingdom', swatches: ['#6FA3F8', '#D8433B', '#EFB43A'] },
  { id: 'hyrule', label: 'Hyrule', swatches: ['#EFEBDA', '#2AA198', '#B8963A'] },
  // Aus dem Picker genommen (Nutzerwunsch 2026-08-13). Wie bei "Basic" damals:
  // versteckt, nicht entfernt — wer ink-blue gespeichert hat, behält es.
  { id: 'ink-blue', label: 'Ink Blue', swatches: ['#F3F8FD', '#3B82F6', '#5C7194'], hidden: true },
  { id: 'matrix', label: 'Matrix', swatches: ['#030503', '#2BE76B', '#12805B'] },
];

const STORAGE_KEY = 'syflo.theme';
const DEFAULT_THEME: ThemeId = 'professional';

export function getStoredTheme(): ThemeId {
  const raw = localStorage.getItem(STORAGE_KEY);
  return THEMES.some(t => t.id === raw) ? (raw as ThemeId) : DEFAULT_THEME;
}

/** Sets the data-theme attribute, swaps the favicon, and persists the choice. */
export function applyTheme(id: ThemeId): void {
  document.documentElement.dataset.theme = id;
  // Each theme ships its own favicon mark (design/mockup-logo-icons.html,
  // Favicon-Test cells). Only the SVG icon is themed; the PNG links stay as
  // fallback for browsers without SVG favicon support.
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]');
  if (icon) icon.href = `/favicon-${id}.svg`;
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // localStorage full/blocked — the theme still applies for this session.
  }
  // Läuft die App in der Electron-Hülle, ziehen Dock-Icon und Schreibtisch-
  // Launcher mit (electron/preload.js exponiert window.syfloDesktop; im
  // normalen Browser ist das undefined und der Aufruf entfällt).
  (window as unknown as { syfloDesktop?: { setTheme: (id: string) => void } })
    .syfloDesktop?.setTheme(id);
}
