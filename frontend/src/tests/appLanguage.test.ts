/**
 * appLanguage.test.ts
 *
 * App language (CONTEXT.md, Grill-Entscheidungen 2026-07-24):
 * - Erstwert aus navigator.language (de* → Deutsch, sonst Englisch)
 * - der System-Default wird NICHT persistiert
 * - eine manuelle Wahl gewinnt dauerhaft (localStorage syflo.appLanguage)
 * - ungültige gespeicherte Werte fallen auf den System-Default zurück
 * - useAppLanguage rendert Komponenten beim Wechsel neu
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { getAppLanguage, setAppLanguage, useAppLanguage } from '../appLanguage';

const mockNavigatorLanguage = (lang: string) =>
  vi.spyOn(window.navigator, 'language', 'get').mockReturnValue(lang);

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('appLanguage', () => {
  it('defaults to English when the system language is not German', () => {
    mockNavigatorLanguage('en-US');
    expect(getAppLanguage()).toBe('en');
  });

  it('defaults to German when the system language is German', () => {
    mockNavigatorLanguage('de-DE');
    expect(getAppLanguage()).toBe('de');
  });

  it('does not persist the system-derived default', () => {
    mockNavigatorLanguage('de-DE');
    getAppLanguage();
    expect(localStorage.getItem('syflo.appLanguage')).toBeNull();
  });

  it('persists a manual choice, which wins over the system language', () => {
    mockNavigatorLanguage('de-DE');
    setAppLanguage('en');
    expect(getAppLanguage()).toBe('en');
    expect(localStorage.getItem('syflo.appLanguage')).toBe('en');
  });

  it('ignores an invalid stored value and falls back to the system default', () => {
    mockNavigatorLanguage('en-US');
    localStorage.setItem('syflo.appLanguage', 'fr');
    expect(getAppLanguage()).toBe('en');
  });

  it('useAppLanguage re-renders subscribers when the language changes', () => {
    mockNavigatorLanguage('en-US');
    const { result } = renderHook(() => useAppLanguage());
    expect(result.current).toBe('en');
    act(() => setAppLanguage('de'));
    expect(result.current).toBe('de');
  });
});
