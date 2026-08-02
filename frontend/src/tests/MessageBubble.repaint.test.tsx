/**
 * MessageBubble.repaint.test.tsx
 *
 * Regression (2026-07-21): Chat-Highlights verschwanden, sobald ein
 * Re-Render den Markdown-DOM neu aufbaute, ohne dass message.content sich
 * änderte — z.B. wenn branchWords nach dem Laden des Baums eintreffen und
 * insertBranchLinks den gerenderten Inhalt verändert. Die zuvor gemalten
 * Ranges hingen dann an entfernten Textknoten und kollabierten still.
 *
 * Der Paint muss deshalb nach JEDEM Commit laufen (idempotent), nicht nur
 * bei Änderungen von content/highlights. paintMessageHighlights ist hier
 * gemockt, weil jsdom keine CSS Custom Highlight API hat — getestet wird
 * die Effekt-Frequenz, die Anker-Mathematik hat eigene Tests
 * (highlightAnchors.test.ts).
 */

import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { paintMessageHighlights } from '../chat/highlightAnchors';
import { MessageBubble } from '../components/ChatArea/MessageBubble';
import type { Message, MessageHighlight } from '../types';

vi.mock('../chat/highlightAnchors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chat/highlightAnchors')>();
  return {
    ...actual,
    paintMessageHighlights: vi.fn(),
    clearMessageHighlights: vi.fn(),
  };
});

const message: Message = {
  id: 'a1',
  chat_id: 'c1',
  role: 'assistant',
  content: 'Gradient clipping alone is not enough here.',
  created_at: '2026-07-21T00:00:00Z',
};

const highlight: MessageHighlight = {
  id: 'mh1',
  messageId: 'a1',
  chatId: 'c1',
  childChatId: null,
  startOffset: 9,
  endOffset: 23,
  text: 'clipping alone',
  color: 'yellow',
  createdAt: '2026-07-21T00:00:00Z',
  updatedAt: '2026-07-21T00:00:00Z',
};

describe('MessageBubble — repaint after DOM-changing re-renders', () => {
  it('malt neu, wenn branchWords nachträglich eintreffen (content unverändert)', () => {
    // Wie in der App: die highlights-Referenz bleibt über Renders stabil
    // (useChatHighlights-State), nur branchWords kommen dazu.
    const stable = { message, onWordRightClick: vi.fn(), highlights: [highlight] };
    const { rerender } = render(<MessageBubble {...stable} />);
    const before = vi.mocked(paintMessageHighlights).mock.calls.length;
    expect(before).toBeGreaterThan(0);

    rerender(
      <MessageBubble
        {...stable}
        branchWords={[{ word: 'clipping alone', chatId: 'c9' }]}
        onBranchClick={vi.fn()}
      />,
    );
    expect(vi.mocked(paintMessageHighlights).mock.calls.length).toBeGreaterThan(before);
  });

  it('malt bei jedem Commit neu — auch ohne Prop-Änderung', () => {
    const props = {
      message,
      onWordRightClick: vi.fn(),
      highlights: [highlight],
    };
    const { rerender } = render(<MessageBubble {...props} />);
    const before = vi.mocked(paintMessageHighlights).mock.calls.length;
    rerender(<MessageBubble {...props} />);
    expect(vi.mocked(paintMessageHighlights).mock.calls.length).toBeGreaterThan(before);
  });

  it('malt während des Streamings nicht', () => {
    vi.mocked(paintMessageHighlights).mockClear();
    render(
      <MessageBubble
        message={message}
        onWordRightClick={vi.fn()}
        highlights={[highlight]}
        isStreaming
      />,
    );
    expect(paintMessageHighlights).not.toHaveBeenCalled();
  });
});
