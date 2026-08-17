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

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import App from '../App';
import { StreamFailedError, TreeHasSourceError } from '../api';
import { MAX_LAG_SECONDS } from '../streaming/TextSmoother';
import { FAILED_MARKER } from '../types';
import type { Chat, ChatDetail, Paper, Settings } from '../types';

const renderPage = vi.fn().mockResolvedValue(undefined);
vi.mock('../pdf/pdfDocument', () => ({
  loadPdfDocument: vi.fn().mockResolvedValue({
    numPages: 2,
    renderPage: (...args: unknown[]) => renderPage(...args),
    // Page size in PDF points — the view needs it to place citation
    // underlines (design/mockup-paper-reference-links.html).
    getPageSize: async () => ({ width: 612, height: 792 }),
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
  // Mirror of the real class — App's `err instanceof StreamFailedError`
  // must match instances created by tests.
  StreamFailedError: class StreamFailedError extends Error {
    userMessage?: unknown;
    assistantMessage?: unknown;
    quotaExhausted?: boolean;
    constructor(message: string, userMessage?: unknown, assistantMessage?: unknown, quotaExhausted?: boolean) {
      super(message);
      this.name = 'StreamFailedError';
      this.userMessage = userMessage;
      this.assistantMessage = assistantMessage;
      this.quotaExhausted = quotaExhausted;
    }
  },
  api: {
    getTree: vi.fn(),
    getSettings: vi.fn(),
    warmupChat: vi.fn().mockResolvedValue(undefined),
    getOllamaModels: vi.fn().mockResolvedValue([]),
    getOllamaStatus: vi.fn().mockResolvedValue({ reachable: true, models: [] }),
    getQuotaCooldowns: vi.fn().mockResolvedValue([]),
    getUsageSummary: vi.fn().mockResolvedValue({ month: '2026-07', pricesAsOf: '2026-07-30', providers: {}, modelsToday: {} }),
    getRegistry: vi.fn().mockRejectedValue(new Error('none')),
    updateSettings: vi.fn(),
    getChat: vi.fn(),
    getAncestors: vi.fn().mockResolvedValue([]),
    getTreePaper: vi.fn(),
    uploadPaper: vi.fn(),
    createChat: vi.fn(),
    deleteChat: vi.fn().mockResolvedValue(undefined),
    listTranscriptHighlights: vi.fn().mockResolvedValue([]),
    createTranscriptHighlight: vi.fn(),
    updateTranscriptHighlight: vi.fn(),
    deleteTranscriptHighlight: vi.fn(),
    renameChat: vi.fn(),
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
    fireEvent.click(screen.getByLabelText('New Chat'));
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
  content: 'Break the whole video down into its sections — each with a heading, its key point, and the details. Leave nothing out.',
  created_at: '2026-07-23T00:00:00Z',
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

  it('importiert das Video, sendet den Auto-Prompt in der App language (Default Englisch) und zeigt den Player', async () => {
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
      'Break the whole video down into its sections — each with a heading, its key point, and the details. Leave nothing out.',
    );
    // Das Video steht eingebettet in der Mittelspalte — seit 2026-08-15 tritt
    // der Player an die Stelle des schlanken Quellen-Banners
    // (design/mockup-youtube-embed-layout.html, Variante C).
    await waitFor(() => expect(screen.getByTestId('video-pane')).toBeInTheDocument());
    expect(screen.getByTestId('video-player-frame')).toBeInTheDocument();
    expect(screen.queryByTestId('video-banner')).not.toBeInTheDocument();
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
      'Gliedere das ganze Video in seine Abschnitte — je Abschnitt eine Überschrift, die Kernaussage und die Details. Nichts weglassen.',
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

// ─── Geführter Leerzustand (ADR-0008, Grill 12b) ─────────────────────────────
// Aktiver Cloud-Provider ohne hinterlegten Key: die Setup-Karte ersetzt die
// Composer-Zeile, statt still zu blockieren.

describe('App — cloud setup notice (ADR-0008)', () => {
  const geminiNoKey: Settings = {
    llm_provider: 'gemini',
    ollama_model: 'qwen3.5:9b',
    gemini_model: 'gemini-2.5-flash',
    groq_model: 'openai/gpt-oss-120b',
    openai_model: 'gpt-4o-mini',
    anthropic_model: 'claude-sonnet-4-5',
    gemini_api_key_set: false,
    groq_api_key_set: false,
    openai_api_key_set: false,
    anthropic_api_key_set: false,
    custom_instructions: '',
    custom_instructions_enabled: true,
  };

  it('renders the setup notice instead of the composer when gemini has no key', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(geminiNoKey);
    await openRootChat();

    expect(await screen.findByTestId('cloud-setup-notice')).toBeInTheDocument();
    expect(screen.getByTestId('cloud-setup-notice')).toHaveTextContent('Gemini');
    expect(screen.queryByTestId('chat-textarea')).not.toBeInTheDocument();
  });

  it('keeps the composer once the gemini key is set', async () => {
    vi.mocked(api.getSettings).mockResolvedValue({ ...geminiNoKey, gemini_api_key_set: true });
    await openRootChat();

    await waitFor(() => expect(screen.getByTestId('chat-textarea')).toBeInTheDocument());
    expect(screen.queryByTestId('cloud-setup-notice')).not.toBeInTheDocument();
  });
});

// ── Anchored retry (regenerate with messageId): answers stay in place ───────

describe('App — anchored retry of a middle *Failed* marker', () => {
  // Q1, F1(marker), Q2, F2(marker) — the retry of F1 must slot its answer
  // between Q1 and Q2, never at the bottom under the wrong question.
  const T1 = '2026-07-25T10:00:01.000Z';
  const T2 = '2026-07-25T10:00:02.000Z';
  const T3 = '2026-07-25T10:00:03.000Z';
  const T4 = '2026-07-25T10:00:04.000Z';
  const midDetail: ChatDetail = {
    ...rootChat,
    children: [],
    messages: [
      { id: 'q1', chat_id: 'c1', role: 'user', content: 'Question one', created_at: T1 },
      { id: 'f1', chat_id: 'c1', role: 'assistant', content: FAILED_MARKER, created_at: T2 },
      { id: 'q2', chat_id: 'c1', role: 'user', content: 'Question two', created_at: T3 },
      { id: 'f2', chat_id: 'c1', role: 'assistant', content: FAILED_MARKER, created_at: T4 },
    ],
  };

  const rowIds = () =>
    screen.getAllByTestId(/^message-row-/).map(el => el.getAttribute('data-testid'));

  it('replaces the marker in place: Q1, A1(new), Q2, F2 — with the waiting look', async () => {
    vi.mocked(api.getChat).mockResolvedValue(midDetail);
    let finish!: (v: { userMessage: Message; assistantMessage: Message }) => void;
    vi.mocked(api.regenerateMessage).mockImplementation(
      () => new Promise(res => { finish = res; }),
    );

    await openRootChat();
    // Two markers, two retry buttons — click the FIRST (F1, middle of chat).
    fireEvent.click(screen.getAllByTestId('retry-button')[0]);

    // The clicked marker's id travels to the endpoint (anchored retry).
    await waitFor(() => expect(api.regenerateMessage).toHaveBeenCalled());
    expect(vi.mocked(api.regenerateMessage).mock.calls[0][1]).toBe('f1');

    // The loading placeholder takes the marker's SLOT (not the bottom)…
    expect(rowIds()[1]).toMatch(/^message-row-temp-assistant-/);
    expect(rowIds()[3]).toBe('message-row-f2');
    // …and shows the same waiting look as a fresh send: dots + quotes
    // (bug report 2026-07-25: tips were tied to the LAST message).
    expect(document.querySelector('.syflo-typing')).not.toBeNull();
    expect(screen.getByTestId('thinking-tip-line')).toBeInTheDocument();

    // done: the backend delivers the answer with the marker's anchor
    // timestamp — it renders exactly where the marker was.
    finish({
      userMessage: { id: 'q1', chat_id: 'c1', role: 'user', content: 'Question one', created_at: T1 },
      assistantMessage: { id: 'a1-new', chat_id: 'c1', role: 'assistant', content: 'Fresh answer one', created_at: T2 },
    });
    await waitFor(() => expect(screen.getByText('Fresh answer one')).toBeInTheDocument());
    expect(rowIds()).toEqual([
      'message-row-q1',
      'message-row-a1-new',
      'message-row-q2',
      'message-row-f2',
    ]);
  });

  it('keeps a re-failed retry at the same position', async () => {
    vi.mocked(api.getChat).mockResolvedValue(midDetail);
    vi.mocked(api.regenerateMessage).mockRejectedValue(
      new StreamFailedError('boom', undefined, {
        id: 'f1-new', chat_id: 'c1', role: 'assistant', content: FAILED_MARKER, created_at: T2,
      }),
    );

    await openRootChat();
    fireEvent.click(screen.getAllByTestId('retry-button')[0]);

    // The fresh marker (anchor timestamp) replaces the old one in place.
    await waitFor(() => expect(rowIds()[1]).toBe('message-row-f1-new'));
    expect(rowIds()).toEqual([
      'message-row-q1',
      'message-row-f1-new',
      'message-row-q2',
      'message-row-f2',
    ]);
    // Still retryable — the error row keeps its button.
    expect(screen.getAllByTestId('retry-button')).toHaveLength(2);
  });
});

// ── Abort mid-regenerate must free the stream state (live report 2026-07-25):
// Retry F1 → Stop → Retry F2 did nothing.

describe('App — retry after aborting a previous regenerate', () => {
  const T1 = '2026-07-25T12:00:01.000Z';
  const T2 = '2026-07-25T12:00:02.000Z';
  const T3 = '2026-07-25T12:00:03.000Z';
  const T4 = '2026-07-25T12:00:04.000Z';
  const q1: Message = { id: 'q1', chat_id: 'c1', role: 'user', content: 'Question one', created_at: T1 };
  const twoFailures: ChatDetail = {
    ...rootChat,
    children: [],
    messages: [
      q1,
      { id: 'f1', chat_id: 'c1', role: 'assistant', content: FAILED_MARKER, created_at: T2 },
      { id: 'q2', chat_id: 'c1', role: 'user', content: 'Question two', created_at: T3 },
      { id: 'f2', chat_id: 'c1', role: 'assistant', content: FAILED_MARKER, created_at: T4 },
    ],
  };

  const rowIds = () =>
    screen.getAllByTestId(/^message-row-/).map(el => el.getAttribute('data-testid'));

  it('Retry F1 → Stop → Retry F2 starts a fresh regenerate at F2\'s slot', async () => {
    vi.mocked(api.getChat).mockResolvedValue(twoFailures);
    // The mock honors the abort signal like the real fetch/reader does.
    vi.mocked(api.regenerateMessage).mockImplementation(
      (_chatId, _messageId, onDelta, _onToolEvent, opts) =>
        new Promise((_resolve, reject) => {
          opts?.onStarted?.(q1);
          onDelta('partial…');
          opts?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );

    await openRootChat();
    fireEvent.click(screen.getAllByTestId('retry-button')[0]);
    await waitFor(() => expect(api.regenerateMessage).toHaveBeenCalledTimes(1));

    // Streaming: the stop button replaces the send arrow — click it.
    fireEvent.click(await screen.findByTestId('stop-button'));

    // The abort settles: F1's slot shows the *Interrupted* marker and the
    // chat no longer counts as streaming (stop button gone, send is back).
    await waitFor(() => expect(screen.getByTestId('interrupted-note')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByTestId('stop-button')).not.toBeInTheDocument());
    expect(rowIds()[1]).toMatch(/^message-row-temp-assistant-/); // interrupted placeholder in F1's slot

    // Second retry on F2 must start a NEW regenerate…
    fireEvent.click(screen.getByTestId('retry-button'));
    await waitFor(() => expect(api.regenerateMessage).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.regenerateMessage).mock.calls[1][1]).toBe('f2');

    // …with its placeholder in F2's slot (not appended at the bottom).
    expect(rowIds()[3]).toMatch(/^message-row-temp-assistant-/);
  });

  it('an abort while still QUEUED restores the marker under its original id', async () => {
    vi.mocked(api.getChat).mockResolvedValue(twoFailures);
    vi.mocked(api.regenerateMessage).mockImplementation(
      (_chatId, _messageId, _onDelta, _onToolEvent, opts) =>
        new Promise((_resolve, reject) => {
          opts?.onQueued?.(1); // waiting in the FIFO queue — never started
          opts?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );

    await openRootChat();
    fireEvent.click(screen.getAllByTestId('retry-button')[0]);
    await waitFor(() => expect(api.regenerateMessage).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByTestId('stop-button'));

    // The marker comes back in place under its REAL id (the backend still
    // has it — the job never started), so it stays retryable.
    await waitFor(() => expect(screen.getAllByTestId('retry-button')).toHaveLength(2));
    expect(rowIds()[1]).toBe('message-row-f1');

    // …and the next retry sends the real id again, not a temp one.
    fireEvent.click(screen.getAllByTestId('retry-button')[0]);
    await waitFor(() => expect(api.regenerateMessage).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.regenerateMessage).mock.calls[1][1]).toBe('f1');
  });
});

// ── Anchored retry of the LAST marker (live regression report 2026-07-25):
// the question above the marker vanished. Q1,F1 with F1 as the last message.

describe('App — anchored retry of the LAST *Failed* marker keeps the question', () => {
  const T1 = '2026-07-25T11:00:01.000Z';
  const T2 = '2026-07-25T11:00:02.000Z';
  const q1: Message = { id: 'q1', chat_id: 'c1', role: 'user', content: 'Only question', created_at: T1 };
  const f1: Message = { id: 'f1', chat_id: 'c1', role: 'assistant', content: FAILED_MARKER, created_at: T2 };
  const lastDetail: ChatDetail = { ...rootChat, children: [], messages: [q1, f1] };

  const rowIds = () =>
    screen.getAllByTestId(/^message-row-/).map(el => el.getAttribute('data-testid'));

  it('keeps Q1 while streaming and shows Q1 + the new answer after done', async () => {
    vi.mocked(api.getChat).mockResolvedValue(lastDetail);
    let finish!: (v: { userMessage: Message; assistantMessage: Message }) => void;
    let handlers!: { onStarted?: (m: Message) => void };
    vi.mocked(api.regenerateMessage).mockImplementation(
      (_chatId, _messageId, _onDelta, _onToolEvent, opts) => {
        handlers = opts ?? {};
        return new Promise(res => { finish = res; });
      },
    );

    await openRootChat();
    fireEvent.click(screen.getByTestId('retry-button'));

    // Question stays, placeholder takes the marker's slot.
    await waitFor(() => expect(api.regenerateMessage).toHaveBeenCalled());
    expect(screen.getByText('Only question')).toBeInTheDocument();
    expect(rowIds()[0]).toBe('message-row-q1');
    expect(rowIds()[1]).toMatch(/^message-row-temp-assistant-/);

    // started delivers the EXISTING user message — that must not remove or
    // duplicate the question.
    handlers.onStarted?.(q1);
    expect(screen.getByText('Only question')).toBeInTheDocument();
    expect(rowIds()).toHaveLength(2);

    finish({
      userMessage: q1,
      assistantMessage: { id: 'a1-new', chat_id: 'c1', role: 'assistant', content: 'Recovered answer', created_at: T2 },
    });
    await waitFor(() => expect(screen.getByText('Recovered answer')).toBeInTheDocument());
    expect(screen.getByText('Only question')).toBeInTheDocument();
    expect(rowIds()).toEqual(['message-row-q1', 'message-row-a1-new']);
  });

  it('keeps Q1 when the retry fails AGAIN and the error payload carries the userMessage', async () => {
    vi.mocked(api.getChat).mockResolvedValue(lastDetail);
    // The real backend puts BOTH persisted messages into the error payload —
    // the regression: the UI dropped the question and never re-added it.
    vi.mocked(api.regenerateMessage).mockRejectedValue(
      new StreamFailedError('still rate limited', q1, {
        id: 'f1-new', chat_id: 'c1', role: 'assistant', content: FAILED_MARKER, created_at: T2,
      }),
    );

    await openRootChat();
    fireEvent.click(screen.getByTestId('retry-button'));

    await waitFor(() => expect(rowIds()).toContain('message-row-f1-new'));
    // The question MUST survive the re-fail.
    expect(screen.getByText('Only question')).toBeInTheDocument();
    expect(rowIds()).toEqual(['message-row-q1', 'message-row-f1-new']);
    expect(screen.getByTestId('retry-button')).toBeInTheDocument();
  });

  it('quota exhausted: the local-model button regenerates THIS answer via ollama', async () => {
    // An installed local model gates the emergency button.
    vi.mocked(api.getOllamaModels).mockResolvedValue([{ name: 'qwen3.5:9b', canThink: true }]);
    vi.mocked(api.getOllamaStatus).mockResolvedValue({ reachable: true, models: [{ name: 'qwen3.5:9b', canThink: true }] });
    vi.mocked(api.getChat).mockResolvedValue(lastDetail);
    vi.mocked(api.regenerateMessage)
      .mockImplementation(() => new Promise(() => {}))
      // First retry: the failover exhausted ALL candidates.
      .mockRejectedValueOnce(new StreamFailedError('all quotas exhausted', q1, {
        id: 'f1-new', chat_id: 'c1', role: 'assistant', content: FAILED_MARKER, created_at: T2,
      }, true));

    await openRootChat();
    fireEvent.click(screen.getByTestId('retry-button'));

    // The persisted marker carries the transient flag → announcement + button.
    const localButton = await screen.findByTestId('retry-local-button');
    expect(screen.getByTestId('failed-note')).toHaveTextContent(
      'All cloud quotas are used up for now.',
    );

    fireEvent.click(localButton);
    await waitFor(() => expect(api.regenerateMessage).toHaveBeenCalledTimes(2));
    const call = vi.mocked(api.regenerateMessage).mock.calls[1];
    expect(call[1]).toBe('f1-new'); // anchored to the clicked marker
    expect(call[4]).toMatchObject({ provider: 'ollama' });
  });

  it('keeps Q1 on a reload mid-stream (GET returns the question, stream re-attaches)', async () => {
    vi.mocked(api.getChat).mockResolvedValue(lastDetail);
    vi.mocked(api.regenerateMessage).mockImplementation(() => new Promise(() => {}));

    await openRootChat();
    fireEvent.click(screen.getByTestId('retry-button'));
    await waitFor(() => expect(api.regenerateMessage).toHaveBeenCalled());

    // Re-select the chat mid-stream: the marker is already deleted
    // server-side, GET delivers only the question. ('Lease review' also
    // appears in the chat header — click the sidebar entry.)
    vi.mocked(api.getChat).mockResolvedValue({ ...rootChat, children: [], messages: [q1] });
    fireEvent.click(screen.getAllByText('Lease review')[0]);
    await waitFor(() => expect(api.getChat).toHaveBeenCalledTimes(2));

    await waitFor(() => expect(screen.getByText('Only question')).toBeInTheDocument());
    expect(rowIds()[0]).toBe('message-row-q1');
    expect(rowIds()[1]).toMatch(/^message-row-temp-assistant-/);
    expect(rowIds()).toHaveLength(2);
  });
});

// ── Smooth text reveal (TextSmoother): big bursts must not "pop" in ─────────

describe('App — smooth reveal of streamed text', () => {
  const geminiWithKey: Settings = {
    llm_provider: 'gemini',
    ollama_model: 'qwen3.5:9b',
    gemini_model: 'gemini-2.5-flash',
    groq_model: 'openai/gpt-oss-120b',
    openai_model: 'gpt-4o-mini',
    anthropic_model: 'claude-sonnet-4-5',
    gemini_api_key_set: true,
    groq_api_key_set: false,
    openai_api_key_set: false,
    anthropic_api_key_set: false,
    custom_instructions: '',
    custom_instructions_enabled: true,
  };

  it('does not show a huge delta burst at once, but shows everything after done', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(geminiWithKey);
    const burst = 'A'.repeat(3000) + ' ENDMARKER';
    let finish!: (v: { userMessage: Message; assistantMessage: Message }) => void;
    vi.mocked(api.sendMessageStream).mockImplementation(
      (_chatId, _content, onDelta) => {
        // A >1000 tok/s cloud model: one giant delta in a single event.
        onDelta(burst);
        return new Promise(res => { finish = res; });
      },
    );

    await openRootChat();
    const textarea = screen.getByTestId('chat-textarea');
    textarea.focus();
    fireEvent.change(textarea, { target: { value: 'Question' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    await waitFor(() => expect(api.sendMessageStream).toHaveBeenCalled());

    // Right after the burst the end of the text must NOT be visible yet —
    // the smoother reveals it gradually instead of popping it in.
    expect(screen.queryByText(/ENDMARKER/)).not.toBeInTheDocument();

    // done: the drain keeps the paced rate (no instant flush — that would
    // bypass the smoothing exactly for the fastest models), so the tail
    // appears within the maxLag horizon, not immediately.
    const now = new Date().toISOString();
    finish({
      userMessage: { id: 'u-real', chat_id: 'c1', role: 'user', content: 'Question', created_at: now },
      assistantMessage: { id: 'a-real', chat_id: 'c1', role: 'assistant', content: burst, created_at: now },
    });
    expect(screen.queryByText(/ENDMARKER/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/ENDMARKER/)).toBeInTheDocument(), {
      timeout: (MAX_LAG_SECONDS + 2) * 1000,
    });
  });
});

// ── Failover note (ADR-0008): SSE `failover` event → quiet note that stays ──

describe('App — provider failover note (ADR-0008)', () => {
  const geminiWithKey: Settings = {
    llm_provider: 'gemini',
    ollama_model: 'qwen3.5:9b',
    gemini_model: 'gemini-2.5-flash',
    groq_model: 'openai/gpt-oss-120b',
    openai_model: 'gpt-4o-mini',
    anthropic_model: 'claude-sonnet-4-5',
    gemini_api_key_set: true,
    groq_api_key_set: true,
    openai_api_key_set: false,
    anthropic_api_key_set: false,
    custom_instructions: '',
    custom_instructions_enabled: true,
  };

  it('shows the note during streaming and keeps it after done', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(geminiWithKey);
    let finish!: (v: { userMessage: Message; assistantMessage: Message }) => void;
    vi.mocked(api.sendMessageStream).mockImplementation(
      (_chatId, _content, onDelta, _attachments, _onToolEvent, opts) => {
        // Backend: limit hit on gemini → groq steps in for this answer.
        opts?.onFailover?.({
          from: 'gemini', fromModel: 'gemini-2.5-flash', to: 'groq',
          model: 'openai/gpt-oss-120b', reason: 'daily',
        });
        onDelta('Answer via groq');
        return new Promise(res => { finish = res; });
      },
    );

    await openRootChat();
    const textarea = screen.getByTestId('chat-textarea');
    // Focus first: the global Enter-to-send listener defers to focused
    // inputs — without focus, jsdom would trigger both send paths.
    textarea.focus();
    fireEvent.change(textarea, { target: { value: 'Question' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    // During streaming: note with both resolved labels + the model name.
    expect(await screen.findByTestId('failover-note')).toHaveTextContent(
      'Quota reached on Gemini — this answer comes from Groq (openai/gpt-oss-120b).',
    );

    // Finish the stream — the note must NOT retroactively vanish from the
    // answer (it explains who the answer came from; transient until reload).
    const now = new Date().toISOString();
    finish({
      userMessage: { id: 'u-real', chat_id: 'c1', role: 'user', content: 'Question', created_at: now },
      assistantMessage: { id: 'a-real', chat_id: 'c1', role: 'assistant', content: 'Answer via groq', created_at: now },
    });
    await waitFor(() => expect(screen.getByText('Answer via groq')).toBeInTheDocument());
    expect(screen.getByTestId('failover-note')).toBeInTheDocument();
  });
});

describe('App — header title follows the auto-generated title (live incident 2026-07-26)', () => {
  // After the first answer the backend auto-titles the chat. refreshTree()
  // updates the sidebar — but the header reads activeChat.title, which must
  // be synced from the fresh tree too, or it keeps showing the stale title.
  it('updates the chat header once refreshTree returns the renamed chat', async () => {
    vi.mocked(api.sendMessageStream).mockResolvedValue({
      userMessage: sentUser,
      assistantMessage: sentAssistant,
    });

    await openRootChat();
    const header = screen.getByTestId('chat-header-shell');
    expect(within(header).getByText('Lease review')).toBeInTheDocument();

    // The tree the post-send refresh fetches carries the new auto-title.
    const renamed = { ...rootChat, title: 'US Professoren für Weltmodelle' };
    vi.mocked(api.getTree).mockResolvedValue([renamed]);

    fireEvent.change(screen.getByTestId('chat-textarea'), { target: { value: 'Wer forscht an Weltmodellen?' } });
    fireEvent.keyDown(screen.getByTestId('chat-textarea'), { key: 'Enter' });

    await waitFor(() =>
      expect(within(screen.getByTestId('chat-header-shell')).getByText('US Professoren für Weltmodelle')).toBeInTheDocument(),
    );
  });
});

// ─── Deleting a branch while the mind map is open ───────────────────────────
//
// User report 2026-08-08: deleting a branch threw the user out of the mind map
// back to the empty start screen. The view must stay put and the selection
// must move to the parent node so the deletion is visible as a node vanishing.

describe('App — delete a branch from the mind map view', () => {
  const branch: Chat = {
    id: 'c2',
    title: 'Rent clause',
    parent_id: 'c1',
    parent_word: 'rent',
    created_at: '2026-07-11T00:02:00Z',
    children: [],
  };
  const rootWithBranch: Chat = { ...rootChat, children: [branch] };

  beforeEach(() => {
    vi.mocked(api.getTree).mockResolvedValue([rootWithBranch]);
    vi.mocked(api.getChat).mockImplementation(async (id: string) =>
      id === 'c2'
        ? { ...branch, messages: [], children: [] }
        : { ...rootWithBranch, messages: [], children: [branch] },
    );
    vi.mocked(api.deleteChat).mockResolvedValue(undefined as never);
  });

  // Both the sidebar and the mind map render a chat's title, so every query
  // for a row is scoped to the sidebar.
  const sidebar = () => within(document.querySelector('.syflo-sidebar') as HTMLElement);

  /** Open the branch chat, then switch the main column to the mind map. */
  async function openBranchInMindMap() {
    render(<App />);
    await waitFor(() => expect(sidebar().getByText('Lease review')).toBeInTheDocument());
    fireEvent.click(sidebar().getByText('Lease review'));
    await waitFor(() => expect(sidebar().getByText('Rent clause')).toBeInTheDocument());
    fireEvent.click(sidebar().getByText('Rent clause'));
    await waitFor(() => expect(api.getChat).toHaveBeenCalledWith('c2'));
    fireEvent.click(screen.getByLabelText('Switch to Mind Map'));
    await waitFor(() => expect(screen.getByTestId('mindmap-pane-resizer')).toBeInTheDocument());
  }

  /** Right-click a sidebar row and confirm the delete modal. */
  async function deleteViaContextMenu(title: string) {
    fireEvent.contextMenu(sidebar().getByText(title));
    fireEvent.click(await screen.findByText('Delete'));
    fireEvent.click(await screen.findByTestId('confirm-delete-chat'));
  }

  it('stays in the mind map and selects the parent node', async () => {
    await openBranchInMindMap();

    // The tree the post-delete refresh returns no longer has the branch.
    vi.mocked(api.getTree).mockResolvedValue([{ ...rootChat, children: [] }]);
    await deleteViaContextMenu('Rent clause');

    await waitFor(() => expect(api.deleteChat).toHaveBeenCalledWith('c2'));
    // Selection moved up to the parent…
    await waitFor(() => expect(api.getChat).toHaveBeenLastCalledWith('c1'));
    // …and the mind map is still the view the user is looking at.
    expect(screen.getByTestId('mindmap-pane-resizer')).toBeInTheDocument();
    // The deleted node is gone from the map/sidebar.
    await waitFor(() => expect(sidebar().queryByText('Rent clause')).not.toBeInTheDocument());
  });

  it('falls back to chat view when the whole tree is deleted', async () => {
    await openBranchInMindMap();

    vi.mocked(api.getTree).mockResolvedValue([]);
    // Deleting the root takes its branches with it — nothing left to show.
    fireEvent.click(sidebar().getByText('All chats'));
    await deleteViaContextMenu('Lease review');

    await waitFor(() => expect(api.deleteChat).toHaveBeenCalledWith('c1'));
    await waitFor(() => expect(screen.queryByTestId('mindmap-pane-resizer')).not.toBeInTheDocument());
  });
});
