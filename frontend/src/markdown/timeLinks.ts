/**
 * markdown/timeLinks.ts
 *
 * Turns the time marks of a video overview into markdown links
 * (`[3:15 – 7:40](t:195)`) BEFORE the markdown/KaTeX pipeline runs, so
 * ReactMarkdown renders them as clickable links. `MessageBubble`'s `a()`
 * renderer opens YouTube at that second (user decision 2026-08-15,
 * variant A of three).
 *
 * Post-processing, NOT a prompt rule — deliberately, for two reasons:
 * the model cannot forget to do it, and every video overview that was
 * already written becomes clickable retroactively.
 *
 * Sibling of branchLinks.ts and bound by the same rule: never rewrite inside
 * code or math. It reuses that module's PROTECTED_SOURCE rather than keeping
 * a second copy — a transcript quoted inside a code fence keeps its marks as
 * text, and a `$t = 1:30$` stays a formula.
 *
 * Runs on RAW model text (before normalizeMathDelimiters), same as branch
 * links, so the Gemini bracket forms are already covered by that list.
 */

import { PROTECTED_SOURCE } from './branchLinks';

/**
 * `[m:ss]`, `[h:mm:ss]`, and ranges written with a dash of any kind
 * (`[3:15–7:40]`, `[3:15 - 7:40]`). The WHOLE bracket becomes one link and it
 * points at the START of the range — that is the second you want to land on;
 * the end is only there to say how long the section runs.
 *
 * The negative lookahead on `(` is what keeps this idempotent: a mark that is
 * already a markdown link (`[3:15](t:195)`, whether from an earlier pass or
 * written by the model itself) is left alone instead of growing a second
 * `(t:…)` tail.
 */
const TIME_RE =
  /\[(\d{1,2}:\d{2}(?::\d{2})?)(\s*[–—−-]\s*\d{1,2}:\d{2}(?::\d{2})?)?\](?!\()/g;

/** "7:40" → 460, "1:02:33" → 3753. Returns null for anything out of range. */
export function parseTimestamp(mark: string): number | null {
  const parts = mark.split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  let seconds: number;
  if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
  else if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else return null;
  // A mark like [99:99] is not a time — the model miscounted, or it is prose
  // in brackets. Better a plain bracket than a link to second 6039.
  if (parts.length >= 2 && parts[parts.length - 1] > 59) return null;
  if (parts.length === 3 && parts[1] > 59) return null;
  return seconds;
}

/** Watch URL that starts at `seconds`. `&t=` needs whole seconds, no unit. */
export function youtubeTimeUrl(youtubeId: string, seconds: number): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(youtubeId)}&t=${Math.floor(seconds)}s`;
}

// ─── Chapter headings, in every shape models actually write ────────────────
//
// The system rule asks for `## Title [m:ss - m:ss]`. What arrives:
// - the canonical shape, possibly already linkified (`[0:04 – 0:34](t:4)`),
// - `# Title [range]` one level high (Flash Lite, 2026-08-20),
// - `## 0:04 – 0:34 – Title` — range FIRST and WITHOUT brackets (Groq
//   gpt-oss-120b, 2026-09-01; two days earlier the same model wrote the
//   canonical shape). With brackets required, that overview had no chapters,
//   no clickable marks, and no readable progress — so the auto-continue never
//   fired and the answer stalled silently at 9:55 of a 47:40 video.
//
// Bare (unbracketed) marks stay confined to two positions on a HEADING line,
// because the 2026-08-30 lesson still holds: the video's own duration is
// injected into the prompt as a bare H:MM:SS string and models echo it — in
// prose, or mid-heading ("## Der Rest bis 3:57:44 fehlt"). Only a range that
// OPENS the heading, or a full start–end range that CLOSES it (optionally in
// parentheses), is a chapter mark; a single bare mark at the end never counts
// ("## Treffen um 10:30" is prose). Kept in step with
// backend/overview-progress.js (`bareHeadingSeconds`) — change both together.

const T_SRC = String.raw`\d{1,2}:\d{2}(?::\d{2})?`;
// Every dash a model has been seen to type between two marks. The plain
// hyphen, en dash, em dash and minus were not enough: on 2026-09-02
// gpt-oss-120b wrote "[0:01 ‑ 0:39]" with U+2011, the NON-BREAKING hyphen —
// indistinguishable on screen, and not one chapter parsed from an otherwise
// perfect overview. The range ‐-― covers the whole dash block at
// once, so the next typographic variant costs nothing.
// (The spaces need no widening: JavaScript's \s already matches U+00A0 and
// the narrow no-break space U+202F, which the same answer also used.)
const DASH_SRC = String.raw`\s*[-‐-―−﹘﹣－]\s*`;
const SEP_SRC = `(?:${DASH_SRC}|\\s*:\\s*|\\s+)`;

