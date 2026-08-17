/**
 * components/ChatArea/QuestionNav.tsx
 *
 * Fragen-Navigation der Chat-Spalte (Grill 2026-07-22,
 * design/mockup-question-nav.html, Varianten 1+3):
 *
 *   1. QuestionNavButton — Header-Button "N questions" mit Popover-Liste
 *      aller Fragen (chronologisch nummeriert). Klick springt zur Frage und
 *      schließt das Popover; Esc/Außenklick schließen ebenfalls. Ab 2 Fragen
 *      sichtbar — bei einer gibt es nichts zu navigieren.
 *   2. QuestionStepper — schwebende Pille "‹n›/‹total›" mit Vor/Zurück,
 *      sichtbar sobald die Nachrichtenliste überläuft; die ChatArea
 *      positioniert und speist sie.
 *
 * Die "aktuelle" Frage kommt per Scroll-Spy aus der ChatArea
 * (chat/questionNav.ts) — eine Quelle für Zähler UND aktiven Listeneintrag.
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, List } from 'lucide-react';
import { useStrings } from '../../strings';
import { MathText } from '../MathText';
import type { QuestionEntry } from '../../chat/questionNav';

interface ButtonProps {
  questions: QuestionEntry[];
  activeIndex: number;
  onJump: (messageId: string) => void;
}

export function QuestionNavButton({ questions, activeIndex, onJump }: ButtonProps) {
  // UI-Texte in der App language — re-rendert beim Sprachwechsel mit.
  const S = useStrings().questionNav;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const activeItemRef = useRef<HTMLButtonElement>(null);

  // Schließen per Esc und Außenklick — gleiches Muster wie das
  // HighlightActionsMenu (mousedown erst im nächsten Tick anhängen, damit
  // der öffnende Klick das Popover nicht sofort wieder schließt).
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const id = window.setTimeout(() => document.addEventListener('mousedown', onPointer), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Beim Öffnen zum aktiven Eintrag scrollen — bei 30 Fragen soll niemand
  // selbst suchen müssen (Grill-Entscheidung 6).
  useEffect(() => {
    if (open) activeItemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [open]);

  if (questions.length < 2) return null;

  return (
    <div ref={rootRef} className="relative">
      {/* Kurzinfo NACH UNTEN: der Knopf sitzt in der obersten Leiste, nach oben
          wurde die Sprechblase am Rand abgeschnitten (Nutzerbericht
          2026-08-11). Und nur in der Symbol-Stufe — sonst stünde derselbe Text
          schon im Knopf. Kein aria-label: der sichtbare Text IST der Name. */}
      <button
        type="button"
        data-focus-item="chat-questions"
        data-testid="question-nav-button"
        aria-expanded={open}
        data-tip={S.buttonTitle}
        data-tip-narrow-only=""
        data-tip-below=""
        onClick={() => setOpen((o) => !o)}
        className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium transition-colors ${
          open
            ? 'bg-blue-50 text-blue-700'
            : 'border border-gray-200 text-gray-500 hover:bg-gray-100 hover:text-gray-700'
        }`}
      >
        <List size={14} />
        <span className="@max-[30rem]:hidden">{S.buttonLabel(questions.length)}</span>
      </button>

      {open && (
        <div
          role="menu"
          data-testid="question-nav-popover"
          className="absolute right-0 top-[calc(100%+6px)] z-30 w-[300px] overflow-hidden rounded-xl border border-gray-100 bg-white shadow-2xl"
        >
          <p className="border-b border-gray-100 px-3.5 pb-2 pt-2.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
            {S.popoverHeading}
          </p>
          <div className="max-h-80 overflow-y-auto py-1">
            {questions.map((q, i) => {
              const isActive = i === activeIndex;
              return (
                <button
                  key={q.messageId}
                  ref={isActive ? activeItemRef : undefined}
                  type="button"
                  role="menuitem"
                  data-testid={`question-nav-item-${q.messageId}`}
                  aria-current={isActive ? 'true' : undefined}
                  onClick={() => {
                    setOpen(false);
                    onJump(q.messageId);
                  }}
                  className={`flex w-full items-baseline gap-2.5 px-3.5 py-2 text-left text-[12.5px] leading-snug transition-colors ${
                    isActive ? 'bg-blue-50' : 'hover:bg-gray-50'
                  }`}
                >
                  <span
                    className={`w-4 shrink-0 text-right font-mono text-[11px] ${
                      isActive ? 'font-semibold text-blue-700' : 'text-gray-400'
                    }`}
                  >
                    {i + 1}
                  </span>
                  <span
                    className={`line-clamp-2 min-w-0 ${q.quoteOnly ? 'italic' : ''} ${
                      isActive ? 'font-medium text-blue-700' : 'text-gray-700'
                    }`}
                  >
                    <MathText text={q.text} />
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

interface StepperProps {
  activeIndex: number;
  total: number;
  onJumpTo: (index: number) => void;
}

// Schwebende Vor/Zurück-Pille. Die ChatArea blendet sie nur ein, wenn die
// Nachrichtenliste überläuft (Grill-Entscheidung 3) und positioniert sie
// absolut über dem Composer.
export function QuestionStepper({ activeIndex, total, onJumpTo }: StepperProps) {
  const S = useStrings().questionNav;
  const atFirst = activeIndex <= 0;
  const atLast = activeIndex >= total - 1;
  return (
    <div
      data-testid="question-stepper"
      className="flex items-center gap-0.5 rounded-full border border-gray-200 bg-white p-1 shadow-md"
    >
      <button
        type="button"
        // The stepper is a row of two controls in the chat region: ← → walk
        // them, Enter presses (user request 2026-08-12).
        data-focus-item="question-prev"
        data-testid="question-stepper-prev"
        aria-label={S.previous}
        disabled={atFirst}
        onClick={() => onJumpTo(activeIndex - 1)}
        className="flex h-7 w-7 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:pointer-events-none disabled:text-gray-300"
      >
        <ChevronUp size={15} strokeWidth={2.2} />
      </button>
      <span className="whitespace-nowrap px-1.5 font-mono text-[11.5px] text-gray-500">
        <b className="font-semibold text-gray-900">{Math.max(0, activeIndex) + 1}</b>/{total}
      </span>
      <button
        type="button"
        data-focus-item="question-next"
        data-testid="question-stepper-next"
        aria-label={S.next}
        disabled={atLast}
        onClick={() => onJumpTo(activeIndex + 1)}
        className="flex h-7 w-7 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:pointer-events-none disabled:text-gray-300"
      >
        <ChevronDown size={15} strokeWidth={2.2} />
      </button>
    </div>
  );
}
