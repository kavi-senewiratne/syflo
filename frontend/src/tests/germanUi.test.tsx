/**
 * tests/germanUi.test.tsx
 *
 * Exemplarische Absicherung der App language (CONTEXT.md, Grill 2026-07-24):
 * Mit gespeicherter Wahl 'de' rendern Komponenten die deutschen Texte aus
 * strings.ts, und Datumsangaben folgen der deutschen Locale (de-DE). Der
 * Default (jsdom: navigator.language en-US) bleibt von diesen Tests
 * unberührt — localStorage wird vor und nach jedem Test aufgeräumt.
 */

import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../api';
import { VideoBanner } from '../components/VideoBanner';
import { HighlightsDrawer } from '../components/HighlightsDrawer';
import { _resetTreeHighlightsCacheForTests } from '../hooks/useTreeHighlights';
import { _resetLabelsCacheForTests } from '../hooks/useLabels';
import type { TreeHighlight, Video } from '../types';

vi.mock('../api', () => ({
  api: {
    listTreeHighlights: vi.fn(),
    getHighlightLabels: vi.fn(),
  },
}));

const video: Video = {
  id: 'v1',
  youtube_id: 'zjkBMFhNj_g',
  title: 'Intro to Large Language Models',
  channel: 'Andrej Karpathy',
  duration_seconds: 3587,
  language: 'en',
  url: 'https://www.youtube.com/watch?v=zjkBMFhNj_g',
  transcript: '[00:00] Hi everyone.',
};

// 5. März: Monat, dessen deutsche Kurzform ('März') sich klar von der
// englischen ('Mar') unterscheidet — 10:00Z liegt in jeder üblichen
// Zeitzone sicher am selben Kalendertag.
const items: TreeHighlight[] = [
  {
    kind: 'pdf', id: 'h-1', color: 'yellow', text: 'CB-MCTS', paperId: 'paper-1',
    pageNumber: 3, rects: [{ left: 10, top: 20, width: 100, height: 14 }],
    chatId: null, createdAt: '2026-03-05T10:00:00.000Z', updatedAt: '2026-03-05T10:00:00.000Z',
  },
];

beforeEach(() => {
  localStorage.setItem('syflo.appLanguage', 'de');
  vi.clearAllMocks();
  _resetTreeHighlightsCacheForTests();
  _resetLabelsCacheForTests();
  vi.mocked(api.getHighlightLabels).mockResolvedValue({
    yellow: 'Important', green: 'Agree', blue: 'Reference', pink: 'Question', orange: 'Disagree',
  });
  vi.mocked(api.listTreeHighlights).mockResolvedValue(items);
});

afterEach(() => {
  localStorage.removeItem('syflo.appLanguage');
});

describe('App language Deutsch (syflo.appLanguage=de)', () => {
  it('VideoBanner rendert die deutschen Texte', () => {
    render(<VideoBanner video={video} onOpenTranscript={vi.fn()} />);

    expect(screen.getByText(/Transcript angehängt/)).toBeInTheDocument();
    expect(screen.getByTestId('video-banner-view-transcript')).toHaveTextContent('Transcript ansehen');
    expect(screen.getByTestId('video-banner-open-youtube')).toHaveTextContent('Auf YouTube öffnen');
  });

  it('HighlightsDrawer formatiert Datumsangaben deutsch (de-DE)', async () => {
    render(
      <HighlightsDrawer chatId="root" onClose={vi.fn()} onJump={vi.fn()} onItemContextMenu={vi.fn()} />,
    );

    // en-US wäre "Mar 5" — de-DE liefert "5. März".
    expect(await screen.findByText('5. März')).toBeInTheDocument();
    // Und die Quelle nutzt die deutsche Seitenangabe.
    expect(screen.getByText('PDF · S. 3')).toBeInTheDocument();
  });
});
