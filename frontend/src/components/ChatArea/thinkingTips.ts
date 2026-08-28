/**
 * thinkingTips.ts — die kuratierten Syflo-Tipps für die Denk-Phase-Rotation
 * (design/mockup-model-picker.html, Sektion 04).
 *
 * Grill 2026-07-22 (memory: project-syflo-quotes-pool): Die Zitate leben
 * jetzt in quotes.json (~1500, quotable-Datensatz bereinigt + handkuratierte
 * Ergänzung) und rotieren über thinkingFeed.ts — 50/50-Münzwurf pro Zeile,
 * aktiver 50er-Pool, Ausmusterung nach 3 Anzeigen. Weiterhin gilt: KEINE
 * Online-API, keine LLM-generierten Zitate.
 *
 * Tipps beschreiben NUR echte Alleinstellungsmerkmale von Syflo — keine
 * generischen Bedien-Hinweise (Nutzerentscheid, Tipp-Wiederholung ist ok).
 */

export interface ThinkingLine {
  kind: 'tip' | 'quote';
  text: string;
  // Nur bei Zitaten: Autor:in.
  cite?: string;
}

export const TIPS: string[] = [
  'Curious about a word in an answer? Right-click it and open it as its own chat.',
  'A new branch already knows the chat it came from — you never have to explain again.',
  'Older chats above a branch come along as short summaries, so the model stays on topic.',
  'Only the chats on the way to the root come along. Side branches stay out of the way.',
  'Select a sentence and choose "Ask in chat" to quote it in the chat you are already in.',
  'Type /branch and a topic to start a side chat without selecting anything first.',
  'Type /btw to ask a quick side question and keep your chat clean.',
  'One paper per tree: search for it by name, drop in a PDF, or paste a YouTube link.',
  'The source stays on screen. Every branch, however deep, can ask it questions.',
  'A paper too long to fit? Syflo searches it and sends only the parts that matter.',
  'Highlight a passage in five colors — in the PDF, the transcript, or the chat.',
  'The highlights drawer lists every mark in the tree. Click one to jump back to it.',
  'When the model quotes the paper, click the quote to land on that spot in the source.',
  'Open the mind map to see your whole tree at once. Click a node to open that chat.',
  'Open the parent panel in a child chat to see exactly what the model inherited.',
  'Hold the space bar to dictate. It runs on this machine — German and English, even mixed.',
  'Cloud models run on your own key. Switch to a local model and nothing leaves the machine.',
  'Write your instructions once in Settings and every answer follows them.',
  'Five themes, and they change more than the colors — try Hyrule while it thinks.',
];

// Wechsel-Intervall der Rotation.
export const THINKING_LINE_INTERVAL_MS = 7000;
