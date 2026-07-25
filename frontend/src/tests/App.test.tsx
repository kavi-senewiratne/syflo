/**
 * App.test.tsx
 *
 * Integration tests for the slice-03 wiring in App.tsx: uploading a PDF via
 * the plus menu switches to the three-column view, the view is restored when
 * a chat whose tree has a paper is opened (reload case), and a second upload
 * into the same tree shows the new-tree prompt (ADR-0002).
 *
 * The API client and the pdf.js wrapper are mocked; everything between them
 * (App state, ChatArea menu, PdfView) is real.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import App from '../App';
import { TreeHasSourceError } from '../api';
import type { Chat, ChatDetail, Paper } from '../types';

const renderPage = vi.fn().mockResolvedValue(undefined);
vi.mock('../pdf/pdfDocument', () => ({
  loadPdfDocument: vi.fn().mockResolvedValue({
    numPages: 2,
    renderPage: (...args: unknown[]) => renderPage(...args),
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
    getAncestors: vi.fn().mockResolvedValue([]),
    getTreePaper: vi.fn(),
    uploadPaper: vi.fn(),
    createChat: vi.fn(),
    deleteChat: vi.fn(),
    renameChat: vi.fn(),
    sendMessageStream: vi.fn(),
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
    getTreeVideo: vi.fn(),
  },
}));

import { api } from '../api';

const rootChat: Chat = {
  id: 'c1',
  title: 'Lease review',
  parent_id: null,
  parent_word: null,
  created_at: '2026-07-11T00:00:00Z',
  children: [],
};

const rootDetail: ChatDetail = { ...rootChat, messages: [], children: [] };

const paper: Paper = {
  id: 'p1',
  title: 'lease-agreement',
  authors: [],
  uploaded_at: '2026-07-11T00:00:00Z',
  status: 'ready',
  pdf_url: '/api/papers/p1/pdf',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getTree).mockResolvedValue([rootChat]);
  vi.mocked(api.getSettings).mockRejectedValue(new Error('none'));
  vi.mocked(api.getChat).mockResolvedValue(rootDetail);
  vi.mocked(api.getTreePaper).mockResolvedValue(null);
  vi.mocked(api.uploadPaper).mockResolvedValue(paper);
  vi.mocked(api.listHighlights).mockResolvedValue([]);
  vi.mocked(api.listMessageHighlights).mockResolvedValue([]);
  vi.mocked(api.getHighlightLabels).mockResolvedValue({
    yellow: 'Important', green: 'Agree', blue: 'Reference', pink: 'Question', orange: 'Disagree',
  });
  vi.mocked(api.getTreeVideo).mockResolvedValue(null);
});

/** Render the app and open the root chat from the sidebar. */
async function openRootChat() {
  render(<App />);
  await waitFor(() => expect(screen.getByText('Lease review')).toBeInTheDocument());
  fireEvent.click(screen.getByText('Lease review'));
  await waitFor(() => expect(api.getChat).toHaveBeenCalledWith('c1'));
}

/** Pick a PDF through the plus menu's "Upload file" entry. */
async function uploadPdfViaPlusMenu(file: File) {
  fireEvent.click(screen.getByTestId('attach-plus-button'));
  fireEvent.click(screen.getByTestId('attach-menu-upload-pdf'));
  fireEvent.change(screen.getByTestId('pdf-file-input'), { target: { files: [file] } });
}

