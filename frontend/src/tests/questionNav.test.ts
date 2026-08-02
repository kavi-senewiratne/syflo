/**
 * questionNav.test.ts
 *
 * Pure Logik der Fragen-Navigation (Grill 2026-07-22, mockup-question-nav.html
 * Varianten 1+3): Ableitung der Fragenliste aus den Nachrichten und der
 * Scroll-Spy, der die "aktuelle" Frage aus der Scroll-Position bestimmt.
 */

import { describe, it, expect } from 'vitest';
import { deriveQuestions, currentQuestionIndex } from '../chat/questionNav';
import type { Message } from '../types';

const msg = (id: string, role: 'user' | 'assistant', content: string): Message => ({
  id,
  chat_id: 'c1',
  role,
  content,
  created_at: new Date().toISOString(),
});

describe('deriveQuestions', () => {
  it('nimmt jede User-Nachricht chronologisch auf, Assistant-Nachrichten nicht', () => {
    const questions = deriveQuestions([
      msg('m1', 'user', 'What is ACT?'),
      msg('m2', 'assistant', 'ACT is…'),
      msg('m3', 'user', 'continue'),
      msg('m4', 'assistant', 'Sure…'),
    ]);
    expect(questions.map((q) => q.messageId)).toEqual(['m1', 'm3']);
    expect(questions.map((q) => q.text)).toEqual(['What is ACT?', 'continue']);
  });

  it('strippt das Ask-in-chat-Zitat und zeigt nur die eigentliche Frage', () => {
    const [q] = deriveQuestions([
      msg('m1', 'user', '> temporal ensembling averages\n> overlapping chunks\n\nWhy does this help?'),
    ]);
    expect(q.text).toBe('Why does this help?');
    expect(q.quoteOnly).toBe(false);
  });

  it('nur-Zitat-Nachricht: Zitattext wird angezeigt und als quoteOnly markiert', () => {
    const [q] = deriveQuestions([msg('m1', 'user', '> the marked passage\n> continues here')]);
    expect(q.text).toBe('the marked passage continues here');
    expect(q.quoteOnly).toBe(true);
  });

  it('reduziert Markdown auf Klartext (fett, Code, Links, Überschriften)', () => {
    const [q] = deriveQuestions([
      msg('m1', 'user', '## Compare **ACT** with `diffusion` — see [the paper](https://x.y)'),
    ]);
    expect(q.text).toBe('Compare ACT with diffusion — see the paper');
  });

  it('mehrzeilige Fragen werden zu einer Vorschau-Zeile zusammengezogen', () => {
    const [q] = deriveQuestions([msg('m1', 'user', 'First line\n\nsecond line')]);
    expect(q.text).toBe('First line second line');
  });
});

describe('currentQuestionIndex (Scroll-Spy)', () => {
  // "Aktuell" ist die letzte Frage, deren Oberkante über der Referenzlinie
  // (Viewport-Mitte) liegt — Grill-Entscheidung 4.
  it('liefert die letzte Frage oberhalb der Referenzlinie', () => {
    expect(currentQuestionIndex([0, 100, 200], 150)).toBe(1);
    expect(currentQuestionIndex([0, 100, 200], 500)).toBe(2);
  });

  it('vor der ersten Frage gilt die erste als aktuell', () => {
    expect(currentQuestionIndex([50, 100], 10)).toBe(0);
  });

  it('ohne Fragen gibt es keinen Index', () => {
    expect(currentQuestionIndex([], 100)).toBe(-1);
  });

  // Screenshot case 2026-07-25: last answer failed (tiny error row), so the
  // last question's top never crossed the midline — stepper stuck at 20/21.
  it('bottom clamp: scrolled to the bottom, the last question is current', () => {
    expect(currentQuestionIndex([0, 100, 200], 150, true)).toBe(2);
    expect(currentQuestionIndex([], 100, true)).toBe(-1);
  });
});
