/**
 * tests/MessageBubble.branchMark.test.tsx
 *
 * Ein Zweig, der aus einer markierten Stelle entstanden ist, wird NUR an
 * dieser Stelle verlinkt (Nutzerentscheid 2026-08-13,
 * design/mockup-simply-blue-fixes.html §04, Variante A).
 *
 * Vorher wurde jedes Vorkommen der Elternwörter zum Link: eine Antwort, die
 * „Leaky Abstraction“ dreimal schreibt, zeigte eine gelb-und-blaue Stelle und
 * zwei blaue — und nichts erklärte den Unterschied (Nutzer-Report 2026-08-13).
 *
 * Zweige ohne Markierung (`/branch`, `/btw`, Rechtsklick auf ein Wort)
 * behalten die Alle-Vorkommen-Regel.
 */

import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MessageBubble } from '../components/ChatArea/MessageBubble';
import type { Message, MessageHighlight } from '../types';

const CONTENT =
  'Backpropagation als „Leaky Abstraction“. Eine Leaky Abstraction lügt. ' +
  'Wer leaky abstraction kennt, rechnet nachher.';

const message: Message = {
  id: 'm1',
  chat_id: 'c1',
  role: 'assistant',
  content: CONTENT,
  created_at: new Date().toISOString(),
};

const WORDS = [{ word: 'Leaky Abstraction', chatId: 'child-1' }];

// Offset des n-ten Vorkommens im GERENDERTEN Text. Der gerenderte Text ist
// hier gleich dem Quelltext (keine Markdown-Zeichen), also reicht indexOf.
const offsetOfNth = (nth: number): number => {
  const re = /leaky abstraction/gi;
  for (let i = 0; ; i++) {
    const m = re.exec(CONTENT);
    if (!m) throw new Error('kein Treffer');
    if (i === nth) return m.index;
  }
};

const highlightOn = (nth: number, childChatId: string | null): MessageHighlight => ({
  id: `h${nth}`,
  messageId: 'm1',
  chatId: 'c1',
  childChatId,
  startOffset: offsetOfNth(nth),
  endOffset: offsetOfNth(nth) + 'Leaky Abstraction'.length,
  text: 'Leaky Abstraction',
  color: 'yellow',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const renderBubble = (highlights?: MessageHighlight[]) =>
  render(
    <MessageBubble
      message={message}
      onWordRightClick={vi.fn()}
      branchWords={WORDS}
      onBranchClick={vi.fn()}
      highlights={highlights}
      onHighlightContextMenu={vi.fn()}
    />,
  );

// Branch-Links sind Spans mit Button-Semantik, keine <a>-Elemente.
const links = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[role="button"]')).map(el => el.textContent);

describe('branch links at a marked passage', () => {
  it('links only the marked occurrence', () => {
    const { container } = renderBubble([highlightOn(1, 'child-1')]);
    expect(links(container)).toEqual(['Leaky Abstraction']);
    // Und zwar die markierte: der Satz um sie herum trägt den Link.
    const link = container.querySelector('[role="button"]')!;
    expect(link.parentElement?.textContent).toContain('lügt');
  });

  it('links the third occurrence when the mark sits there', () => {
    const { container } = renderBubble([highlightOn(2, 'child-1')]);
    expect(links(container)).toEqual(['leaky abstraction']);
  });

  it('keeps all occurrences linked for a branch without a mark', () => {
    // /branch, /btw, Rechtsklick auf ein Wort — kein Highlight zeigt auf child-1.
    const { container } = renderBubble([highlightOn(0, null)]);
    expect(links(container)).toHaveLength(3);
  });

  it('keeps all occurrences linked when the bubble knows no highlights', () => {
    const { container } = renderBubble(undefined);
    expect(links(container)).toHaveLength(3);
  });

  it('links nothing here when the mark lives in ANOTHER message', () => {
    const elsewhere = { ...highlightOn(0, 'child-1'), id: 'h9', messageId: 'm-other' };
    const { container } = renderBubble([elsewhere]);
    expect(links(container)).toHaveLength(0);
    // Der Text bleibt vollständig lesbar — nur eben ohne Sprung.
    expect(container.textContent).toContain('Eine Leaky Abstraction lügt');
  });
});
