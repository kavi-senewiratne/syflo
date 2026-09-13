/**
 * BtwLifetime.test.tsx
 *
 * Section 05 of design/mockup-btw-composer-fold.html: an aside belongs to its
 * CHAT, not to the screen. Opening another branch leaves the panel behind
 * untouched; coming back finds it exactly where it was. Nothing is marked,
 * nothing is announced — the composer simply still has it.
 *
 * Only a reload clears everything, and that needs no test: the state is plain
 * React state and never reaches the database.
 */

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import App from '../App';
import type { Chat, ChatDetail } from '../types';

vi.mock('../pdf/pdfDocument', () => ({
  loadPdfDocument: vi.fn().mockResolvedValue({ numPages: 1, renderPage: vi.fn() }),
}));

vi.mock('../api', () => ({
  TreeHasSourceError: class extends Error {},
  StreamFailedError: class extends Error {},
  api: {
    getTree: vi.fn(),
    getSettings: vi.fn(),
    warmupChat: vi.fn().mockResolvedValue(undefined),
    getOllamaModels: vi.fn().mockResolvedValue([]),
    getOllamaStatus: vi.fn().mockResolvedValue({ reachable: true, models: [] }),
    getQuotaCooldowns: vi.fn().mockResolvedValue([]),
    getUsageSummary: vi.fn().mockResolvedValue({ month: '2026-08', pricesAsOf: '2026-08-01', providers: {}, modelsToday: {} }),
    getRegistry: vi.fn().mockRejectedValue(new Error('none')),
    getChat: vi.fn(),
    getAncestors: vi.fn().mockResolvedValue([]),
    getTreePaper: vi.fn().mockResolvedValue(null),
    getTreeVideo: vi.fn().mockResolvedValue(null),
    listHighlights: vi.fn().mockResolvedValue([]),
    listMessageHighlights: vi.fn().mockResolvedValue([]),
    getHighlightLabels: vi.fn().mockResolvedValue({}),
    askAside: vi.fn(),
    keepAside: vi.fn(),
    createChat: vi.fn(),
    deleteChat: vi.fn().mockResolvedValue(undefined),
    renameChat: vi.fn(),
    sendMessageStream: vi.fn(),
    regenerateMessage: vi.fn(),
    explainWord: vi.fn(),
    uploadPaper: vi.fn(),
    searchPapers: vi.fn(),
    importPaperFromUrl: vi.fn(),
    searchYouTube: vi.fn(),
    importYouTubeVideo: vi.fn(),
    createMessageHighlight: vi.fn(),
    updateMessageHighlight: vi.fn(),
    deleteMessageHighlight: vi.fn(),
    createHighlight: vi.fn(),
    updateHighlight: vi.fn(),
    deleteHighlight: vi.fn(),
    setHighlightLabel: vi.fn(),
    updateSettings: vi.fn(),
  },
}));

import { api } from '../api';

const parent: Chat = {
  id: 'c1', title: 'Attention', parent_id: null, parent_word: null,
  created_at: '2026-08-08T00:00:00Z', children: [],
};
const branch: Chat = {
  id: 'c2', title: 'Softmax scale', parent_id: 'c1', parent_word: 'square root of d_k',
  created_at: '2026-08-08T00:01:00Z', children: [],
};
const detail = (c: Chat): ChatDetail => ({ ...c, messages: [], children: [] });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getTree).mockResolvedValue([{ ...parent, children: [branch] }]);
  vi.mocked(api.getSettings).mockRejectedValue(new Error('none'));
  vi.mocked(api.getChat).mockImplementation(async (id: string) =>
    detail(id === 'c2' ? branch : parent),
  );
  vi.mocked(api.askAside).mockResolvedValue({ answer: 'A raw score.', model: null, truncated: false });
});