const CANONICAL_HEADING_RE = new RegExp(
  `^(#{1,4})\\s+(.*?)\\s*\\[(${T_SRC})(?:${DASH_SRC}(${T_SRC}))?\\](?:\\([^)]*\\))?\\s*$`,
);
// A heading that is ONLY a time range and nothing else: `## 10:09 – 13:13`
// (optionally bracketed). It has no topic title — the model wrote the range
// alone and put the sentence on the next line. Two marks joined by a dash are
// unambiguously a range, so this is safe to accept with an empty title. It
// MUST be tried before LEADING_HEADING_RE: that pattern requires a title after
// the range, so on a title-less range it backtracks and swallows the END mark
// AS the title — the "13:13 shows up as the chapter name" bug (user report
// 2026-09-06). The end-of-line `\s*$` absorbs a markdown hard-break's trailing
// spaces, so a range with or without them parses the same way.
const RANGE_ONLY_HEADING_RE = new RegExp(
  `^(#{1,4})\\s+\\[?(${T_SRC})${DASH_SRC}(${T_SRC})\\]?(?:\\([^)]*\\))?\\s*$`,
);
const LEADING_HEADING_RE = new RegExp(
  `^(#{1,4})\\s+(\\[?)(${T_SRC})(?:${DASH_SRC}(${T_SRC}))?(\\]?)(?:\\([^)]*\\))?(${SEP_SRC})(.+)$`,
);
const TRAILING_HEADING_RE = new RegExp(
  `^(#{1,4})\\s+(.+?)${SEP_SRC}\\(?(${T_SRC})${DASH_SRC}(${T_SRC})\\)?\\s*$`,
);

/**
 * A line that is NOTHING but a time mark — the "mark on the next line"
 * overview shape (Gemini Flash Lite, 2026-09-12, Hassabis lecture):
 *
 *   ## Eine Reise zur Künstlichen Intelligenz
 *   [0:02 - 5:48]
 *
 * All ten chapters of an otherwise well-formed overview carried their range
 * this way, so not one parsed and the video pane stood empty. Accepted: a
 * bracketed mark or range, possibly already linkified, and a BARE range —
 * two marks joined by a dash are unambiguous (same reasoning as
 * RANGE_ONLY_HEADING_RE). A bare SINGLE mark is not: the video's duration is
 * injected into the prompt as exactly such a bare string (2026-08-30 lesson
 * above), and an echo of it must not become a chapter.
 *
 * The pairing with the heading above happens in chapters.ts, which walks the
 * lines; parseChapterHeading stays single-line because
 * linkifyBareHeadingRanges depends on that.
 */
const LONE_MARK_LINE_RE = new RegExp(
  `^\\s*(?:\\[(${T_SRC})(?:${DASH_SRC}(${T_SRC}))?\\](?:\\([^)]*\\))?|(${T_SRC})${DASH_SRC}(${T_SRC}))\\s*$`,
);

export function parseLoneMarkLine(
  line: string,
): { startSeconds: number; endSeconds: number | null } | null {
  if (!line || !line.includes(':')) return null;
  const m = line.match(LONE_MARK_LINE_RE);
  if (!m) return null;
  const start = m[1] ?? m[3];
  const end = m[2] ?? m[4] ?? null;
  const startSeconds = parseTimestamp(start);
  if (startSeconds === null) return null;
  const endSeconds = end ? parseTimestamp(end) : null;
  if (end !== null && endSeconds === null) return null;
  return { startSeconds, endSeconds };
}

export interface ChapterHeading {
  /** Heading depth: number of hashes. */
  level: number;
  /** Heading text without the range and without a dangling separator dash. */
  title: string;
  /** The marks as written ('0:04'), for re-rendering. */
  start: string;
  end: string | null;
  startSeconds: number;
  endSeconds: number | null;
  /**
   * Span of a BARE range in the line — what insertTimeLinks must wrap.
   * Null when the range is already bracketed or linkified.
   */
  bare: { index: number; length: number } | null;
}

/** A dangling separator once the range is parsed out ('Einführung –' → 'Einführung'). */
export function cleanTitle(raw: string): string {
  return raw.trim().replace(/[\s–—−:-]+$/, '').trim();
}

/**
 * Reads one line as a chapter heading, or null. The time mark is what
 * separates a chapter from any other heading — a heading without one is
 * never a chapter.
 */
