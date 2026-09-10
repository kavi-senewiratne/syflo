/**
 * tests/ModelFlowApp.test.tsx
 *
 * App-level wiring of model flow v3 (design/mockup-model-flow.html):
 * §05 — the SSE failReason is pinned onto the failed message and picks the
 *       honest card; client-detected outages render the network card.
 * §09 — a stream drop mid-answer renders the interrupted row (the backend
 *       persisted *Interrupted*), not a failed row whose retry 409s.
 * §10 — a trailing unanswered question renders the quiet resend row wired
 *       to the non-anchored regenerate; a stop while QUEUED deletes the
 *       pending row persisted at enqueue ("counts as never asked").
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import App, { AUTO_CONTINUE_ERROR_RETRIES } from '../App';
import { StreamFailedError } from '../api';
import { FAILED_MARKER } from '../types';
import type { Chat, ChatDetail, Message, Registry, RegistryModel, Settings } from '../types';

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
  // Mirror of the real class — App's `err instanceof StreamFailedError`
  // must match instances created by tests.
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
    continueMessage: vi.fn(),
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

const rootChat: Chat = {
  id: 'c1',
  title: 'Lease review',
  parent_id: null,
  parent_word: null,
  created_at: '2026-07-26T00:00:00Z',
  children: [],
};
const rootDetail: ChatDetail = { ...rootChat, messages: [], children: [] };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem('syflo.appLanguage');
  vi.mocked(api.getTree).mockResolvedValue([rootChat]);
  vi.mocked(api.getSettings).mockRejectedValue(new Error('none'));
  vi.mocked(api.getChat).mockResolvedValue(rootDetail);
  vi.mocked(api.getTreePaper).mockResolvedValue(null);
  vi.mocked(api.getTreeVideo).mockResolvedValue(null);
  vi.mocked(api.getAncestors).mockResolvedValue([]);
  vi.mocked(api.listMessageHighlights).mockResolvedValue([]);
  vi.mocked(api.deleteMessage).mockResolvedValue(undefined);
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
  // Focus first: without it the window-level Enter fallback fires too
  // (activeElement is <body> in jsdom) and sends the question twice.
  (textarea as HTMLTextAreaElement).focus();
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
}

// ─── §05 · failReason pinned onto the failed message ────────────────────────

describe('App — failReason from the SSE error picks the honest card', () => {
  it('renders the no_key card from a persisted *Failed* marker with failReason', async () => {
    const failedUser: Message = {
      id: 'u1', chat_id: 'c1', role: 'user', content: 'Frage', created_at: '2026-07-26T00:00:01Z',
    };
    const failedAssistant: Message = {
      id: 'a1', chat_id: 'c1', role: 'assistant', content: FAILED_MARKER, created_at: '2026-07-26T00:00:02Z',
    };
    vi.mocked(api.sendMessageStream).mockRejectedValue(
      new StreamFailedError('no key', failedUser, failedAssistant, false, undefined, undefined, {
        failReason: 'no_key', failProvider: 'gemini',
      }),
    );

    await openRootChat();
    await typeAndSend('Frage');

    // Registry not loaded → raw provider name as fallback.
    await waitFor(() =>
      expect(screen.getByTestId('failed-note')).toHaveTextContent(
        'No API key is stored for gemini.',
      ),
    );
    expect(screen.queryByTestId('retry-button')).not.toBeInTheDocument();
  });

  it('renders the network card when the request fails client-side', async () => {
    vi.mocked(api.sendMessageStream).mockRejectedValue(
      new Error('Stream ended without completion'),
    );

    await openRootChat();
    await typeAndSend('Frage');

    await waitFor(() =>
      expect(screen.getByTestId('failed-note')).toHaveTextContent(
        'No connection to the Syflo backend.',
      ),
    );
    expect(screen.getByTestId('retry-button')).toBeEnabled();
  });
});

// ─── Overloaded provider · the waiting is shown, not hidden ────────────────
// design/mockup-truncated-answer.html §03: the backend retries a 503 in place;
// the app must pin the announcement onto the streaming answer, or the user
// stares at silent thinking dots for up to 14 seconds.

describe('App — overloaded provider announces the retry', () => {
  it('shows the overload row while the backend waits, and drops it when text arrives', async () => {
    const startedUser: Message = {
      id: 'u1', chat_id: 'c1', role: 'user', content: 'Frage', created_at: '2026-08-16T00:00:01Z',
    };
    let deliver: (() => void) | undefined;
    vi.mocked(api.sendMessageStream).mockImplementation(
      (_chatId, _content, onDelta, _atts, _onTool, opts) =>
        new Promise((resolve) => {
          opts?.onStarted?.(startedUser);
          opts?.onOverloaded?.({ retryInSeconds: 4, attempt: 1, maxAttempts: 3, provider: 'gemini' });
          deliver = () => { onDelta('Endlich die Antwort.'); resolve(undefined as never); };
        }),
    );

    await openRootChat();
    await typeAndSend('Frage');

    await waitFor(() => expect(screen.getByTestId('overloaded-note')).toBeInTheDocument());
    expect(screen.getByTestId('overloaded-note')).toHaveTextContent(/1 of 3/);

    deliver!();
    await waitFor(() => expect(screen.queryByTestId('overloaded-note')).not.toBeInTheDocument());
  });
});

// ─── Truncated answer · continue writing in place, by itself ───────────────
// design/mockup-truncated-answer.html §01: the continuation grows the answer
// instead of replacing it, so the chapters already parsed survive. Since
// 2026-08-26 (user request) no click is asked for: a cut answer in ANY chat
// continues on its own, and the card is only what is left when the automat
// gives up.

describe('App — continuing an answer the provider cut short', () => {
  const cutDetail: ChatDetail = {
    ...rootChat,
    children: [],
    messages: [
      { id: 'u1', chat_id: 'c1', role: 'user', content: 'Gliedere das Video', created_at: '2026-08-16T00:00:01Z' },
      {
        id: 'a1', chat_id: 'c1', role: 'assistant',
        content: '## Teil eins [0:03 - 5:12]\n\nDie Gewichte entsprechen dem',
        created_at: '2026-08-16T00:00:02Z',
        truncated: 1,
      },
    ],
  };

  it('streams the continuation into the SAME bubble without a click', async () => {
    vi.mocked(api.getChat).mockResolvedValue(cutDetail);
    vi.mocked(api.continueMessage).mockImplementation((_chatId, _messageId, onDelta) => {
      onDelta(' Binärcode.');
      return Promise.resolve({
        userMessage: cutDetail.messages[0],
        assistantMessage: {
          ...cutDetail.messages[1],
          content: '## Teil eins [0:03 - 5:12]\n\nDie Gewichte entsprechen dem Binärcode.',
          truncated: 0,
        },
      });
    });

    await openRootChat();

    await waitFor(() => expect(api.continueMessage).toHaveBeenCalledWith(
      'c1', 'a1', expect.any(Function), expect.anything(),
    ));
    // One answer bubble, now finished — no second bubble starting mid-sentence.
    await waitFor(() => expect(screen.queryByTestId('truncated-note')).not.toBeInTheDocument());
    expect(screen.getByText(/Die Gewichte entsprechen dem Binärcode\./)).toBeInTheDocument();
    expect(api.continueMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps going round after round until the answer is whole', async () => {
    vi.mocked(api.getChat).mockResolvedValue(cutDetail);
    let round = 0;
    let grown = cutDetail.messages[1].content;
    vi.mocked(api.continueMessage).mockImplementation(async () => {
      round += 1;
      grown += ' und weiter';
      const done = round === 3;
      return {
        userMessage: cutDetail.messages[0],
        assistantMessage: { ...cutDetail.messages[1], content: grown, truncated: done ? 0 : 1 },
      };
    });

    await openRootChat();

    await waitFor(() => expect(api.continueMessage).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByTestId('truncated-note')).not.toBeInTheDocument());
  });

  it('hands the decision back with the card once a round appends nothing', async () => {
    // A round that adds no text would repeat forever — one is enough to know.
    vi.mocked(api.getChat).mockResolvedValue(cutDetail);
    vi.mocked(api.continueMessage).mockResolvedValue({
      userMessage: cutDetail.messages[0],
      assistantMessage: { ...cutDetail.messages[1] },
    });

    await openRootChat();

    expect(await screen.findByTestId('truncated-note')).toBeInTheDocument();
    expect(api.continueMessage).toHaveBeenCalledTimes(1);
    // The manual exit still works after the automat gave up.
    fireEvent.click(screen.getByTestId('continue-button'));
    await waitFor(() => expect(api.continueMessage).toHaveBeenCalledTimes(2));
  });

  it('shows the writing cursor in the bubble while a round is running', async () => {
    // User report 2026-08-29 (Waymo overview, eight rounds over 4:50 min): the
    // text grew and the bubble looked idle, so nobody could tell whether the
    // answer was finished. A continuation never reached `streamingMessageIds`
    // — the only thing MessageBubble reads — so neither cursor nor dots ran.
    vi.mocked(api.getChat).mockResolvedValue(cutDetail);
    let release: (() => void) | undefined;
    vi.mocked(api.continueMessage).mockImplementation((_chatId, _messageId, onDelta) =>
      new Promise((resolve) => {
        onDelta(' Binärcode.');
        release = () => resolve({
          userMessage: cutDetail.messages[0],
          assistantMessage: {
            ...cutDetail.messages[1],
            content: '## Teil eins [0:03 - 5:12]\n\nDie Gewichte entsprechen dem Binärcode.',
            truncated: 0,
          },
        });
      }),
    );

    await openRootChat();

    // Mid-round: the answer says it is still being written.
    expect(await screen.findByTestId('streaming-cursor')).toBeInTheDocument();
    release?.();
    // …and stops saying so the moment the round is done.
    await waitFor(() => expect(screen.queryByTestId('streaming-cursor')).not.toBeInTheDocument());
  });

  it('retries an errored round in place before putting the card back', async () => {
    vi.mocked(api.getChat).mockResolvedValue(cutDetail);
    vi.mocked(api.continueMessage).mockRejectedValue(new Error('offline'));

    await openRootChat();

    expect(await screen.findByTestId('truncated-note')).toBeInTheDocument();
    expect(api.continueMessage).toHaveBeenCalledTimes(AUTO_CONTINUE_ERROR_RETRIES);
  });
});

// ─── §09 · connection drop mid-answer → interrupted, not failed ─────────────

describe('App — stream drop mid-answer renders the interrupted row', () => {
  it('shows the interrupted row (backend persisted *Interrupted*), never a 409 loop', async () => {
    const startedUser: Message = {
      id: 'u1', chat_id: 'c1', role: 'user', content: 'Frage', created_at: '2026-07-26T00:00:01Z',
    };
    vi.mocked(api.sendMessageStream).mockImplementation(
      (_chatId, _content, onDelta, _atts, _onTool, opts) =>
        new Promise((_resolve, reject) => {
          opts?.onStarted?.(startedUser);
          onDelta('Die Antwort beginnt…');
          // The connection drops before completion.
          setTimeout(() => reject(new Error('network error')), 0);
        }),
    );

    await openRootChat();
    await typeAndSend('Frage');

    await waitFor(() => expect(screen.getByTestId('interrupted-note')).toBeInTheDocument());
    expect(screen.queryByTestId('failed-note')).not.toBeInTheDocument();
    // The exit: the row carries the retry (§09).
    expect(screen.getByTestId('interrupted-retry-button')).toBeInTheDocument();
  });
});

// ─── §10 · unanswered trailing question → resend row ────────────────────────

describe('App — unanswered trailing question (reload case)', () => {
  const pendingDetail: ChatDetail = {
    ...rootChat,
    children: [],
    messages: [
      { id: 'u-pending', chat_id: 'c1', role: 'user', content: 'Verlorene Frage', created_at: '2026-07-26T00:00:01Z', pending: 1 },
    ],
  };

  it('renders the resend row and wires it to the non-anchored regenerate', async () => {
    vi.mocked(api.getChat).mockResolvedValue(pendingDetail);
    vi.mocked(api.regenerateMessage).mockImplementation(() => new Promise(() => {}));

    await openRootChat();

    const row = await screen.findByTestId('unanswered-note');
    expect(row).toHaveTextContent('Left without an answer.');
    fireEvent.click(screen.getByTestId('resend-button'));

    await waitFor(() => expect(api.regenerateMessage).toHaveBeenCalled());
    // Non-anchored: the backend claims the trailing pending question itself.
    expect(vi.mocked(api.regenerateMessage).mock.calls[0][1]).toBeUndefined();
    // The row disappears while the regenerate runs.
    await waitFor(() => expect(screen.queryByTestId('unanswered-note')).not.toBeInTheDocument());
  });
});

// ─── §10 · stop while queued deletes the pending row ────────────────────────

describe('App — stop while queued cancels the persisted pending question', () => {
  it('DELETEs the trailing pending row matching the aborted question', async () => {
    const pendingDetail: ChatDetail = {
      ...rootChat,
      children: [],
      messages: [
        { id: 'u-pending', chat_id: 'c1', role: 'user', content: 'Wartende Frage', created_at: '2026-07-26T00:00:01Z', pending: 1 },
      ],
    };
    // First getChat: opening the chat (empty). Later getChats (the cancel
    // refetch) see the pending row persisted at enqueue.
    vi.mocked(api.getChat)
      .mockResolvedValueOnce(rootDetail)
      .mockResolvedValue(pendingDetail);
    vi.mocked(api.sendMessageStream).mockImplementation(
      (_chatId, _content, _onDelta, _atts, _onTool, opts) =>
        new Promise((_resolve, reject) => {
          opts?.onQueued?.(0); // waiting — never started
          opts?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );

    await openRootChat();
    await typeAndSend('Wartende Frage');

    fireEvent.click(await screen.findByTestId('stop-button'));

    // The explicit stop "counts as never asked": the pending row persisted
    // at enqueue is deleted via the new DELETE endpoint.
    await waitFor(() =>
      expect(api.deleteMessage).toHaveBeenCalledWith('c1', 'u-pending'),
    );
  });
});

// ─── quota card · "Modell wechseln" pick auto-retries the answer ────────────

describe('App — picking a model via the card\'s "Modell wechseln" auto-retries', () => {
  const regModel = (name: string, label: string): RegistryModel => ({
    name, label, vision: true, canThink: false,
    contextWindowTokens: 128_000, budgetCapTokens: 8_000, free: true, pricing: null,
  });
  const registry: Registry = {
    asOf: '2026-07-01',
    providers: {
      gemini: { label: 'Google Gemini', kind: 'cloud', models: [regModel('gemini-2.5-flash', 'Gemini Flash')] },
      groq: { label: 'Groq', kind: 'cloud', models: [regModel('llama-4-scout', 'Llama 4 Scout')] },
      openai: { label: 'OpenAI', kind: 'cloud', models: [] },
      anthropic: { label: 'Anthropic', kind: 'cloud', models: [] },
      ollama: { kind: 'local', models: [] },
    },
  };
  const cloudSettings: Settings = {
    llm_provider: 'gemini',
    ollama_model: 'qwen3.5:9b',
    gemini_model: 'gemini-2.5-flash',
    groq_model: 'llama-4-scout',
    openai_model: '',
    anthropic_model: '',
    gemini_api_key_set: true,
    groq_api_key_set: true,
    openai_api_key_set: false,
    anthropic_api_key_set: false,
    custom_instructions: '',
    custom_instructions_enabled: false,
    tavily_api_key_set: false,
  };
  const failedUser: Message = {
    id: 'u1', chat_id: 'c1', role: 'user', content: 'Frage', created_at: '2026-07-26T00:00:01Z',
  };
  const failedAssistant: Message = {
    id: 'a1', chat_id: 'c1', role: 'assistant', content: FAILED_MARKER, created_at: '2026-07-26T00:00:02Z',
  };

  beforeEach(() => {
    vi.mocked(api.getSettings).mockResolvedValue(cloudSettings);
    vi.mocked(api.getRegistry).mockResolvedValue(registry);
    vi.mocked(api.updateSettings).mockImplementation(patch =>
      Promise.resolve({ ...cloudSettings, ...patch } as Settings),
    );
    vi.mocked(api.regenerateMessage).mockImplementation(() => new Promise(() => {}));
    vi.mocked(api.sendMessageStream).mockRejectedValue(
      new StreamFailedError('too large', failedUser, failedAssistant, true, undefined, 'too_large'),
    );
  });

  async function failWithTooLarge() {
    await openRootChat();
    await typeAndSend('Frage');
    await screen.findByTestId('switch-model-button');
  }

  it('retries the failed answer right after picking a DIFFERENT model', async () => {
    await failWithTooLarge();
    fireEvent.click(screen.getByTestId('switch-model-button'));
    fireEvent.click(await screen.findByTestId('model-item-llama-4-scout'));

    // The settings write lands BEFORE the regenerate: the retry must run
    // against the newly picked model, never against the exhausted one.
    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({ llm_provider: 'groq', groq_model: 'llama-4-scout' }),
    );
    await waitFor(() => expect(api.regenerateMessage).toHaveBeenCalled());
    // Anchored retry of THIS failed marker.
    expect(vi.mocked(api.regenerateMessage).mock.calls[0][0]).toBe('c1');
    expect(vi.mocked(api.regenerateMessage).mock.calls[0][1]).toBe('a1');
  });

  it('does NOT auto-retry when the pick is the already-active model', async () => {
    await failWithTooLarge();
    fireEvent.click(screen.getByTestId('switch-model-button'));
    fireEvent.click(await screen.findByTestId('model-item-gemini-2.5-flash'));

    // The identical request would fail identically — the card stays and
    // keeps its post-switch enabled retry as the manual escape.
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
    expect(api.regenerateMessage).not.toHaveBeenCalled();
  });

  it('does NOT auto-retry a pick made after dismissing the card\'s menu', async () => {
    await failWithTooLarge();
    fireEvent.click(screen.getByTestId('switch-model-button'));
    await screen.findByTestId('model-menu');
    // Dismiss without picking — the armed retry must be disarmed.
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByTestId('model-menu')).not.toBeInTheDocument());

    // A later, unrelated switch via the composer pill switches only.
    fireEvent.click(screen.getByTestId('model-pill'));
    fireEvent.click(await screen.findByTestId('model-item-llama-4-scout'));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
    expect(api.regenerateMessage).not.toHaveBeenCalled();
  });
});

// ─── Ein 409 heißt "schon fertig", nicht "fehlgeschlagen" ──────────────────
// Gemessen am 2026-09-03: Nach der letzten Fortsetzungsrunde feuerte der
// Automat noch einmal aus einem Render-alten Zustand. Der Server antwortete
// korrekt mit 409 "nothing to continue" — und die Fehlerbehandlung stempelte
// die fertige 27-Kapitel-Übersicht als "bricht mitten im Satz ab".
describe('App — continuation refused with 409', () => {
  const cutDetail: ChatDetail = {
    ...rootChat,
    children: [],
    messages: [
      { id: 'u1', chat_id: 'c1', role: 'user', content: 'Gliedere das Video', created_at: '2026-09-03T00:00:01Z' },
      {
        id: 'a1', chat_id: 'c1', role: 'assistant',
        content: '## Schluss [3:55:27 - 3:57:44]\n\n**Ende.**',
        created_at: '2026-09-03T00:00:02Z',
        truncated: 1,
      },
    ],
  };

  it('keeps the answer whole instead of stamping the cut-off card on it', async () => {
    vi.mocked(api.getChat).mockResolvedValue(cutDetail);
    vi.mocked(api.continueMessage).mockRejectedValue(
      Object.assign(new Error('nothing to continue'), { alreadyComplete: true }),
    );

    await openRootChat();

    await waitFor(() => expect(api.continueMessage).toHaveBeenCalled());
    // No card, and no retry storm on top of it.
    await waitFor(() => expect(screen.queryByTestId('truncated-note')).not.toBeInTheDocument());
    expect(screen.getByText(/Ende\./)).toBeInTheDocument();
  });
});
