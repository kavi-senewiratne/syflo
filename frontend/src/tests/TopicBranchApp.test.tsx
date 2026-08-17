/**
 * TopicBranchApp.test.tsx
 *
 * `/branch <topic>` end to end through App (design/mockup-branch-command.html):
 * the typed topic becomes a branch under the chosen parent, the branch opens,
 * and the topic is asked in it — verbatim, because the app does not put words
 * in the user's mouth (mockup §06).
 *
 * The API client is mocked; App, ChatArea and the tree are real.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import App from '../App';
import type { Chat, ChatDetail } from '../types';

vi.mock('../pdf/pdfDocument', () => ({
  loadPdfDocument: vi.fn().mockResolvedValue({ numPages: 0, renderPage: vi.fn() }),
}));

vi.mock('../api', () => ({
  TreeHasSourceError: class TreeHasSourceError extends Error {},
  StreamFailedError: class StreamFailedError extends Error {},
  api: {
    getTree: vi.fn(),
    getSettings: vi.fn(),
    warmupChat: vi.fn().mockResolvedValue(undefined),
    getOllamaModels: vi.fn().mockResolvedValue([]),
    getOllamaStatus: vi.fn().mockResolvedValue({ reachable: true, models: [] }),
    getQuotaCooldowns: vi.fn().mockResolvedValue([]),
    getUsageSummary: vi.fn().mockResolvedValue({ month: '2026-08', pricesAsOf: '2026-08-01', providers: {}, modelsToday: {} }),
    getRegistry: vi.fn().mockRejectedValue(new Error('none')),
    updateSettings: vi.fn(),
    getChat: vi.fn(),
    getAncestors: vi.fn().mockResolvedValue([]),
    getTreePaper: vi.fn(),
    getTreeVideo: vi.fn(),
    createChat: vi.fn(),
    deleteChat: vi.fn(),
    renameChat: vi.fn(),
    passageTitle: vi.fn(),
    sendMessageStream: vi.fn(),
    regenerateMessage: vi.fn(),
    explainWord: vi.fn(),
    listHighlights: vi.fn(),
    listMessageHighlights: vi.fn(),
    createMessageHighlight: vi.fn(),
    updateMessageHighlight: vi.fn(),
    deleteMessageHighlight: vi.fn(),
    createHighlight: vi.fn(),
    updateHighlight: vi.fn(),
    deleteHighlight: vi.fn(),
    getHighlightLabels: vi.fn(),
    setHighlightLabel: vi.fn(),
    searchPapers: vi.fn(),
    importPaperFromUrl: vi.fn(),
    searchYouTube: vi.fn(),
    importYouTubeVideo: vi.fn(),
  },
}));

import { api } from '../api';

const rootChat: Chat = {
  id: 'c-root',
  title: 'Attention Is All You Need',
  parent_id: null,
  parent_word: null,
  created_at: '2026-08-08T00:00:00Z',
  children: [],
};

const branchChat: Chat = {
  id: 'c-branch',
  title: 'Scaled dot-product',
  parent_id: 'c-root',
  parent_word: 'we scale the dot products',
  created_at: '2026-08-08T01:00:00Z',
  children: [],
};

const detail = (chat: Chat): ChatDetail => ({ ...chat, messages: [], children: [] });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getTree).mockResolvedValue([{ ...rootChat, children: [branchChat] }]);
  vi.mocked(api.getSettings).mockRejectedValue(new Error('none'));
  vi.mocked(api.getChat).mockImplementation(async (id: string) =>
    detail(id === 'c-branch' ? branchChat : id === 'c-new' ? newBranch : rootChat)
  );
  vi.mocked(api.getTreePaper).mockResolvedValue(null);
  vi.mocked(api.getTreeVideo).mockResolvedValue(null);
  vi.mocked(api.listHighlights).mockResolvedValue([]);
  vi.mocked(api.listMessageHighlights).mockResolvedValue([]);
  vi.mocked(api.getHighlightLabels).mockResolvedValue({
    yellow: 'Important', green: 'Agree', blue: 'Reference', pink: 'Question', orange: 'Disagree',
  });
  vi.mocked(api.passageTitle).mockResolvedValue({ title: 'Positional encodings', quote: null });
  vi.mocked(api.createChat).mockResolvedValue(newBranch);
  vi.mocked(api.sendMessageStream).mockResolvedValue(undefined as never);
});

const newBranch: Chat = {
  id: 'c-new',
  title: 'Positional encodings',
  parent_id: 'c-root',
  parent_word: null,
  created_at: '2026-08-08T02:00:00Z',
  children: [],
};

/** Open a chat from the sidebar tree. */
async function openChat(title: string, id: string) {
  render(<App />);
  await waitFor(() => expect(screen.getByText(title)).toBeInTheDocument());
  fireEvent.click(screen.getByText(title));
  await waitFor(() => expect(api.getChat).toHaveBeenCalledWith(id));
}

function typeBranchCommand(topic: string) {
  const textarea = screen.getByPlaceholderText(/Ask anything/i);
  fireEvent.change(textarea, { target: { value: `/branch ${topic}` } });
  fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
}

describe('/branch through App', () => {
  it('creates a branch under the current chat, titled but without a parent quote', async () => {
    await openChat('Attention Is All You Need', 'c-root');
    typeBranchCommand('positional encodings');

    // The title comes from the same passage-title call the selection popup
    // uses — it tidies the topic, it does not invent one.
    await waitFor(() => expect(api.passageTitle).toHaveBeenCalledWith('positional encodings'));
    await waitFor(() =>
      // 'topic' is the branch origin: it leaves the trace line in the parent
      // transcript (design/mockup-branch-trace.html).
      expect(api.createChat).toHaveBeenCalledWith(
        'Positional encodings', 'c-root', undefined, undefined, undefined, 'topic',
      )
    );
  });

  it('asks the topic in the new branch, verbatim', async () => {
    await openChat('Attention Is All You Need', 'c-root');
    typeBranchCommand('positional encodings');

    await waitFor(() =>
      expect(api.sendMessageStream).toHaveBeenCalledWith(
        'c-new',
        'positional encodings',
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      )
    );
  });

  it('hangs the branch under the chat the user pointed the chip at', async () => {
    await openChat('Attention Is All You Need', 'c-root');

    const textarea = screen.getByPlaceholderText(/Ask anything/i);
    fireEvent.change(textarea, { target: { value: '/branch positional encodings' } });
    fireEvent.click(screen.getByTestId('branch-target'));
    fireEvent.click(screen.getByTestId('branch-target-item-c-branch'));
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    await waitFor(() =>
      expect(api.createChat).toHaveBeenCalledWith(
        'Positional encodings', 'c-branch', undefined, undefined, undefined, 'topic',
      )
    );
  });

  // A brand-new root chat is still empty when the first /branch is typed in
  // it — and an empty root chat is exactly what the app cleans up on
  // navigation. It must not clean up the parent of the branch it just made.
  it('never deletes the chat the branch was created under', async () => {
    await openChat('Attention Is All You Need', 'c-root');
    typeBranchCommand('positional encodings');

    await waitFor(() => expect(api.createChat).toHaveBeenCalled());
    await waitFor(() => expect(api.sendMessageStream).toHaveBeenCalled());
    expect(api.deleteChat).not.toHaveBeenCalled();
  });
});
