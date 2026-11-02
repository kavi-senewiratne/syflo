/**
 * SidebarHtmlTag.test.tsx
 *
 * A tree with an HTML source (ADR-0013) carries an HTML tag on its root row,
 * the same badge family as PDF and YT (mockup-html-app.html: Lucide `Code`).
 */

import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ChatTree } from '../components/Sidebar/ChatTree';
import { Sidebar } from '../components/Sidebar';
import type { Chat } from '../types';

const chats: Chat[] = [
  { id: '1', title: 'Underactuated Lernpfad', parent_id: null, parent_word: null, created_at: '', html_source_id: 'h1', children: [] },
  { id: '2', title: 'Plain chat', parent_id: null, parent_word: null, created_at: '', children: [] },
];

describe('HTML tag in the sidebar', () => {
  it('ChatTree shows it only on roots with html_source_id', () => {
    render(
      <ChatTree
        chats={chats}
        activeChatId={null}
        renamingId={null}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        onRenameSubmit={vi.fn()}
        onRenameCancel={vi.fn()}
      />,
    );
    const tags = screen.getAllByTestId('tree-html-tag');
    expect(tags).toHaveLength(1);
    expect(tags[0]).toHaveTextContent('HTML');
    expect(screen.getByText('Underactuated Lernpfad').closest('div')).toContainElement(tags[0]);
  });

  it('the sidebar root list shows it too', () => {
    render(
      <Sidebar
        chats={chats}
        activeChatId={null}
        onSelect={vi.fn()}
        onNewChat={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
        onTogglePin={vi.fn()}
        categories={[]}
        onCreateCategory={vi.fn()}
        onRenameCategory={vi.fn()}
        onDeleteCategory={vi.fn()}
        onToggleCategoryCollapsed={vi.fn()}
        onMoveChatToCategory={vi.fn()}
        viewMode="chat"
        onToggleView={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenFeedback={vi.fn()}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
      />,
    );
    expect(screen.getAllByTestId('root-list-html-tag')).toHaveLength(1);
  });
});
