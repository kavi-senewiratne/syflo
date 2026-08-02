/**
 * ParentContextPane.test.tsx
 *
 * Seit 2026-07-22 zeigt die Pane NUR den Elternchat (read-only); die
 * Vorfahren-Karten zogen damals in ein Banner der Chat-Spalte um und sind
 * 2026-08-01 ganz entfallen. Hier bleiben: wörtliches Rendern des
 * Elternchats und der Scroll zur Ursprungs-Nachricht.
 */

import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ParentContextPane } from '../components/ParentContextPane';
import type { ChatDetail } from '../types';

function makeParentChat(overrides: Partial<ChatDetail> = {}): ChatDetail {
  return {
    id: 'parent',
    title: 'Attention',
    parent_id: 'root',
    parent_word: 'attention',
    created_at: new Date().toISOString(),
    children: [],
    messages: [
      {
        id: 'm1',
        chat_id: 'parent',
        role: 'user',
        content: 'What is attention exactly?',
        created_at: new Date().toISOString(),
      },
    ],
    ...overrides,
  } as ChatDetail;
}

const noopProps = {
  highlights: [],
  onOpenChat: vi.fn(),
  onSelectChat: vi.fn(),
  onWordRightClick: vi.fn(),
  onChatSelection: vi.fn(),
  onHighlightContextMenu: vi.fn(),
};

describe('ParentContextPane', () => {
  it('renders the parent chat verbatim', () => {
    render(<ParentContextPane chat={makeParentChat()} {...noopProps} />);
    expect(screen.getByText('What is attention exactly?')).toBeInTheDocument();
  });

  it('zeigt KEINE Vorfahren-Karten mehr (2026-08-01 ersatzlos entfallen)', () => {
    render(<ParentContextPane chat={makeParentChat()} {...noopProps} />);
    expect(screen.queryByTestId('ancestor-chainline')).not.toBeInTheDocument();
    expect(screen.queryByTestId(/ancestor-card-/)).not.toBeInTheDocument();
  });
});

// Nutzer-Report 2026-07-22: Nach "Open as new chat" scrollte der Eltern-Chat
// im Center-Pane an den Anfang — der Kontext der Auswahl war weg. Die Pane
// scrollt jetzt zur Ursprungs-Nachricht und meldet das Ziel als verbraucht.
describe('ParentContextPane – Scroll zur Ursprungs-Nachricht', () => {
  it('scrollt beim Mount zur scrollToMessageId und meldet consumed', () => {
    const scrollIntoView = vi.fn();
    const original = window.HTMLElement.prototype.scrollIntoView;
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const onScrollTargetConsumed = vi.fn();
    try {
      render(
        <ParentContextPane
          chat={makeParentChat()}
          {...noopProps}
          scrollToMessageId="m1"
          onScrollTargetConsumed={onScrollTargetConsumed}
        />,
      );
      expect(scrollIntoView).toHaveBeenCalled();
      const target = scrollIntoView.mock.instances.at(-1) as HTMLElement;
      expect(target).toBe(screen.getByTestId('parent-msg-m1'));
      expect(onScrollTargetConsumed).toHaveBeenCalled();
    } finally {
      window.HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it('ohne scrollToMessageId wird nicht gescrollt', () => {
    const scrollIntoView = vi.fn();
    const original = window.HTMLElement.prototype.scrollIntoView;
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      render(<ParentContextPane chat={makeParentChat()} {...noopProps} />);
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      window.HTMLElement.prototype.scrollIntoView = original;
    }
  });
});
