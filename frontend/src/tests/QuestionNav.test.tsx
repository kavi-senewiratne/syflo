/**
 * QuestionNav.test.tsx
 *
 * UI der Fragen-Navigation (Grill 2026-07-22, mockup-question-nav.html
 * Varianten 1+3): Header-Button mit Popover + schwebender Prev/Next-Stepper.
 * Die pure Ableitungs-/Scroll-Spy-Logik ist in questionNav.test.ts abgedeckt;
 * hier geht es um sichtbares Verhalten der Komponenten und die Integration
 * in die ChatArea (Sprung + Flash, Overflow-Sichtbarkeit, Shortcuts).
 */

import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { QuestionNavButton, QuestionStepper } from '../components/ChatArea/QuestionNav';
import { ChatArea } from '../components/ChatArea';
import type { QuestionEntry } from '../chat/questionNav';
import type { ChatDetail } from '../types';

const entries = (n: number): QuestionEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    messageId: `m${i + 1}`,
    text: `Question number ${i + 1}?`,
    quoteOnly: false,
  }));

describe('QuestionNavButton (Header-Popover)', () => {
  it('bleibt unter 2 Fragen unsichtbar', () => {
    render(<QuestionNavButton questions={entries(1)} activeIndex={0} onJump={vi.fn()} />);
    expect(screen.queryByTestId('question-nav-button')).not.toBeInTheDocument();
  });

  it('zeigt ab 2 Fragen den Button mit Anzahl', () => {
    render(<QuestionNavButton questions={entries(3)} activeIndex={0} onJump={vi.fn()} />);
    expect(screen.getByTestId('question-nav-button')).toHaveTextContent('3 questions');
  });

  it('öffnet das Popover mit nummerierten Einträgen, der aktive ist markiert', () => {
    render(<QuestionNavButton questions={entries(3)} activeIndex={1} onJump={vi.fn()} />);
    fireEvent.click(screen.getByTestId('question-nav-button'));
    const popover = screen.getByTestId('question-nav-popover');
    expect(popover).toHaveTextContent('Question number 1?');
    expect(popover).toHaveTextContent('Question number 3?');
    const active = screen.getByTestId('question-nav-item-m2');
    expect(active).toHaveAttribute('aria-current', 'true');
    expect(active).toHaveTextContent('2');
  });

  it('Klick auf einen Eintrag springt zur Frage und schließt das Popover', () => {
    const onJump = vi.fn();
    render(<QuestionNavButton questions={entries(3)} activeIndex={0} onJump={onJump} />);
    fireEvent.click(screen.getByTestId('question-nav-button'));
    fireEvent.click(screen.getByTestId('question-nav-item-m3'));
    expect(onJump).toHaveBeenCalledWith('m3');
    expect(screen.queryByTestId('question-nav-popover')).not.toBeInTheDocument();
  });

  it('Escape schließt das Popover', () => {
    render(<QuestionNavButton questions={entries(2)} activeIndex={0} onJump={vi.fn()} />);
    fireEvent.click(screen.getByTestId('question-nav-button'));
    expect(screen.getByTestId('question-nav-popover')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('question-nav-popover')).not.toBeInTheDocument();
  });

  it('Nur-Zitat-Fragen erscheinen kursiv', () => {
    const qs: QuestionEntry[] = [
      { messageId: 'm1', text: 'normal question', quoteOnly: false },
      { messageId: 'm2', text: 'the quoted passage', quoteOnly: true },
    ];
    render(<QuestionNavButton questions={qs} activeIndex={0} onJump={vi.fn()} />);
    fireEvent.click(screen.getByTestId('question-nav-button'));
    const quoteItem = screen.getByTestId('question-nav-item-m2');
    expect(quoteItem.querySelector('.italic')).toHaveTextContent('the quoted passage');
  });
});

describe('QuestionStepper', () => {
  it('zeigt den Zähler "aktuell/gesamt"', () => {
    render(<QuestionStepper activeIndex={3} total={12} onJumpTo={vi.fn()} />);
    expect(screen.getByTestId('question-stepper')).toHaveTextContent('4/12');
  });

  it('Vor/Zurück springen zur Nachbar-Frage', () => {
    const onJumpTo = vi.fn();
    render(<QuestionStepper activeIndex={3} total={12} onJumpTo={onJumpTo} />);
    fireEvent.click(screen.getByTestId('question-stepper-prev'));
    expect(onJumpTo).toHaveBeenLastCalledWith(2);
    fireEvent.click(screen.getByTestId('question-stepper-next'));
    expect(onJumpTo).toHaveBeenLastCalledWith(4);
  });

  it('an den Enden ist der jeweilige Pfeil deaktiviert', () => {
    const onJumpTo = vi.fn();
    const { rerender } = render(<QuestionStepper activeIndex={0} total={3} onJumpTo={onJumpTo} />);
    expect(screen.getByTestId('question-stepper-prev')).toBeDisabled();
    expect(screen.getByTestId('question-stepper-next')).not.toBeDisabled();
    rerender(<QuestionStepper activeIndex={2} total={3} onJumpTo={onJumpTo} />);
    expect(screen.getByTestId('question-stepper-next')).toBeDisabled();
    fireEvent.click(screen.getByTestId('question-stepper-next'));
    expect(onJumpTo).not.toHaveBeenCalled();
  });
});

