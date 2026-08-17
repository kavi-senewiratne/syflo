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

export function insertTimeLinks(content: string): string {
  if (!content || !content.includes('[')) return content;

  // Same cut as branchLinks: alternating open / protected parts, odd indices
  // protected.
  return content
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
  for (const m of content.matchAll(re)) {
    const mark = m[2] ?? m[1];
    if (parseTimestamp(mark) !== null) last = mark;
  }
  return last;
}
