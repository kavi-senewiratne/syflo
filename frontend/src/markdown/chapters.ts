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

import {
  cleanTitle,
  lastTimeMark,
  parseChapterHeading,
  parseLoneMarkLine,
  parseTimestamp,
} from './timeLinks';
import type { ChapterHeading } from './timeLinks';
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

// A heading line is recognized by timeLinks.ts's parseChapterHeading, which
// knows every shape models actually write: the canonical `## Topic [range]`
// (possibly already linkified — accepted so a chapter list can also be built
// from rendered content), `#` one level high (Flash Lite, 2026-08-20), and a
// BARE range with no brackets, range-first (`## 0:04 – 0:34 – Topic`, Groq
// gpt-oss-120b 2026-09-01) or range-last. The time mark stays mandatory; it
// is what separates a chapter from any other heading — but it may sit alone
// on the NEXT line under a mark-less heading (Gemini Flash Lite, 2026-09-12):
// that pairing happens here, where the lines are, via parseLoneMarkLine.

/** A heading that carries no time mark of its own — pairing candidate. */
const PLAIN_HEADING_RE = /^(#{1,4})\s+(\S.*)$/;

/** The bold sentence right under a heading: `**…**` alone on its line. */
const KEY_POINT_RE = /^\*\*(.+?)\*\*[.!?]?$/;

/**
 * A key point half-bolded as a labeled bullet instead of a plain bold
 * sentence — `**Kernaussage:** the rest, unbolded.` The bullet-list rule
 * right below the key-point rule in the system prompt (backend/routes/
 * messages.js) asks for exactly this "**label:** detail" shape, and a model
 * sometimes carries it up one line (measured 2026-08-30, Groq gpt-oss-120b,
 * every chapter of an otherwise well-formed overview). The label itself is
 * discarded; only the sentence after it becomes the key point — it is still
 * the model's own claim, just formatted with a label instead of full bold.
 */
const LABELED_KEY_POINT_RE = /^\*\*[^*:]{1,40}:\*\*\s*(.+?)[.!?]?$/;

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
    let head: Pick<
      ChapterHeading,
      'level' | 'title' | 'startSeconds' | 'endSeconds'
    > | null = parseChapterHeading(line);
    // The key point starts below the heading — or below the mark line, when
    // the mark sits alone on the next line under a mark-less heading (Gemini
    // Flash Lite, 2026-09-12: every chapter of the Hassabis overview, and the
    // pane stood empty). Only blank lines may separate the two.
    let below = i + 1;
    if (!head) {
      const plain = line.match(PLAIN_HEADING_RE);
      if (!plain) return;
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const lone = j < lines.length ? parseLoneMarkLine(lines[j]) : null;
      if (!lone) return;
      head = {
        level: plain[1].length,
        title: cleanTitle(plain[2]),
        startSeconds: lone.startSeconds,
        endSeconds: lone.endSeconds,
      };
      below = j + 1;
    }

    const { startSeconds, endSeconds } = head;

    // The key point is the first non-empty line below the heading, and only
    // when it is entirely bold. Anything else (a bullet, prose) means the
    // model skipped the key point — then the chapter is title-only rather
    // than borrowing the first bullet, which would read as a claim.
    let keyPoint: string | null = null;
    let keyPointOffset: number | null = null;
    for (let j = below; j < lines.length; j++) {
      const next = lines[j].trim();
      if (!next) continue;
      const m = next.match(KEY_POINT_RE);
      const labeled = !m ? next.match(LABELED_KEY_POINT_RE) : null;
      const found = m && !m[1].includes('**') ? m[1] : labeled ? labeled[1] : null;
      if (found) {
        keyPoint = found.trim();
        const inLine = lines[j].indexOf(keyPoint);
        keyPointOffset = inLine >= 0 ? lineStart[j] + inLine : null;
      }
      break;
    }

    const title = head.title;
    const titleInLine = title ? line.indexOf(title) : -1;

    chapters.push({
      title,
      level: head.level,
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

/**
 * Everything past this much of the video counts as covered. A minute of outro
 * is not worth a paid continuation round; a quarter of the video is. Kept in
 * step with `backend/overview-progress.js`, which decides the same thing for
 * the endpoint — change both together.
 */
const TAIL_TOLERANCE_RATIO = 0.05;
const TAIL_TOLERANCE_MIN_SECONDS = 60;

/**
 * Does the overview stop well before the video does?
 *
 * The second signal that an overview is unfinished, next to the provider's
 * `truncated` flag — and the one that caught the case the flag misses: on
 * 2026-08-18 Flash Lite ended cleanly after covering 16:16 of a 1:06:31 video
 * and reported itself finished. Nothing was cut, so nothing asked to be
 * continued, and the reader got a quarter of the video with no sign of it.
 * The overview writes its own time ranges, so it says where it got to.
 *
 * An unknown duration means "no opinion": this drives a paid call, so it is
 * measured or it is not claimed.
 */
export function overviewStopsShort(
  content: string,
  durationSeconds?: number | null,
  // How far the transcript the model saw actually reached (messages
  // .covered_until_seconds). A mark past it is the truncation note's own
  // number coming back out, not coverage — measured 2026-09-02 on a 3:57:44
  // video whose overview closed at "[1:41:43 - 3:57:44]" and therefore looked
  // finished at 43 %.
  coveredUntilSeconds?: number | null,
): boolean {
  if (!durationSeconds) return false;
  const mark = lastTimeMark(content);
  const marked = mark ? parseTimestamp(mark) : null;
  const covered = marked !== null && coveredUntilSeconds != null
    ? Math.min(marked, coveredUntilSeconds)
    : marked;
  if (covered === null) return false;
  const tolerance = Math.max(TAIL_TOLERANCE_MIN_SECONDS, durationSeconds * TAIL_TOLERANCE_RATIO);
  return covered < durationSeconds - tolerance;
}