describe('an aside belongs to its chat', () => {
  it('waits in the chat it was asked in while another branch is open', async () => {
    render(<App />);
    await screen.findByText('Attention');
    fireEvent.click(screen.getByText('Attention'));

    const textarea = await screen.findByPlaceholderText(/Ask anything/i);
    fireEvent.change(textarea, { target: { value: '/btw what does logit mean again?' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    await screen.findByTestId('btw-panel');

    // Off to the branch — its composer is clean.
    fireEvent.click(screen.getByText('Softmax scale'));
    await waitFor(() => expect(screen.queryByTestId('btw-panel')).not.toBeInTheDocument());

    // And back: the aside is where it was left.
    fireEvent.click(screen.getByText('Attention'));
    await waitFor(() => expect(screen.getByTestId('btw-panel')).toBeInTheDocument());
    expect(screen.getByTestId('btw-panel')).toHaveTextContent('what does logit mean again?');
  });
});

// Nutzerbericht 2026-08-20: „die Antworten sollten geschmeidiger auftauchen.
// Es kommt alles auf einmal." Die Chat-Antworten laufen seit Juli durch den
// TextSmoother (85 Zeichen/s, vom Nutzer eingestellt) — die Nebenfrage lief
// daran vorbei und setzte jedes Modell-Paket in einem Rutsch ins Panel.
describe('an aside reveals itself at reading pace', () => {
  it('does not drop a whole paragraph into the panel at once', async () => {
    const paragraph = 'Mechanistic Interpretability zerlegt ein Netz in Schaltkreise. '.repeat(10);
    vi.mocked(api.askAside).mockImplementation(async (_chatId, _q, onDelta) => {
      // Ein einziges großes Paket — genau das, was schnelle Cloud-Modelle
      // liefern und was ohne Glättung als Block erscheint.
      onDelta(paragraph);
      return { answer: paragraph, model: null, truncated: false };
    });

    render(<App />);
    await screen.findByText('Attention');
    fireEvent.click(screen.getByText('Attention'));

    const textarea = await screen.findByPlaceholderText(/Ask anything/i);
    fireEvent.change(textarea, { target: { value: '/btw was ist mech interp?' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    const answer = await screen.findByTestId('btw-answer');
    const len = () => (answer.textContent || '').length;
    // Die erste Länge, die überhaupt sichtbar wird, und die, bei der es
    // stehen bleibt.
    let first = 0;
    let last = 0;
    let stable = 0;
    for (let i = 0; i < 200 && stable < 4; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
      const now = len();
      if (now > 0 && first === 0) first = now;
      stable = now === last && now > 0 ? stable + 1 : 0;
      last = now;
    }
    expect(last).toBeGreaterThan(500);           // der ganze Absatz steht am Ende
    expect(first).toBeGreaterThan(0);            // es fing wirklich an
    expect(first).toBeLessThan(last / 2);        // aber eben nicht als Block
  });

  // In der laufenden App gemessen (2026-08-20): die Knöpfe standen schon da,
  // als erst 1461 von 1905 Zeichen sichtbar waren. „Im Chat behalten" darf
  // aber erst erscheinen, wenn die Antwort wirklich vollständig dasteht —
  // sonst behält man ein Bruchstück.
  it('shows its two buttons only once the whole answer stands', async () => {
    const paragraph = 'Ein Attention Head vergleicht Positionen miteinander. '.repeat(12);
    vi.mocked(api.askAside).mockImplementation(async (_chatId, _q, onDelta) => {
      onDelta(paragraph);
      return { answer: paragraph, model: null, truncated: false };
    });

    render(<App />);
    await screen.findByText('Attention');
    fireEvent.click(screen.getByText('Attention'));

    const textarea = await screen.findByPlaceholderText(/Ask anything/i);
    fireEvent.change(textarea, { target: { value: '/btw was ist ein attention head?' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    const answer = await screen.findByTestId('btw-answer');
    let lenAtButton = -1;
    for (let i = 0; i < 200; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
      if (screen.queryByTestId('btw-keep')) {
        lenAtButton = (answer.textContent || '').length;
        break;
      }
    }
    expect(lenAtButton).toBeGreaterThan(0);
    // Vollständig, nicht bloß angefangen. (Das gerenderte Markdown wirft das
    // abschließende Leerzeichen weg — deshalb gegen den getrimmten Text.)
    expect(lenAtButton).toBe(paragraph.trimEnd().length);
  });
});
