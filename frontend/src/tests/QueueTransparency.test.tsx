/**
 * tests/QueueTransparency.test.tsx
 *
 * Queue transparency + reason-true failover notes (design/mockup-model-flow.html):
 * §07 — the queued note gains a neutral model chip naming the local model
 *       that will answer this waiting question; when the queue is answering
 *       ANOTHER chat right now, the waiting text becomes a link that jumps
 *       there (tooltip previews the current question).
 * §11 — the failover note tells the TRUE reason (no_vision /
 *       model_unavailable instead of always claiming "Quota reached"), and
 *       multi-hop failovers keep naming the ORIGINAL model the user chose.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageBubble } from '../components/ChatArea/MessageBubble';
import App from '../App';
import type { Chat, ChatDetail, Message } from '../types';

vi.mock('../pdf/pdfDocument', () => ({
  loadPdfDocument: vi.fn().mockResolvedValue({ numPages: 1, renderPage: vi.fn() }),
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
  StreamFailedError: class StreamFailedError extends Error {
    userMessage?: unknown;
    assistantMessage?: unknown;
    quotaExhausted?: boolean;
    retryAt?: string;
    quotaReason?: string;
    failReason?: string;
    failProvider?: string;
    failModel?: string;
    constructor(
      message: string,
      userMessage?: unknown,
      assistantMessage?: unknown,
      quotaExhausted?: boolean,
      retryAt?: string,
      quotaReason?: string,
      fail?: { failReason?: string; failProvider?: string; failModel?: string },
    ) {
      super(message);
      this.name = 'StreamFailedError';
      this.userMessage = userMessage;
      this.assistantMessage = assistantMessage;
      this.quotaExhausted = quotaExhausted;
      this.retryAt = retryAt;
      this.quotaReason = quotaReason;
      this.failReason = fail?.failReason;
      this.failProvider = fail?.failProvider;
      this.failModel = fail?.failModel;
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
    getTreePaper: vi.fn().mockResolvedValue(null),
    getTreeVideo: vi.fn().mockResolvedValue(null),
    uploadPaper: vi.fn(),
    createChat: vi.fn(),
    deleteChat: vi.fn(),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    renameChat: vi.fn(),
    sendMessageStream: vi.fn(),
    regenerateMessage: vi.fn(),
    explainWord: vi.fn(),
    listHighlights: vi.fn().mockResolvedValue([]),
    listMessageHighlights: vi.fn().mockResolvedValue([]),
    createMessageHighlight: vi.fn(),
    updateMessageHighlight: vi.fn(),
    deleteMessageHighlight: vi.fn(),
    createHighlight: vi.fn(),
    updateHighlight: vi.fn(),
    deleteHighlight: vi.fn(),
    getHighlightLabels: vi.fn().mockResolvedValue({
      yellow: 'Important', green: 'Agree', blue: 'Reference', pink: 'Question', orange: 'Disagree',
    }),
    setHighlightLabel: vi.fn(),
    searchPapers: vi.fn(),
    importPaperFromUrl: vi.fn(),
    searchYouTube: vi.fn(),
    importYouTubeVideo: vi.fn(),
  },
}));

import { api } from '../api';

// ─── MessageBubble · §07 queued model chip ───────────────────────────────────

const queuedBase: Message = {
  id: 'a-queued',
  chat_id: 'c1',
  role: 'assistant',
  content: '',
  created_at: '2026-07-26T00:00:02.000Z',
  queuedAhead: 1,
};

describe('MessageBubble — queued model chip (§07)', () => {
  beforeEach(() => localStorage.removeItem('syflo.appLanguage'));

  it('renders a neutral Cpu chip naming the model that will answer', () => {
    render(
      <MessageBubble
        message={{ ...queuedBase, queuedModel: 'qwen3.5:9b' }}
        isStreaming
        onWordRightClick={vi.fn()}
      />,
    );
    const chip = screen.getByTestId('queued-model-chip');
    expect(chip).toHaveTextContent('qwen3.5:9b');
    // Neutral pill like the picker badges, but gray (theme tokens only).
    expect(chip.className).toContain('rounded-full');
    expect(chip.className).toContain('bg-gray-100');
    expect(chip.className).toContain('text-gray-500');
  });

  it('omits the chip when the queued event named no model', () => {
    render(<MessageBubble message={queuedBase} isStreaming onWordRightClick={vi.fn()} />);
    expect(screen.getByTestId('queued-note')).toBeInTheDocument();
    expect(screen.queryByTestId('queued-model-chip')).not.toBeInTheDocument();
  });
});

// ─── MessageBubble · clickable ahead-link (user request 2026-07-26) ──────────

describe('MessageBubble — clickable ahead-link to the chat being answered', () => {
  beforeEach(() => localStorage.removeItem('syflo.appLanguage'));

  it('turns the waiting text into a button with the current-question tooltip and navigates on click', () => {
    const onOpenChat = vi.fn();
    render(
      <MessageBubble
        message={{ ...queuedBase, queuedCurrent: { chatId: 'c2', question: 'Warum LoRA?' } }}
        isStreaming
        onWordRightClick={vi.fn()}
        onOpenChat={onOpenChat}
      />,
    );
    const link = screen.getByTestId('queued-ahead-link');
    expect(link).toHaveTextContent('Waiting — 1 request ahead');
    expect(link).toHaveAttribute('title', 'Now answering: “Warum LoRA?…”');
    fireEvent.click(link);
    expect(onOpenChat).toHaveBeenCalledWith('c2');
  });

  it('shows the German tooltip under app language DE', () => {
    localStorage.setItem('syflo.appLanguage', 'de');
    render(
      <MessageBubble
        message={{ ...queuedBase, queuedCurrent: { chatId: 'c2', question: 'Warum LoRA?' } }}
        isStreaming
        onWordRightClick={vi.fn()}
        onOpenChat={vi.fn()}
      />,
    );
    expect(screen.getByTestId('queued-ahead-link')).toHaveAttribute(
      'title',
      'Gerade dran: „Warum LoRA?…“',
    );
  });

  it('stays plain text when the current question belongs to THIS chat', () => {
    render(
      <MessageBubble
        message={{ ...queuedBase, queuedCurrent: { chatId: 'c1', question: 'Eigene Frage' } }}
        isStreaming
        onWordRightClick={vi.fn()}
        onOpenChat={vi.fn()}
      />,
    );
    expect(screen.getByTestId('queued-note')).toHaveTextContent('Waiting — 1 request ahead');
    expect(screen.queryByTestId('queued-ahead-link')).not.toBeInTheDocument();
  });

  it('stays plain text when the queued event carried no current question', () => {
    render(
      <MessageBubble message={queuedBase} isStreaming onWordRightClick={vi.fn()} onOpenChat={vi.fn()} />,
    );
    expect(screen.getByTestId('queued-note')).toHaveTextContent('Waiting — 1 request ahead');
    expect(screen.queryByTestId('queued-ahead-link')).not.toBeInTheDocument();
  });
});

// ─── MessageBubble · §11 reason-true failover notes ──────────────────────────

describe('MessageBubble — reason-true failover notes (§11)', () => {
  beforeEach(() => localStorage.removeItem('syflo.appLanguage'));

  const answered: Message = {
    id: 'a-failover',
    chat_id: 'c1',
    role: 'assistant',
    content: 'Answer…',
    created_at: '2026-07-26T00:00:04.000Z',
  };
  const labels = {
    'openai/gpt-oss-120b': 'gpt-oss 120B',
    'llama-3.3-70b-versatile': 'Llama 3.3 70B',
    'gemini-2.5-flash': 'Gemini Flash',
  };

  it("no_vision, same provider: 'X can't read images' with model names", () => {
    render(
      <MessageBubble
        message={{
          ...answered,
          failover: {
            from: 'groq', fromModel: 'openai/gpt-oss-120b',
            to: 'groq', model: 'llama-3.3-70b-versatile', reason: 'no_vision',
          },
        }}
        onWordRightClick={vi.fn()}
        modelLabels={labels}
      />,
    );
    expect(screen.getByTestId('failover-note')).toHaveTextContent(
      "gpt-oss 120B can't read images — this answer comes from Llama 3.3 70B.",
    );
  });

  it('no_vision, cross provider: provider labels + model', () => {
    render(
      <MessageBubble
        message={{
          ...answered,
          failover: {
            from: 'groq', fromModel: 'openai/gpt-oss-120b',
            to: 'gemini', model: 'gemini-2.5-flash', reason: 'no_vision',
          },
        }}
        onWordRightClick={vi.fn()}
        modelLabels={labels}
      />,
    );
    expect(screen.getByTestId('failover-note')).toHaveTextContent(
      "Groq can't read images — this answer comes from Gemini (Gemini Flash).",
    );
  });

  it("model_unavailable, same provider: 'X is no longer available'", () => {
    render(
      <MessageBubble
        message={{
          ...answered,
          failover: {
            from: 'gemini', fromModel: 'gemini-2.5-pro',
            to: 'gemini', model: 'gemini-2.5-flash', reason: 'model_unavailable',
          },
        }}
        onWordRightClick={vi.fn()}
        modelLabels={{ ...labels, 'gemini-2.5-pro': 'Gemini Pro' }}
      />,
    );
    expect(screen.getByTestId('failover-note')).toHaveTextContent(
      'Gemini Pro is no longer available — this answer comes from Gemini Flash.',
    );
  });

  it('quota reasons keep the existing wording (cooldown shares it)', () => {
    render(
      <MessageBubble
        message={{
          ...answered,
          failover: {
            from: 'groq', fromModel: 'openai/gpt-oss-120b',
            to: 'groq', model: 'llama-3.3-70b-versatile', reason: 'cooldown',
          },
        }}
        onWordRightClick={vi.fn()}
        modelLabels={labels}
      />,
    );
    expect(screen.getByTestId('failover-note')).toHaveTextContent(
      'Quota reached on gpt-oss 120B — this answer comes from Llama 3.3 70B.',
    );
  });

  it('shows the German no_vision note under app language DE', () => {
    localStorage.setItem('syflo.appLanguage', 'de');
    render(
      <MessageBubble
        message={{
          ...answered,
          failover: {
            from: 'groq', fromModel: 'openai/gpt-oss-120b',
            to: 'groq', model: 'llama-3.3-70b-versatile', reason: 'no_vision',
          },
        }}
        onWordRightClick={vi.fn()}
        modelLabels={labels}
      />,
    );
    expect(screen.getByTestId('failover-note')).toHaveTextContent(
      'gpt-oss 120B kann keine Bilder lesen — diese Antwort kommt von Llama 3.3 70B.',
    );
  });
});

// ─── App level · queued patch, navigation click, multi-hop failover ─────────

const rootChat: Chat = {
  id: 'c1',
  title: 'Lease review',
  parent_id: null,
  parent_word: null,
  created_at: '2026-07-26T00:00:00Z',
  children: [],
};
const otherChat: Chat = {
  id: 'c2',
  title: 'Other paper',
  parent_id: null,
  parent_word: null,
  created_at: '2026-07-26T00:00:00Z',
  children: [],
};
const rootDetail: ChatDetail = { ...rootChat, messages: [], children: [] };
const otherDetail: ChatDetail = { ...otherChat, messages: [], children: [] };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem('syflo.appLanguage');
  vi.mocked(api.getTree).mockResolvedValue([rootChat, otherChat]);
  vi.mocked(api.getSettings).mockRejectedValue(new Error('none'));
  vi.mocked(api.getChat).mockImplementation(async (id: string) =>
    id === 'c2' ? otherDetail : rootDetail,
  );
  vi.mocked(api.getTreePaper).mockResolvedValue(null);
  vi.mocked(api.getTreeVideo).mockResolvedValue(null);
  vi.mocked(api.getAncestors).mockResolvedValue([]);
  vi.mocked(api.listMessageHighlights).mockResolvedValue([]);
  vi.mocked(api.warmupChat).mockResolvedValue({ warmed: false });
});

async function openRootChat() {
  render(<App />);
  await waitFor(() => expect(screen.getByText('Lease review')).toBeInTheDocument());
  fireEvent.click(screen.getByText('Lease review'));
  await waitFor(() => expect(api.getChat).toHaveBeenCalledWith('c1'));
}

async function typeAndSend(text: string) {
  const textarea = await screen.findByTestId('chat-textarea');
  (textarea as HTMLTextAreaElement).focus();
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
}

describe('App — queued event patches model chip + ahead-link (§07)', () => {
  it('shows the chip and navigates to the chat being answered on click', async () => {
    vi.mocked(api.sendMessageStream).mockImplementation(
      (_chatId, _content, _onDelta, _atts, _onTool, opts) =>
        new Promise(() => {
          opts?.onQueued?.(1, {
            model: 'qwen3.5:9b',
            current: { chatId: 'c2', question: 'Warum LoRA statt Full-Finetuning?' },
          });
        }),
    );

    await openRootChat();
    await typeAndSend('Meine Frage');

    const chip = await screen.findByTestId('queued-model-chip');
    expect(chip).toHaveTextContent('qwen3.5:9b');

    const link = screen.getByTestId('queued-ahead-link');
    expect(link).toHaveAttribute(
      'title',
      'Now answering: “Warum LoRA statt Full-Finetuning?…”',
    );
    fireEvent.click(link);
    await waitFor(() => expect(api.getChat).toHaveBeenCalledWith('c2'));
  });

  it('renders plain text when the current question is in the SAME chat', async () => {
    vi.mocked(api.sendMessageStream).mockImplementation(
      (_chatId, _content, _onDelta, _atts, _onTool, opts) =>
        new Promise(() => {
          opts?.onQueued?.(1, {
            model: 'qwen3.5:9b',
            current: { chatId: 'c1', question: 'Vorherige Frage' },
          });
        }),
    );

    await openRootChat();
    await typeAndSend('Meine Frage');

    await screen.findByTestId('queued-note');
    expect(screen.queryByTestId('queued-ahead-link')).not.toBeInTheDocument();
  });
});

describe('App — multi-hop failover keeps the ORIGINAL from/fromModel (§11)', () => {
  it('names the model the user chose, not the last intermediate hop', async () => {
    vi.mocked(api.sendMessageStream).mockImplementation(
      (_chatId, _content, onDelta, _atts, _onTool, opts) =>
        new Promise(() => {
          // Hop 1: gemini → groq (quota), hop 2: groq → groq sibling (cooldown).
          opts?.onFailover?.({
            from: 'gemini', fromModel: 'gemini-2.5-flash',
            to: 'groq', model: 'openai/gpt-oss-120b', reason: 'daily',
          });
          opts?.onFailover?.({
            from: 'groq', fromModel: 'openai/gpt-oss-120b',
            to: 'groq', model: 'llama-3.3-70b-versatile', reason: 'cooldown',
          });
          onDelta('Answer via the last hop');
        }),
    );

    await openRootChat();
    await typeAndSend('Frage');

    // The note names the ORIGINAL provider (gemini), destination + model of
    // the LAST hop — never "Quota reached on groq" (audit finding).
    expect(await screen.findByTestId('failover-note')).toHaveTextContent(
      'Quota reached on Gemini — this answer comes from Groq (llama-3.3-70b-versatile).',
    );
  });
});
