import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Sidebar } from '../components/Sidebar';
import type { Category, Chat } from '../types';

/**
 * Sidebar categories — design/mockup-sidebar-categories-v2.html.
 *
 * Categories are the third organising principle in the root list, and the only
 * one the user owns. The tests below describe what the sidebar SHOWS, never how
 * it stores it: a chat filed into a category leaves its date section, a closed
 * thing hides its contents, and a subcategory is a heading inside its parent.
 */

const now = new Date().toISOString();

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

beforeEach(() => {
  localStorage.clear();
  // Reset, not just clear: onCreateCategory now has a return value, and a
  // resolved category left over from one test would file chats in the next.
  Object.values(handlers).forEach(fn => fn.mockReset());
});

describe('a category and the chats in it', () => {
  it('lists a filed chat under its category and not in a date section', () => {
    render(<Sidebar
      {...baseProps}
      categories={[category('c1', 'Robotics')]}
      chats={[chat('1', 'Gripper limits', { category_id: 'c1' }), chat('2', 'SearXNG rate limits')]}
    />);

    const robotics = screen.getByTestId('category-c1');
    expect(within(robotics).getByText('Robotics')).toBeInTheDocument();
    // The filed chat sits inside the category's own block…
    expect(within(screen.getByTestId('category-body-c1')).getByText('Gripper limits')).toBeInTheDocument();
    // …and the date section holds only what is left over.
    const today = screen.getByTestId('date-section-Today');
    expect(within(today).getByText('SearXNG rate limits')).toBeInTheDocument();
    expect(within(today).queryByText('Gripper limits')).not.toBeInTheDocument();
  });

  it('hides the chats of a collapsed category and shows how many are hidden', () => {
    render(<Sidebar
      {...baseProps}
      categories={[category('c1', 'Robotics', { collapsed: 1 })]}
      chats={[chat('1', 'Gripper limits', { category_id: 'c1' })]}
    />);

    expect(screen.getByText('Robotics')).toBeInTheDocument();
    expect(screen.queryByTestId('category-body-c1')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('category-c1')).getByText('1')).toBeInTheDocument();
  });

  it('asks to collapse when the category row is clicked', () => {
    render(<Sidebar {...baseProps} categories={[category('c1', 'Robotics')]} />);
    fireEvent.click(screen.getByText('Robotics'));
    expect(handlers.onToggleCategoryCollapsed).toHaveBeenCalledWith('c1', true);
  });

  it('counts the chats of its subcategories too, because a closed row hides those as well', () => {
    render(<Sidebar
      {...baseProps}
      categories={[category('c1', 'Robotics', { collapsed: 1 }), category('c2', 'Teleop', { parent_id: 'c1' })]}
      chats={[chat('1', 'Gripper limits', { category_id: 'c1' }), chat('2', 'Recording rig', { category_id: 'c2' })]}
    />);
    expect(within(screen.getByTestId('category-c1')).getByText('2')).toBeInTheDocument();
  });

  // Same rule the date sections already follow: open, the rows say how many
  // there are, so the number is noise; closed, it is the only thing that
  // separates "closed" from "empty" (mockup §"The everyday state": a closed
  // thing is recognisable by two signals at once — chevron and count).
  it('drops the count while the category is open — the rows already say how many', () => {
    render(<Sidebar
      {...baseProps}
      categories={[category('c1', 'Robotics')]}
      chats={[chat('1', 'Gripper limits', { category_id: 'c1' }), chat('2', 'Recording rig', { category_id: 'c1' })]}
    />);
    expect(within(screen.getByTestId('category-label-c1')).queryByText('2')).not.toBeInTheDocument();
  });

  // The hint was removed on 2026-08-16: an empty category is self-evident, and
  // a two-line instruction under every one of them was noise the user read once.
  it('shows an empty category as just its row — no explanatory text', () => {
    render(<Sidebar {...baseProps} categories={[category('c1', 'Robotics')]} />);
    expect(screen.getByText('Robotics')).toBeInTheDocument();
    expect(screen.queryByText(/Empty/)).not.toBeInTheDocument();
    expect(screen.queryByText(/drag a chat here/i)).not.toBeInTheDocument();
  });
});