describe('App — PDF upload end-to-end (slice 03)', () => {
  it('switches to the three-column view after uploading a PDF', async () => {
    await openRootChat();
    expect(screen.queryByTestId('chat-pane-right')).not.toBeInTheDocument();

    const pdf = new File(['%PDF-1.4'], 'lease-agreement.pdf', { type: 'application/pdf' });
    await uploadPdfViaPlusMenu(pdf);

    await waitFor(() => expect(api.uploadPaper).toHaveBeenCalledWith('c1', pdf));
    // Center column renders the PDF, chat moves into the fixed right pane.
    await waitFor(() => {
      expect(screen.getAllByTestId('pdf-page-canvas').length).toBe(2);
    });
    expect(screen.getByTestId('chat-pane-right')).toBeInTheDocument();
  });

  it('restores the three-column view when opening a chat whose tree has a PDF', async () => {
    vi.mocked(api.getTreePaper).mockResolvedValue(paper);
    await openRootChat();

    await waitFor(() => expect(api.getTreePaper).toHaveBeenCalledWith('c1'));
    await waitFor(() => {
      expect(screen.getAllByTestId('pdf-page-canvas').length).toBe(2);
    });
    expect(screen.getByTestId('chat-pane-right')).toBeInTheDocument();
  });

  it('zeigt bei einem zweiten PDF im selben Tree den Neuer-Tree-Dialog (ADR-0002)', async () => {
    vi.mocked(api.getTreePaper).mockResolvedValue(paper);
    vi.mocked(api.uploadPaper).mockRejectedValueOnce(new TreeHasSourceError('c1'));
    await openRootChat();
    await waitFor(() => expect(screen.getByTestId('chat-pane-right')).toBeInTheDocument());

    const second = new File(['%PDF-1.4'], 'other.pdf', { type: 'application/pdf' });
    await uploadPdfViaPlusMenu(second);

    // Rejected with 'tree-has-pdf' → prompt instead of a new paper.
    await waitFor(() => expect(screen.getByTestId('new-tree-prompt')).toBeInTheDocument());
    expect(screen.getByTestId('new-tree-prompt')).toHaveTextContent('other.pdf');

    // Confirming creates a fresh root chat and uploads the held file there.
    const newChat: Chat = { ...rootChat, id: 'c2', title: 'New Chat' };
    vi.mocked(api.createChat).mockResolvedValue(newChat);
    vi.mocked(api.getChat).mockResolvedValue({ ...newChat, messages: [], children: [] });
    fireEvent.click(screen.getByTestId('new-tree-confirm'));

    await waitFor(() => expect(api.createChat).toHaveBeenCalledWith('New Chat'));
    await waitFor(() => expect(api.uploadPaper).toHaveBeenCalledWith('c2', second));
    expect(screen.queryByTestId('new-tree-prompt')).not.toBeInTheDocument();
    await waitFor(() => expect(api.getChat).toHaveBeenCalledWith('c2'));
  });

  it('schließt den Dialog bei Cancel, ohne etwas hochzuladen', async () => {
    vi.mocked(api.getTreePaper).mockResolvedValue(paper);
    vi.mocked(api.uploadPaper).mockRejectedValueOnce(new TreeHasSourceError('c1'));
    await openRootChat();
    await waitFor(() => expect(screen.getByTestId('chat-pane-right')).toBeInTheDocument());

    await uploadPdfViaPlusMenu(new File(['%PDF-1.4'], 'other.pdf', { type: 'application/pdf' }));
    await waitFor(() => expect(screen.getByTestId('new-tree-prompt')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('new-tree-cancel'));
    expect(screen.queryByTestId('new-tree-prompt')).not.toBeInTheDocument();
    expect(api.createChat).not.toHaveBeenCalled();
  });
});

describe('App — Paper-Suche (Slice 07)', () => {
  const searchResult = {
    id: 'W1',
    title: 'Attention Is All You Need',
    authors: ['Vaswani'],
    year: 2017,
    citations: 80000,
    open_access_pdf_url: 'https://arxiv.org/pdf/1706.03762.pdf',
    abstract: null,
    doi: '10.1/attention',
    pdf_candidates: ['https://arxiv.org/pdf/1706.03762.pdf', 'https://mirror.example.org/1706.pdf'],
  };

  async function openSearchModal() {
    await openRootChat();
    fireEvent.click(screen.getByTestId('attach-plus-button'));
    fireEvent.click(screen.getByTestId('attach-menu-research-paper'));
    await waitFor(() => expect(screen.getByTestId('paper-search-modal')).toBeInTheDocument());
  }

  async function searchAndFind() {
    vi.mocked(api.searchPapers).mockResolvedValue({ results: [searchResult], rate_limited: false });
    fireEvent.change(screen.getByTestId('paper-search-input'), { target: { value: 'attention' } });
    fireEvent.click(screen.getByTestId('paper-search-submit'));
    await waitFor(() => expect(screen.getByTestId('paper-search-import-W1')).toBeInTheDocument());
  }

  it('"Research paper" im Plus-Menü öffnet das Such-Modal', async () => {
    await openSearchModal();
    expect(screen.getByText('Add a research paper')).toBeInTheDocument();
  });

  it('Import bindet das Paper an den Tree und öffnet die Drei-Spalten-Ansicht', async () => {
    await openSearchModal();
    await searchAndFind();

    vi.mocked(api.importPaperFromUrl).mockResolvedValue(paper);
    fireEvent.click(screen.getByTestId('paper-search-import-W1'));

    await waitFor(() =>
      expect(api.importPaperFromUrl).toHaveBeenCalledWith(
        'c1',
        'https://arxiv.org/pdf/1706.03762.pdf',
        'Attention Is All You Need',
        ['https://mirror.example.org/1706.pdf'], // primäre URL aus den Fallbacks entfernt
      ),
    );
    await waitFor(() => expect(screen.queryByTestId('paper-search-modal')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('chat-pane-right')).toBeInTheDocument());
    expect(screen.getAllByTestId('pdf-page-canvas').length).toBeGreaterThan(0);
  });

  it('Import in einen Tree mit PDF zeigt den Neuer-Tree-Dialog (ADR-0002)', async () => {
    await openSearchModal();
    await searchAndFind();

    vi.mocked(api.importPaperFromUrl).mockRejectedValueOnce(new TreeHasSourceError('c1'));
    fireEvent.click(screen.getByTestId('paper-search-import-W1'));

    await waitFor(() => expect(screen.getByTestId('new-tree-prompt')).toBeInTheDocument());
    expect(screen.getByTestId('new-tree-prompt')).toHaveTextContent('Attention Is All You Need');

    // Bestätigen: neuer Root-Chat + Import dorthin.
    const newChat: Chat = { ...rootChat, id: 'c2', title: 'New Chat' };
    vi.mocked(api.createChat).mockResolvedValue(newChat);
    vi.mocked(api.getChat).mockResolvedValue({ ...newChat, messages: [], children: [] });
    vi.mocked(api.importPaperFromUrl).mockResolvedValue(paper);
    fireEvent.click(screen.getByTestId('new-tree-confirm'));

    await waitFor(() =>
      expect(api.importPaperFromUrl).toHaveBeenLastCalledWith(
        'c2',
        'https://arxiv.org/pdf/1706.03762.pdf',
        'Attention Is All You Need',
        ['https://mirror.example.org/1706.pdf'],
      ),
    );
  });
});

describe('App — verlassene leere Chats aufräumen (Nutzerkorrektur 2026-07-22)', () => {
  const withMessages: ChatDetail = {
    ...rootChat,
    messages: [
      { id: 'm1', chat_id: 'c1', role: 'user', content: 'Hi', created_at: '2026-07-11T00:01:00Z' },
    ],
    children: [],
  };

  it('löscht einen leeren neuen Chat, wenn man zu einem anderen Chat wegnavigiert', async () => {
    const newChat: Chat = { ...rootChat, id: 'c2', title: 'New Chat' };
    vi.mocked(api.createChat).mockResolvedValue(newChat);
    vi.mocked(api.deleteChat).mockResolvedValue(undefined as never);
    vi.mocked(api.getChat).mockImplementation(async (id: string) =>
      id === 'c2' ? { ...newChat, messages: [], children: [] } : withMessages,
    );

    render(<App />);
    await waitFor(() => expect(screen.getByText('Lease review')).toBeInTheDocument());

    // Neuen Chat anlegen, nichts senden, zurück zum bestehenden Chat.
    fireEvent.click(screen.getByTitle('New Chat'));
    await waitFor(() => expect(api.getChat).toHaveBeenCalledWith('c2'));
    fireEvent.click(screen.getByText('Lease review'));

    await waitFor(() => expect(api.deleteChat).toHaveBeenCalledWith('c2'));
  });

  it('löscht einen Chat mit Nachrichten beim Wegnavigieren NICHT', async () => {
    const emptyChat: Chat = { ...rootChat, id: 'c2', title: 'New Chat' };
    vi.mocked(api.deleteChat).mockResolvedValue(undefined as never);
    vi.mocked(api.getTree).mockResolvedValue([rootChat, emptyChat]);
    vi.mocked(api.getChat).mockImplementation(async (id: string) =>
      id === 'c2' ? { ...emptyChat, messages: [], children: [] } : withMessages,
    );

    render(<App />);
    await waitFor(() => expect(screen.getByText('Lease review')).toBeInTheDocument());

    // Chat MIT Nachrichten öffnen und wegnavigieren → bleibt erhalten.
    // (Nach der Auswahl zeigt die Sidebar die erweiterte Einzelbaum-Ansicht —
    // erst über "All chats" zurück zur Liste, dann den anderen Chat öffnen.)
    fireEvent.click(screen.getByText('Lease review'));
    await waitFor(() => expect(api.getChat).toHaveBeenCalledWith('c1'));
    fireEvent.click(screen.getByText('All chats'));
    fireEvent.click(screen.getByText('New Chat'));
    await waitFor(() => expect(api.getChat).toHaveBeenCalledWith('c2'));

    expect(api.deleteChat).not.toHaveBeenCalled();
  });
});

// ─── YouTube Transcript (ADR-0005) ──────────────────────────────────────────

import type { Video, VideoSearchResult, Message } from '../types';

const videoResult: VideoSearchResult = {
  youtube_id: 'zjkBMFhNj_g',
  title: 'Intro to Large Language Models',
  channel: 'Andrej Karpathy',
  duration: '59:47',
  published: '2 years ago',
  thumbnail_url: null,
  url: 'https://www.youtube.com/watch?v=zjkBMFhNj_g',
};

const boundVideo: Video = {
  id: 'v1',
  youtube_id: 'zjkBMFhNj_g',
  title: 'Intro to Large Language Models',
  channel: 'Andrej Karpathy',
  duration_seconds: 3587,
  language: 'en',
  url: 'https://www.youtube.com/watch?v=zjkBMFhNj_g',
  transcript: '[00:00] Hi everyone.',
};

const sentUser: Message = {
  id: 'u1', chat_id: 'c1', role: 'user',
  content: 'Structure the information in this video.', created_at: '2026-07-23T00:00:00Z',
};
const sentAssistant: Message = {
  id: 'a1', chat_id: 'c1', role: 'assistant',
  content: 'Overview…', created_at: '2026-07-23T00:00:01Z',
};

/** Open the YouTube modal via the plus menu, search, and click Add. */
async function importVideoViaPlusMenu() {
  fireEvent.click(screen.getByTestId('attach-plus-button'));
  fireEvent.click(screen.getByTestId('attach-menu-youtube-transcript'));
  fireEvent.change(screen.getByTestId('youtube-search-input'), {
    target: { value: 'karpathy llm' },
  });
  fireEvent.click(screen.getByTestId('youtube-search-submit'));
  await waitFor(() =>
    expect(screen.getByTestId('youtube-search-import-zjkBMFhNj_g')).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByTestId('youtube-search-import-zjkBMFhNj_g'));
}

describe('App — YouTube transcript import (ADR-0005)', () => {
  beforeEach(() => {
    localStorage.removeItem('syflo.appLanguage');
    vi.mocked(api.searchYouTube).mockResolvedValue([videoResult]);
    vi.mocked(api.importYouTubeVideo).mockResolvedValue(boundVideo);
    vi.mocked(api.sendMessageStream).mockResolvedValue({
      userMessage: sentUser,
      assistantMessage: sentAssistant,
    });
  });

  it('importiert das Video, sendet den Auto-Prompt in der App language (Default Englisch) und zeigt das Banner', async () => {
    await openRootChat();
    await importVideoViaPlusMenu();

    await waitFor(() =>
      expect(api.importYouTubeVideo).toHaveBeenCalledWith('c1', 'zjkBMFhNj_g'),
    );
    // Sichtbarer Auto-Prompt als normale Nachricht — in der App language
    // (ADR-0005, amendiert 2026-07-24), hier der Default Englisch.
    await waitFor(() => expect(api.sendMessageStream).toHaveBeenCalled());
    expect(vi.mocked(api.sendMessageStream).mock.calls[0][0]).toBe('c1');
    expect(vi.mocked(api.sendMessageStream).mock.calls[0][1]).toBe(
      'Structure the information in this video.',
    );
    // Quellen-Banner erscheint über dem Verlauf.
    await waitFor(() => expect(screen.getByTestId('video-banner')).toBeInTheDocument());
    // Modal ist zu.
    expect(screen.queryByTestId('youtube-search-modal')).not.toBeInTheDocument();
  });

  it('sendet den Auto-Prompt auf Deutsch, wenn die App language Deutsch ist — die Untertitel-Spur entscheidet nicht mehr', async () => {
    localStorage.setItem('syflo.appLanguage', 'de');
    // Das Video bleibt englisch — die deutsche Video overview kommt trotzdem,
    // die Spiegel-Regel im Backend folgt dem deutschen Auto-Prompt.
    await openRootChat();
    await importVideoViaPlusMenu();

    await waitFor(() => expect(api.sendMessageStream).toHaveBeenCalled());
    expect(vi.mocked(api.sendMessageStream).mock.calls[0][1]).toBe(
      'Strukturiere die Informationen aus diesem Video.',
    );
  });

  it('zeigt bei einer zweiten Quelle im Baum den Neuer-Tree-Dialog (tree-has-source)', async () => {
    vi.mocked(api.importYouTubeVideo)
      .mockRejectedValueOnce(new TreeHasSourceError('c1'))
      .mockResolvedValue(boundVideo);
    vi.mocked(api.createChat).mockResolvedValue({
      id: 'c9', title: 'New Chat', parent_id: null, parent_word: null,
      created_at: '2026-07-23T00:00:00Z',
    });
    await openRootChat();
    await importVideoViaPlusMenu();

    await waitFor(() => expect(screen.getByTestId('new-tree-prompt')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('new-tree-confirm'));

    // Neuer Baum → Import dorthin, Auto-Prompt in den neuen Chat.
    await waitFor(() => expect(api.importYouTubeVideo).toHaveBeenLastCalledWith('c9', 'zjkBMFhNj_g'));
    await waitFor(() => expect(api.sendMessageStream).toHaveBeenCalled());
    expect(vi.mocked(api.sendMessageStream).mock.calls[0][0]).toBe('c9');
  });
});
