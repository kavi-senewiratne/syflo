/**
 * tests/OverloadRetry.test.tsx
 *
 * Überlasteter Anbieter (design/mockup-truncated-answer.html §03). Gemessen am
 * 2026-08-16: derselbe Prompt zog fünf 503er ("high demand") und eine saubere
 * Antwort innerhalb von vier Minuten. Das Backend wiederholt deshalb dieselbe
 * Anfrage — und die Wartezeit wird gezeigt, statt dass nichts passiert.
 *
 * Die Zeile folgt der Rate-Limit-Zeile (mockup-quota-states §10, Variante C):
 * dieselbe stille Meta-Zeile über der Blase, nur die Ursache heißt anders.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MessageBubble } from '../components/ChatArea/MessageBubble';
import { FAILED_MARKER } from '../types';
import type { Message } from '../types';

const waitingMessage: Message = {
  id: 'a-overloaded',
  chat_id: 'c1',
  role: 'assistant',
  content: '',
  created_at: '2026-08-16T00:00:01.000Z',
  overloaded: { retryInSeconds: 4, attempt: 2, maxAttempts: 3, provider: 'gemini' },
};

describe('MessageBubble – overloaded provider', () => {
  it('names the busy provider, the wait and which attempt this is', () => {
    render(
      <MessageBubble message={waitingMessage} isStreaming showThinkingTips onWordRightClick={vi.fn()} />,
    );
    const note = screen.getByTestId('overloaded-note');
    expect(note).toHaveTextContent(/gemini/i);
    expect(note).toHaveTextContent(/4s/);
    expect(note).toHaveTextContent(/2.*3/);
    // Waiting is still thinking, not an error: dots and quote stay.
    expect(document.querySelector('.syflo-typing')).not.toBeNull();
  });

  it('disappears as soon as the retry produces text', () => {
    const answering: Message = { ...waitingMessage, overloaded: undefined, content: 'Antwort…' };
    render(<MessageBubble message={answering} isStreaming onWordRightClick={vi.fn()} />);
    expect(screen.queryByTestId('overloaded-note')).not.toBeInTheDocument();
  });
});

describe('MessageBubble – all overload retries used up', () => {
  const givenUp: Message = {
    id: 'a-overload-failed',
    chat_id: 'c1',
    role: 'assistant',
    content: FAILED_MARKER,
    created_at: '2026-08-16T00:00:02.000Z',
    failReason: 'overloaded',
    failProvider: 'gemini',
  };

  it('blames the busy provider and offers a plain retry — repeating CAN work here', () => {
    const onRetry = vi.fn();
    render(
      <MessageBubble message={givenUp} onWordRightClick={vi.fn()} onRetryMessage={onRetry} />,
    );
    const card = screen.getByTestId('failed-note');
    expect(card).toHaveTextContent(/gemini/i);
    expect(card).toHaveTextContent(/overloaded/i);
    fireEvent.click(screen.getByTestId('retry-button'));
    expect(onRetry).toHaveBeenCalledWith(givenUp);
  });

  it('offers the local model as the always-available way out', () => {
    render(
      <MessageBubble
        message={givenUp}
        onWordRightClick={vi.fn()}
        hasLocalModel
        onRetryLocalModel={vi.fn()}
      />,
    );
    expect(screen.getByTestId('retry-local-button')).toBeInTheDocument();
  });
});
