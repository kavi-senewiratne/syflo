/**
 * QuoteJump.test.tsx
 *
 * Clicking the quote of an "Ask in chat" question jumps back to the passage
 * it was taken from (design/mockup-quote-jump-to-source.html, variant A).
 *
 * The rules the mockup fixed:
 *   - only a message that carries an anchor (quote_highlight_id) is clickable
 *     — older messages and PDF quotes saved without a color stay dead text;
 *   - a click that ends a text selection is NOT a jump (the user was quoting,
 *     not navigating);
 *   - the resting look is unchanged, so nothing about the bubble moves.
 */

import { render, fireEvent, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageBubble } from '../components/ChatArea/MessageBubble';
import { ChatArea } from '../components/ChatArea';
import type { ChatDetail, Message } from '../types';

const quoted: Message = {
  id: 'm1',
  chat_id: 'c1',
  role: 'user',
  created_at: '2026-08-08T10:00:00Z',
  attachments: [],
  content: '> 0,5 × 0,5 = 0,25\n\nWarum multiplizieren wir?',
  quote_highlight_id: 'hl-1',
};

function quoteEl(container: HTMLElement) {
  return container.querySelector('[data-testid="user-message-quote"]') as HTMLElement;
}

describe('MessageBubble – clickable quote', () => {
  beforeEach(() => {
    // jsdom keeps a live Selection between tests; start collapsed.
    window.getSelection()?.removeAllRanges();
  });

  it('calls onQuoteClick with the message when the quote is clicked', () => {
    const onQuoteClick = vi.fn();
    const { container } = render(
      <MessageBubble message={quoted} onWordRightClick={vi.fn()} onQuoteClick={onQuoteClick} />,
    );
    fireEvent.click(quoteEl(container));
    expect(onQuoteClick).toHaveBeenCalledWith(quoted);
  });

  it('marks the quote as a control and gives it a jump tooltip', () => {
    const { container } = render(
      <MessageBubble message={quoted} onWordRightClick={vi.fn()} onQuoteClick={vi.fn()} />,
    );
    const quote = quoteEl(container);
    expect(quote.getAttribute('role')).toBe('button');
    expect(quote.getAttribute('tabindex')).toBe('0');
    expect(quote.getAttribute('title')).toBeTruthy();
    expect(quote.className).toContain('syflo-quote-link');
  });

  it('jumps on Enter and Space, for keyboard users', () => {
    const onQuoteClick = vi.fn();
    const { container } = render(
      <MessageBubble message={quoted} onWordRightClick={vi.fn()} onQuoteClick={onQuoteClick} />,
    );
    fireEvent.keyDown(quoteEl(container), { key: 'Enter' });
    fireEvent.keyDown(quoteEl(container), { key: ' ' });
    expect(onQuoteClick).toHaveBeenCalledTimes(2);
  });

  it('leaves a quote without an anchor as dead text', () => {
    // Messages sent before the feature, and PDF quotes saved without a color
    // (no highlight row exists), carry no anchor.
    const { container } = render(
      <MessageBubble
        message={{ ...quoted, quote_highlight_id: null }}
        onWordRightClick={vi.fn()}
        onQuoteClick={vi.fn()}
      />,
    );
    const quote = quoteEl(container);
    expect(quote.getAttribute('role')).toBeNull();
    expect(quote.className).not.toContain('syflo-quote-link');
  });

  it('does not jump when the click ends a text selection', () => {
    // "Ask in chat" on a quote must keep working: marking the quoted text
    // and releasing the mouse inside it is a selection, not navigation.
    const onQuoteClick = vi.fn();
    const { container } = render(
      <MessageBubble message={quoted} onWordRightClick={vi.fn()} onQuoteClick={onQuoteClick} />,
    );
    const quote = quoteEl(container);
    const range = document.createRange();
    range.selectNodeContents(quote);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    fireEvent.click(quote);
    expect(onQuoteClick).not.toHaveBeenCalled();
  });
});

describe('ChatArea – the sent quote carries its anchor', () => {
  const chat: ChatDetail = {
    id: 'c1',
    title: 'Münzwürfe',
    created_at: '2026-08-08T10:00:00Z',
    updated_at: '2026-08-08T10:00:00Z',
    parent_id: null,
    parent_word: null,
    messages: [],
    children: [],
  } as unknown as ChatDetail;

  it('sends the highlight id of the composer quote along with the question', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined);
    render(
      <ChatArea
        chat={chat}
        loading={false}
        streaming={false}
        onSendMessage={onSendMessage}
        onWordRightClick={vi.fn()}
        onSelectChat={vi.fn()}
        composerQuote={{
          text: '0,5 × 0,5 = 0,25',
          sourceLabel: 'Münzwürfe',
          color: 'yellow',
          highlightId: 'hl-1',
        }}
      />,
    );
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Warum multiplizieren wir?' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await vi.waitFor(() => expect(onSendMessage).toHaveBeenCalled());
    const [content, , targetChatId, quoteHighlightId] = onSendMessage.mock.calls[0];
    expect(content).toBe('> 0,5 × 0,5 = 0,25\n\nWarum multiplizieren wir?');
    expect(targetChatId).toBeUndefined();
    expect(quoteHighlightId).toBe('hl-1');
  });

  it('sends no anchor when the question goes out without a quote', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined);
    render(
      <ChatArea
        chat={chat}
        loading={false}
        streaming={false}
        onSendMessage={onSendMessage}
        onWordRightClick={vi.fn()}
        onSelectChat={vi.fn()}
      />,
    );
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Einfach nur eine Frage' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await vi.waitFor(() => expect(onSendMessage).toHaveBeenCalled());
    expect(onSendMessage.mock.calls[0][3]).toBeNull();
  });
});
