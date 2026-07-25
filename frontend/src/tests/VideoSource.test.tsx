/**
 * VideoSource.test.tsx
 *
 * Tests for the video source UI (ADR-0005): the VideoBanner that keeps the
 * tree's YouTube transcript visible on every chat, and the TranscriptDrawer
 * that shows the raw transcript with minute marks (exactly what the model
 * sees).
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { VideoBanner } from '../components/VideoBanner';
import { TranscriptDrawer } from '../components/TranscriptDrawer';
import type { Video } from '../types';

const video: Video = {
  id: 'v1',
  youtube_id: 'zjkBMFhNj_g',
  title: 'Intro to Large Language Models',
  channel: 'Andrej Karpathy',
  duration_seconds: 3587,
  language: 'en',
  url: 'https://www.youtube.com/watch?v=zjkBMFhNj_g',
  transcript: '[00:00] Hi everyone.\n\n[01:30] So what is a large language model really?',
};

describe('VideoBanner (ADR-0005)', () => {
  it('zeigt Titel, Kanal und Dauer der Quelle', () => {
    render(<VideoBanner video={video} onOpenTranscript={vi.fn()} />);

    expect(screen.getByTestId('video-banner')).toBeInTheDocument();
    expect(screen.getByText('Intro to Large Language Models')).toBeInTheDocument();
    expect(screen.getByText(/Andrej Karpathy/)).toBeInTheDocument();
    expect(screen.getByText(/59:47/)).toBeInTheDocument();
  });

  it('öffnet das Transkript per Klick und verlinkt zum Video', () => {
    const onOpenTranscript = vi.fn();
    render(<VideoBanner video={video} onOpenTranscript={onOpenTranscript} />);

    fireEvent.click(screen.getByTestId('video-banner-view-transcript'));
    expect(onOpenTranscript).toHaveBeenCalled();

    const link = screen.getByTestId('video-banner-open-youtube') as HTMLAnchorElement;
    expect(link.href).toBe('https://www.youtube.com/watch?v=zjkBMFhNj_g');
  });
});

describe('TranscriptDrawer (ADR-0005)', () => {
  it('rendert das Transkript als Absätze mit Minutenmarken', () => {
    render(<TranscriptDrawer video={video} onClose={vi.fn()} />);

    expect(screen.getByTestId('transcript-drawer')).toBeInTheDocument();
    expect(screen.getByText('00:00')).toBeInTheDocument();
    expect(screen.getByText('Hi everyone.')).toBeInTheDocument();
    expect(screen.getByText('01:30')).toBeInTheDocument();
    expect(screen.getByText('So what is a large language model really?')).toBeInTheDocument();
  });

  it('schließt über den Close-Button', () => {
    const onClose = vi.fn();
    render(<TranscriptDrawer video={video} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close transcript'));
    expect(onClose).toHaveBeenCalled();
  });
});