// User decision 2026-08-16, after seeing it in the app: FILING WINS. The
// morning's rule was the opposite — pinning won — and it made dragging a
// pinned chat into a category look broken: the chat moved in the database and
// nothing moved on screen.
describe('a chat that is both pinned and filed', () => {
  const both = [
    chat('1', 'A Neural Probabilistic Language Model', {
      pinned_at: '2026-08-11T22:39:32.572Z', category_id: 'c1',
    }),
    chat('2', 'Instruction sandwich', { pinned_at: '2026-08-12T10:00:00Z' }),
  ];

  it('is listed in its category, not in the pinned section', () => {
    render(<Sidebar {...baseProps} categories={[category('c1', 'Zero to Hero')]} chats={both} />);

    expect(within(screen.getByTestId('category-body-c1'))
      .getByText('A Neural Probabilistic Language Model')).toBeInTheDocument();
    // Exactly once on screen, and not under "Pinned".
    expect(screen.getAllByText('A Neural Probabilistic Language Model')).toHaveLength(1);
    const pinnedSection = screen.getByTestId('pinned-group-label').parentElement!;
    expect(pinnedSection.textContent).not.toContain('A Neural Probabilistic');
    // The chat that is only pinned still is.
    expect(pinnedSection.textContent).toContain('Instruction sandwich');
  });

  it('takes the pinned section away entirely once its last chat is filed', () => {
    render(<Sidebar
      {...baseProps}
      categories={[category('c1', 'Zero to Hero')]}
      chats={[both[0]]}
    />);
    expect(screen.queryByTestId('pinned-group-label')).not.toBeInTheDocument();
  });
});

// User decision 2026-08-16, fourth look: the categories wear the same clothes
// as the timeline. A category is a "Verlauf"-style heading (11 px uppercase,
// gray-500, with its folder), a subcategory a "Gestern"-style one (gray-400).
// The sidebar then has exactly two heading ranks and one row type.
describe('how a category is dressed', () => {
  it('matches the timeline parent, and its subcategory matches a date heading', () => {
    render(<Sidebar
      {...baseProps}
      categories={[category('c1', 'Robotics'), category('c2', 'Teleop data', { parent_id: 'c1' })]}
      chats={[chat('1', 'Gripper limits', { category_id: 'c1' }), chat('2', 'SearXNG rate limits')]}
    />);

    const cat = screen.getByTestId('category-label-c1');
    const sub = screen.getByTestId('subcategory-label-c2');
    const timeline = screen.getByTestId('timeline-group-label');
    const dateHeading = screen.getAllByTestId('chat-group-label')[0];

    for (const cls of ['text-[11px]', 'uppercase', 'tracking-wider', 'pl-2.5']) {
      expect(cat.className).toContain(cls);
      expect(sub.className).toContain(cls);
    }
    // Rank by colour, the same two steps the timeline uses.
    expect(cat.className).toContain('text-gray-500');
    expect(timeline.className).toContain('text-gray-500');
    expect(sub.className).toContain('text-gray-400');
    expect(dateHeading.className).toContain('text-gray-400');
    // The folder is what tells a category from the clock above it.
    expect(cat.querySelector('svg.lucide-folder')).toBeTruthy();
  });

  // The drop ring is drawn on this very element, so the element must be the
  // LABEL and nothing more. With the section gap as top padding the ring wrapped
  // 20 px of empty space above the words and read as an oversized box (user,
  // 2026-08-16). The gap therefore lives in the margin, outside the ring.
  it('keeps the section gap outside the box the drop ring is drawn on', () => {
    render(<Sidebar {...baseProps} categories={[category('c1', 'Robotics'), category('c2', 'Sub', { parent_id: 'c1' })]} />);

    for (const el of [screen.getByTestId('category-label-c1'), screen.getByTestId('subcategory-label-c2')]) {
      expect(el.className).toMatch(/\bmt-\d/);
      expect(el.className).not.toMatch(/\bpt-[3-9]\b/);
    }
  });
});

