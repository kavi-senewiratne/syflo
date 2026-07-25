/**
 * chat/messageOrder.ts
 *
 * Nachrichten werden IMMER chronologisch (created_at aufsteigend) gerendert —
 * unabhängig davon, in welcher Reihenfolge sie im State gelandet sind. Die
 * optimistische Oberfläche und das Neu-Einsortieren eines Hintergrund-Streams
 * nach einem Abbruch konnten die Array-Reihenfolge durcheinanderbringen
 * (Nutzer-Screenshot 2026-07-24: neue Frage stand über der älteren). Diese
 * eine Sortierung beim Rendern erzwingt die richtige Reihenfolge by construction.
 */

export interface OrderableMessage {
  created_at: string;
  role: string;
}

/**
 * Kopie der Nachrichten in chronologischer Reihenfolge. ISO-8601-Zeitstempel
 * vergleichen lexikografisch = chronologisch. Array.prototype.sort ist stabil
 * (ES2019+): bei gleichem Zeitstempel — z. B. optimistische User- und
 * Assistant-Nachricht, die im selben Millisekunden-Tick angelegt wurden —
 * bleibt die Einfüge-Reihenfolge (User vor Assistant) erhalten.
 */
export function orderMessages<T extends OrderableMessage>(messages: T[]): T[] {
  return [...messages].sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
  );
}
