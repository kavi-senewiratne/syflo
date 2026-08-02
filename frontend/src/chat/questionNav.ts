/**
 * chat/questionNav.ts
 *
 * Fragen-Navigation in der Chat-Spalte (Grill 2026-07-22,
 * design/mockup-question-nav.html, Varianten 1+3): jede User-Nachricht ist
 * eine "Frage" — bewusst ohne Heuristik, damit die Liste nie etwas
 * verschluckt. Hier liegt nur die pure Logik; die UI (Header-Popover +
 * Stepper) sitzt in components/ChatArea/QuestionNav.tsx.
 */

import type { Message } from '../types';
import { splitLeadingQuote } from './messageQuote';

export interface QuestionEntry {
  messageId: string;
  // Anzeigetext fürs Popover: Zitat-Präfix entfernt, Markdown zu Klartext.
  text: string;
  // true, wenn die Nachricht NUR aus dem Ask-in-chat-Zitat bestand — das
  // Popover rendert den Zitattext dann kursiv.
  quoteOnly: boolean;
}

// Markdown zu Klartext fürs Inhaltsverzeichnis: die Liste ist eine Vorschau,
// kein Renderer — Auszeichnung würde beim Überfliegen nur ablenken.
function toPreviewText(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, '')            // Überschriften-Präfixe
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // Links/Bilder → Linktext
    .replace(/(\*\*|__)(.+?)\1/g, '$2')     // fett
    .replace(/(\*|_)(.+?)\1/g, '$2')        // kursiv
    .replace(/`([^`]*)`/g, '$1')            // Inline-Code
    .replace(/\s*\n\s*/g, ' ')              // eine Vorschau-Zeile
    .trim();
}

// Scroll-Spy (Grill-Entscheidung 4): "aktuell" ist die LETZTE Frage, deren
// Oberkante über der Referenzlinie (Viewport-Mitte) liegt. Liegt noch keine
// darüber, gilt die erste als aktuell; ohne Fragen -1. tops sind die
// y-Offsets der User-Bubbles im Scroll-Inhalt, aufsteigend.
// Bottom clamp (screenshot case 2026-07-25): when the list is scrolled all
// the way down, the last question counts as current even if its top never
// crosses the reference line — a short (or failed) final answer leaves too
// little content below the question for the midline rule to reach it.
export function currentQuestionIndex(
  tops: number[],
  refLine: number,
  atBottom = false,
): number {
  if (tops.length === 0) return -1;
  if (atBottom) return tops.length - 1;
  let current = 0;
  for (let i = 0; i < tops.length; i++) {
    if (tops[i] <= refLine) current = i;
  }
  return current;
}

export function deriveQuestions(messages: Message[]): QuestionEntry[] {
  return messages
    .filter((m) => m.role === 'user')
    .map((m) => {
      const { quote, rest } = splitLeadingQuote(m.content);
      const quoteOnly = quote !== null && rest.trim() === '';
      return {
        messageId: m.id,
        text: toPreviewText(quoteOnly ? quote : rest),
        quoteOnly,
      };
    });
}
