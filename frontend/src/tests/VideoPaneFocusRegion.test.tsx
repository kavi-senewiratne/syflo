/**
 * VideoPaneFocusRegion.test.tsx
 *
 * The video pane is the middle column's source, exactly as the PDF pane is
 * (ADR-0011): so it is the `source` keyboard region, and the things a reader
 * acts on in it — the view switch, every chapter, every transcript block — are
 * its items. Without this the ring walked from the sidebar straight into the
 * chat and skipped the whole middle column (user report 2026-08-17).
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { VideoPane } from '../components/VideoPane';
import { readScreen } from '../keyboard/readScreen';
import { buildLayout } from '../keyboard/focusMap';
import type { Video } from '../types';

const video: Video = {
  id: 'v1',
  youtube_id: 'zjkBMFhNj_g',
  title: 'Intro to Large Language Models',
  channel: 'Andrej Karpathy',
  duration_seconds: 3587,
  language: 'en',
  url: 'https://www.youtube.com/watch?v=zjkBMFhNj_g',
  transcript: '[00:00] Hi everyone.\n\n[07:30] So this is the pre-training stage.',
};

const overview = `## An LLM is two files [0:00 - 7:30]

**A model you can hold in your hand.**

## Where the parameters come from [7:30 - 14:14]

**Pre-training compresses the internet.**
`;

function itemsOf(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-focus-item]'))
    .map((el) => el.dataset.focusItem!);
}

describe('VideoPane as a keyboard region', () => {
  it('is the source region, like the PDF pane', () => {
    const { container } = render(<VideoPane video={video} overview={overview} />);

    expect(container.querySelector('[data-focus-region="source"]')).not.toBeNull();
  });

  it('makes the view switch and every chapter an item', () => {
    const { container } = render(<VideoPane video={video} overview={overview} />);

    expect(itemsOf(container)).toEqual([
      'video-view-chapters',
      'video-view-transcript',
      'chapter-0',
      'chapter-1',
    ]);
  });

  it('makes every transcript block an item once the transcript is shown', () => {
    const { container } = render(<VideoPane video={video} overview={overview} />);

    fireEvent.click(screen.getByTestId('video-view-transcript'));

    expect(itemsOf(container)).toEqual([
      'video-view-chapters',
      'video-view-transcript',
      'transcript-0',
      'transcript-1',
    ]);
  });

  it('reads the chapters as a sequence, not as a row of side-by-side controls', () => {
    // Same rule as the marks in the PDF: ← out of a chapter means "leave the
    // column", never "the chapter to my left".
    const { container } = render(<VideoPane video={video} overview={overview} />);

    const list = container.querySelector('[data-focus-axis="sequence"]');
    expect(list?.querySelectorAll('[data-focus-item]').length).toBe(2);
  });

  it('gives the ring a place even before the overview has written a chapter', () => {
    // A region on screen is never empty (ADR-0011) — the switch alone carries
    // it while the overview is still arriving.
    const { container } = render(<VideoPane video={video} overview={null} />);

    expect(itemsOf(container)).toEqual(['video-view-chapters', 'video-view-transcript']);
  });

  it('lands the source column between the sidebar and the chat', () => {
    render(<VideoPane video={video} overview={overview} />);

    const layout = buildLayout(readScreen(document));

    expect(layout.columns.map((c) => c.id)).toContain('source');
    expect(layout.columns.find((c) => c.id === 'source')?.items).toContain('chapter-1');
  });
});

/**
 * §03, Variante A (Nutzerentscheidung 2026-08-18): eine Kapitelkarte kommt
 * blendend und um 7 px aufsteigend an, statt hart in die Liste zu springen.
 * Die Bewegung hängt am Einhängen des Knotens — die Regel selbst steht in
 * index.css, hier wird nur festgehalten, dass jede Karte sie trägt.
 */
describe('VideoPane — chapters arriving', () => {
  it('gives every chapter the arrival animation', () => {
    render(<VideoPane video={video} overview={overview} />);

    const rows = screen.getAllByTestId('video-chapter');
    expect(rows).toHaveLength(2);
    rows.forEach((row) => expect(row.className).toContain('syflo-chapter-in'));
  });
});
