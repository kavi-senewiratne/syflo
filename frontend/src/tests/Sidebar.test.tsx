import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Sidebar } from '../components/Sidebar';
import type { Chat } from '../types';

const mockChats: Chat[] = [
  { id: '1', title: 'First Chat', parent_id: null, parent_word: null, created_at: new Date().toISOString(), children: [] },
  { id: '2', title: 'Second Chat', parent_id: null, parent_word: null, created_at: new Date().toISOString(), children: [
    { id: '3', title: 'Child Chat', parent_id: '2', parent_word: 'quantum', created_at: new Date().toISOString(), children: [] }
  ]},
];

describe('Sidebar', () => {
  const defaultProps = {
    chats: mockChats,
    activeChatId: null,
    onSelect: vi.fn(),
    onNewChat: vi.fn(),
    onDelete: vi.fn(),
    onRename: vi.fn(),
    viewMode: 'chat' as const,
    onToggleView: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenFeedback: vi.fn(),
    collapsed: false,
    onToggleCollapsed: vi.fn(),
  };

  it('renders root chat titles', () => {
    render(<Sidebar {...defaultProps} />);
    expect(screen.getByText('First Chat')).toBeInTheDocument();
    expect(screen.getByText('Second Chat')).toBeInTheDocument();
  });

  it('zeigt den YT-Tag an Bäumen mit YouTube transcript (ADR-0005)', () => {
    const withVideo: Chat[] = [
      { ...mockChats[0], video_id: 'v1' },
      mockChats[1],
    ];
    render(<Sidebar {...defaultProps} chats={withVideo} />);
    expect(screen.getByTestId('root-list-yt-tag')).toHaveTextContent('YT');
    // Der zweite Baum hat keine Quelle — kein Tag.
    expect(screen.getAllByTestId('root-list-yt-tag')).toHaveLength(1);
  });

  it('has no "Active model" box in the footer — the composer pill owns that', () => {
    // mockup-model-picker.html, Sektion 01: nur noch das Zahnrad im Footer.
    render(<Sidebar {...defaultProps} />);
    expect(screen.queryByText(/Active model/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Open settings'));
    expect(defaultProps.onOpenSettings).toHaveBeenCalledWith('appearance');
  });

  it('opens the feedback dialog from the expanded footer button', () => {
    render(<Sidebar {...defaultProps} />);
    fireEvent.click(screen.getByLabelText('Send feedback'));
    expect(defaultProps.onOpenFeedback).toHaveBeenCalled();
  });

  it('opens the feedback dialog from the collapsed rail button', () => {
    render(<Sidebar {...defaultProps} collapsed />);
    fireEvent.click(screen.getByLabelText('Send feedback'));
    expect(defaultProps.onOpenFeedback).toHaveBeenCalled();
  });

  it('does not show child chats in default flat view', () => {
    render(<Sidebar {...defaultProps} />);
    expect(screen.queryByText('Child Chat')).not.toBeInTheDocument();
  });

  it('shows child chat after clicking a root (parent_word badge removed)', () => {
    render(<Sidebar {...defaultProps} />);
    fireEvent.click(screen.getByText('Second Chat'));
    expect(screen.getByText('Child Chat')).toBeInTheDocument();
    expect(screen.queryByText('quantum')).not.toBeInTheDocument();
  });

  it('shows back button in expanded view', () => {
    render(<Sidebar {...defaultProps} />);
    fireEvent.click(screen.getByText('Second Chat'));
    expect(screen.getByText('All chats')).toBeInTheDocument();
  });

  it('returns to flat view when back button is clicked', () => {
    render(<Sidebar {...defaultProps} />);
    fireEvent.click(screen.getByText('Second Chat'));
    fireEvent.click(screen.getByText('All chats'));
    expect(screen.getByText('First Chat')).toBeInTheDocument();
    expect(screen.queryByText('Child Chat')).not.toBeInTheDocument();
  });

  it('calls onSelect when chat is clicked', () => {
    const onSelect = vi.fn();
    render(<Sidebar {...defaultProps} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('First Chat'));
    expect(onSelect).toHaveBeenCalledWith('1');
  });

  it('calls onNewChat when New Chat button clicked', () => {
    const onNewChat = vi.fn();
    render(<Sidebar {...defaultProps} onNewChat={onNewChat} />);
    fireEvent.click(screen.getByTitle('New Chat'));
    expect(onNewChat).toHaveBeenCalled();
  });

  it('shows empty state message when no chats', () => {
    render(<Sidebar {...defaultProps} chats={[]} />);
    expect(screen.getByText(/No chats yet/i)).toBeInTheDocument();
  });

  it('highlights active root chat', () => {
    render(<Sidebar {...defaultProps} activeChatId="1" />);
    const activeItem = screen.getByText('First Chat').closest('div');
    expect(activeItem?.className).toContain('bg-blue-50');
  });

  it('does not render a trash icon (delete moved to context menu)', () => {
    render(<Sidebar {...defaultProps} />);
    expect(screen.queryByTitle('Delete chat')).not.toBeInTheDocument();
  });

  it('shows the full chat title as a tooltip on the row', () => {
    render(<Sidebar {...defaultProps} />);
    const row = screen.getByText('First Chat').closest('div');
    expect(row?.getAttribute('title')).toBe('First Chat');
  });

  it('opens the context menu on right-click with rename and delete options', () => {
    render(<Sidebar {...defaultProps} />);
    fireEvent.contextMenu(screen.getByText('First Chat'));
    expect(screen.getByText('Rename')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('clicking Delete in context menu opens the confirmation dialog', () => {
    const onDelete = vi.fn();
    render(<Sidebar {...defaultProps} onDelete={onDelete} />);
    fireEvent.contextMenu(screen.getByText('First Chat'));
    fireEvent.click(screen.getByText('Delete'));
    expect(screen.getByText('Delete chat?')).toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('cancel in the confirmation dialog closes it without deleting', () => {
    const onDelete = vi.fn();
    render(<Sidebar {...defaultProps} onDelete={onDelete} />);
    fireEvent.contextMenu(screen.getByText('First Chat'));
    fireEvent.click(screen.getByText('Delete'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Delete chat?')).not.toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('confirming the dialog calls onDelete with the right id', () => {
    const onDelete = vi.fn();
    render(<Sidebar {...defaultProps} onDelete={onDelete} />);
    fireEvent.contextMenu(screen.getByText('First Chat'));
    // Click Delete in context menu (opens modal)
    fireEvent.click(screen.getByText('Delete'));
    // Click Delete in confirmation modal — last "Delete" in the DOM
    const deleteBtns = screen.getAllByText('Delete');
    fireEvent.click(deleteBtns[deleteBtns.length - 1]);
    expect(onDelete).toHaveBeenCalledWith('1');
  });

  it('clicking Rename switches the row to an inline editor', () => {
    render(<Sidebar {...defaultProps} />);
    fireEvent.contextMenu(screen.getByText('First Chat'));
    fireEvent.click(screen.getByText('Rename'));
    const input = screen.getByDisplayValue('First Chat');
    expect(input).toBeInTheDocument();
    expect(input.tagName).toBe('INPUT');
  });

  it('submitting a renamed title calls onRename with the new value', () => {
    const onRename = vi.fn();
    render(<Sidebar {...defaultProps} onRename={onRename} />);
    fireEvent.contextMenu(screen.getByText('First Chat'));
    fireEvent.click(screen.getByText('Rename'));
    const input = screen.getByDisplayValue('First Chat');
    fireEvent.change(input, { target: { value: 'Renamed Chat' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('1', 'Renamed Chat');
  });

  it('Escape during rename cancels without calling onRename', () => {
    const onRename = vi.fn();
    render(<Sidebar {...defaultProps} onRename={onRename} />);
    fireEvent.contextMenu(screen.getByText('First Chat'));
    fireEvent.click(screen.getByText('Rename'));
    const input = screen.getByDisplayValue('First Chat');
    fireEvent.change(input, { target: { value: 'Should not stick' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onRename).not.toHaveBeenCalled();
  });
});
