/**
 * BranchTraceLine.test.tsx
 *
 * The branch line in the transcript (design/mockup-branch-trace.html,
 * variant A): what the parent chat shows after `/btw` or `/branch`, and the
 * way back from the branch's own header.
 */

import { render, fireEvent, screen, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ChatArea } from '../components/ChatArea';
import type { Chat, ChatDetail, Message } from '../types';

const message = (id: string, role: 'user' | 'assistant', content: string): Message => ({
  id,
  chat_id: 'parent',
  role,
  content,
  created_at: `2026-08-09T10:0${id.slice(1)}:00Z`,
  attachments: [],
} as unknown as Message);

const child = (
  id: string,
  origin: 'btw' | 'topic' | null,
  anchor: string | null,
  title = `Titel ${id}`,
  created_at = '2026-08-09T11:00:00Z',
): Chat => ({
  id,
  title,
  parent_id: 'parent',
  parent_word: origin === 'topic' ? null : 'eine Passage',
  created_at,
  branch_origin: origin,
  branch_anchor_message_id: anchor,
});

const parentChat = (children: Chat[]): ChatDetail => ({
  id: 'parent',
  title: 'Attention Is All You Need',
  parent_id: null,
  parent_word: null,
  created_at: '2026-08-09T09:00:00Z',
  messages: [
    message('m1', 'user', 'Erklär mir Multi-Head Attention.'),
    message('m2', 'assistant', 'Jeder Head lernt eine eigene Beziehung.'),
  ],
  children,
} as unknown as ChatDetail);

function renderChat(chat: ChatDetail, props: Record<string, unknown> = {}) {
  return render(
    <ChatArea
      chat={chat}
      loading={false}
      streaming={false}
      onSendMessage={vi.fn()}
      onWordRightClick={vi.fn()}
      onSelectChat={vi.fn()}
      {...props}
    />,
  );
}

describe('the branch line in the parent transcript', () => {
  it('draws a line for a /btw branch, naming the command and the branch', () => {
    renderChat(parentChat([child('kv', 'btw', 'm2', 'Was ist ein KV-Cache?')]));

    const line = screen.getByTestId('branch-trace-kv');
    expect(within(line).getByText('/btw')).toBeTruthy();
    expect(line.textContent).toContain('Was ist ein KV-Cache?');
  });

  it('names /branch for a topic branch', () => {
    renderChat(parentChat([child('rope', 'topic', 'm2', 'Rotary embeddings')]));

    expect(within(screen.getByTestId('branch-trace-rope')).getByText('/branch')).toBeTruthy();
  });

  it('draws nothing for a selection branch — the coloured passage is its trace', () => {
    renderChat(parentChat([child('passage', null, 'm2')]));

    expect(screen.queryByTestId('branch-trace-passage')).toBeNull();
    expect(screen.queryByTestId('branch-trace-group')).toBeNull();
  });

  it('puts the line right after its anchor message, not at the end', () => {
    const { container } = renderChat(parentChat([child('kv', 'btw', 'm1')]));

    const nodes = Array.from(
      container.querySelectorAll('[data-testid="message-row-m1"], [data-testid="branch-trace-kv"], [data-testid="message-row-m2"]'),
    ).map((el) => el.getAttribute('data-testid'));

    expect(nodes).toEqual(['message-row-m1', 'branch-trace-kv', 'message-row-m2']);
  });

  it('opens the branch when the line is clicked', () => {
    const onSelectChat = vi.fn();
    renderChat(parentChat([child('kv', 'btw', 'm2')]), { onSelectChat });

    fireEvent.click(screen.getByTestId('branch-trace-kv'));
    expect(onSelectChat).toHaveBeenCalledWith('kv');
  });

  it('turns the clicked pill into a spinner while the branch loads', () => {
    // Opening a branch takes about a second (user report 2026-08-09) — without
    // feedback the click reads as swallowed.
    renderChat(parentChat([child('kv', 'btw', 'm2'), child('rope', 'topic', 'm2')]), {
      onSelectChat: vi.fn(),
    });

    fireEvent.click(screen.getByTestId('branch-trace-kv'));

    expect(screen.getByTestId('branch-trace-kv').getAttribute('data-opening')).toBe('true');
    expect(screen.getByTestId('branch-trace-kv').querySelector('.animate-spin')).toBeTruthy();
    // The other lines stop accepting clicks while one is loading.
    expect((screen.getByTestId('branch-trace-rope') as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens a branch only once, however often the line is clicked', () => {
    const onSelectChat = vi.fn();
    renderChat(parentChat([child('kv', 'btw', 'm2')]), { onSelectChat });

    fireEvent.click(screen.getByTestId('branch-trace-kv'));
    fireEvent.click(screen.getByTestId('branch-trace-kv'));

    expect(onSelectChat).toHaveBeenCalledTimes(1);
  });

  it('folds a stack after two lines and unfolds on demand', () => {
    renderChat(parentChat([
      child('a', 'btw', 'm2', 'A', '2026-08-09T11:00:00Z'),
      child('b', 'topic', 'm2', 'B', '2026-08-09T12:00:00Z'),
      child('c', 'btw', 'm2', 'C', '2026-08-09T13:00:00Z'),
    ]));

    expect(screen.queryByTestId('branch-trace-c')).toBeNull();
    fireEvent.click(screen.getByTestId('branch-trace-more'));
    expect(screen.getByTestId('branch-trace-c')).toBeTruthy();
  });

  it('floats a line with a dead anchor to the top instead of dropping it', () => {
    const { container } = renderChat(parentChat([child('kv', 'btw', 'geloescht')]));

    const nodes = Array.from(
      container.querySelectorAll('[data-testid="branch-trace-kv"], [data-testid="message-row-m1"]'),
    ).map((el) => el.getAttribute('data-testid'));

    expect(nodes).toEqual(['branch-trace-kv', 'message-row-m1']);
  });
});

describe('the way back from the branch', () => {
  const topicBranch: ChatDetail = {
    id: 'rope',
    title: 'Rotary embeddings',
    parent_id: 'parent',
    parent_word: null,
    created_at: '2026-08-09T11:00:00Z',
    branch_origin: 'topic',
    branch_anchor_message_id: 'm2',
    messages: [message('m1', 'user', 'Rotary embeddings')],
    children: [],
  } as unknown as ChatDetail;

  it('shows a back-link naming the parent in a branch that has no quote', () => {
    renderChat(topicBranch, { parentTitle: 'Attention Is All You Need' });

    const link = screen.getByTestId('trace-back-link');
    expect(link.textContent).toContain('Attention Is All You Need');
  });

  it('keeps the branch title — the back-link does not replace it', () => {
    renderChat(topicBranch, { parentTitle: 'Attention Is All You Need' });

    expect(screen.getByRole('heading').textContent).toContain('Rotary embeddings');
  });

  it('calls the jump handler on click and on Enter', () => {
    const onBranchedFromClick = vi.fn();
    renderChat(topicBranch, { parentTitle: 'Parent', onBranchedFromClick });

    fireEvent.click(screen.getByTestId('trace-back-link'));
    fireEvent.keyDown(screen.getByTestId('trace-back-link'), { key: 'Enter' });
    expect(onBranchedFromClick).toHaveBeenCalledTimes(2);
  });

  it('offers no back-link in a root chat', () => {
    renderChat(parentChat([]));
    expect(screen.queryByTestId('trace-back-link')).toBeNull();
  });
});
