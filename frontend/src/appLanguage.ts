/**
 * appLanguage.ts
 *
 * App language (CONTEXT.md): die Sprache, in der UI-Chrome, Auto-Nachrichten
 * (z.B. der Auto-Prompt der Video overview) und Explain-Antworten verfasst
 * sind. Bewusst NICHT die Antwortsprache normaler Chat-Antworten (Spiegel-
 * Regel im Backend) und nicht das Diktat (immer Auto-Detect, ADR-0004).
 *
 * Reines Frontend-Preference nach dem Theme-Muster (theme.ts): localStorage,
 * sofortige Wirkung, kein Backend-Roundtrip. Ohne gespeicherte Wahl folgt
 * der Wert navigator.language (de* → Deutsch, sonst Englisch); der System-
 * Default wird nicht persistiert — erst eine manuelle Wahl wird gespeichert
 * und gewinnt ab dann dauerhaft (gleiche Logik wie beim Recommended model).
 */

import { useSyncExternalStore } from 'react';

export type AppLanguage = 'en' | 'de';

export const APP_LANGUAGES: { id: AppLanguage; label: string }[] = [
  // Labels stehen immer in ihrer eigenen Sprache, damit man aus einer
  // versehentlich gewählten Sprache zurückfindet — nie übersetzen.
  { id: 'en', label: 'English' },
  { id: 'de', label: 'Deutsch' },
];

const STORAGE_KEY = 'syflo.appLanguage';

const listeners = new Set<() => void>();

function isAppLanguage(value: unknown): value is AppLanguage {
  return value === 'en' || value === 'de';
}

export function getAppLanguage(): AppLanguage {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (isAppLanguage(stored)) return stored;
  return navigator.language.toLowerCase().startsWith('de') ? 'de' : 'en';
}

export function setAppLanguage(lang: AppLanguage): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // localStorage voll/blockiert — die Wahl gilt trotzdem für diese Session
    // nicht weiter; Subscriber bekommen dennoch den aktuellen Wert.
  }
  listeners.forEach(l => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-rendert die Komponente, sobald die App language wechselt. */
export function useAppLanguage(): AppLanguage {
  return useSyncExternalStore(subscribe, getAppLanguage);
}
