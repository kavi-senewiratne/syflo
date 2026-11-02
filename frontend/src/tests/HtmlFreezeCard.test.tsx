/**
 * HtmlFreezeCard.test.tsx
 *
 * The warning card under the FIRST answer of an HTML tree
 * (design/mockup-html-app.html, variant B; ADR-0013 decision 7): one line
 * naming the culprit, each resource with its exact reason, one accent-pill
 * exit. Under the answer, never instead of it, and one card per bubble.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MessageBubble } from '../components/ChatArea/MessageBubble';
import { CARD_ACTION_BTN } from '../components/ChatArea/cardActionButton';
import type { Message } from '../types';

const answer: Message = {
  id: 'a1',
  chat_id: 'c1',
  role: 'assistant',
  content: 'Die Vorlesung hat vier Teile.',
  created_at: new Date().toISOString(),
};

const unfrozen = [
  { url: 'https://cdnjs.cloudflare.com/mathjax.js', kind: 'script', reason: 'no-internet' },
  { url: 'https://fonts.googleapis.com/plex', kind: 'font', reason: 'too-large' },
];

function renderBubble(over: Partial<Message> = {}, props: Partial<React.ComponentProps<typeof MessageBubble>> = {}) {
  const onRetry = vi.fn();
  render(
    <MessageBubble
      message={{ ...answer, ...over }}
      onWordRightClick={vi.fn()}
      htmlFreeze={{ unfrozen, retrying: false, onRetry }}
      {...props}
    />,
  );
  return { onRetry };
}

describe('the HTML freeze card', () => {
  it('names the culprit and lists every resource with its exact reason', () => {
    renderBubble();
    const card = screen.getByTestId('html-freeze-card');
    expect(card).toHaveTextContent('2 resources not frozen');
    expect(card).toHaveTextContent('mathjax.js (cdnjs.cloudflare.com): no internet');
    expect(card).toHaveTextContent('plex (fonts.googleapis.com): too large');
  });

  it('sits under the answer text, not instead of it', () => {
    renderBubble();
    expect(screen.getByText('Die Vorlesung hat vier Teile.')).toBeInTheDocument();
  });

  it('offers one accent-pill exit that retries', () => {
    const { onRetry } = renderBubble();
    const btn = screen.getByRole('button', { name: 'Try again' });
    expect(btn.className).toContain(CARD_ACTION_BTN.split(' ')[0]);
    expect(btn.className).toContain('bg-blue-50');
    fireEvent.click(btn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('is busy while a retry runs and cannot be clicked twice', () => {
    const onRetry = vi.fn();
    render(
      <MessageBubble
        message={answer}
        onWordRightClick={vi.fn()}
        htmlFreeze={{ unfrozen, retrying: true, onRetry }}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Try again' });
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn).toBeDisabled();
  });

  it('uses the singular for one resource', () => {
    render(
      <MessageBubble
        message={answer}
        onWordRightClick={vi.fn()}
        htmlFreeze={{ unfrozen: [unfrozen[0]], retrying: false, onRetry: vi.fn() }}
      />,
    );
    expect(screen.getByTestId('html-freeze-card')).toHaveTextContent('1 resource not frozen');
  });

  it('is absent when everything is frozen', () => {
    render(
      <MessageBubble
        message={answer}
        onWordRightClick={vi.fn()}
        htmlFreeze={{ unfrozen: [], retrying: false, onRetry: vi.fn() }}
      />,
    );
    expect(screen.queryByTestId('html-freeze-card')).not.toBeInTheDocument();
  });

  it('is absent without the prop (every other answer)', () => {
    render(<MessageBubble message={answer} onWordRightClick={vi.fn()} />);
    expect(screen.queryByTestId('html-freeze-card')).not.toBeInTheDocument();
  });

  it('yields to a truncated-answer card: one card per bubble', () => {
    renderBubble({ truncated: 1 } as Partial<Message>);
    expect(screen.queryByTestId('html-freeze-card')).not.toBeInTheDocument();
    expect(screen.getByTestId('truncated-note')).toBeInTheDocument();
  });

  it('waits while the answer is still being written', () => {
    renderBubble({}, { isStreaming: true });
    expect(screen.queryByTestId('html-freeze-card')).not.toBeInTheDocument();
  });

  it('does not hang under a failed answer', () => {
    renderBubble({ content: '*Failed*' });
    expect(screen.queryByTestId('html-freeze-card')).not.toBeInTheDocument();
  });
});
