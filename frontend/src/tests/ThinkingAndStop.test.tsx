/**
 * tests/ThinkingAndStop.test.tsx
 *
 * (1) Denk-Phase: unter den bekannten Lade-Punkten rotiert eine lokale
 *     Tipp-/Zitat-Zeile — nie die Gedankenkette selbst (mockup-model-picker,
 *     Sektion 04). (2) Stop-Button: während des Streamens wird der
 *     Senden-Pfeil zum roten Quadrat, das den Stream abbricht.
 */

import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ChatArea } from '../components/ChatArea';
import { MessageBubble } from '../components/ChatArea/MessageBubble';
import { ThinkingIndicator } from '../components/ChatArea/ThinkingIndicator';
import { THINKING_LINE_INTERVAL_MS } from '../components/ChatArea/thinkingTips';
import type { ChatDetail, Message } from '../types';

const streamingChat: ChatDetail = {
  id: '1',
  title: 'Streaming Chat',
  parent_id: null,
  parent_word: null,
  created_at: new Date().toISOString(),
  messages: [
    { id: 'm1', chat_id: '1', role: 'user', content: 'Question', created_at: new Date().toISOString() },
    { id: 'm2', chat_id: '1', role: 'assistant', content: '', created_at: new Date().toISOString() },
  ],
  children: [],
};

const baseProps = {
  loading: false,
  onSendMessage: vi.fn().mockResolvedValue(undefined),
  onWordRightClick: vi.fn(),
  onSelectChat: vi.fn(),
};

describe('thinking tips', () => {
  it('rotates a local tip/quote line beneath the dots while thinking', () => {
    vi.useFakeTimers();
    try {
      render(<ThinkingIndicator withTips />);
      const first = screen.getByTestId('thinking-tip-line').textContent;
      expect(first).toBeTruthy();

      act(() => { vi.advanceTimersByTime(THINKING_LINE_INTERVAL_MS + 50); });
      const second = screen.getByTestId('thinking-tip-line').textContent;
      expect(second).toBeTruthy();
      expect(second).not.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows no tip line for the plain (non-thinking) loading state', () => {
    render(<ThinkingIndicator />);
    expect(screen.queryByTestId('thinking-tip-line')).not.toBeInTheDocument();
  });

  it('shows tips while waiting for the first token — thinking or not', () => {
    // Nutzerentscheid 2026-07-21: Die Wartezeit vor dem ersten Token (z. B.
    // Prompt-Verarbeitung eines großen Papers) bekommt sofort Tipps/Zitate,
    // unabhängig vom Thinking-Modus.
    render(<ChatArea chat={streamingChat} streaming {...baseProps} />);
    expect(screen.getByTestId('thinking-tip-line')).toBeInTheDocument();
  });
});

describe('live thinking panel', () => {
  const mkMessage = (over: Partial<Message>): Message => ({
    id: 'a1',
    chat_id: '1',
    role: 'assistant',
    content: '',
    created_at: new Date().toISOString(),
    ...over,
  });
  const bubbleProps = { onWordRightClick: vi.fn() };

  it('streams the chain of thought expanded while the model is still thinking', () => {
    render(
      <MessageBubble
        message={mkMessage({ reasoning: 'Step 1: consider the paper…' })}
        isStreaming
        {...bubbleProps}
      />
    );
    expect(screen.getByTestId('thinking-toggle')).toHaveTextContent('Thinking…');
    expect(screen.getByTestId('thinking-panel')).toHaveTextContent('Step 1: consider the paper…');
  });

  it('auto-collapses the panel once the answer starts streaming', () => {
    render(
      <MessageBubble
        message={mkMessage({ reasoning: 'Hidden thoughts', content: 'The answer' })}
        isStreaming
        {...bubbleProps}
      />
    );
    expect(screen.queryByTestId('thinking-panel')).not.toBeInTheDocument();
  });

  it('lets the user expand the collapsed thoughts again after the answer', () => {
    render(
      <MessageBubble
        message={mkMessage({ reasoning: 'Old thoughts', content: 'Done', thoughtForSeconds: 12 })}
        {...bubbleProps}
      />
    );
    const toggle = screen.getByTestId('thinking-toggle');
    expect(toggle).toHaveTextContent('Thought for 12s');
    expect(screen.queryByTestId('thinking-panel')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.getByTestId('thinking-panel')).toHaveTextContent('Old thoughts');

    fireEvent.click(toggle);
    expect(screen.queryByTestId('thinking-panel')).not.toBeInTheDocument();
  });

  it('renders no panel when the message has no reasoning', () => {
    render(<MessageBubble message={mkMessage({ content: 'Plain answer' })} {...bubbleProps} />);
    expect(screen.queryByTestId('thinking-toggle')).not.toBeInTheDocument();
  });
});

describe('stop button', () => {
  it('replaces the send arrow while streaming and aborts on click', () => {
    const onStop = vi.fn();
    render(
      <ChatArea chat={streamingChat} streaming onStopStreaming={onStop} {...baseProps} />
    );

    const stop = screen.getByTestId('stop-button');
    expect(screen.queryByLabelText('Send')).not.toBeInTheDocument();
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalled();
  });

  it('shows the normal send arrow when idle', () => {
    render(
      <ChatArea chat={streamingChat} streaming={false} onStopStreaming={vi.fn()} {...baseProps} />
    );
    expect(screen.queryByTestId('stop-button')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Send')).toBeInTheDocument();
  });
});
