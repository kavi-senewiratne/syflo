import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Sidebar } from '../components/Sidebar';
import type { Category, Chat } from '../types';

/**
 * The date sections under one parent — design/mockup-sidebar-timeline-group.html,
 * variant B (user decision 2026-08-16).
 *
 * B's whole point is what does NOT move: the parent is an 11 px heading like
 * "Pinned", the date headings indent under it, and the CHATS stay exactly where
 * they are. The tests below pin down both halves of that.
 */

const now = new Date().toISOString();
const yesterday = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();

const chat = (id: string, title: string, extra: Partial<Chat> = {}): Chat => ({
  id, title, parent_id: null, parent_word: null, created_at: now, children: [], ...extra,
});

const category = (id: string, name: string, extra: Partial<Category> = {}): Category => ({
  id, name, parent_id: null, position: 0, collapsed: 0, created_at: now, ...extra,
});

const handlers = {
  onSelect: vi.fn(),
  onNewChat: vi.fn(),
  onDelete: vi.fn(),
  onRename: vi.fn(),
  onTogglePin: vi.fn(),
  onToggleView: vi.fn(),
  onOpenSettings: vi.fn(),
  onOpenFeedback: vi.fn(),
  onToggleCollapsed: vi.fn(),
  onCreateCategory: vi.fn(),
  onRenameCategory: vi.fn(),
  onDeleteCategory: vi.fn(),
  onToggleCategoryCollapsed: vi.fn(),
  onMoveChatToCategory: vi.fn(),
};

const baseProps = {
  ...handlers,
  chats: [] as Chat[],
  categories: [] as Category[],
  activeChatId: null,
  viewMode: 'chat' as const,
  collapsed: false,
};

const twoDays = [chat('1', 'SearXNG rate limits'), chat('2', 'Gemini error arrays', { created_at: yesterday })];

beforeEach(() => {
  localStorage.clear();
  Object.values(handlers).forEach(fn => fn.mockClear());
});

