/**
 * tests/FailedRetryQueue.test.tsx
 *
 * Fehlerzeile + Sende-Warteschlange (2026-07-24): Fehlgeschlagene Antworten
 * verschwinden nicht mehr stumm — der '*Failed*'-Marker rendert eine dezente
 * Fehlerzeile mit "Erneut versuchen". Wartende Fragen zeigen ihren Platz in
 * der Backend-Warteschlange (FIFO, ein Ollama-Slot) statt der Denk-Punkte,
 * die Sidebar eine kleine Uhr statt der animierten Punkte.
 */

import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MessageBubble } from '../components/ChatArea/MessageBubble';
import { ChatTree } from '../components/Sidebar/ChatTree';
import { api, StreamFailedError } from '../api';
import { FAILED_MARKER } from '../types';
import type { Chat, Message } from '../types';

const failedMessage: Message = {
  id: 'a-failed',
  chat_id: 'c1',
  role: 'assistant',
  content: FAILED_MARKER,
  created_at: '2026-07-24T00:00:01.000Z',
};

describe('MessageBubble – *Failed* error row', () => {
  it('renders the error row with a retry button and passes the message up', () => {
    const onRetry = vi.fn();
    render(
      <MessageBubble message={failedMessage} onWordRightClick={vi.fn()} onRetryMessage={onRetry} />,
    );

    expect(screen.getByTestId('failed-note')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('retry-button'));
    expect(onRetry).toHaveBeenCalledWith(failedMessage);
  });

  it('omits the retry button when no handler is wired (read-only panes)', () => {
    render(<MessageBubble message={failedMessage} onWordRightClick={vi.fn()} />);
    expect(screen.getByTestId('failed-note')).toBeInTheDocument();
    expect(screen.queryByTestId('retry-button')).not.toBeInTheDocument();
  });

  it('never renders the raw marker text as markdown', () => {
    render(<MessageBubble message={failedMessage} onWordRightClick={vi.fn()} />);
    expect(screen.queryByText('*Failed*')).not.toBeInTheDocument();
  });
});

describe('MessageBubble – queued placeholder', () => {
  const queuedMessage: Message = {
    id: 'a-queued',
    chat_id: 'c1',
    role: 'assistant',
    content: '',
    created_at: '2026-07-24T00:00:02.000Z',
    queuedAhead: 2,
  };

  it('shows the queue position instead of the thinking dots', () => {
    render(<MessageBubble message={queuedMessage} isStreaming onWordRightClick={vi.fn()} />);
    expect(screen.getByTestId('queued-note')).toBeInTheDocument();
    expect(screen.getByTestId('queued-note').textContent).toMatch(/2/);
    // Die Denk-Punkte gehören dem generierenden Zustand — nicht dem wartenden.
    expect(document.querySelector('.syflo-typing')).toBeNull();
  });

  it('falls back to the thinking dots once the job has started', () => {
    const started: Message = { ...queuedMessage, queuedAhead: undefined };
    render(<MessageBubble message={started} isStreaming onWordRightClick={vi.fn()} />);
    expect(screen.queryByTestId('queued-note')).not.toBeInTheDocument();
    expect(document.querySelector('.syflo-typing')).not.toBeNull();
  });
});

// ─── Rate-Limit-Countdown (ADR-0008): sichtbarer Auto-Retry nach 429 ─────────

