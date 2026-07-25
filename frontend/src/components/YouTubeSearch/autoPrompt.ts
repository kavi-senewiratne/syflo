/**
 * components/YouTubeSearch/autoPrompt.ts
 *
 * Der sichtbare Auto-Prompt, der direkt nach dem Video-Import gesendet wird
 * (ADR-0005). Bewusst kurz — die Nicht-zusammenfassen-Regel steckt im
 * System-Prompt des Backends. Die Sprache folgt der App language (ADR-0005,
 * amendiert 2026-07-24; vorher: Untertitel-Spur): englisches Video plus
 * deutsche App language → deutscher Prompt → die Spiegel-Regel des Backends
 * liefert eine deutsche Video overview. Folgefragen spiegeln wie immer.
 */

import type { AppLanguage } from '../../appLanguage';

export function structurePrompt(language: AppLanguage): string {
  return language === 'de'
    ? 'Strukturiere die Informationen aus diesem Video.'
    : 'Structure the information in this video.';
}