export function parseChapterHeading(line: string): ChapterHeading | null {
  if (!line || line[0] !== '#') return null;

  const canonical = line.match(CANONICAL_HEADING_RE);
  if (canonical) {
    const startSeconds = parseTimestamp(canonical[3]);
    if (startSeconds === null) return null;
    return {
      level: canonical[1].length,
      title: cleanTitle(canonical[2]),
      start: canonical[3],
      end: canonical[4] ?? null,
      startSeconds,
      endSeconds: canonical[4] ? parseTimestamp(canonical[4]) : null,
      bare: null,
    };
  }

  const rangeOnly = line.match(RANGE_ONLY_HEADING_RE);
  if (rangeOnly) {
    const [, hashes, start, end] = rangeOnly;
    const startSeconds = parseTimestamp(start);
    const endSeconds = parseTimestamp(end);
    if (startSeconds === null || endSeconds === null) return null;
    const from = line.indexOf(start, hashes.length);
    const endIdx = line.indexOf(end, from + start.length);
    return {
      level: hashes.length,
      title: '',
      start,
      end,
      startSeconds,
      endSeconds,
      bare: { index: from, length: endIdx + end.length - from },
    };
  }

  const leading = line.match(LEADING_HEADING_RE);
  if (leading) {
    const [, hashes, open, start, end, close, sep, rest] = leading;
    // '[0:04' without ']' (or the reverse) is a broken mark, not a chapter.
    if (Boolean(open) !== Boolean(close)) return null;
    // A single bare mark needs an explicit separator, so a heading that
    // merely STARTS with a clock time ("## 12:30 Uhr Mittagessen") stays prose.
    if (!end && !open && !/^\s*[–—−:-]/.test(sep)) return null;
    const startSeconds = parseTimestamp(start);
    if (startSeconds === null) return null;
    let bare: ChapterHeading['bare'] = null;
    if (!open) {
      const from = line.indexOf(start, hashes.length);
      const endIdx = end ? line.indexOf(end, from + start.length) : -1;
      bare = { index: from, length: (end ? endIdx + end.length : from + start.length) - from };
    }
    return {
      level: hashes.length,
      title: cleanTitle(rest),
      start,
      end: end ?? null,
      startSeconds,
      endSeconds: end ? parseTimestamp(end) : null,
      bare,
    };
  }

  const trailing = line.match(TRAILING_HEADING_RE);
  if (trailing) {
    const [, hashes, rawTitle, start, end] = trailing;
    const startSeconds = parseTimestamp(start);
    if (startSeconds === null) return null;
    const endIdx = line.lastIndexOf(end);
    const from = line.lastIndexOf(start, endIdx - 1);
    return {
      level: hashes.length,
      title: cleanTitle(rawTitle),
      start,
      end,
      startSeconds,
      endSeconds: parseTimestamp(end),
      bare: { index: from, length: endIdx + end.length - from },
    };
  }

  return null;
}

/**
 * Brackets a bare heading range and links it (`## 0:04 – 0:34 – T` →
 * `## [0:04 – 0:34](t:4) – T`). Line-based with its own fence tracking:
 * a heading quoted inside a code fence stays text, same rule as the
 * PROTECTED_SOURCE split below — which cannot carry this pass, because its
 * parts may start mid-line.
 */
function linkifyBareHeadingRanges(content: string): string {
  if (!content.includes('#')) return content;
  let inFence = false;
  return content
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const head = parseChapterHeading(line);
      if (!head?.bare) return line;
      const { index, length } = head.bare;
      const range = line.slice(index, index + length);
      return `${line.slice(0, index)}[${range}](t:${head.startSeconds})${line.slice(index + length)}`;
    })
    .join('\n');
}

export function insertTimeLinks(content: string): string {
  if (!content) return content;
  const withHeadings = linkifyBareHeadingRanges(content);
  if (!withHeadings.includes('[')) return withHeadings;

  // Same cut as branchLinks: alternating open / protected parts, odd indices
  // protected.
  return withHeadings
    .split(new RegExp(`(${PROTECTED_SOURCE})`, 'g'))
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part.replace(TIME_RE, (whole, start: string, range?: string) => {
        const seconds = parseTimestamp(start);
        if (seconds === null) return whole;
        return `[${start}${range ?? ''}](t:${seconds})`;
      });
    })
    .join('');
}

/**
 * The LAST time mark in a text, as it was written ("5:12"), or null when the
 * text carries none. Used by the truncation card to say how far a cut-off
 * Video overview got — the reader's real question is "why does it stop
 * here?", and the minute answers it without scrolling the whole answer.
 *
 * Reads the END of a range when there is one ("[0:03 - 5:12]" → "5:12"): that
 * is where the answer actually stood when it broke off.
 */
export function lastTimeMark(content: string): string | null {
  if (!content) return null;
  let last: string | null = null;
  // Marks may already be linkified ("[0:03](t:3)") — the source text of a
  // rendered message passes through here too.
  const re = /\[(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*[–—−-]\s*(\d{1,2}:\d{2}(?::\d{2})?))?\]/g;
  for (const line of content.split('\n')) {
    for (const m of line.matchAll(re)) {
      const mark = m[2] ?? m[1];
      if (parseTimestamp(mark) !== null) last = mark;
    }
    // A heading may carry its range without brackets (gpt-oss, 2026-09-01);
    // bare marks in PROSE still never count — see the note above
    // parseChapterHeading.
    const head = line.includes('[') ? null : parseChapterHeading(line);
    if (head) last = head.end ?? head.start;
  }
  return last;
}
