/**
 * markdown/chapters.ts
 *
 * Chapters of a Video overview — the sections the model wrote, turned into a
 * navigable list under the embedded player (variant C of
 * design/mockup-youtube-embed-layout.html § 02, user decision 2026-08-15).
 *
 * The source is the overview message itself, not a second model call: the
 * system rule in backend/routes/messages.js already asks for exactly this
 * shape — a "##" heading with a `[m:ss - m:ss]` range, then ONE bold sentence
 * as the key point. Reading the message we already have means the chapters
 * cost nothing and appear the moment the overview finishes streaming.
 *
 * Sibling of timeLinks.ts and reuses its `parseTimestamp`, so a mark that is
 * not a time (`[99:99]`) is rejected in both places by the same rule.
 */

import { parseTimestamp } from './timeLinks';
import type { Message } from '../types';

export interface Chapter {
  title: string;
  /**
   * Heading depth: 2 for a section the overview rule asks for, 3+ for a
   * sub-section the model added on its own. The list indents by it — without
   * that, a sub-section that starts at its parent's second (measured in a real
   * overview 2026-08-15: 07:48 twice in a row) reads as a duplicate that
   * "jumps back".
   */
  level: number;
  startSeconds: number;
  /** End of the range, or null when the heading names a single mark. */
  endSeconds: number | null;
  /** The bold sentence under the heading; null when the model omitted it. */
  keyPoint: string | null;
  /**
   * Where the title and the key point sit in the overview TEXT. The anchor of
   * a chapter highlight (user request 2026-08-16, chapters became colorable):
   * a mark there stores offsets into the overview, exactly as a transcript
   * mark stores offsets into the transcript.
   */
  titleOffset: number;
  keyPointOffset: number | null;
}

/**
 * A heading line: two or more hashes, the topic, and the time range at the
 * end. The range may already have been linkified (`[0:00](t:0)`) if the text
 * passed through insertTimeLinks — accepted so a chapter list can also be
 * built from rendered content.
 */
const HEADING_RE =
  /^(#{2,4})\s+(.*?)\s*\[(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*[–—−-]\s*(\d{1,2}:\d{2}(?::\d{2})?))?\](?:\([^)]*\))?\s*$/;

/** The bold sentence right under a heading: `**…**` alone on its line. */
const KEY_POINT_RE = /^\*\*(.+?)\*\*[.!?]?$/;

export function parseChapters(content: string): Chapter[] {
  if (!content) return [];

  const lines = content.split('\n');
  const chapters: Chapter[] = [];
  // Running start of each line in `content` — offsets are measured against the
  // original text, so a repeated sentence cannot be found in the wrong place.
  const lineStart: number[] = [];
  let at = 0;
  for (const line of lines) {
    lineStart.push(at);
    at += line.length + 1; // + the "\n" that split removed
  }

  lines.forEach((line, i) => {
    const head = line.match(HEADING_RE);
    if (!head) return;

    const startSeconds = parseTimestamp(head[3]);
    if (startSeconds === null) return;
    const endSeconds = head[4] ? parseTimestamp(head[4]) : null;

    // The key point is the first non-empty line below the heading, and only
    // when it is entirely bold. Anything else (a bullet, prose) means the
    // model skipped the key point — then the chapter is title-only rather
    // than borrowing the first bullet, which would read as a claim.
    let keyPoint: string | null = null;
    let keyPointOffset: number | null = null;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim();
      if (!next) continue;
      const m = next.match(KEY_POINT_RE);
      if (m && !m[1].includes('**')) {
        keyPoint = m[1].trim();
        const inLine = lines[j].indexOf(keyPoint);
        keyPointOffset = inLine >= 0 ? lineStart[j] + inLine : null;
      }
      break;
    }

    const title = head[2].trim();
    const titleInLine = line.indexOf(title);

    chapters.push({
      title,
      level: head[1].length,
      startSeconds,
      endSeconds,
      keyPoint,
      titleOffset: titleInLine >= 0 ? lineStart[i] + titleInLine : lineStart[i],
      keyPointOffset,
    });
  });

  return chapters;
}

/**
 * The Video overview in a chat's history: the NEWEST assistant message whose
 * headings carry time marks. Newest, because a second "structure it again"
 * supersedes the first attempt — the pane should show the cut the reader just
 * asked for. Only assistant messages count: a user may quote headings back.
 */
export function pickOverviewMessage(messages: Message[]): Message | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant' || !m.content) continue;
    if (parseChapters(m.content).length > 0) return m;
  }
  return null;
}

/**
 * The overview's TEXT — the chapter list's only input. Kept next to
 * pickOverviewMessage and defined through it, so the pane's state (was this
 * overview cut short? which message does "continue" mean?) can never point at
 * a different message than the chapters on screen.
 */
export function pickOverviewContent(messages: Message[]): string | null {
  return pickOverviewMessage(messages)?.content ?? null;
}

/**
 * Index of the chapter that `seconds` falls into, or -1. A chapter runs until
 * the next chapter starts — the model's own `endSeconds` is ignored for this,
 * because a gap between two ranges would otherwise leave the list with no
 * active row while the video keeps playing.
 */
export function activeChapterIndex(chapters: Chapter[], seconds: number): number {
  if (chapters.length === 0) return -1;
  let active = 0;
  chapters.forEach((c, i) => {
    // Bei gleicher Startsekunde gewinnt der TIEFERE Abschnitt: er sagt genauer,
    // wo man ist. Wer einen Hauptabschnitt ANGEKLICKT hat, behält seine Zeile
    // trotzdem — das regelt die Pane über den angeklickten Index.
    if (seconds + 0.5 >= c.startSeconds) active = i;
  });
  // Vor der ersten Marke bleibt es die 0: ein Vortrag, der laut Übersicht bei
  // 0:02 anfängt, ist in Sekunde 0 nicht „nirgendwo" (gemessen 2026-08-15).
  return active;
}