describe('MessageBubble – rate-limit countdown', () => {
  const rateLimitedMessage: Message = {
    id: 'a-rate-limited',
    chat_id: 'c1',
    role: 'assistant',
    content: '',
    created_at: '2026-07-25T00:00:03.000Z',
    rateLimit: { retryInSeconds: 24, attempt: 1 },
  };

  it('keeps the normal thinking dots + quotes and adds the countdown beneath', () => {
    // The countdown only appears when all candidate models are exhausted —
    // it should feel like normal thinking, not like an error (user wish).
    render(
      <MessageBubble message={rateLimitedMessage} isStreaming showThinkingTips onWordRightClick={vi.fn()} />,
    );
    expect(screen.getByTestId('rate-limit-note')).toHaveTextContent(
      'Rate limit reached — retrying in 24s',
    );
    expect(document.querySelector('.syflo-typing')).not.toBeNull();
    expect(screen.getByTestId('thinking-tip-line')).toBeInTheDocument();
  });

  it('drops the countdown once tokens flow again', () => {
    const resumed: Message = { ...rateLimitedMessage, rateLimit: undefined, content: 'Answer…' };
    render(<MessageBubble message={resumed} isStreaming onWordRightClick={vi.fn()} />);
    expect(screen.queryByTestId('rate-limit-note')).not.toBeInTheDocument();
  });

  it('names limit type and model when the event carries scope + model (variant C)', () => {
    const scoped: Message = {
      ...rateLimitedMessage,
      rateLimit: { retryInSeconds: 18, attempt: 1, scope: 'tokens', model: 'gemini-flash-latest' },
    };
    render(
      <MessageBubble
        message={scoped}
        isStreaming
        onWordRightClick={vi.fn()}
        modelLabels={{ 'gemini-flash-latest': 'Gemini Flash' }}
      />,
    );
    expect(screen.getByTestId('rate-limit-note')).toHaveTextContent(
      'Per-minute limit (tokens) on Gemini Flash — resuming in 18 s',
    );
  });

  it('names the model in the retrying state too', () => {
    vi.useFakeTimers();
    try {
      const scoped: Message = {
        ...rateLimitedMessage,
        rateLimit: { retryInSeconds: 1, attempt: 1, scope: 'requests', model: 'gemini-flash-latest' },
      };
      render(
        <MessageBubble
          message={scoped}
          isStreaming
          onWordRightClick={vi.fn()}
          modelLabels={{ 'gemini-flash-latest': 'Gemini Flash' }}
        />,
      );
      act(() => { vi.advanceTimersByTime(1000); });
      expect(screen.getByTestId('rate-limit-note')).toHaveTextContent('Retrying on Gemini Flash…');
    } finally {
      vi.useRealTimers();
    }
  });

  it('switches to "Retrying…" once the countdown reaches 0 instead of freezing at 0', () => {
    vi.useFakeTimers();
    try {
      const shortWait: Message = { ...rateLimitedMessage, rateLimit: { retryInSeconds: 2, attempt: 1 } };
      render(<MessageBubble message={shortWait} isStreaming onWordRightClick={vi.fn()} />);
      expect(screen.getByTestId('rate-limit-note')).toHaveTextContent('retrying in 2s');

      act(() => { vi.advanceTimersByTime(2000); });
      expect(screen.getByTestId('rate-limit-note')).toHaveTextContent('Retrying…');
      expect(screen.getByTestId('rate-limit-note')).not.toHaveTextContent('0s');

      // And it stays honest while the retry round-trip is still in flight —
      // with the normal loading dots still bouncing above.
      act(() => { vi.advanceTimersByTime(3000); });
      expect(screen.getByTestId('rate-limit-note')).toHaveTextContent('Retrying…');
      expect(document.querySelector('.syflo-typing')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Quota exhausted (ADR-0008): emergency answer via the local model ────────

describe('MessageBubble – quota-exhausted error row', () => {
  const quotaMessage: Message = {
    id: 'f-quota',
    chat_id: 'c1',
    role: 'assistant',
    content: FAILED_MARKER,
    created_at: '2026-07-25T00:00:05.000Z',
    quotaExhausted: true,
  };

  it('shows the announcement and BOTH buttons when a local model is installed', () => {
    const onRetry = vi.fn();
    const onLocal = vi.fn();
    render(
      <MessageBubble
        message={quotaMessage}
        onWordRightClick={vi.fn()}
        onRetryMessage={onRetry}
        onRetryLocalModel={onLocal}
        hasLocalModel
      />,
    );

    expect(screen.getByTestId('failed-note')).toHaveTextContent(
      'All cloud quotas are used up for now.',
    );
    expect(screen.getByTestId('retry-button')).toBeInTheDocument();
    // Short action label on the button; the slow-model warning lives in the
    // footnote below the button row (card layout, user feedback 2026-07-25).
    expect(screen.getByTestId('retry-local-button')).toHaveTextContent(
      'Answer with the local model',
    );
    expect(screen.getByText('The local model can be much slower.')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('retry-local-button'));
    expect(onLocal).toHaveBeenCalledWith(quotaMessage);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('offers only the announcement + normal retry without an installed local model', () => {
    render(
      <MessageBubble
        message={quotaMessage}
        onWordRightClick={vi.fn()}
        onRetryMessage={vi.fn()}
        onRetryLocalModel={vi.fn()}
        hasLocalModel={false}
      />,
    );

    expect(screen.getByTestId('failed-note')).toHaveTextContent(
      'All cloud quotas are used up for now.',
    );
    expect(screen.getByTestId('retry-button')).toBeInTheDocument();
    expect(screen.queryByTestId('retry-local-button')).not.toBeInTheDocument();
  });

  it('keeps the generic error text for ordinary failures', () => {
    const plain: Message = { ...quotaMessage, quotaExhausted: undefined };
    render(
      <MessageBubble message={plain} onWordRightClick={vi.fn()} onRetryMessage={vi.fn()} hasLocalModel />,
    );
    expect(screen.getByTestId('failed-note')).toHaveTextContent(
      'The answer could not be generated.',
    );
    expect(screen.queryByTestId('retry-local-button')).not.toBeInTheDocument();
  });

  // retryAt (mockup-quota-states §04/§05): the retry button is only ever
  // active when clicking it can work.

  it('drops retry and shows the reset time for a long cooldown (daily limit)', () => {
    const msg: Message = {
      ...quotaMessage,
      retryAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    };
    render(
      <MessageBubble
        message={msg}
        onWordRightClick={vi.fn()}
        onRetryMessage={vi.fn()}
        onRetryLocalModel={vi.fn()}
        hasLocalModel
      />,
    );
    expect(screen.queryByTestId('retry-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('quota-retry-at')).toHaveTextContent(
      'Expected to be available again around',
    );
    expect(screen.getByTestId('retry-local-button')).toBeInTheDocument();
  });

  it('keeps an enabled retry during a long cooldown when NO local model exists', () => {
    // Without a local model retry is the only escape — the quota may reset
    // early, so the button stays rather than leaving a dead end.
    const msg: Message = {
      ...quotaMessage,
      retryAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    };
    render(
      <MessageBubble message={msg} onWordRightClick={vi.fn()} onRetryMessage={vi.fn()} hasLocalModel={false} />,
    );
    expect(screen.getByTestId('retry-button')).toBeEnabled();
  });

  // quotaReason (mockup-quota-states v3): one precise message + action set
  // per cause; the generic line stays as fallback without a reason.

  it('daily: names the daily quota, offers the billing link, no retry', () => {
    const msg: Message = {
      ...quotaMessage,
      quotaReason: 'daily',
      retryAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    };
    render(
      <MessageBubble
        message={msg}
        onWordRightClick={vi.fn()}
        onRetryMessage={vi.fn()}
        onRetryLocalModel={vi.fn()}
        hasLocalModel
        billingUrl="https://console.example.com/billing"
      />,
    );
    expect(screen.getByTestId('failed-note')).toHaveTextContent(
      'The daily quota of the cloud models is used up.',
    );
    expect(screen.queryByTestId('retry-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('raise-limit-link')).toHaveAttribute(
      'href', 'https://console.example.com/billing',
    );
    expect(screen.getByTestId('retry-local-button')).toBeInTheDocument();
  });

  it('rate_limit: names the minute limits and explains the burst', () => {
    const msg: Message = {
      ...quotaMessage,
      quotaReason: 'rate_limit',
      retryAt: new Date(Date.now() + 60_000).toISOString(),
    };
    render(
      <MessageBubble message={msg} onWordRightClick={vi.fn()} onRetryMessage={vi.fn()} hasLocalModel={false} />,
    );
    expect(screen.getByTestId('failed-note')).toHaveTextContent(
      'The cloud models are at their per-minute limits right now.',
    );
    expect(screen.getByTestId('quota-minute-note')).toBeInTheDocument();
    expect(screen.getByTestId('retry-button')).toBeDisabled();
    expect(screen.queryByTestId('raise-limit-link')).not.toBeInTheDocument();
  });

  it('billing: names the gate, offers the free model + billing link — no retry, no reset time', () => {
    // W4 (mockup-model-cost-tiers, 2026-07-30): a zero-limit 429 is not a
    // daily limit — it never comes back at midnight. The card must not
    // promise a reset; the primary exit answers with a FREE model.
    const onRetryFree = vi.fn();
    const msg: Message = {
      ...quotaMessage,
      quotaReason: 'billing',
      failProvider: 'gemini',
      failModel: 'gemini-pro-latest',
    };
    render(
      <MessageBubble
        message={msg}
        onWordRightClick={vi.fn()}
        onRetryMessage={vi.fn()}
        onRetryLocalModel={vi.fn()}
        hasLocalModel
        billingUrls={{ gemini: 'https://console.example.com/billing' }}
        modelLabels={{ 'gemini-pro-latest': 'Gemini Pro' }}
        freeFallback={{ providerLabel: 'Gemini', modelLabel: 'Gemini Flash' }}
        onRetryFreeModel={onRetryFree}
      />,
    );
    expect(screen.getByTestId('failed-note')).toHaveTextContent(
      'Gemini Pro has no quota without billing',
    );
    expect(screen.queryByTestId('quota-retry-at')).not.toBeInTheDocument();
    expect(screen.queryByTestId('retry-button')).not.toBeInTheDocument();
    // The model menu covers local + siblings (footnote) — no extra button row.
    expect(screen.queryByTestId('retry-local-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('setup-billing-link')).toHaveAttribute(
      'href', 'https://console.example.com/billing',
    );
    fireEvent.click(screen.getByTestId('retry-free-button'));
    expect(onRetryFree).toHaveBeenCalledWith(msg);
  });

  it('re-offers an ENABLED retry after a model switch (too_large card)', () => {
    // Card created at 00:00:05; the user switches models afterwards — the
    // picked model may have budget, so retry comes back enabled.
    const msg: Message = { ...quotaMessage, quotaReason: 'too_large' };
    render(
      <MessageBubble
        message={msg}
        onWordRightClick={vi.fn()}
        onRetryMessage={vi.fn()}
        onRetryLocalModel={vi.fn()}
        hasLocalModel
        settingsChangedAt="2026-07-25T00:10:00.000Z"
      />,
    );
    expect(screen.getByTestId('retry-button')).toBeEnabled();
  });

  it('too_large: never offers retry, but switch-model and billing link', () => {
    const onOpenPicker = vi.fn();
    const msg: Message = { ...quotaMessage, quotaReason: 'too_large' };
    render(
      <MessageBubble
        message={msg}
        onWordRightClick={vi.fn()}
        onRetryMessage={vi.fn()}
        onRetryLocalModel={vi.fn()}
        hasLocalModel
        billingUrl="https://console.example.com/billing"
        onOpenModelPicker={onOpenPicker}
      />,
    );
    expect(screen.getByTestId('failed-note')).toHaveTextContent(
      'The question plus its context is too large for the cloud limits.',
    );
    expect(screen.queryByTestId('retry-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('raise-limit-link')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('switch-model-button'));
    // The card hands over ITS message — the pick that follows retries it.
    expect(onOpenPicker).toHaveBeenCalledWith(msg);
  });

  it('disables retry with a countdown for a short cooldown and re-enables it after retryAt', () => {
    vi.useFakeTimers();
    try {
      const msg: Message = {
        ...quotaMessage,
        retryAt: new Date(Date.now() + 60_000).toISOString(),
      };
      render(
        <MessageBubble
          message={msg}
          onWordRightClick={vi.fn()}
          onRetryMessage={vi.fn()}
          onRetryLocalModel={vi.fn()}
          hasLocalModel
        />,
      );
      const btn = screen.getByTestId('retry-button');
      expect(btn).toBeDisabled();
      expect(btn).toHaveTextContent('Try again (60 s)');

      act(() => { vi.advanceTimersByTime(61_000); });
      expect(screen.getByTestId('retry-button')).toBeEnabled();
      expect(screen.getByTestId('retry-button')).toHaveTextContent('Try again');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Failover note (ADR-0008): another provider steps in for one answer ──────

describe('MessageBubble – failover note', () => {
  const failoverMessage: Message = {
    id: 'a-failover',
    chat_id: 'c1',
    role: 'assistant',
    content: 'Answer text…',
    created_at: '2026-07-25T00:00:04.000Z',
    failover: { from: 'gemini', fromModel: 'gemini-2.5-flash', to: 'groq', model: 'openai/gpt-oss-120b', reason: 'daily' },
  };

  it('shows the note with resolved provider labels while streaming', () => {
    render(<MessageBubble message={failoverMessage} isStreaming onWordRightClick={vi.fn()} />);
    expect(screen.getByTestId('failover-note')).toHaveTextContent(
      'Quota reached on Gemini — this answer comes from Groq (openai/gpt-oss-120b).',
    );
  });

  it('keeps the note after streaming — it explains who the answer is from', () => {
    render(<MessageBubble message={failoverMessage} onWordRightClick={vi.fn()} />);
    expect(screen.getByTestId('failover-note')).toBeInTheDocument();
  });

  it('names the models (registry labels) when a sibling model of the SAME provider steps in', () => {
    const sameProvider: Message = {
      ...failoverMessage,
      failover: {
        from: 'groq', fromModel: 'openai/gpt-oss-120b',
        to: 'groq', model: 'llama-3.3-70b-versatile', reason: 'cooldown',
      },
    };
    render(
      <MessageBubble
        message={sameProvider}
        onWordRightClick={vi.fn()}
        modelLabels={{ 'openai/gpt-oss-120b': 'gpt-oss 120B', 'llama-3.3-70b-versatile': 'Llama 3.3 70B' }}
      />,
    );
    expect(screen.getByTestId('failover-note')).toHaveTextContent(
      'Quota reached on gpt-oss 120B — this answer comes from Llama 3.3 70B.',
    );
  });

  it('falls back to raw model names in the same-provider note without registry labels', () => {
    const sameProvider: Message = {
      ...failoverMessage,
      failover: {
        from: 'groq', fromModel: 'openai/gpt-oss-120b',
        // A quota reason — no_vision/model_unavailable now carry their own
        // reason-true copy (QueueTransparency.test.tsx, mockup-model-flow §11).
        to: 'groq', model: 'llama-3.3-70b-versatile', reason: 'daily',
      },
    };
    render(<MessageBubble message={sameProvider} onWordRightClick={vi.fn()} />);
    expect(screen.getByTestId('failover-note')).toHaveTextContent(
      'Quota reached on openai/gpt-oss-120b — this answer comes from llama-3.3-70b-versatile.',
    );
  });

  it('falls back to raw provider names for unknown providers', () => {
    const unknown: Message = {
      ...failoverMessage,
      failover: { from: 'newcloud', fromModel: 'x1', to: 'groq', model: 'm1', reason: 'rate_limit' },
    };
    render(<MessageBubble message={unknown} onWordRightClick={vi.fn()} />);
    expect(screen.getByTestId('failover-note')).toHaveTextContent(
      'Quota reached on newcloud — this answer comes from Groq (m1).',
    );
  });
});

describe('Sidebar ChatTree – queued clock', () => {
  const chat: Chat = {
    id: 'c1',
    title: 'Waiting Chat',
    parent_id: null,
    parent_word: null,
    created_at: '2026-07-24T00:00:00.000Z',
    children: [],
  };
  const treeProps = {
    chats: [chat],
    activeChatId: null,
    renamingId: null,
    onSelect: vi.fn(),
    onContextMenu: vi.fn(),
    onRenameSubmit: vi.fn(),
    onRenameCancel: vi.fn(),
  };

  it('shows the clock for chats whose question waits in the queue', () => {
    render(<ChatTree {...treeProps} queuedChatIds={new Set(['c1'])} />);
    expect(screen.getByTestId('sidebar-queued-clock')).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-streaming-dots')).not.toBeInTheDocument();
  });

  it('prefers the streaming dots when the chat is already generating', () => {
    render(
      <ChatTree
        {...treeProps}
        streamingChatIds={new Set(['c1'])}
        queuedChatIds={new Set(['c1'])}
      />,
    );
    expect(screen.getByTestId('sidebar-streaming-dots')).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-queued-clock')).not.toBeInTheDocument();
  });
});

// ─── SSE-Protokoll: queued/started-Events + persistierter Fehler ────────────

/** Mock-Fetch-Response, deren Body ein ReadableStream aus SSE-Events ist. */
function mockSSEResponse(events: object[]) {
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (index < events.length) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(events[index++])}\n\n`));
      } else {
        controller.close();
      }
    },
  });
  return Promise.resolve({ ok: true, body: stream } as Response);
}

const persistedUser: Message = {
  id: 'u1', chat_id: 'c1', role: 'user', content: 'Frage', created_at: '2026-07-24T00:00:03.000Z',
};
const persistedAssistant: Message = {
  id: 'a1', chat_id: 'c1', role: 'assistant', content: 'Antwort', created_at: '2026-07-24T00:00:04.000Z',
};

describe('api.sendMessageStream – queue events', () => {
  it('dispatches queued and started events to the callbacks', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(mockSSEResponse([
      { queued: { ahead: 2 } },
      { queued: { ahead: 1 } },
      { started: true, userMessage: persistedUser },
      { delta: 'Antwort' },
      { done: true, userMessage: persistedUser, assistantMessage: persistedAssistant },
    ])));
    try {
      const onQueued = vi.fn();
      const onStarted = vi.fn();
      const result = await api.sendMessageStream('c1', 'Frage', vi.fn(), [], undefined, {
        onQueued,
        onStarted,
      });
      expect(onQueued.mock.calls.map(c => c[0])).toEqual([2, 1]);
      expect(onStarted).toHaveBeenCalledWith(persistedUser);
      expect(result.assistantMessage).toEqual(persistedAssistant);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects with StreamFailedError carrying the persisted messages', async () => {
    const failedAssistant: Message = { ...persistedAssistant, content: FAILED_MARKER };
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(mockSSEResponse([
      { started: true, userMessage: persistedUser },
      { error: 'Ollama exploded', userMessage: persistedUser, assistantMessage: failedAssistant },
    ])));
    try {
      const promise = api.sendMessageStream('c1', 'Frage', vi.fn(), []);
      await expect(promise).rejects.toBeInstanceOf(StreamFailedError);
      const err = await promise.catch(e => e) as StreamFailedError;
      expect(err.message).toBe('Ollama exploded');
      expect(err.userMessage).toEqual(persistedUser);
      expect(err.assistantMessage).toEqual(failedAssistant);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('api.regenerateMessage', () => {
  it('POSTs to /regenerate and reads the same SSE protocol', async () => {
    const fetchMock = vi.fn().mockReturnValue(mockSSEResponse([
      { started: true, userMessage: persistedUser },
      { delta: 'Ant' },
      { delta: 'wort' },
      { done: true, userMessage: persistedUser, assistantMessage: persistedAssistant },
    ]));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const deltas: string[] = [];
      const result = await api.regenerateMessage('c1', 'f-marker-1', d => deltas.push(d));
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/chats/c1/messages/regenerate',
        expect.objectContaining({ method: 'POST' }),
      );
      // Anchored retry: the clicked marker's id travels in the body.
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body.messageId).toBe('f-marker-1');
      expect(deltas.join('')).toBe('Antwort');
      expect(result.userMessage.id).toBe('u1');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sends provider ollama in the body for the emergency local answer', async () => {
    const fetchMock = vi.fn().mockReturnValue(mockSSEResponse([
      { done: true, userMessage: persistedUser, assistantMessage: persistedAssistant },
    ]));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await api.regenerateMessage('c1', 'f-marker-1', () => {}, undefined, { provider: 'ollama' });
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body.provider).toBe('ollama');
      expect(body.messageId).toBe('f-marker-1');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