describe('a subcategory', () => {
  const nested = {
    categories: [category('c1', 'Robotics'), category('c2', 'Teleop data', { parent_id: 'c1' })],
    chats: [chat('1', 'Gripper limits', { category_id: 'c1' }), chat('2', 'Recording rig', { category_id: 'c2' })],
  };

  it('is a heading inside its parent, with its chats in the same column as the parent’s', () => {
    render(<Sidebar {...baseProps} {...nested} />);

    const parentBody = screen.getByTestId('category-body-c1');
    expect(within(parentBody).getByTestId('subcategory-label-c2')).toHaveTextContent('Teleop data');
    expect(within(screen.getByTestId('subcategory-body-c2')).getByText('Recording rig')).toBeInTheDocument();

    // §02-C: a chat in a subcategory is indented no further than one in the
    // category itself — the heading does the separating, not another step.
    const inParent = screen.getByText('Gripper limits').closest('[data-focus-item]')!;
    const inSub = screen.getByText('Recording rig').closest('[data-focus-item]')!;
    expect(inSub.className).toBe(inParent.className);
  });

  it('collapses on its own without closing its parent', () => {
    render(<Sidebar {...baseProps} {...nested} />);
    fireEvent.click(screen.getByTestId('subcategory-label-c2'));
    expect(handlers.onToggleCategoryCollapsed).toHaveBeenCalledWith('c2', true);
  });

  it('disappears with its parent when the parent is closed', () => {
    render(<Sidebar
      {...baseProps}
      {...nested}
      categories={[category('c1', 'Robotics', { collapsed: 1 }), category('c2', 'Teleop data', { parent_id: 'c1' })]}
    />);
    expect(screen.queryByTestId('subcategory-label-c2')).not.toBeInTheDocument();
  });
});

describe('filing a chat from its right-click menu', () => {
  const props = {
    ...baseProps,
    categories: [category('c1', 'Robotics'), category('c2', 'Teleop data', { parent_id: 'c1' }), category('c3', 'Syflo itself')],
    chats: [chat('1', 'SearXNG rate limits')],
  };

  it('files into a category the menu lists', () => {
    render(<Sidebar {...props} />);
    fireEvent.contextMenu(screen.getByText('SearXNG rate limits'));
    fireEvent.click(screen.getByText('Move to category'));
    fireEvent.click(screen.getByTestId('move-target-c3'));
    expect(handlers.onMoveChatToCategory).toHaveBeenCalledWith('1', 'c3');
  });

  it('offers the parent itself next to its subcategories, so nobody has to back out', () => {
    render(<Sidebar {...props} />);
    fireEvent.contextMenu(screen.getByText('SearXNG rate limits'));
    fireEvent.click(screen.getByText('Move to category'));
    expect(screen.getByTestId('move-target-c1')).toHaveTextContent('Robotics itself');
    expect(screen.getByTestId('move-target-c2')).toHaveTextContent('Teleop data');
  });

  it('offers to take a filed chat back out', () => {
    render(<Sidebar {...props} chats={[chat('1', 'Gripper limits', { category_id: 'c1' })]} />);
    fireEvent.contextMenu(screen.getByText('Gripper limits'));
    fireEvent.click(screen.getByText('Move to category'));
    fireEvent.click(screen.getByText('Remove from category'));
    expect(handlers.onMoveChatToCategory).toHaveBeenCalledWith('1', null);
  });

  it('does not offer filing on a branch — categories hold trees', () => {
    const root = chat('1', 'Root', { children: [chat('2', 'Branch', { parent_id: '1' })] });
    render(<Sidebar {...props} chats={[root]} />);
    fireEvent.click(screen.getByText('Root'));            // open the tree view
    fireEvent.contextMenu(screen.getByText('Branch'));
    expect(screen.queryByText('Move to category')).not.toBeInTheDocument();
  });
});

