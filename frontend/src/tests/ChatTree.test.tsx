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

  it('snaps line thickness to whole device pixels at fractional zoom', () => {
    const original = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 2.2, configurable: true });
    try {
      render(<ChatTree chats={nestedChats} {...baseProps} />);
      // 1 CSS px would be 2.2 device px — snapped per element to 2 or 3 and
      // therefore visibly uneven; floor(dpr)/dpr paints 2 device px everywhere.
      const expected = `${Math.floor(2.2) / 2.2}px`;
      expect(screen.getByTestId('tree-trunk-end').style.width).toBe(expected);
      expect(screen.getByTestId('tree-elbow').style.height).toBe(expected);
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { value: original, configurable: true });
    }
  });

  it('recomputes the line thickness when zoom changes (resize event)', () => {
    const original = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
    try {
      render(<ChatTree chats={nestedChats} {...baseProps} />);
      expect(screen.getByTestId('tree-elbow').style.height).toBe('1px');
      Object.defineProperty(window, 'devicePixelRatio', { value: 1.5, configurable: true });
      fireEvent(window, new Event('resize'));
      // floor(1.5) = 1 device px — the thinner snap, never the bulkier one.
      expect(screen.getByTestId('tree-elbow').style.height).toBe(`${Math.floor(1.5) / 1.5}px`);
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { value: original, configurable: true });
    }
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

describe('ChatTree – path highlight (design/mockup-tree-path-highlight.html, variant B)', () => {
  const deepChats: Chat[] = [
    {
      id: '1', title: 'Root', parent_id: null, parent_word: null, created_at: '',
      children: [
        {
          id: '2', title: 'On path', parent_id: '1', parent_word: null, created_at: '',
          children: [
            { id: '3', title: 'Active leaf', parent_id: '2', parent_word: null, created_at: '', children: [] },
          ],
        },
        { id: '4', title: 'Off path', parent_id: '1', parent_word: null, created_at: '', children: [] },
      ],
    },
  ];

  const fullPath = new Set(['1', '2', '3']);

  it('colors the elbow of every node on the path to the active chat', () => {
    render(<ChatTree chats={deepChats} {...baseProps} activeChatId="3" activePathIds={fullPath} />);
    // 'On path' hangs off the root, 'Active leaf' hangs off 'On path' — both
    // elbows together trace the chain from the root down to the active chat.
    const colored = screen.getAllByTestId('tree-elbow').filter(e => e.className.includes('bg-blue-400'));
    expect(colored.length).toBe(2);
  });

  it('does NOT color the elbow of a sibling that is off the path', () => {
    render(<ChatTree chats={deepChats} {...baseProps} activeChatId="3" activePathIds={fullPath} />);
    const offPathElbow = screen.getByText('Off path').closest('[data-testid="tree-child"]')?.querySelector('[data-testid="tree-elbow"]');
    expect(offPathElbow?.className).toContain('bg-slate-300');
  });

  it('stops the colored trunk at the on-path child’s elbow — the rest carries later siblings', () => {
    // Regression (user report 2026-08-01): 'On path' is not the last sibling,
    // so its trunk segment continues past its own subtree down to 'Off path'.
    // Coloring the whole segment drew a line beside unrelated rows.
    render(<ChatTree chats={deepChats} {...baseProps} activeChatId="3" activePathIds={fullPath} />);
    const wrapper = screen.getByText('On path').closest('[data-testid="tree-child"]')!;
    const colored = wrapper.querySelector('[data-testid="tree-trunk-path"]') as HTMLElement;
    const remainder = wrapper.querySelector('[data-testid="tree-trunk"]') as HTMLElement;
    // colored piece ends at the elbow (top -2, height 18 → y = 16)
    expect(colored.style.height).toBe('18px');
    expect(colored.style.bottom).toBe('');
    // the continuation below it stays neutral and runs to the wrapper's end
    expect(remainder.className).toContain('bg-slate-300');
    expect(remainder.style.top).toBe('16px');
    expect(remainder.style.bottom).toBe('0px');
  });

  it('colors an earlier sibling’s trunk in full — it is the run down to the on-path child', () => {
    const laterChild: Chat[] = [
      {
        id: '1', title: 'Root', parent_id: null, parent_word: null, created_at: '',
        children: [
          { id: '2', title: 'Before', parent_id: '1', parent_word: null, created_at: '', children: [] },
          { id: '3', title: 'Active', parent_id: '1', parent_word: null, created_at: '', children: [] },
        ],
      },
    ];
    render(<ChatTree chats={laterChild} {...baseProps} activeChatId="3" activePathIds={new Set(['1', '3'])} />);
    const beforeTrunk = screen.getByText('Before').closest('[data-testid="tree-child"]')?.querySelector('[data-testid="tree-trunk"]');
    expect(beforeTrunk?.className).toContain('bg-blue-400');
    // …but its own elbow points at an off-path row, so it stays neutral
    const beforeElbow = screen.getByText('Before').closest('[data-testid="tree-child"]')?.querySelector('[data-testid="tree-elbow"]');
    expect(beforeElbow?.className).toContain('bg-slate-300');
  });

  it('stacks the chat row above the connectors so no line runs into the pill', () => {
    // Regression (user report 2026-08-01): the elbow overshoots the row's left
    // edge by 6px, so on the selected row it was drawn inside the rounded pill.
    render(<ChatTree chats={deepChats} {...baseProps} activeChatId="3" activePathIds={fullPath} />);
    const activeRow = screen.getByText('Active leaf').closest('div');
    expect(activeRow?.className).toContain('relative');
    expect(activeRow?.className).toContain('z-[1]');
  });

  it('does not color any connector without activePathIds', () => {
    render(<ChatTree chats={deepChats} {...baseProps} activeChatId="3" />);
    expect(screen.queryByTestId('tree-trunk-path')).not.toBeInTheDocument();
    screen.getAllByTestId(/tree-trunk|tree-elbow/).forEach(line => {
      expect(line.className).toContain('bg-slate-300');
    });
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

describe('ChatTree – the row whose context menu is open stays marked (design/mockup-context-menu-target.html, variant A)', () => {
  const rowOf = (title: string) => screen.getByText(title).closest('div') as HTMLElement;

  it('holds the hover pill on the row the menu belongs to', () => {
    render(<ChatTree chats={flatChats} {...baseProps} contextMenuId="1" />);
    expect(rowOf('Alpha').classList.contains('bg-gray-100')).toBe(true);
    // Every other row keeps its neutral styling.
    expect(rowOf('Beta').classList.contains('bg-gray-100')).toBe(false);
  });

  it('deepens the active row instead of graying it, so it still reads as the open chat', () => {
    render(<ChatTree chats={flatChats} {...baseProps} activeChatId="1" contextMenuId="1" />);
    const row = rowOf('Alpha');
    expect(row.classList.contains('bg-blue-100')).toBe(true);
    expect(row.classList.contains('bg-gray-100')).toBe(false);
  });

  it('marks nothing while no menu is open', () => {
    render(<ChatTree chats={flatChats} {...baseProps} />);
    expect(rowOf('Alpha').classList.contains('bg-gray-100')).toBe(false);
    expect(rowOf('Beta').classList.contains('bg-gray-100')).toBe(false);
  });

  it('also marks a child row deep in the tree', () => {
    render(<ChatTree chats={nestedChats} {...baseProps} contextMenuId="2" />);
    expect(rowOf('Child Chat').classList.contains('bg-gray-100')).toBe(true);
    expect(rowOf('Parent Chat').classList.contains('bg-gray-100')).toBe(false);
  });
});