describe('the timeline parent', () => {
  it('announces itself above the date sections, with a clock', () => {
    render(<Sidebar {...baseProps} chats={twoDays} />);

    const heading = screen.getByTestId('timeline-group-label');
    expect(heading).toHaveTextContent('History');
    expect(heading.querySelector('svg.lucide-clock')).toBeTruthy();

    // It stands before the first date heading, not after it.
    const firstDate = screen.getAllByTestId('chat-group-label')[0];
    expect(heading.compareDocumentPosition(firstDate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('does not exist when every chat is pinned or filed — it would head nothing', () => {
    render(<Sidebar
      {...baseProps}
      categories={[category('c1', 'Robotics')]}
      chats={[chat('1', 'Gripper limits', { category_id: 'c1' })]}
    />);
    expect(screen.queryByTestId('timeline-group-label')).not.toBeInTheDocument();
  });

  it('puts the whole clock side away in one click, and says how much it hid', () => {
    render(<Sidebar {...baseProps} chats={twoDays} />);
    fireEvent.click(screen.getByTestId('timeline-group-label'));

    expect(screen.queryByTestId('chat-group-label')).not.toBeInTheDocument();
    expect(screen.queryByText('SearXNG rate limits')).not.toBeInTheDocument();
    expect(screen.queryByText('Gemini error arrays')).not.toBeInTheDocument();
    expect(screen.getByTestId('timeline-group-label')).toHaveTextContent('2');
  });

  it('gives each date section back the state the user left it in', () => {
    render(<Sidebar {...baseProps} chats={twoDays} />);

    // Close "Yesterday" by hand, then close and reopen the whole timeline.
    const [, yesterdayHeading] = screen.getAllByTestId('chat-group-label');
    fireEvent.click(yesterdayHeading);
    expect(screen.queryByText('Gemini error arrays')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('timeline-group-label'));
    fireEvent.click(screen.getByTestId('timeline-group-label'));

    // Today is back; Yesterday is still closed — the parent hid them, it did
    // not reset them.
    expect(screen.getByText('SearXNG rate limits')).toBeInTheDocument();
    expect(screen.queryByText('Gemini error arrays')).not.toBeInTheDocument();
  });

  it('survives a remount closed', () => {
    const { unmount } = render(<Sidebar {...baseProps} chats={twoDays} />);
    fireEvent.click(screen.getByTestId('timeline-group-label'));
    unmount();

    render(<Sidebar {...baseProps} chats={twoDays} />);
    expect(screen.queryByTestId('chat-group-label')).not.toBeInTheDocument();
  });
});

describe('what variant B deliberately leaves alone', () => {
  // User decision 2026-08-16, fourth look: NO chat is indented anywhere. A
  // filed chat is marked by the heading above it, exactly the way a chat from
  // yesterday is — the sidebar has one left edge and no exceptions.
  it('does not move the chats — no chat row is indented, filed or not', () => {
    render(<Sidebar
      {...baseProps}
      categories={[category('c1', 'Robotics')]}
      chats={[chat('1', 'SearXNG rate limits'), chat('2', 'Gripper limits', { category_id: 'c1' })]}
    />);

    const inTimeline = screen.getByText('SearXNG rate limits').closest('[data-focus-item]')!;
    const inCategory = screen.getByText('Gripper limits').closest('[data-focus-item]')!;
    expect(inCategory.className).toContain('pl-2.5');
    expect(inCategory.className).not.toContain('pl-7');
    expect(inTimeline.className).toBe(inCategory.className);
  });

  it('keeps Pinned a heading too — the top level has one grammar', () => {
    render(<Sidebar {...baseProps} chats={[
      chat('1', 'SearXNG rate limits'),
      chat('2', 'Instruction sandwich', { pinned_at: '2026-08-16T10:00:00Z' }),
    ]} />);

    const pinned = screen.getByTestId('pinned-group-label');
    const timeline = screen.getByTestId('timeline-group-label');
    expect(pinned.tagName).toBe(timeline.tagName);
    // Same rank, same tone: both are top-level sections carrying a symbol,
    // so both take the darker gray-500 (user, 2026-08-16).
    expect(pinned.className).toContain('text-gray-500');
    expect(timeline.className).toContain('text-gray-500');
    // Both carry a symbol in the same reserved slot.
    expect(pinned.querySelector('svg.lucide-pin')).toBeTruthy();
    expect(timeline.querySelector('svg.lucide-clock')).toBeTruthy();
  });

  // User decision 2026-08-16, third look: a heading with no symbol has NO gap
  // where a symbol would go. The reserved slot was meant to align the labels,
  // but an empty box between the chevron and the word simply reads as an
  // indent — which is the very thing that was just removed.
  it('leaves no hole where a symbol would be — the word follows the chevron', () => {
    render(<Sidebar {...baseProps} chats={twoDays} />);
    const child = screen.getAllByTestId('chat-group-label')[0];

    expect(child.className).toContain('pl-2.5');
    expect(child.className).not.toContain('pl-7');
    // Chevron, then the label. Nothing between them.
    const boxes = [...child.children].map(el => el.tagName.toLowerCase());
    expect(boxes[0]).toBe('svg');
    expect(boxes[1]).toBe('span');
    expect(child.children[1]).toHaveTextContent('Today');
  });

  it('still gives Pinned and the timeline their symbols', () => {
    render(<Sidebar {...baseProps} chats={[
      ...twoDays,
      chat('3', 'Instruction sandwich', { pinned_at: '2026-08-16T10:00:00Z' }),
    ]} />);
    expect(screen.getByTestId('pinned-group-label').querySelector('svg.lucide-pin')).toBeTruthy();
    expect(screen.getByTestId('timeline-group-label').querySelector('svg.lucide-clock')).toBeTruthy();
  });

  it('marks the parent darker than its children — 18 px of white is not enough on its own', () => {
    render(<Sidebar {...baseProps} chats={twoDays} />);
    expect(screen.getByTestId('timeline-group-label').className).toContain('text-gray-500');
    expect(screen.getAllByTestId('chat-group-label')[0].className).toContain('text-gray-400');
  });
});

describe('the header', () => {
  it('has no new-category button — creating one lives in a chat’s right-click menu', () => {
    render(<Sidebar {...baseProps} chats={twoDays} />);
    expect(screen.queryByLabelText('New category')).not.toBeInTheDocument();
    // The way in is still there.
    fireEvent.contextMenu(screen.getByText('SearXNG rate limits'));
    fireEvent.click(screen.getByText('Move to category'));
    expect(screen.getByText(/New category/)).toBeInTheDocument();
  });
});
