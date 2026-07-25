/**
 * tests/FailedRetryQueue.test.tsx
 *
 * Fehlerzeile + Sende-Warteschlange (2026-07-24): Fehlgeschlagene Antworten
 * verschwinden nicht mehr stumm — der '*Failed*'-Marker rendert eine dezente
 * Fehlerzeile mit "Erneut versuchen". Wartende Fragen zeigen ihren Platz in
 * der Backend-Warteschlange (FIFO, ein Ollama-Slot) statt der Denk-Punkte,
 * die Sidebar eine kleine Uhr statt der animierten Punkte.
 */

import { render, screen, fireEvent } from '@testing-library/react';
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
      const result = await api.regenerateMessage('c1', d => deltas.push(d));
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/chats/c1/messages/regenerate',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(deltas.join('')).toBe('Antwort');
      expect(result.userMessage.id).toBe('u1');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
