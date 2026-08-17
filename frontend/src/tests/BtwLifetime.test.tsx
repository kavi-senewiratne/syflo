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

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
  vi.mocked(api.askAside).mockResolvedValue({ answer: 'A raw score.', model: null });
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
