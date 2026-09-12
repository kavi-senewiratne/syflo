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

  // The header links are the only way back to a branch's origin; without a
  // data-focus-item the keyboard walk skips them entirely (user report
  // 2026-09-12).
  it('exposes the "Branched from" quote as a keyboard item', () => {
    const branchChat: ChatDetail = {
      ...chat,
      id: '2',
      parent_id: '1',
      parent_word: 'the working draft is currently being refined',
    };
    const { container } = render(<ChatArea {...props} chat={branchChat} />);

    const item = container.querySelector('[data-focus-item="chat-branched-from"]');
    expect(item).not.toBeNull();
    expect(item?.getAttribute('role')).toBe('link');
  });

  it('exposes the topic-branch trace-back link as a keyboard item', () => {
    const topicBranch: ChatDetail = {
      ...chat,
      id: '3',
      parent_id: '1',
      parent_word: null,
      branch_origin: 'topic',
    };
    const { container } = render(<ChatArea {...props} chat={topicBranch} />);

    const item = container.querySelector('[data-focus-item="chat-trace-back"]');
    expect(item).not.toBeNull();
    expect(item?.getAttribute('role')).toBe('link');
  });
});
