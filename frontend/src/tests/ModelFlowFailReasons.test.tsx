/**
 * tests/ModelFlowFailReasons.test.tsx
 *
 * Model flow v3 (design/mockup-model-flow.html §05/§06/§09/§10): swallowed
 * errors get honest cards. The SSE error carries a failReason
 * ('no_key' | 'bad_key' | 'no_vision' | 'network' | 'local_missing' |
 * 'local_unreachable'); persisted *Failed* markers carry fail_reason so the
 * deterministic cards survive reloads. Each reason renders its own card with
 * exits that actually work — never a retry that fails identically.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MessageBubble } from '../components/ChatArea/MessageBubble';
import { ChatArea } from '../components/ChatArea';
import { api, StreamFailedError } from '../api';
import { FAILED_MARKER } from '../types';
import type { ChatDetail, Message } from '../types';

/** Mock fetch response whose body is a ReadableStream of SSE events. */
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
  id: 'u1', chat_id: 'c1', role: 'user', content: 'Frage', created_at: '2026-07-26T00:00:01.000Z',
};
const failedAssistant: Message = {
  id: 'a1', chat_id: 'c1', role: 'assistant', content: FAILED_MARKER, created_at: '2026-07-26T00:00:02.000Z',
};

// ─── 1 · api surfaces failReason/failProvider/failModel ─────────────────────

