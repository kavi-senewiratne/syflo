/**
 * YouTubeSearch.test.tsx
 *
 * Tests for the "Add a YouTube transcript" modal (ADR-0005): search results
 * with title/channel/duration, the import flow (Add button, inline errors —
 * e.g. a video without captions), and closing.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { YouTubeSearchModal } from '../components/YouTubeSearch';
import type { VideoSearchResult } from '../types';

vi.mock('../api', () => ({
  api: { searchYouTube: vi.fn() },
}));

import { api } from '../api';

const karpathy: VideoSearchResult = {
  youtube_id: 'zjkBMFhNj_g',
  title: 'Intro to Large Language Models',
  channel: 'Andrej Karpathy',
  duration: '59:47',
  published: '2 years ago',
  thumbnail_url: 'https://i.ytimg.com/vi/zjkBMFhNj_g/hqdefault.jpg',
  url: 'https://www.youtube.com/watch?v=zjkBMFhNj_g',
};

// published: null — die InnerTube-Anreicherung ist best-effort; die Zeile
// darf dann schlicht kein Datum zeigen.
const blueBrown: VideoSearchResult = {
  youtube_id: 'LPZh9BOjkQs',
  title: 'Large Language Models explained briefly',
  channel: '3Blue1Brown',
  duration: '7:57',
  published: null,
  thumbnail_url: null,
  url: 'https://www.youtube.com/watch?v=LPZh9BOjkQs',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.searchYouTube).mockResolvedValue([karpathy, blueBrown]);
});

async function renderAndSearch(onImport = vi.fn().mockResolvedValue(undefined)) {
  const onClose = vi.fn();
  render(<YouTubeSearchModal onClose={onClose} onImport={onImport} />);
  fireEvent.change(screen.getByTestId('youtube-search-input'), {
    target: { value: 'large language models' },
  });
  fireEvent.click(screen.getByTestId('youtube-search-submit'));
  await waitFor(() =>
    expect(screen.getByText('Intro to Large Language Models')).toBeInTheDocument(),
  );
  return { onClose, onImport };
}

describe('YouTubeSearchModal (ADR-0005)', () => {
  it('zeigt Titel, Kanal, Datum und Dauer der Treffer', async () => {
    await renderAndSearch();

    expect(api.searchYouTube).toHaveBeenCalledWith('large language models');
    expect(screen.getByText('Andrej Karpathy')).toBeInTheDocument();
    expect(screen.getByText('59:47')).toBeInTheDocument();
    expect(screen.getByText('2 years ago')).toBeInTheDocument();
    expect(screen.getByText('3Blue1Brown')).toBeInTheDocument();
  });

  it('ruft onImport mit dem gewählten Treffer auf', async () => {
    const { onImport } = await renderAndSearch();

    fireEvent.click(screen.getByTestId('youtube-search-import-zjkBMFhNj_g'));

    await waitFor(() => expect(onImport).toHaveBeenCalledWith(karpathy));
  });

  it('zeigt eine Import-Ablehnung inline (z. B. Video ohne Untertitel)', async () => {
    const onImport = vi
      .fn()
      .mockRejectedValue(new Error('YouTube offers no captions for this video — not even auto-generated ones. Pick a different video.'));
    await renderAndSearch(onImport);

    fireEvent.click(screen.getByTestId('youtube-search-import-zjkBMFhNj_g'));

    await waitFor(() =>
      expect(screen.getByTestId('youtube-search-error')).toHaveTextContent(/no captions/i),
    );
  });

  it('schließt über den Close-Button', async () => {
    const { onClose } = await renderAndSearch();
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalled();
  });

  // Bug-Report 2026-07-24 (wie PaperSearch): "Keine Treffer." darf nicht als
  // abgestandener Rest über einer laufenden neuen Suche stehen bleiben.
  it('blendet "No results." aus, solange eine neue Suche läuft', async () => {
    vi.mocked(api.searchYouTube).mockResolvedValue([]);
    render(<YouTubeSearchModal onClose={vi.fn()} onImport={vi.fn()} />);
    fireEvent.change(screen.getByTestId('youtube-search-input'), {
      target: { value: 'large language models' },
    });
    fireEvent.click(screen.getByTestId('youtube-search-submit'));
    await screen.findByText('No results.');

    let resolveSearch!: (v: VideoSearchResult[]) => void;
    vi.mocked(api.searchYouTube).mockReturnValue(
      new Promise(r => { resolveSearch = r; }) as ReturnType<typeof api.searchYouTube>,
    );
    fireEvent.click(screen.getByTestId('youtube-search-submit'));

    await waitFor(() => expect(screen.queryByText('No results.')).not.toBeInTheDocument());
    expect(screen.getByTestId('youtube-search-status')).toBeInTheDocument();

    resolveSearch([karpathy]);
    await screen.findByText('Intro to Large Language Models');
    expect(screen.queryByText('No results.')).not.toBeInTheDocument();
  });
});
