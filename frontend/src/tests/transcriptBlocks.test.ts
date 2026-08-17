/**
 * tests/transcriptBlocks.test.ts
 *
 * Der Parser der Transcript-Absätze — gemeinsame Grundlage der Transcript-
 * Ansicht in der VideoPane und der TranscriptDrawer.
 */

import { describe, it, expect } from 'vitest';
import { parseTranscriptBlocks } from '../markdown/transcriptBlocks';


// ─── Offset im Roh-Transcript ──────────────────────────────────────────────
// Eine farbige Markierung im Transcript (mockup-transcript-selection.html)
// muss einen Anker haben, der einen Neuaufbau der Liste überlebt. Wie im Chat
// sind das Zeichen-Offsets — hier in den Transcript-Text des Videos. Dafür
// muss jeder Block wissen, wo sein Text im Ganzen beginnt.

describe('parseTranscriptBlocks – Offsets', () => {
  const transcript = '[00:00] Hi everyone.\n\n[07:30] A feature is the smallest unit.';

  it('nennt für jeden Block den Startindex seines Textes im Transcript', () => {
    const blocks = parseTranscriptBlocks(transcript);

    expect(transcript.slice(blocks[0].offset, blocks[0].offset + blocks[0].text.length))
      .toBe(blocks[0].text);
    expect(transcript.slice(blocks[1].offset, blocks[1].offset + blocks[1].text.length))
      .toBe(blocks[1].text);
  });

  it('zählt auch ohne Zeitmarke richtig', () => {
    const plain = 'Erster Absatz.\n\nZweiter Absatz.';
    const blocks = parseTranscriptBlocks(plain);
    expect(plain.slice(blocks[1].offset, blocks[1].offset + blocks[1].text.length))
      .toBe('Zweiter Absatz.');
  });
});