// ─── ChatArea-Integration ────────────────────────────────────────────────────

const twoQuestionChat: ChatDetail = {
  id: 'c1',
  title: 'Test Chat',
  parent_id: null,
  parent_word: null,
  created_at: new Date().toISOString(),
  messages: [
    { id: 'm1', chat_id: 'c1', role: 'user', content: 'First question?', created_at: new Date().toISOString() },
    { id: 'm2', chat_id: 'c1', role: 'assistant', content: 'An answer.', created_at: new Date().toISOString() },
    { id: 'm3', chat_id: 'c1', role: 'user', content: 'Second question?', created_at: new Date().toISOString() },
  ],
  children: [],
};

const defaultProps = {
  loading: false,
  streaming: false,
  onSendMessage: vi.fn().mockResolvedValue(undefined),
  onWordRightClick: vi.fn(),
  onSelectChat: vi.fn(),
};

describe('ChatArea-Integration', () => {
  afterEach(() => vi.restoreAllMocks());

  it('Popover-Klick scrollt zur Frage — OHNE Aufblinken (Nutzerkorrektur 2026-07-22)', () => {
    const scrollIntoView = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    render(<ChatArea chat={twoQuestionChat} {...defaultProps} />);
    fireEvent.click(screen.getByTestId('question-nav-button'));

    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByTestId('question-nav-item-m1'));
      const row = screen.getByTestId('message-row-m1');
      const target = scrollIntoView.mock.instances.at(-1) as unknown as HTMLElement;
      expect(row.contains(target)).toBe(true);
      // Kein Flash — weder sofort noch nach Scroll-Ruhe.
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(row).not.toHaveAttribute('data-flash');
    } finally {
      vi.useRealTimers();
      window.HTMLElement.prototype.scrollIntoView = () => {};
    }
  });

  it('Stepper ist ohne Überlauf unsichtbar', () => {
    render(<ChatArea chat={twoQuestionChat} {...defaultProps} />);
    expect(screen.queryByTestId('question-stepper')).not.toBeInTheDocument();
  });

  it('Stepper erscheint, sobald die Liste überläuft', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
    render(<ChatArea chat={twoQuestionChat} {...defaultProps} />);
    expect(screen.getByTestId('question-stepper')).toBeInTheDocument();
  });

  it('Alt+↑ scrollt zur vorherigen Frage', () => {
    const scrollIntoView = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      render(<ChatArea chat={twoQuestionChat} {...defaultProps} />);
      const callsBefore = scrollIntoView.mock.calls.length;
      // jsdom-Layout: alle Oberkanten sind 0 → die letzte Frage gilt als
      // aktuell, Alt+↑ springt also zur ersten.
      fireEvent.keyDown(window, { key: 'ArrowUp', altKey: true });
      expect(scrollIntoView.mock.calls.length).toBe(callsBefore + 1);
      const target = scrollIntoView.mock.instances.at(-1) as unknown as HTMLElement;
      expect(screen.getByTestId('message-row-m1').contains(target)).toBe(true);
    } finally {
      window.HTMLElement.prototype.scrollIntoView = () => {};
    }
  });

  it('funktioniert auch in Kind-Chats (Branch mit parent_word)', () => {
    // Nutzerwunsch 2026-07-22: die Navigation darf im kompakten Branch-Header
    // nicht verloren gehen.
    const childChat: ChatDetail = { ...twoQuestionChat, parent_id: 'p1', parent_word: 'attention' };
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
    render(<ChatArea chat={childChat} {...defaultProps} />);
    expect(screen.getByTestId('question-nav-button')).toHaveTextContent('2 questions');
    expect(screen.getByTestId('question-stepper')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('question-nav-button'));
    expect(screen.getByTestId('question-nav-popover')).toHaveTextContent('First question?');
  });

  it('Alt+↑ bleibt stumm, solange der Composer fokussiert ist', () => {
    const scrollIntoView = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      render(<ChatArea chat={twoQuestionChat} {...defaultProps} />);
      const textarea = screen.getByTestId('chat-textarea');
      textarea.focus();
      const callsBefore = scrollIntoView.mock.calls.length;
      fireEvent.keyDown(textarea, { key: 'ArrowUp', altKey: true });
      expect(scrollIntoView.mock.calls.length).toBe(callsBefore);
    } finally {
      window.HTMLElement.prototype.scrollIntoView = () => {};
    }
  });

  // Nutzerreport 2026-08-10: in einer schmalen Spalte wächst der Composer auf
  // seine Maximalhöhe, und der Stepper mit festem Abstand vom Spaltenboden
  // (bottom-32) landete DARIN. Er gehört an die Oberkante des Composers, also
  // in dessen Container — dann steigt er bei jeder Feldhöhe mit
  // (design/mockup-composer-narrow.html §05).
  it('Stepper hängt am Composer, nicht an einem festen Abstand vom Spaltenboden', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
    render(<ChatArea chat={twoQuestionChat} {...defaultProps} />);

    const stepper = screen.getByTestId('question-stepper');
    const composerArea = screen.getByTestId('chat-input-dropzone');
    const anchor = stepper.closest('[data-testid="composer-floaters"]');

    expect(anchor).not.toBeNull();
    expect(composerArea.contains(anchor as Node)).toBe(true);
    expect(anchor).toHaveClass('bottom-full');
    expect(anchor?.className).not.toMatch(/bottom-32/);
  });
});
