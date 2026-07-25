/**
 * ChatTree.test.tsx
 *
 * Tests for the ChatTree and TreeNode components that render the hierarchical
 * chat list inside the sidebar's expanded view.
 * Covers: rendering, expand/collapse, chat selection, right-click context menu,
 * inline rename, and the parent_word badge that was removed for a cleaner sidebar.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ChatTree } from '../components/Sidebar/ChatTree';
import type { Chat } from '../types';

const flatChats: Chat[] = [
  { id: '1', title: 'Alpha', parent_id: null, parent_word: null, created_at: '', children: [] },
  { id: '2', title: 'Beta', parent_id: null, parent_word: null, created_at: '', children: [] },
];

const nestedChats: Chat[] = [
  {
    id: '1',
    title: 'Parent Chat',
    parent_id: null,
    parent_word: null,
    created_at: '',
    children: [
      { id: '2', title: 'Child Chat', parent_id: '1', parent_word: 'quantum', created_at: '', children: [] },
    ],
  },
];

const baseProps = {
  activeChatId: null,
  renamingId: null,
  onSelect: vi.fn(),
  onContextMenu: vi.fn(),
  onRenameSubmit: vi.fn(),
  onRenameCancel: vi.fn(),
};

describe('ChatTree – rendering', () => {
  it('renders all root-level chat titles', () => {
    render(<ChatTree chats={flatChats} {...baseProps} />);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('renders child chats', () => {
    render(<ChatTree chats={nestedChats} {...baseProps} />);
    expect(screen.getByText('Parent Chat')).toBeInTheDocument();
    expect(screen.getByText('Child Chat')).toBeInTheDocument();
  });

  it('does NOT show the parent_word badge — removed for a cleaner sidebar', () => {
    render(<ChatTree chats={nestedChats} {...baseProps} />);
    expect(screen.queryByText('quantum')).not.toBeInTheDocument();
  });

  it('does NOT show a trash icon — delete moved to right-click context menu', () => {
    render(<ChatTree chats={flatChats} {...baseProps} />);
    expect(screen.queryByTitle('Delete chat')).not.toBeInTheDocument();
  });

  it('exposes the full title as a tooltip on each row', () => {
    render(<ChatTree chats={flatChats} {...baseProps} />);
    const row = screen.getByText('Alpha').closest('div');
    expect(row?.getAttribute('title')).toBe('Alpha');
  });

  it('highlights the active chat', () => {
    render(<ChatTree chats={flatChats} {...baseProps} activeChatId="1" />);
    const activeRow = screen.getByText('Alpha').closest('div');
    expect(activeRow?.className).toContain('bg-blue-50');
  });

  it('does not highlight inactive chats', () => {
    render(<ChatTree chats={flatChats} {...baseProps} activeChatId="1" />);
    const inactiveRow = screen.getByText('Beta').closest('div');
    expect(inactiveRow?.className).not.toContain('bg-blue-50');
  });

  it('zeigt den PDF-Tag nur an Knoten mit paper_id (ADR-0002)', () => {
    const withPaper: Chat[] = [
      { ...flatChats[0], paper_id: 'p1' },
      flatChats[1],
    ];
    render(<ChatTree chats={withPaper} {...baseProps} />);
    const tags = screen.getAllByTestId('tree-pdf-tag');
    expect(tags.length).toBe(1);
    expect(screen.getByText('Alpha').closest('div')).toContainElement(tags[0]);
  });

  it('zeigt den YT-Tag nur an Knoten mit video_id (ADR-0005)', () => {
    const withVideo: Chat[] = [
      { ...flatChats[0], video_id: 'v1' },
      flatChats[1],
    ];
    render(<ChatTree chats={withVideo} {...baseProps} />);
    const tags = screen.getAllByTestId('tree-yt-tag');
    expect(tags.length).toBe(1);
    expect(tags[0]).toHaveTextContent('YT');
    expect(screen.getByText('Alpha').closest('div')).toContainElement(tags[0]);
  });
});

describe('ChatTree – interactions', () => {
  it('calls onSelect with the correct id when a chat is clicked', () => {
    const onSelect = vi.fn();
    render(<ChatTree chats={flatChats} {...baseProps} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('Alpha'));
    expect(onSelect).toHaveBeenCalledWith('1');
  });

  it('calls onContextMenu with id and cursor coordinates on right-click', () => {
    const onContextMenu = vi.fn();
    render(<ChatTree chats={flatChats} {...baseProps} onContextMenu={onContextMenu} />);
    fireEvent.contextMenu(screen.getByText('Alpha'), { clientX: 100, clientY: 200 });
    expect(onContextMenu).toHaveBeenCalledWith('1', 100, 200);
  });

  it('renders an inline input when the row is in renaming state', () => {
    render(<ChatTree chats={flatChats} {...baseProps} renamingId="1" />);
    const input = screen.getByDisplayValue('Alpha');
    expect(input.tagName).toBe('INPUT');
  });

  it('Enter in the inline input submits the new title', () => {
    const onRenameSubmit = vi.fn();
    render(<ChatTree chats={flatChats} {...baseProps} renamingId="1" onRenameSubmit={onRenameSubmit} />);
    const input = screen.getByDisplayValue('Alpha');
    fireEvent.change(input, { target: { value: 'Alpha 2' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRenameSubmit).toHaveBeenCalledWith('1', 'Alpha 2');
  });

  it('Escape in the inline input cancels the rename', () => {
    const onRenameCancel = vi.fn();
    render(<ChatTree chats={flatChats} {...baseProps} renamingId="1" onRenameCancel={onRenameCancel} />);
    const input = screen.getByDisplayValue('Alpha');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onRenameCancel).toHaveBeenCalled();
  });
});

describe('ChatTree – connector lines', () => {
  it('shows trunk and elbow lines for nested branches, none for root-level chats', () => {
    render(<ChatTree chats={nestedChats} {...baseProps} />);
    // the child row is connected to its parent by a trunk segment and an elbow
    expect(screen.getAllByTestId(/tree-trunk/).length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('tree-elbow').length).toBe(1);
  });

  it('shows no connector lines when there are only root-level chats', () => {
    render(<ChatTree chats={flatChats} {...baseProps} />);
    expect(screen.queryByTestId(/tree-trunk/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('tree-elbow')).not.toBeInTheDocument();
  });

  it('ends the trunk at the last sibling — no dangling line below it', () => {
    const threeChildren: Chat[] = [
      {
        id: '1', title: 'Parent', parent_id: null, parent_word: null, created_at: '',
        children: [
          { id: '2', title: 'First', parent_id: '1', parent_word: null, created_at: '', children: [] },
          { id: '3', title: 'Middle', parent_id: '1', parent_word: null, created_at: '', children: [] },
          { id: '4', title: 'Last', parent_id: '1', parent_word: null, created_at: '', children: [] },
        ],
      },
    ];
    render(<ChatTree chats={threeChildren} {...baseProps} />);
    // non-last siblings carry a continuing trunk; only the last sibling gets the
    // terminating segment that stops at its row
    expect(screen.getAllByTestId('tree-trunk').length).toBe(2);
    expect(screen.getAllByTestId('tree-trunk-end').length).toBe(1);
    const end = screen.getByTestId('tree-trunk-end');
    expect(end.style.bottom).toBe('');
    expect(end.style.height).not.toBe('');
  });

  it('hides the children’s connector lines when the parent is collapsed', () => {
    render(<ChatTree chats={nestedChats} {...baseProps} />);
    const chevron = screen.getAllByRole('button').find(btn =>
      btn.closest('div')?.textContent?.includes('Parent Chat')
    );
    fireEvent.click(chevron!);
    expect(screen.queryByTestId(/tree-trunk/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('tree-elbow')).not.toBeInTheDocument();
  });
});

describe('ChatTree – expand / collapse', () => {
  it('shows child chats by default (expanded)', () => {
    render(<ChatTree chats={nestedChats} {...baseProps} />);
    expect(screen.getByText('Child Chat')).toBeInTheDocument();
  });

  it('hides child chats after clicking the collapse chevron', () => {
    render(<ChatTree chats={nestedChats} {...baseProps} />);
    const chevronButtons = screen.getAllByRole('button');
    const chevron = chevronButtons.find(btn =>
      btn.closest('div')?.textContent?.includes('Parent Chat')
    );
    fireEvent.click(chevron!);
    expect(screen.queryByText('Child Chat')).not.toBeInTheDocument();
  });

  it('shows child chats again after clicking the expand chevron twice', () => {
    render(<ChatTree chats={nestedChats} {...baseProps} />);
    const chevronButtons = screen.getAllByRole('button');
    const chevron = chevronButtons.find(btn =>
      btn.closest('div')?.textContent?.includes('Parent Chat')
    );
    fireEvent.click(chevron!);
    fireEvent.click(chevron!);
    expect(screen.getByText('Child Chat')).toBeInTheDocument();
  });
});
