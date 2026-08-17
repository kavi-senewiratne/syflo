/**
 * components/YouTubeSearch/autoPrompt.ts
 *
 * Der sichtbare Auto-Prompt, der direkt nach dem Video-Import gesendet wird
 * (ADR-0005). Der Prompt nennt die Nicht-zusammenfassen-Regel seit
 * 2026-08-06 selbst ("keine Zusammenfassung", Nutzerwunsch) — im
 * System-Prompt des Backends steht sie zusätzlich, weil der sichtbare
 * Prompt allein das Standardverhalten des Modells nicht zuverlässig
 * überstimmt. Die Sprache folgt der App language (ADR-0005,
 * amendiert 2026-07-24; vorher: Untertitel-Spur): englisches Video plus
 * deutsche App language → deutscher Prompt → die Spiegel-Regel des Backends
 * liefert eine deutsche Video overview. Folgefragen spiegeln wie immer.
 */

import type { AppLanguage } from '../../appLanguage';

export function structurePrompt(language: AppLanguage): string {
  // Nennt die FORM des Ergebnisses, nicht das Verbot (Nutzerentscheid
  // 2026-08-15). „Keine Zusammenfassung" allein ist eine Verneinung: sie sagt,
  // wohin das Modell nicht soll, und lässt den Raum daneben offen — es fiel
  // regelmäßig auf sein Standardverhalten zurück. Die Dreiteilung
  // Überschrift / Kernaussage / Details beschreibt stattdessen das Ziel.
  // Die genaue Ausgabeform steht in der System-Regel des Backends
  // (routes/messages.js), weil der sichtbare Prompt als Frage im Chat lesbar
  // bleiben soll und ihn allein das Modell ohnehin nicht zuverlässig befolgt.
  return language === 'de'
    ? 'Gliedere das ganze Video in seine Abschnitte — je Abschnitt eine Überschrift, die Kernaussage und die Details. Nichts weglassen.'
    : 'Break the whole video down into its sections — each with a heading, its key point, and the details. Leave nothing out.';
}