describe('api.sendMessageStream – failReason on the SSE error', () => {
  it('rejects with StreamFailedError carrying failReason, failProvider and failModel', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(mockSSEResponse([
      {
        error: 'no API key stored for gemini',
        userMessage: persistedUser,
        assistantMessage: failedAssistant,
        failReason: 'no_key',
        failProvider: 'gemini',
        failModel: 'gemini-2.5-flash',
      },
    ])));
    try {
      const promise = api.sendMessageStream('c1', 'Frage', vi.fn(), []);
      await expect(promise).rejects.toBeInstanceOf(StreamFailedError);
      const err = await promise.catch(e => e) as StreamFailedError;
      expect(err.failReason).toBe('no_key');
      expect(err.failProvider).toBe('gemini');
      expect(err.failModel).toBe('gemini-2.5-flash');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('ignores unknown failReason codes instead of rendering a wrong card', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(mockSSEResponse([
      { error: 'boom', assistantMessage: failedAssistant, failReason: 'brand_new_code' },
    ])));
    try {
      const err = await api.sendMessageStream('c1', 'Frage', vi.fn(), []).catch(e => e) as StreamFailedError;
      expect(err.failReason).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('api.getChat – persisted fail_reason maps to failReason', () => {
  it('maps the fail_reason column onto the message for the card rendering path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        id: 'c1', title: 'T', parent_id: null, parent_word: null,
        created_at: '2026-07-26T00:00:00.000Z',
        children: [],
        messages: [
          persistedUser,
          { ...failedAssistant, fail_reason: 'no_vision' },
        ],
      }),
    } as Response));
    try {
      const chat = await api.getChat('c1');
      expect(chat.messages[1].failReason).toBe('no_vision');
      // Non-failed rows stay untouched.
      expect(chat.messages[0].failReason).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('drops unknown fail_reason values (renders the generic row instead)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        id: 'c1', title: 'T', parent_id: null, parent_word: null,
        created_at: '2026-07-26T00:00:00.000Z',
        children: [],
        messages: [{ ...failedAssistant, fail_reason: 'space_weather' }],
      }),
    } as Response));
    try {
      const chat = await api.getChat('c1');
      expect(chat.messages[0].failReason).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ─── 2 · MessageBubble failReason cards (mockup-model-flow §05/§11) ─────────

describe('MessageBubble – failReason cards', () => {
  const base: Message = {
    id: 'f1', chat_id: 'c1', role: 'assistant', content: FAILED_MARKER,
    created_at: '2026-07-26T00:00:03.000Z',
  };
  const noop = vi.fn();

  it('no_key: names the provider, offers key setup + local answer, NO plain retry', () => {
    const onOpenSettings = vi.fn();
    const onLocal = vi.fn();
    const msg: Message = { ...base, failReason: 'no_key', failProvider: 'gemini' };
    render(
      <MessageBubble
        message={msg}
        onWordRightClick={noop}
        onRetryMessage={vi.fn()}
        onOpenSettings={onOpenSettings}
        onRetryLocalModel={onLocal}
        hasLocalModel
        providerLabels={{ gemini: 'Google Gemini' }}
      />,
    );
    expect(screen.getByTestId('failed-note')).toHaveTextContent(
      'No API key is stored for Google Gemini.',
    );
    expect(screen.queryByTestId('retry-button')).not.toBeInTheDocument();
    const keyButton = screen.getByTestId('open-settings-button');
    expect(keyButton).toHaveTextContent('Add API key');
    fireEvent.click(keyButton);
    expect(onOpenSettings).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('retry-local-button'));
    expect(onLocal).toHaveBeenCalledWith(msg);
  });

  it('no_key: falls back to the raw provider name without a registry label', () => {
    const msg: Message = { ...base, failReason: 'no_key', failProvider: 'newcloud' };
    render(<MessageBubble message={msg} onWordRightClick={noop} onOpenSettings={vi.fn()} />);
    expect(screen.getByTestId('failed-note')).toHaveTextContent(
      'No API key is stored for newcloud.',
    );
  });

  it('no_key: hides the local button without an installed local model', () => {
    const msg: Message = { ...base, failReason: 'no_key', failProvider: 'gemini' };
    render(
      <MessageBubble
        message={msg}
        onWordRightClick={noop}
        onOpenSettings={vi.fn()}
        onRetryLocalModel={vi.fn()}
        hasLocalModel={false}
      />,
    );
    expect(screen.queryByTestId('retry-local-button')).not.toBeInTheDocument();
  });

  it('bad_key: same layout with the rejected-key message and "Check API key"', () => {
    const msg: Message = { ...base, failReason: 'bad_key', failProvider: 'gemini' };
    render(
      <MessageBubble
        message={msg}
        onWordRightClick={noop}
        onRetryMessage={vi.fn()}
        onOpenSettings={vi.fn()}
        providerLabels={{ gemini: 'Google Gemini' }}
      />,
    );
    expect(screen.getByTestId('failed-note')).toHaveTextContent(
      'The Google Gemini API key was rejected.',
    );
    expect(screen.getByTestId('open-settings-button')).toHaveTextContent('Check API key');
    expect(screen.queryByTestId('retry-button')).not.toBeInTheDocument();
  });

  it('no_vision: names the model, local answer is primary, switch model + footnote', () => {
    const onLocal = vi.fn();
    const onOpenPicker = vi.fn();
    const msg: Message = { ...base, failReason: 'no_vision', failModel: 'openai/gpt-oss-120b' };
    render(
      <MessageBubble
        message={msg}
        onWordRightClick={noop}
        onRetryMessage={vi.fn()}
        onRetryLocalModel={onLocal}
        hasLocalModel
        localModelName="qwen3.5:9b"
        onOpenModelPicker={onOpenPicker}
        modelLabels={{ 'openai/gpt-oss-120b': 'gpt-oss 120B' }}
      />,
    );
    expect(screen.getByTestId('failed-note')).toHaveTextContent(
      'gpt-oss 120B cannot read images.',
    );
    // Tooltip names the ACTUAL local model that understands images.
    expect(screen.getByTestId('retry-local-button')).toHaveAttribute(
      'title', expect.stringContaining('qwen3.5:9b'),
    );
    fireEvent.click(screen.getByTestId('switch-model-button'));
    // The card hands over ITS message — the pick that follows retries it.
    expect(onOpenPicker).toHaveBeenCalledWith(msg);
    expect(screen.getByText('Or remove the image from the question and send it again.')).toBeInTheDocument();
    expect(screen.queryByTestId('retry-button')).not.toBeInTheDocument();
  });

  it('network: honest enabled retry + restart footnote, no local button', () => {
    const onRetry = vi.fn();
    const msg: Message = { ...base, failReason: 'network' };
    render(
      <MessageBubble
        message={msg}
        onWordRightClick={noop}
        onRetryMessage={onRetry}
        onRetryLocalModel={vi.fn()}
        hasLocalModel
      />,
    );
    expect(screen.getByTestId('failed-note')).toHaveTextContent(
      'No connection to the Syflo backend.',
    );
    // Without the backend, local inference is unreachable too (§05 C).
    expect(screen.queryByTestId('retry-local-button')).not.toBeInTheDocument();
    expect(screen.getByText('Is Syflo still running? If in doubt, restart the app.')).toBeInTheDocument();
    const retry = screen.getByTestId('retry-button');
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledWith(msg);
  });

  it('local_missing: settings check + named cloud exit + install footnote', () => {
    const onOpenSettings = vi.fn();
    const onCloud = vi.fn();
    const msg: Message = { ...base, failReason: 'local_missing', failModel: 'qwen3.5:9b' };
    render(
      <MessageBubble
        message={msg}
        onWordRightClick={noop}
        onRetryMessage={vi.fn()}
        onOpenSettings={onOpenSettings}
        cloudFallback={{ providerLabel: 'Google Gemini', modelLabel: 'Gemini Flash' }}
        onRetryCloudModel={onCloud}
      />,
    );
    expect(screen.getByTestId('failed-note')).toHaveTextContent(
      'The local model qwen3.5:9b is not installed.',
    );
    expect(screen.getByTestId('open-settings-button')).toHaveTextContent('Check in Settings');
    const cloud = screen.getByTestId('retry-cloud-button');
    expect(cloud).toHaveTextContent('Answer with Gemini Flash');
    // The tooltip spells out what leaves the machine (privacy guard, §11).
    expect(cloud).toHaveAttribute('title', expect.stringContaining('Google Gemini'));
    fireEvent.click(cloud);
    expect(onCloud).toHaveBeenCalledWith(msg);
    expect(screen.getByText('ollama pull qwen3.5:9b')).toBeInTheDocument();
    expect(screen.queryByTestId('retry-button')).not.toBeInTheDocument();
  });

  it('local_missing: no cloud button when no provider has a key', () => {
    const msg: Message = { ...base, failReason: 'local_missing', failModel: 'qwen3.5:9b' };
    render(
      <MessageBubble
        message={msg}
        onWordRightClick={noop}
        onOpenSettings={vi.fn()}
        onRetryCloudModel={vi.fn()}
        cloudFallback={null}
      />,
    );
    expect(screen.queryByTestId('retry-cloud-button')).not.toBeInTheDocument();
  });

  it('local_unreachable: settings check + enabled retry (Ollama may just have started)', () => {
    const onRetry = vi.fn();
    const msg: Message = { ...base, failReason: 'local_unreachable' };
    render(
      <MessageBubble
        message={msg}
        onWordRightClick={noop}
        onRetryMessage={onRetry}
        onOpenSettings={vi.fn()}
      />,
    );
    expect(screen.getByTestId('failed-note')).toHaveTextContent('Ollama is not reachable.');
    expect(screen.getByTestId('open-settings-button')).toBeInTheDocument();
    const retry = screen.getByTestId('retry-button');
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledWith(msg);
  });

  // §05: a key save / provider change re-arms retry — same rule as after a
  // pill model switch (settingsChangedAt generalizes modelSwitchedAt).
  it('re-offers an enabled retry once settings changed after the card appeared', () => {
    const msg: Message = { ...base, failReason: 'no_key', failProvider: 'gemini' };
    render(
      <MessageBubble
        message={msg}
        onWordRightClick={noop}
        onRetryMessage={vi.fn()}
        onOpenSettings={vi.fn()}
        settingsChangedAt="2026-07-26T00:10:00.000Z"
      />,
    );
    expect(screen.getByTestId('retry-button')).toBeEnabled();
  });
});

