/**
 * markdown/transcriptBlocks.ts
 *
 * The raw transcript as the model sees it, cut into its coarse paragraphs:
 * `[01:30] text…` (buildTranscriptText writes one block per 30 seconds).
 *
 * One parser for two readers — the transcript view of the VideoPane, where a
 * block is clickable and therefore needs its second, and the TranscriptDrawer,
 * which only reads. They used to carry a copy each.
 */

export interface TranscriptBlock {
  /** Start of the block in seconds, or null for text without a mark. */
  seconds: number | null;
  /** The mark as written ("01:30"), so both views show the same chip. */
  time: string | null;
  text: string;
  /**
   * Where this block's TEXT starts inside the raw transcript. The anchor of a
   * transcript highlight (mockup-transcript-selection.html): marks are stored
   * as character offsets into the whole transcript, so they survive the list
   * being rebuilt — the same contract chat highlights have against a message.
   */
  offset: number;
}

/**
 * Index of the paragraph the player is currently inside, or -1 when the
 * transcript carries no marks. Same rule as the chapters: the last block that
 * has started — a block runs until the next one begins.
 */
export function activeBlockIndex(blocks: TranscriptBlock[], seconds: number): number {
  let active = -1;
  blocks.forEach((b, i) => {
    if (b.seconds !== null && seconds + 0.5 >= b.seconds) active = i;
  });
  // Vor der ersten Marke gilt der erste Absatz — wie bei den Kapiteln.
  return active === -1 && blocks.length > 0 && blocks[0].seconds !== null ? 0 : active;
}

export function parseTranscriptBlocks(transcript: string): TranscriptBlock[] {
  const source = transcript ?? '';
  // Offsets are measured against the ORIGINAL string, so the split has to
  // keep track of where each piece came from — searching for the text later
  // would land on the wrong copy whenever a sentence repeats.
  const blocks: TranscriptBlock[] = [];
  const re = /\n\n+/g;
  let cursor = 0;
  const pieces: Array<{ raw: string; at: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    pieces.push({ raw: source.slice(cursor, m.index), at: cursor });
    cursor = m.index + m[0].length;
  }
  pieces.push({ raw: source.slice(cursor), at: cursor });

  for (const piece of pieces) {
    const mark = piece.raw.match(/^\[(\d+:\d{2}(?::\d{2})?)\]\s*([\s\S]*)$/);
    if (!mark) {
      if (piece.raw.trim().length === 0) continue;
      blocks.push({ seconds: null, time: null, text: piece.raw, offset: piece.at });
      continue;
    }
    const parts = mark[1].split(':').map(Number);
    const seconds =
      parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
    if (mark[2].trim().length === 0) continue;
    blocks.push({
      seconds,
      time: mark[1],
      text: mark[2],
      // The text starts after the "[mm:ss] " prefix the parser stripped.
      offset: piece.at + (piece.raw.length - mark[2].length),
    });
  }
  return blocks;
}
