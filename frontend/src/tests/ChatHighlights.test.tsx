/**
 * ChatHighlights.test.tsx
 *
 * Chat-text highlighting + "Ask in chat"
 * (design/mockup-chat-highlights-ask-in-chat.html):
 *
 *   1. MessageBubble: right-click with a live selection fires onChatSelection
 *      with message-relative character offsets (whitespace trimmed off), on
 *      user and assistant bubbles alike; leading "> " quotes in user messages
 *      render as a styled block.
 *   2. ChatArea: the composer quote block renders, is removable, and sending
 *      prepends the quote as a markdown blockquote.
 *   3. App integration: selection right-click opens the popup with the color
 *      row + "Ask in chat"; a swatch click persists a message highlight;
 *      "Ask in chat" branches from the selection, opens the branch with the
 *      quote pre-filled, and (no PDF) shows the parent chat as center context.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageBubble } from '../components/ChatArea/MessageBubble';
import { ChatArea } from '../components/ChatArea';
import App from '../App';
import type { Chat, ChatDetail, Message, MessageHighlight } from '../types';

// pdf.js braucht DOMMatrix etc., das jsdom nicht hat — wie in App.test.tsx
// wird der Wrapper weggemockt (der PDF-Pfad ist hier ohnehin nie aktiv).
vi.mock('../pdf/pdfDocument', () => ({
  loadPdfDocument: vi.fn().mockResolvedValue({
    numPages: 0,
    renderPage: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../api', () => ({
  TreeHasSourceError: class TreeHasSourceError extends Error {
    rootChatId: string | null;
    constructor(rootChatId: string | null) {
      super('tree-has-source');
      this.name = 'TreeHasSourceError';
      this.rootChatId = rootChatId;
    }
  },
  api: {
    getTree: vi.fn(),
    getSettings: vi.fn(),
    // Modell-System v2: App ruft diese beim Start auf — Defaults, damit
    // bestehende Tests ohne eigenes Setup weiterlaufen.
    applyRecommendedModel: vi.fn().mockResolvedValue({ applied: false, model: '' }),
    warmupChat: vi.fn().mockResolvedValue(undefined),
    getOllamaModels: vi.fn().mockResolvedValue([]),
    getSystemRecommendation: vi.fn().mockRejectedValue(new Error('none')),
    updateSettings: vi.fn(),
    pullOllamaModel: vi.fn().mockResolvedValue(undefined),
    deleteOllamaModel: vi.fn().mockResolvedValue(undefined),
    getChat: vi.fn(),
    getAncestors: vi.fn(),
    getTreePaper: vi.fn(),
    getTreeVideo: vi.fn().mockResolvedValue(null),
    uploadPaper: vi.fn(),
    createChat: vi.fn(),
    deleteChat: vi.fn(),
    renameChat: vi.fn(),
    sendMessageStream: vi.fn(),
    explainWord: vi.fn(),
    listHighlights: vi.fn(),
    createHighlight: vi.fn(),
    updateHighlight: vi.fn(),
    deleteHighlight: vi.fn(),
    listMessageHighlights: vi.fn(),
    createMessageHighlight: vi.fn(),
    updateMessageHighlight: vi.fn(),
    deleteMessageHighlight: vi.fn(),
    getHighlightLabels: vi.fn(),
    setHighlightLabel: vi.fn(),
    searchPapers: vi.fn(),
    importPaperFromUrl: vi.fn(),
  },
}));

import { api } from '../api';

const assistantMessage: Message = {
  id: 'a1',
  chat_id: 'c1',
  role: 'assistant',
  content: 'Gradient clipping alone is not enough here.',
  created_at: '2026-07-19T00:00:00Z',
};

const userMessage: Message = {
  id: 'u1',
  chat_id: 'c1',
  role: 'user',
  content: 'Why does warmup help at the start?',
  created_at: '2026-07-19T00:00:00Z',
};

// Mock a live selection over [start, end) of the given text node — jsdom has
// no real selection, but Range math works, so the bubble's offset capture
// runs for real.
function mockSelectionOver(node: Node, start: number, end: number) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  vi.spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => range,
    toString: () => range.toString(),
  } as unknown as Selection);
  return range;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MessageBubble — chat selection capture', () => {
  it('fires onChatSelection with message-relative offsets on assistant text', () => {
    const onChatSelection = vi.fn();
    render(
      <MessageBubble
        message={assistantMessage}
        onWordRightClick={vi.fn()}
        onChatSelection={onChatSelection}
      />,
    );
    const p = screen.getByText(/Gradient clipping/);
    // "clipping alone" = offsets 9..23 of the content
    mockSelectionOver(p.firstChild!, 9, 23);
    fireEvent.contextMenu(p);
    expect(onChatSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'a1',
        chatId: 'c1',
        text: 'clipping alone',
        startOffset: 9,
        endOffset: 23,
      }),
      assistantMessage.content,
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('trims selected whitespace out of text and offsets', () => {
    const onChatSelection = vi.fn();
    render(
      <MessageBubble
        message={assistantMessage}
        onWordRightClick={vi.fn()}
        onChatSelection={onChatSelection}
      />,
    );
    const p = screen.getByText(/Gradient clipping/);
    // " clipping alone " = offsets 8..24 — expect them tightened to 9..23.
    mockSelectionOver(p.firstChild!, 8, 24);
    fireEvent.contextMenu(p);
    expect(onChatSelection).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'clipping alone', startOffset: 9, endOffset: 23 }),
      expect.any(String),
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('also captures selections on user messages', () => {
    const onChatSelection = vi.fn();
    render(
      <MessageBubble
        message={userMessage}
        onWordRightClick={vi.fn()}
        onChatSelection={onChatSelection}
      />,
    );
    const p = screen.getByText(/Why does warmup/);
    mockSelectionOver(p.firstChild!, 9, 15); // "warmup"
    fireEvent.contextMenu(p);
    expect(onChatSelection).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'u1', text: 'warmup', startOffset: 9, endOffset: 15 }),
      userMessage.content,
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('renders a leading "> " quote in a user message as a styled block', () => {
    const quoted: Message = {
      ...userMessage,
      content: '> Gradient clipping alone is not enough\n\nIs there a fix?',
    };
    render(<MessageBubble message={quoted} onWordRightClick={vi.fn()} />);
    expect(screen.getByTestId('user-message-quote')).toHaveTextContent(
      'Gradient clipping alone is not enough',
    );
    expect(screen.getByText('Is there a fix?')).toBeInTheDocument();
    // The raw "> " marker must not leak into the rendered bubble.
    expect(screen.queryByText(/^>/)).not.toBeInTheDocument();
  });
});

describe('ChatArea — composer quote', () => {
  const chat: ChatDetail = {
    id: 'c2',
    title: 'Branch',
    parent_id: 'c1',
    parent_word: 'warmup',
    created_at: '2026-07-19T00:00:00Z',
    messages: [],
    children: [],
  };

  function renderComposer(onSendMessage = vi.fn().mockResolvedValue(undefined), onClear = vi.fn()) {
    render(
      <ChatArea
        chat={chat}
        loading={false}
        streaming={false}
        onSendMessage={onSendMessage}
        onWordRightClick={vi.fn()}
        onSelectChat={vi.fn()}
        composerQuote={{ text: 'Gradient clipping alone', sourceLabel: 'Optimizer deep dive', color: 'pink' }}
        onClearComposerQuote={onClear}
      />,
    );
    return { onSendMessage, onClear };
  }

  it('renders the quote block with text and source', () => {
    renderComposer();
    const quote = screen.getByTestId('composer-quote');
    expect(quote).toHaveTextContent('Gradient clipping alone');
    expect(quote).toHaveTextContent('from "Optimizer deep dive"');
  });

  it('removes the quote via the × button', () => {
    const { onClear } = renderComposer();
    fireEvent.click(screen.getByTestId('composer-quote-remove'));
    expect(onClear).toHaveBeenCalled();
  });

  it('sends the quote as a markdown blockquote above the question', async () => {
    const { onSendMessage, onClear } = renderComposer();
    fireEvent.change(screen.getByTestId('chat-textarea'), {
      target: { value: 'Is there a fix?' },
    });
    fireEvent.keyDown(screen.getByTestId('chat-textarea'), { key: 'Enter' });
    await waitFor(() =>
      expect(onSendMessage).toHaveBeenCalledWith(
        '> Gradient clipping alone\n\nIs there a fix?',
        [],
      ),
    );
    expect(onClear).toHaveBeenCalled();
  });
});

describe('App — chat highlight + Ask in chat flow', () => {
  const rootChat: Chat = {
    id: 'c1',
    title: 'Optimizer deep dive',
    parent_id: null,
    parent_word: null,
    created_at: '2026-07-19T00:00:00Z',
    children: [],
  };
  const rootDetail: ChatDetail = {
    ...rootChat,
    messages: [assistantMessage],
    children: [],
  };
  const childChat: Chat = {
    id: 'c9',
    title: 'About: clipping alone',
    parent_id: 'c1',
    parent_word: 'clipping alone',
    created_at: '2026-07-19T00:01:00Z',
    children: [],
  };
  const childDetail: ChatDetail = { ...childChat, messages: [], children: [] };
  const savedHighlight: MessageHighlight = {
    id: 'mh1',
    messageId: 'a1',
    chatId: 'c1',
    startOffset: 9,
    endOffset: 23,
    text: 'clipping alone',
    color: 'pink',
    createdAt: '2026-07-19T00:00:30Z',
    updatedAt: '2026-07-19T00:00:30Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getTree).mockResolvedValue([rootChat]);
    vi.mocked(api.getSettings).mockRejectedValue(new Error('none'));
    vi.mocked(api.getChat).mockImplementation(async (id: string) => {
      if (id === 'c1') return rootDetail;
      if (id === 'c9') return childDetail;
      throw new Error(`unexpected chat ${id}`);
    });
    vi.mocked(api.getTreePaper).mockResolvedValue(null);
    vi.mocked(api.getAncestors).mockResolvedValue([]);
    vi.mocked(api.listHighlights).mockResolvedValue([]);
    vi.mocked(api.listMessageHighlights).mockResolvedValue([]);
    vi.mocked(api.createMessageHighlight).mockResolvedValue(savedHighlight);
    vi.mocked(api.createChat).mockResolvedValue(childChat);
    vi.mocked(api.explainWord).mockResolvedValue({ explanation: 'a definition' });
    vi.mocked(api.getHighlightLabels).mockResolvedValue({
      yellow: 'Important', green: 'Agree', blue: 'Reference', pink: 'Question', orange: 'Disagree',
    });
  });

  async function openRootAndSelect() {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Optimizer deep dive')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Optimizer deep dive'));
    await waitFor(() => expect(screen.getByText(/Gradient clipping/)).toBeInTheDocument());
    const p = screen.getByText(/Gradient clipping/);
    mockSelectionOver(p.firstChild!, 9, 23); // "clipping alone"
    fireEvent.contextMenu(p);
  }

  it('opens the popup with color row and "Ask in chat" for a chat selection', async () => {
    await openRootAndSelect();
    await waitFor(() => expect(screen.getByTestId('popup-color-section')).toBeInTheDocument());
    expect(screen.getByTestId('popup-ask-in-chat')).toBeInTheDocument();
    expect(screen.getByText('Open as new chat')).toBeInTheDocument();
  });

  it('persists a message highlight on swatch click, recolors on second click', async () => {
    await openRootAndSelect();
    await waitFor(() => expect(screen.getByTestId('popup-color-section')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Highlight as Question'));
    await waitFor(() =>
      expect(api.createMessageHighlight).toHaveBeenCalledWith('c1', {
        messageId: 'a1',
        color: 'pink',
        text: 'clipping alone',
        startOffset: 9,
        endOffset: 23,
      }),
    );
    vi.mocked(api.updateMessageHighlight).mockResolvedValue({ ...savedHighlight, color: 'blue' });
    fireEvent.click(screen.getByLabelText('Highlight as Reference'));
    await waitFor(() =>
      expect(api.updateMessageHighlight).toHaveBeenCalledWith('mh1', 'blue'),
    );
    expect(api.createMessageHighlight).toHaveBeenCalledTimes(1);
  });

  it('"Ask in chat" erstellt automatisch ein Highlight in der aktiven Farbe', async () => {
    // Nutzerentscheid 2026-07-21: Auch ohne Swatch-Klick wird die Selektion
    // beim "Ask in chat" dauerhaft markiert (Default-Farbe = aktive Farbe).
    await openRootAndSelect();
    await waitFor(() => expect(screen.getByTestId('popup-ask-in-chat')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('popup-ask-in-chat'));

    await waitFor(() =>
      expect(api.createMessageHighlight).toHaveBeenCalledWith('c1', {
        messageId: 'a1',
        color: 'yellow',
        text: 'clipping alone',
        startOffset: 9,
        endOffset: 23,
      }),
    );
  });

  it('"Ask in chat" nach Swatch-Klick legt kein zweites Highlight an', async () => {
    await openRootAndSelect();
    await waitFor(() => expect(screen.getByTestId('popup-color-section')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Highlight as Question'));
    await waitFor(() => expect(api.createMessageHighlight).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('popup-ask-in-chat'));
    await waitFor(() => expect(screen.getByTestId('composer-quote')).toBeInTheDocument());
    expect(api.createMessageHighlight).toHaveBeenCalledTimes(1);
  });

  it('"Open as new chat" markiert die Selektion dauerhaft im Elternchat', async () => {
    // Mockup Sektion 03: "The selection that spawned the branch stays
    // visibly highlighted in the parent."
    await openRootAndSelect();
    await waitFor(() => expect(screen.getByText('Open as new chat')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Open as new chat'));

    await waitFor(() =>
      expect(api.createChat).toHaveBeenCalledWith('About: clipping alone', 'c1', 'clipping alone'),
    );
    await waitFor(() =>
      expect(api.createMessageHighlight).toHaveBeenCalledWith('c1', {
        messageId: 'a1',
        color: 'yellow',
        text: 'clipping alone',
        startOffset: 9,
        endOffset: 23,
      }),
    );
  });

  it('"Open as new chat" nach Swatch-Klick legt kein zweites Highlight an', async () => {
    await openRootAndSelect();
    await waitFor(() => expect(screen.getByTestId('popup-color-section')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Highlight as Question'));
    await waitFor(() => expect(api.createMessageHighlight).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText('Open as new chat'));
    await waitFor(() =>
      expect(api.createChat).toHaveBeenCalledWith('About: clipping alone', 'c1', 'clipping alone'),
    );
    await waitFor(() => expect(screen.getByTestId('parent-context-pane')).toBeInTheDocument());
    expect(api.createMessageHighlight).toHaveBeenCalledTimes(1);
  });

  it('"Ask in chat" drops the quote into the SAME chat\'s composer without branching', async () => {
    await openRootAndSelect();
    await waitFor(() => expect(screen.getByTestId('popup-ask-in-chat')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('popup-ask-in-chat'));

    // Quote sits in the current chat's composer…
    await waitFor(() => expect(screen.getByTestId('composer-quote')).toBeInTheDocument());
    expect(screen.getByTestId('composer-quote')).toHaveTextContent('clipping alone');
    expect(screen.getByTestId('composer-quote')).toHaveTextContent('from "Optimizer deep dive"');
    // …no branch was created, no layout change.
    expect(api.createChat).not.toHaveBeenCalled();
    expect(screen.queryByTestId('parent-context-pane')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-pane-right')).not.toBeInTheDocument();
  });

  it('"Open as new chat" branches and shows the parent as read-only center context (no PDF)', async () => {
    await openRootAndSelect();
    await waitFor(() => expect(screen.getByText('Open as new chat')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Open as new chat'));

    await waitFor(() =>
      expect(api.createChat).toHaveBeenCalledWith('About: clipping alone', 'c1', 'clipping alone'),
    );
    // The branch opens in the right pane, parent chat renders in the center.
    await waitFor(() => expect(screen.getByTestId('parent-context-pane')).toBeInTheDocument());
    expect(screen.getByTestId('chat-pane-right')).toBeInTheDocument();
    // No quote is pre-filled by branching.
    expect(screen.queryByTestId('composer-quote')).not.toBeInTheDocument();
  });

  it('"Open as new chat" with unreachable backend keeps the popup open and shows the error', async () => {
    // Regression (2026-07-20): createChat rejected as an unhandled promise
    // rejection after the popup had already closed — the click appeared to
    // crash the app. Now the popup stays open and reports the failure.
    await openRootAndSelect();
    await waitFor(() => expect(screen.getByText('Open as new chat')).toBeInTheDocument());

    vi.mocked(api.createChat).mockRejectedValueOnce(new Error('Failed to create chat'));
    fireEvent.click(screen.getByText('Open as new chat'));

    // Popup bleibt offen und zeigt die Fehlermeldung im Definitionsbereich.
    await waitFor(() =>
      expect(screen.getByText(/Could not create chat: Failed to create chat/)).toBeInTheDocument(),
    );
    expect(screen.getByText('Open as new chat')).toBeInTheDocument();
    // Kein Branch, kein Layout-Wechsel.
    expect(screen.queryByTestId('parent-context-pane')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-pane-right')).not.toBeInTheDocument();
  });
});
