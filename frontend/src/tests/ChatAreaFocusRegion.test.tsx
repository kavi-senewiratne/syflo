import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ChatArea } from '../components/ChatArea';
import type { ChatDetail } from '../types';

/**
 * A keyboard region the user cannot see must not hold the focus ring
 * (ADR-0011). The highlights drawer's overlay variant covers the chat column
 * entirely — found in the running app, where the ring could walk behind it.
 */

const chat: ChatDetail = {
  id: '1',
  title: 'Attention Is All You Need',
  parent_id: null,
  parent_word: null,
  created_at: new Date().toISOString(),
  messages: [
    { id: 'm1', chat_id: '1', role: 'user', content: 'Why divide by sqrt(d_k)?', created_at: new Date().toISOString() },
  ],
  children: [],
};

const props = {
  chat,
  loading: false,
  streaming: false,
  onSendMessage: vi.fn(),
  onWordRightClick: vi.fn(),
  onSelectChat: vi.fn(),
};

describe('ChatArea as a keyboard region', () => {
  it('is a region while the chat column is visible', () => {
    const { container } = render(<ChatArea {...props} />);

    expect(container.querySelector('[data-focus-region="chat"]')).not.toBeNull();
  });

  it('stops being a region while the highlights drawer covers it', () => {
    const { container } = render(
      <ChatArea {...props} highlightsDrawer={<div>drawer</div>} />,
    );

    expect(container.querySelector('[data-focus-region="chat"]')).toBeNull();
  });
});