describe('the category’s own menu', () => {
  const props = {
    ...baseProps,
    categories: [category('c1', 'Robotics'), category('c2', 'Teleop data', { parent_id: 'c1' })],
    chats: [chat('1', 'Gripper limits', { category_id: 'c1' })],
  };

  it('offers the container’s verbs and promises that the chats survive', () => {
    render(<Sidebar {...props} />);
    fireEvent.contextMenu(screen.getByText('Robotics'));

    expect(screen.getByText('New subcategory')).toBeInTheDocument();
    expect(screen.getByText('Delete category')).toBeInTheDocument();
    expect(screen.getByText(/stays and returns to its date section/)).toBeInTheDocument();
    // Dropped by decision 2026-08-16.
    expect(screen.queryByText(/Collapse all/i)).not.toBeInTheDocument();
  });

  // Deleting a category asks first, exactly like deleting a chat (user
  // request 2026-08-16). The menu entry only opens the question; the modal is
  // where the deletion happens, and it repeats that the chats survive.
  it('asks before deleting, and only then deletes', async () => {
    render(<Sidebar {...props} />);
    fireEvent.contextMenu(screen.getByText('Robotics'));
    fireEvent.click(screen.getByText('Delete category'));
    expect(handlers.onDeleteCategory).not.toHaveBeenCalled();

    expect(screen.getByText('Delete category?')).toBeInTheDocument();
    expect(screen.getByText(/stays and returns to its date section/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('confirm-delete-category'));
    await waitFor(() => expect(handlers.onDeleteCategory).toHaveBeenCalledWith('c1'));
  });

  it('deletes nothing when the question is cancelled', () => {
    render(<Sidebar {...props} />);
    fireEvent.contextMenu(screen.getByText('Robotics'));
    fireEvent.click(screen.getByText('Delete category'));
    fireEvent.click(screen.getByText('Cancel'));

    expect(screen.queryByText('Delete category?')).not.toBeInTheDocument();
    expect(handlers.onDeleteCategory).not.toHaveBeenCalled();
  });

  it('renames in place', () => {
    render(<Sidebar {...props} />);
    fireEvent.contextMenu(screen.getByText('Robotics'));
    fireEvent.click(screen.getByText('Rename'));
    const input = screen.getByDisplayValue('Robotics');
    fireEvent.change(input, { target: { value: 'Robots' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(handlers.onRenameCategory).toHaveBeenCalledWith('c1', 'Robots');
  });

  it('offers no "New subcategory" on a subcategory — depth stops at two', () => {
    render(<Sidebar {...props} />);
    fireEvent.contextMenu(screen.getByTestId('subcategory-label-c2'));
    expect(screen.getByText('Delete category')).toBeInTheDocument();
    expect(screen.queryByText('New subcategory')).not.toBeInTheDocument();
  });
});

describe('creating a category', () => {
  // The header's folder-plus was removed on 2026-08-16 — creating a category
  // now starts where the wish arises, in a chat's own right-click menu.
  it('names a fresh category in place, started from a chat’s menu', () => {
    render(<Sidebar {...baseProps} chats={[chat('1', 'SearXNG rate limits')]} />);
    fireEvent.contextMenu(screen.getByText('SearXNG rate limits'));
    fireEvent.click(screen.getByText('Move to category'));
    fireEvent.click(screen.getByText(/New category/));

    const input = screen.getByPlaceholderText('Category name');
    fireEvent.change(input, { target: { value: 'Reading list' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(handlers.onCreateCategory).toHaveBeenCalledWith('Reading list', null);
  });

  // The entry sits INSIDE "Move to category", so it is a filing gesture that
  // happens to need a container first — creating the category and leaving the
  // chat where it was is the half-done version of what was asked.
  it('files the chat into the category its own menu just created', async () => {
    handlers.onCreateCategory.mockResolvedValue(category('new', 'Reading list'));
    render(<Sidebar {...baseProps} chats={[chat('1', 'SearXNG rate limits')]} />);
    fireEvent.contextMenu(screen.getByText('SearXNG rate limits'));
    fireEvent.click(screen.getByText('Move to category'));
    fireEvent.click(screen.getByText(/New category/));

    const input = screen.getByPlaceholderText('Category name');
    fireEvent.change(input, { target: { value: 'Reading list' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(handlers.onMoveChatToCategory).toHaveBeenCalledWith('1', 'new'));
  });

  // Abandoning the naming abandons the filing too — nothing was created, so
  // there is nothing to file into.
  it('files nothing when the naming is abandoned', async () => {
    render(<Sidebar {...baseProps} chats={[chat('1', 'SearXNG rate limits')]} />);
    fireEvent.contextMenu(screen.getByText('SearXNG rate limits'));
    fireEvent.click(screen.getByText('Move to category'));
    fireEvent.click(screen.getByText(/New category/));
    fireEvent.keyDown(screen.getByPlaceholderText('Category name'), { key: 'Escape' });

    expect(handlers.onCreateCategory).not.toHaveBeenCalled();
    expect(handlers.onMoveChatToCategory).not.toHaveBeenCalled();
  });

  // A subcategory made from a CATEGORY's menu has no chat waiting on it.
  it('files no chat into a subcategory made from the category menu', async () => {
    handlers.onCreateCategory.mockResolvedValue(category('c2', 'Teleop data', { parent_id: 'c1' }));
    render(<Sidebar {...baseProps} categories={[category('c1', 'Robotics')]} chats={[chat('1', 'SearXNG rate limits')]} />);
    fireEvent.contextMenu(screen.getByText('Robotics'));
    fireEvent.click(screen.getByText('New subcategory'));

    const input = screen.getByPlaceholderText('Category name');
    fireEvent.change(input, { target: { value: 'Teleop data' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(handlers.onCreateCategory).toHaveBeenCalledWith('Teleop data', 'c1'));
    expect(handlers.onMoveChatToCategory).not.toHaveBeenCalled();
  });

  it('creates a subcategory under the category whose menu asked for it', () => {
    render(<Sidebar {...baseProps} categories={[category('c1', 'Robotics')]} />);
    fireEvent.contextMenu(screen.getByText('Robotics'));
    fireEvent.click(screen.getByText('New subcategory'));

    const input = screen.getByPlaceholderText('Category name');
    fireEvent.change(input, { target: { value: 'Teleop data' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(handlers.onCreateCategory).toHaveBeenCalledWith('Teleop data', 'c1');
  });
});

describe('dragging a chat into a category', () => {
  // A tiny stand-in for the real DataTransfer, which jsdom does not implement.
  const transfer = () => {
    const store: Record<string, string> = {};
    return { setData: (k: string, v: string) => { store[k] = v; }, getData: (k: string) => store[k] ?? '' };
  };

  it('files the dragged chat into the category it is dropped on', () => {
    render(<Sidebar
      {...baseProps}
      categories={[category('c1', 'Robotics')]}
      chats={[chat('1', 'SearXNG rate limits')]}
    />);

    const row = screen.getByText('SearXNG rate limits').closest('[data-focus-item]')!;
    const dataTransfer = transfer();
    fireEvent.dragStart(row, { dataTransfer });
    fireEvent.drop(screen.getByTestId('category-c1').firstElementChild!, { dataTransfer });

    expect(handlers.onMoveChatToCategory).toHaveBeenCalledWith('1', 'c1');
  });

  it('files into a subcategory when dropped on its heading', () => {
    render(<Sidebar
      {...baseProps}
      categories={[category('c1', 'Robotics'), category('c2', 'Teleop data', { parent_id: 'c1' })]}
      chats={[chat('1', 'SearXNG rate limits')]}
    />);

    const row = screen.getByText('SearXNG rate limits').closest('[data-focus-item]')!;
    const dataTransfer = transfer();
    fireEvent.dragStart(row, { dataTransfer });
    fireEvent.drop(screen.getByTestId('subcategory-label-c2'), { dataTransfer });

    expect(handlers.onMoveChatToCategory).toHaveBeenCalledWith('1', 'c2');
  });
});

describe('collapsing the sections the system owns', () => {
  const props = {
    ...baseProps,
    chats: [chat('1', 'SearXNG rate limits'), chat('2', 'Pinned one', { pinned_at: '2026-08-16T10:00:00Z' })],
  };

  it('closes a date section and remembers it across a remount', () => {
    const { unmount } = render(<Sidebar {...props} />);
    expect(screen.getByTestId('date-section-Today')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('chat-group-label'));
    expect(screen.queryByTestId('date-section-Today')).not.toBeInTheDocument();

    unmount();
    render(<Sidebar {...props} />);
    expect(screen.queryByTestId('date-section-Today')).not.toBeInTheDocument();
  });

  it('closes the pinned section too, and the pin icon is back on its heading', () => {
    render(<Sidebar {...props} />);
    const heading = screen.getByTestId('pinned-group-label');
    expect(heading.querySelector('svg.lucide-pin')).toBeTruthy();

    fireEvent.click(heading);
    expect(screen.queryByText('Pinned one')).not.toBeInTheDocument();
  });
});
