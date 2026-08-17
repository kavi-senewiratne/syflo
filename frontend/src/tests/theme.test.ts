/**
 * theme.test.ts
 *
 * applyTheme: setzt data-theme + Favicon und meldet den Wechsel an die
 * Electron-Hülle (window.syfloDesktop aus electron/preload.js), damit
 * Dock-Icon und Schreibtisch-Launcher mitziehen. Im normalen Browser
 * existiert die Brücke nicht — dann darf nichts passieren (und nichts
 * werfen).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { applyTheme, THEMES } from '../theme';

afterEach(() => {
  delete (window as unknown as { syfloDesktop?: unknown }).syfloDesktop;
  delete document.documentElement.dataset.theme;
  localStorage.clear();
});

describe('applyTheme', () => {
  it('sets the data-theme attribute and persists the choice', () => {
    applyTheme('matrix');
    expect(document.documentElement.dataset.theme).toBe('matrix');
    expect(localStorage.getItem('syflo.theme')).toBe('matrix');
  });

  it('forwards the theme to the Electron bridge when present', () => {
    const setTheme = vi.fn();
    (window as unknown as { syfloDesktop?: { setTheme: (id: string) => void } })
      .syfloDesktop = { setTheme };

    applyTheme('hyrule');
    expect(setTheme).toHaveBeenCalledWith('hyrule');
  });

  it('does not throw without the Electron bridge (plain browser)', () => {
    expect(() => applyTheme('ink-blue')).not.toThrow();
  });

  it('offers the default theme in the picker again, labelled "Simply Blue"', () => {
    const basic = THEMES.find(t => t.id === 'professional');
    expect(basic?.hidden).toBeUndefined();
    // Umbenannt 2026-08-13; die ID bleibt `professional` (localStorage-Prefs).
    expect(basic?.label).toBe('Simply Blue');
    expect(THEMES).toHaveLength(5);
  });

  it('hides Ink Blue from the picker but keeps it a valid theme (2026-08-13)', () => {
    const ink = THEMES.find(t => t.id === 'ink-blue');
    expect(ink?.hidden).toBe(true);
    // versteckt ≠ entfernt: gespeicherte Prefs bleiben gültig.
    expect(THEMES.filter(t => !t.hidden).map(t => t.id)).toEqual([
      'professional', 'mushroom-kingdom', 'hyrule', 'matrix',
    ]);
  });
});
