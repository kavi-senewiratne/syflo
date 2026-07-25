/**
 * PaperSearch.test.tsx
 *
 * Tests for the "Add a research paper" modal (Slice 07): the three
 * availability states (open / manual / paywalled) with their mockup actions,
 * the import flow (spinner, inline errors), and the debounced search.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PaperSearchModal } from '../components/PaperSearch';
import type { SearchResult } from '../types';

vi.mock('../api', () => ({
  api: { searchPapers: vi.fn() },
}));

import { api } from '../api';

const openResult: SearchResult = {
  id: 'W1',
  title: 'Attention Is All You Need',
  authors: ['Vaswani', 'Shazeer', 'Parmar', 'Uszkoreit'],
  year: 2017,
  citations: 80000,
  open_access_pdf_url: 'https://arxiv.org/pdf/1706.03762.pdf',
  abstract: null,
  doi: '10.1/attention',
  pdf_candidates: ['https://arxiv.org/pdf/1706.03762.pdf'],
};

const manualResult: SearchResult = {
  id: 'W2',
  title: 'Dec-MCTS: Decentralized planning',
  authors: ['Best'],
  year: 2018,
  citations: 200,
  // Alle Kandidaten liegen auf einem blockierten Host (sagepub) → 'manual'.
  open_access_pdf_url: 'https://journals.sagepub.com/doi/pdf/10.1177/x.pdf',
  abstract: null,
  doi: '10.1177/x',
  pdf_candidates: ['https://journals.sagepub.com/doi/pdf/10.1177/x.pdf'],
};

const paywalledResult: SearchResult = {
  id: 'W3',
  title: 'Attention in Psychology',
  authors: ['Lindsay'],
  year: 2020,
  citations: 500,
  open_access_pdf_url: null,
  abstract: null,
  doi: '10.3389/fncom',
  pdf_candidates: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.searchPapers).mockResolvedValue({
    results: [openResult, manualResult, paywalledResult],
    rate_limited: false,
  });
});

async function renderAndSearch(onImport = vi.fn().mockResolvedValue(undefined)) {
  const onClose = vi.fn();
  render(<PaperSearchModal onClose={onClose} onImport={onImport} />);
  fireEvent.change(screen.getByTestId('paper-search-input'), {
    target: { value: 'attention' },
  });
  fireEvent.click(screen.getByTestId('paper-search-submit'));
  await waitFor(() => expect(screen.getByText('Attention Is All You Need')).toBeInTheDocument());
  return { onClose, onImport };
}

describe('PaperSearchModal (Slice 07)', () => {
  it('zeigt die drei Verfügbarkeits-Zustände mit den Mockup-Aktionen', async () => {
    await renderAndSearch();

    // open → Import-Button + "Open access"-Badge
    expect(screen.getByText('Open access')).toBeInTheDocument();
    expect(screen.getByTestId('paper-search-import-W1')).toHaveTextContent('Import');

    // manual → Badge + "Open source page"-Link mit Hinweis, KEIN Import
    expect(screen.getByTestId('paper-search-badge-manual')).toBeInTheDocument();
    const sourceLink = screen.getByTestId('paper-search-open-source-page');
    expect(sourceLink).toHaveAttribute('href', 'https://doi.org/10.1177/x');
    expect(screen.getByText(/host blocks direct download/i)).toBeInTheDocument();
    expect(screen.queryByTestId('paper-search-import-W2')).not.toBeInTheDocument();

    // paywalled → Lock-Badge + "View publisher"-Link
    expect(screen.getByTestId('paper-search-badge-paywalled')).toBeInTheDocument();
    expect(screen.getByTestId('paper-search-view-publisher')).toHaveAttribute(
      'href', 'https://doi.org/10.3389/fncom',
    );
  });

  it('Import-Klick ruft onImport mit dem Treffer auf und zeigt den Spinner', async () => {
    let resolveImport: () => void;
    const onImport = vi.fn(() => new Promise<void>((r) => { resolveImport = r; }));
    await renderAndSearch(onImport);

    fireEvent.click(screen.getByTestId('paper-search-import-W1'));
    expect(onImport).toHaveBeenCalledWith(openResult);
    expect(screen.getByTestId('paper-search-import-W1')).toHaveTextContent('Importing…');
    resolveImport!();
    await waitFor(() =>
      expect(screen.getByTestId('paper-search-import-W1')).toHaveTextContent('Import'),
    );
  });

  it('zeigt Import-Fehler inline statt das Modal zu schließen', async () => {
    const onImport = vi.fn().mockRejectedValue(new Error('Publisher blocks direct download (HTTP 403).'));
    await renderAndSearch(onImport);

    fireEvent.click(screen.getByTestId('paper-search-import-W1'));
    await waitFor(() =>
      expect(screen.getByTestId('paper-search-error')).toHaveTextContent(/Publisher blocks/),
    );
    expect(screen.getByTestId('paper-search-modal')).toBeInTheDocument();
  });

  it('sucht debounced beim Tippen (400 ms, ab 3 Zeichen)', async () => {
    vi.useFakeTimers();
    try {
      render(<PaperSearchModal onClose={vi.fn()} onImport={vi.fn()} />);
      fireEvent.change(screen.getByTestId('paper-search-input'), { target: { value: 'at' } });
      vi.advanceTimersByTime(500);
      expect(api.searchPapers).not.toHaveBeenCalled();

      fireEvent.change(screen.getByTestId('paper-search-input'), { target: { value: 'attention' } });
      vi.advanceTimersByTime(399);
      expect(api.searchPapers).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(api.searchPapers).toHaveBeenCalledWith('attention');
    } finally {
      vi.useRealTimers();
    }
  });

  it('zeigt den Rate-Limit-Hinweis, wenn das Backend drosselt', async () => {
    vi.mocked(api.searchPapers).mockResolvedValue({ results: [], rate_limited: true });
    render(<PaperSearchModal onClose={vi.fn()} onImport={vi.fn()} />);
    fireEvent.change(screen.getByTestId('paper-search-input'), { target: { value: 'attention' } });
    fireEvent.click(screen.getByTestId('paper-search-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('paper-search-rate-limited')).toBeInTheDocument(),
    );
  });

  it('schließt über Escape und den Close-Button', async () => {
    const onClose = vi.fn();
    render(<PaperSearchModal onClose={onClose} onImport={vi.fn()} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  // Bug-Report 2026-07-24: "Keine Treffer." blieb aus der vorherigen Suche
  // stehen, während die neue Suche lief — ein abgestandener Leerzustand.
  it('blendet "No results." aus, solange eine neue Suche läuft', async () => {
    vi.mocked(api.searchPapers).mockResolvedValue({ results: [], rate_limited: false });
    render(<PaperSearchModal onClose={vi.fn()} onImport={vi.fn()} />);
    fireEvent.change(screen.getByTestId('paper-search-input'), { target: { value: 'attention' } });
    fireEvent.click(screen.getByTestId('paper-search-submit'));
    await screen.findByText('No results.');

    // Zweite Suche bleibt absichtlich hängen (pending Promise).
    let resolveSearch!: (v: { results: SearchResult[]; rate_limited: boolean }) => void;
    vi.mocked(api.searchPapers).mockReturnValue(
      new Promise(r => { resolveSearch = r; }) as ReturnType<typeof api.searchPapers>,
    );
    fireEvent.click(screen.getByTestId('paper-search-submit'));

    // Kein abgestandenes "No results." — stattdessen der Suchstatus.
    await waitFor(() => expect(screen.queryByText('No results.')).not.toBeInTheDocument());
    expect(screen.getByTestId('paper-search-status')).toBeInTheDocument();

    // Erst ein wirklich leeres Ergebnis bringt den Text zurück — hier kommt
    // stattdessen ein Treffer, also erscheint die Liste.
    resolveSearch({ results: [openResult], rate_limited: false });
    await screen.findByText('Attention Is All You Need');
    expect(screen.queryByText('No results.')).not.toBeInTheDocument();
  });
});