// ─── 3 · Interrupted gets an exit (mockup-model-flow §09) ───────────────────

describe('MessageBubble – interrupted row retry', () => {
  const interrupted: Message = {
    id: 'i1', chat_id: 'c1', role: 'assistant', content: '*Interrupted*',
    created_at: '2026-07-26T00:00:04.000Z',
  };

  it('offers the same retry as the failed row and passes the marker up', () => {
    const onRetry = vi.fn();
    render(
      <MessageBubble message={interrupted} onWordRightClick={vi.fn()} onRetryMessage={onRetry} />,
    );
    expect(screen.getByTestId('interrupted-note')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('interrupted-retry-button'));
    expect(onRetry).toHaveBeenCalledWith(interrupted);
  });

  it('omits the retry button when no handler is wired (read-only panes)', () => {
    render(<MessageBubble message={interrupted} onWordRightClick={vi.fn()} />);
    expect(screen.getByTestId('interrupted-note')).toBeInTheDocument();
    expect(screen.queryByTestId('interrupted-retry-button')).not.toBeInTheDocument();
  });
});

// ─── 4 · Unanswered row gating (mockup-model-flow §10) ──────────────────────

describe('ChatArea – unanswered trailing question row', () => {
  const baseChat: ChatDetail = {
    id: 'c1', title: 'T', parent_id: null, parent_word: null,
    created_at: '2026-07-26T00:00:00.000Z',
    children: [],
    messages: [
      { id: 'u1', chat_id: 'c1', role: 'user', content: 'Verlorene Frage', created_at: '2026-07-26T00:00:01.000Z', pending: 1 },
    ],
  };
  const chatAreaProps = {
    loading: false,
    onSendMessage: vi.fn().mockResolvedValue(undefined),
    onWordRightClick: vi.fn(),
    onSelectChat: vi.fn(),
  };

  it('renders the quiet row with resend for a trailing user message without a live stream', () => {
    const onResend = vi.fn();
    render(
      <ChatArea chat={baseChat} streaming={false} onResendUnanswered={onResend} {...chatAreaProps} />,
    );
    expect(screen.getByTestId('unanswered-note')).toHaveTextContent('Left without an answer.');
    fireEvent.click(screen.getByTestId('resend-button'));
    expect(onResend).toHaveBeenCalledWith(baseChat.messages[0]);
  });

  it('does NOT appear while the question is queued/streaming in this session', () => {
    render(
      <ChatArea chat={baseChat} streaming onResendUnanswered={vi.fn()} {...chatAreaProps} />,
    );
    expect(screen.queryByTestId('unanswered-note')).not.toBeInTheDocument();
  });

  it('does NOT appear when the trailing message is an answered assistant turn', () => {
    const answered: ChatDetail = {
      ...baseChat,
      messages: [
        { id: 'u1', chat_id: 'c1', role: 'user', content: 'Frage', created_at: '2026-07-26T00:00:01.000Z' },
        { id: 'a1', chat_id: 'c1', role: 'assistant', content: 'Antwort', created_at: '2026-07-26T00:00:02.000Z' },
      ],
    };
    render(
      <ChatArea chat={answered} streaming={false} onResendUnanswered={vi.fn()} {...chatAreaProps} />,
    );
    expect(screen.queryByTestId('unanswered-note')).not.toBeInTheDocument();
  });
});

