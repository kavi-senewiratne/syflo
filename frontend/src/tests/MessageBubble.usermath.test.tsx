/**
 * MessageBubble.usermath.test.tsx
 *
 * User messages and the thinking panel are plain text by design (no
 * markdown), but they carry $…$ math: "Ask in chat" quotes come from KaTeX
 * selections, users type formulas, and reasoning models think in LaTeX.
 * These must render through MathText, not as raw delimiters
 * (audit 2026-07-28).
 */

import { render, fireEvent, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MessageBubble } from '../components/ChatArea/MessageBubble';
import type { Message } from '../types';

const base: Omit<Message, 'content'> = {
  id: 'm1',
  chat_id: 'c1',
  role: 'user',
  created_at: '2026-07-28T10:00:00Z',
  attachments: [],
};

describe('MessageBubble – math in plain-text renders', () => {
  it('renders $…$ in the user message body as KaTeX', () => {
    const msg: Message = { ...base, content: 'Was bedeutet $w_{t-1}$ hier?' };
    const { container } = render(<MessageBubble message={msg} onWordRightClick={vi.fn()} />);
    expect(container.querySelector('.katex')).not.toBeNull();
    expect(container.textContent).not.toContain('$w_{t-1}$');
  });

  it('renders $…$ in the leading Ask-in-chat quote as KaTeX', () => {
    const msg: Message = { ...base, content: '> Energie $E(w_t)$ erklärt\n\nWarum?' };
    const { container } = render(<MessageBubble message={msg} onWordRightClick={vi.fn()} />);
    const quote = container.querySelector('[data-testid="user-message-quote"]');
    expect(quote).not.toBeNull();
    expect(quote!.querySelector('.katex')).not.toBeNull();
  });

  it('renders $…$ inside the thinking panel as KaTeX', () => {
    const msg: Message = {
      ...base,
      id: 'm2',
      role: 'assistant',
      content: 'Antwort.',
      reasoning: 'Erst $\\sum_i y_i$ betrachten…',
    };
    const { container } = render(<MessageBubble message={msg} onWordRightClick={vi.fn()} />);
    fireEvent.click(screen.getByTestId('thinking-toggle'));
    const panel = screen.getByTestId('thinking-panel');
    expect(panel.querySelector('.katex')).not.toBeNull();
  });
});
