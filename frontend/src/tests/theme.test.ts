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

  it('hides "Basic" from the picker list but keeps it as a valid theme', () => {
    const basic = THEMES.find(t => t.id === 'professional');
    expect(basic?.hidden).toBe(true);
    // versteckt ≠ entfernt: der Eintrag bleibt Teil von THEMES
    expect(THEMES).toHaveLength(5);
  });
});
