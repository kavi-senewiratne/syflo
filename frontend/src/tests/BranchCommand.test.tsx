import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatArea } from '../components/ChatArea';
import type { ChatDetail } from '../types';

/**
 * /branch — a branch from a typed topic
 * (design/mockup-branch-command.html).
 *
 * The other door into the chat tree: no passage is selected, the topic is
 * typed. What the command owes the user is that the landing place is never a
 * surprise — the chip names the parent BEFORE Enter, and it can be changed.
 */

const mockChat: ChatDetail = {
  id: 'c-current',
  title: 'Scaled dot-product',
  parent_id: 'c-root',
  parent_word: 'we scale the dot products',
  created_at: new Date().toISOString(),
  messages: [
    { id: 'm1', chat_id: 'c-current', role: 'user', content: 'Why divide by the square root of d_k?', created_at: new Date().toISOString() },
  ],
  children: [],
};

const defaultProps = {
  streaming: false,
  onSendMessage: vi.fn().mockResolvedValue(undefined),
  onWordRightClick: vi.fn(),
  onSelectChat: vi.fn(),
};

describe('/branch topic branch', () => {
  beforeEach(() => {
    defaultProps.onSendMessage.mockClear();
  });

  it('opens a branch for the typed topic instead of sending a chat message', async () => {
    const onOpenTopicBranch = vi.fn();
    render(<ChatArea chat={mockChat} loading={false} {...defaultProps} onOpenTopicBranch={onOpenTopicBranch} />);
    const textarea = screen.getByPlaceholderText(/Ask anything/i);
    fireEvent.change(textarea, { target: { value: '/branch positional encodings' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    // The topic travels verbatim, and it lands under the chat the user stands
    // in — variant A of the mockup, the default.
    await waitFor(() => expect(onOpenTopicBranch).toHaveBeenCalledWith('positional encodings', 'c-current'));
    expect(defaultProps.onSendMessage).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('');
  });

  it('does nothing on a bare /branch — a half-typed command is not an empty branch', () => {
    const onOpenTopicBranch = vi.fn();
    render(<ChatArea chat={mockChat} loading={false} {...defaultProps} onOpenTopicBranch={onOpenTopicBranch} />);
    const textarea = screen.getByPlaceholderText(/Ask anything/i);
    // With the trailing space the slash menu is out of the way, so this is
    // Enter on the command itself — not on a menu entry.
    fireEvent.change(textarea, { target: { value: '/branch ' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(onOpenTopicBranch).not.toHaveBeenCalled();
    expect(defaultProps.onSendMessage).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('/branch ');
  });

  it('leaves /branch inside a sentence as ordinary text', async () => {
    const onOpenTopicBranch = vi.fn();
    render(<ChatArea chat={mockChat} loading={false} {...defaultProps} onOpenTopicBranch={onOpenTopicBranch} />);
    const textarea = screen.getByPlaceholderText(/Ask anything/i);
    fireEvent.change(textarea, { target: { value: 'is git /branch the right analogy here?' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    await waitFor(() => expect(defaultProps.onSendMessage).toHaveBeenCalled());
    expect(onOpenTopicBranch).not.toHaveBeenCalled();
  });

  // Mockup §01: the landing place is on screen BEFORE Enter, never a surprise
  // afterwards.
  describe('the chip', () => {
    it('names the parent the branch will hang under while the topic is typed', () => {
      render(<ChatArea chat={mockChat} loading={false} {...defaultProps} onOpenTopicBranch={vi.fn()} />);
      fireEvent.change(screen.getByPlaceholderText(/Ask anything/i), { target: { value: '/branch positional' } });

      const chip = screen.getByTestId('branch-chip');
      expect(chip).toHaveTextContent('/branch');
      expect(chip).toHaveTextContent('Scaled dot-product');
    });

    it('marks the command in the composer so the line reads as a command', () => {
      render(<ChatArea chat={mockChat} loading={false} {...defaultProps} onOpenTopicBranch={vi.fn()} />);
      fireEvent.change(screen.getByPlaceholderText(/Ask anything/i), { target: { value: '/branch positional' } });

      const marked = screen.getByTestId('chat-textarea-highlight').querySelector('.text-blue-600');
      expect(marked).toHaveTextContent('/branch');
    });

    it('is gone as soon as the line is no longer the command', () => {
      render(<ChatArea chat={mockChat} loading={false} {...defaultProps} onOpenTopicBranch={vi.fn()} />);
      const textarea = screen.getByPlaceholderText(/Ask anything/i);
      fireEvent.change(textarea, { target: { value: '/branch positional' } });
      expect(screen.getByTestId('branch-chip')).toBeInTheDocument();

      fireEvent.change(textarea, { target: { value: 'positional' } });
      expect(screen.queryByTestId('branch-chip')).not.toBeInTheDocument();
    });
  });

  // The slash menu is the only place a command is discovered at all — /branch
  // has to stand next to /btw and /feedback there.
  it('is offered in the slash menu and fills the command in', () => {
    render(<ChatArea chat={mockChat} loading={false} {...defaultProps} onOpenTopicBranch={vi.fn()} />);
    const textarea = screen.getByPlaceholderText(/Ask anything/i);
    fireEvent.change(textarea, { target: { value: '/br' } });

    const item = screen.getByTestId('slash-item-branch');
    expect(item).toHaveTextContent('/branch');
    fireEvent.click(item);

    // The topic is still missing, so the command is only filled in — nothing
    // is created yet.
    expect(textarea).toHaveValue('/branch ');
  });

  // Mockup §02, variant C: the current chat is the default, and one click
  // moves the branch to the root or to any other chat in the tree.
  describe('the target picker', () => {
    const branchTargets = [
      { id: 'c-root', title: 'Attention Is All You Need', depth: 0 },
      { id: 'c-current', title: 'Scaled dot-product', depth: 1 },
      { id: 'c-other', title: 'Curse of dimensionality', depth: 1 },
    ];

    const openPicker = () => {
      fireEvent.change(screen.getByPlaceholderText(/Ask anything/i), { target: { value: '/branch positional encodings' } });
      fireEvent.click(screen.getByTestId('branch-target'));
    };

    it('offers the current chat first, then the rest of the tree', () => {
      render(
        <ChatArea chat={mockChat} loading={false} {...defaultProps} onOpenTopicBranch={vi.fn()} branchTargets={branchTargets} />
      );
      openPicker();

      const items = screen.getAllByTestId(/^branch-target-item-/);
      expect(items[0]).toHaveTextContent('Scaled dot-product');
      expect(items.map((i) => i.textContent).join(' ')).toContain('Attention Is All You Need');
      expect(items.map((i) => i.textContent).join(' ')).toContain('Curse of dimensionality');
      // No chat appears twice — the current one is moved to the top, not copied.
      expect(items).toHaveLength(3);
    });

    it('creates the branch under the chat the user pointed at', async () => {
      const onOpenTopicBranch = vi.fn();
      render(
        <ChatArea chat={mockChat} loading={false} {...defaultProps} onOpenTopicBranch={onOpenTopicBranch} branchTargets={branchTargets} />
      );
      openPicker();
      fireEvent.click(screen.getByTestId('branch-target-item-c-root'));

      // The chip answers "where does it land?" before Enter is pressed.
      expect(screen.getByTestId('branch-chip')).toHaveTextContent('Attention Is All You Need');

      fireEvent.keyDown(screen.getByPlaceholderText(/Ask anything/i), { key: 'Enter', shiftKey: false });
      await waitFor(() => expect(onOpenTopicBranch).toHaveBeenCalledWith('positional encodings', 'c-root'));
    });

    it('forgets a chosen target once the command is gone', () => {
      render(
        <ChatArea chat={mockChat} loading={false} {...defaultProps} onOpenTopicBranch={vi.fn()} branchTargets={branchTargets} />
      );
      openPicker();
      fireEvent.click(screen.getByTestId('branch-target-item-c-root'));

      const textarea = screen.getByPlaceholderText(/Ask anything/i);
      fireEvent.change(textarea, { target: { value: 'just a question' } });
      fireEvent.change(textarea, { target: { value: '/branch something else' } });

      // Back to the default — a target chosen for one branch must not silently
      // govern the next one.
      expect(screen.getByTestId('branch-chip')).toHaveTextContent('Scaled dot-product');
    });
  });
});
