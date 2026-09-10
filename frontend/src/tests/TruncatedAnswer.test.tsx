/**
 * tests/TruncatedAnswer.test.tsx
 *
 * Abgebrochene Antwort (design/mockup-truncated-answer.html §01). Gemessen am
 * 2026-08-16: eine Video overview endete nach 340 Tokens mitten im Wort, und
 * die Oberfläche zeigte sie wie eine fertige Antwort.
 *
 * Anders als '*Failed*' ersetzt die Karte die Antwort NICHT — der Text, der
 * ankam, bleibt stehen. Sie steht darunter und bietet den einzigen Ausweg an,
 * der die Arbeit behält: weiterschreiben.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MessageBubble } from '../components/ChatArea/MessageBubble';
import type { Message } from '../types';

const cutOff: Message = {
  id: 'a-cut',
  chat_id: 'c1',
  role: 'assistant',
  content: '## Was ist Mechanistic Interpretability? [0:03 - 5:12]\n\nDie Gewichte entsprechen dem',
  created_at: '2026-08-16T00:00:01.000Z',
  truncated: 1,
};

describe('MessageBubble – answer cut short by the provider', () => {
  it('keeps the text that arrived and offers to continue it', () => {
    const onContinue = vi.fn();
    render(
      <MessageBubble message={cutOff} onWordRightClick={vi.fn()} onContinueMessage={onContinue} />,
    );

    // The work is not thrown away.
    expect(screen.getByText(/Die Gewichte entsprechen dem/)).toBeInTheDocument();
    expect(screen.getByTestId('truncated-note')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('continue-button'));
    expect(onContinue).toHaveBeenCalledWith(cutOff);
  });

  it('says how far the answer got when the text carries time marks', () => {
    render(<MessageBubble message={cutOff} onWordRightClick={vi.fn()} onContinueMessage={vi.fn()} />);
    // The reader's real question is "why does it stop?" — the last mark
    // answers it without scrolling.
    expect(screen.getByTestId('truncated-note')).toHaveTextContent('5:12');
  });

  it('stays quiet on a finished answer', () => {
    const done: Message = { ...cutOff, truncated: 0 };
    render(<MessageBubble message={done} onWordRightClick={vi.fn()} onContinueMessage={vi.fn()} />);
    expect(screen.queryByTestId('truncated-note')).not.toBeInTheDocument();
  });

  it('prints no stray "0" under a finished answer', () => {
    // `truncated` is a SQLite number, and `{0 && …}` renders the 0 itself —
    // a lone zero appeared under every continued answer (user report with
    // screenshot 2026-08-16).
    const done: Message = { ...cutOff, truncated: 0 };
    const { container } = render(
      <MessageBubble message={done} onWordRightClick={vi.fn()} onContinueMessage={vi.fn()} />,
    );
    // The stray zero is its own text node next to the answer — the rendered
    // text as a whole says nothing about it.
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const nodes: string[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode.nodeValue ?? '');
    expect(nodes).not.toContain('0');
  });

  it('hides the card while the continuation is streaming', () => {
    render(
      <MessageBubble message={cutOff} isStreaming onWordRightClick={vi.fn()} onContinueMessage={vi.fn()} />,
    );
    expect(screen.queryByTestId('truncated-note')).not.toBeInTheDocument();
  });
});

/**
 * Naht ohne Beleg (mockup-truncated-answer §04, Live-Vorfall 2026-09-07): die
 * Fortsetzung hat zweimal ihre Wiederhol-Anweisung ignoriert, der Text wurde
 * trotzdem angefügt — mitten in der Antwort kann ein Stück fehlen. Die Karte
 * sagt das, und ihr Ausweg ist REGENERATE: Weiterschreiben kann eine falsch
 * verschweißte Mitte nicht mehr reparieren.
 */
describe('MessageBubble – continued answer with an unverified seam', () => {
  const stitched: Message = {
    id: 'a-seam',
    chat_id: 'c1',
    role: 'assistant',
    content: '* Nur der Normalverteilungsannahme erfüllt ist, dann gelten die bekannten Verteilungen.',
    created_at: '2026-09-07T20:05:35.000Z',
    truncated: 0,
    seam_suspect: 1,
  };

  it('warns about the seam and offers regenerate', () => {
    const onRetry = vi.fn();
    render(
      <MessageBubble message={stitched} onWordRightClick={vi.fn()} onRetryMessage={onRetry} />,
    );

    expect(screen.getByTestId('seam-suspect-note')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('seam-regenerate-button'));
    expect(onRetry).toHaveBeenCalledWith(stitched);
  });

  it('waits until the automat is done growing the answer', () => {
    // While truncated is still set, further continuation rounds are running —
    // the truncated card owns the bubble until they finish.
    const stillGrowing: Message = { ...stitched, truncated: 1 };
    render(
      <MessageBubble message={stillGrowing} onWordRightClick={vi.fn()} onRetryMessage={vi.fn()} onContinueMessage={vi.fn()} />,
    );
    expect(screen.queryByTestId('seam-suspect-note')).not.toBeInTheDocument();
    expect(screen.getByTestId('truncated-note')).toBeInTheDocument();
  });

  it('stays quiet on an answer whose seam was verified', () => {
    const clean: Message = { ...stitched, seam_suspect: 0 };
    render(<MessageBubble message={clean} onWordRightClick={vi.fn()} onRetryMessage={vi.fn()} />);
    expect(screen.queryByTestId('seam-suspect-note')).not.toBeInTheDocument();
  });
});