describe('api.deleteMessage – cancel of a pending question', () => {
  it('DELETEs the pending message row', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 } as Response);
    vi.stubGlobal('fetch', fetchMock);
    try {
      await api.deleteMessage('c1', 'u-pending');
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/chats/c1/messages/u-pending',
        expect.objectContaining({ method: 'DELETE' }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ─── Raise limit targets the provider that hit the limit (§08) ───────────────
// After a cross-provider failover the daily/too_large error may come from a
// different provider than the active one — the billing link must follow
// failProvider, not blindly the active provider's url.

describe('MessageBubble – billing link follows failProvider', () => {
  const quotaMsg: Message = {
    id: 'f9', chat_id: 'c1', role: 'assistant', content: FAILED_MARKER,
    created_at: '2026-07-26T00:00:03.000Z',
    quotaExhausted: true, quotaReason: 'too_large', failProvider: 'groq',
  };

  it('prefers billingUrls[failProvider] over the active provider url', () => {
    render(
      <MessageBubble
        message={quotaMsg}
        onWordRightClick={vi.fn()}
        billingUrl="https://active.example/billing"
        billingUrls={{ groq: 'https://groq.example/billing' }}
      />
    );
    expect(screen.getByTestId('raise-limit-link')).toHaveAttribute('href', 'https://groq.example/billing');
  });

  it('falls back to the active provider url when failProvider is unknown', () => {
    render(
      <MessageBubble
        message={{ ...quotaMsg, failProvider: undefined }}
        onWordRightClick={vi.fn()}
        billingUrl="https://active.example/billing"
        billingUrls={{ groq: 'https://groq.example/billing' }}
      />
    );
    expect(screen.getByTestId('raise-limit-link')).toHaveAttribute('href', 'https://active.example/billing');
  });
});
