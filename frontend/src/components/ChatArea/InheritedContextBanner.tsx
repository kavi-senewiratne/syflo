/**
 * components/ChatArea/InheritedContextBanner.tsx
 *
 * Variante 3a aus design/mockup-context-banner-variants.html (§01):
 * Der geerbte Vorfahren-Kontext gehört zum Chat, der ihn EMPFÄNGT — nicht
 * in die mittlere Spalte (Nutzer-Feedback 2026-07-22: die Karten dort
 * erklärten ihre Rolle nicht). Ein schmales Banner unter dem Chat-Header
 * („Carries background from N earlier chats") klappt als Inline-Akkordeon
 * auf und zeigt pro Vorfahre die Kernaussage + Stichpunkte
 * (summary_display), mit dem wörtlich geerbten Summary-Text einen Klick
 * dahinter. Alte Summaries ohne display-Struktur fallen auf den als
 * Markdown gerenderten Volltext zurück.
 */

import { useState } from 'react';
import { ChevronDown, ChevronUp, GitBranch, MessageSquare, Send } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { normalizeMathDelimiters } from './MessageBubble';
import { gfmTableComponents } from './markdownTables';
import { useStrings } from '../../strings';
import type { ChatAncestor } from '../../types';

interface Props {
  // Vorfahren-Pfad (Wurzel → … → direkter Elternchat) des aktiven Chats.
  ancestors: ChatAncestor[];
}

// Summary-Texte durch dieselbe Markdown+KaTeX-Pipeline wie die Chat-Bubbles
// schicken — der Summarizer schreibt Markdown mit Inline-LaTeX ($...$);
// als Rohtext gerendert standen $- und *-Zeichen im UI (Report 2026-07-22).
function SummaryMarkdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className ?? 'text-[12px] leading-relaxed text-gray-600 [&_p+p]:mt-1.5'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={gfmTableComponents}
      >
        {normalizeMathDelimiters(text)}
      </ReactMarkdown>
    </div>
  );
}

function AncestorCard({ ancestor, isParent }: { ancestor: ChatAncestor; isParent: boolean }) {
  const S = useStrings().inheritedContext;
  const [literalOpen, setLiteralOpen] = useState(false);
  const { display, summary } = ancestor;

  return (
    <div
      data-testid={`inherited-card-${ancestor.id}`}
      className="bg-white border border-gray-200 rounded-xl px-3 py-2.5"
    >
      <div className="flex items-center gap-2 mb-1.5">
        <MessageSquare size={13} className="text-gray-400 shrink-0" />
        <span className="text-[12px] font-semibold text-gray-900 truncate">{ancestor.title}</span>
        {isParent && (
          <span className="shrink-0 text-[9.5px] font-semibold uppercase tracking-wider text-gray-400 bg-gray-50 border border-gray-200 rounded px-1.5 py-px">
            {S.inheritedWordForWord}
          </span>
        )}
        <span className="ml-auto shrink-0 text-[10px] font-semibold text-blue-700 bg-blue-50 border border-blue-100 rounded-full px-2 py-px">
          {ancestor.parent_word || 'root'}
        </span>
      </div>

      {display ? (
        <>
          <SummaryMarkdown
            text={display.gist}
            className="text-[12px] leading-relaxed font-medium text-gray-900"
          />
          {display.points.length > 0 && (
            <ul className="mt-1.5 flex flex-col gap-1">
              {display.points.map((p, i) => (
                <li key={i} className="relative pl-3.5 before:absolute before:left-0.5 before:top-[7px] before:h-[4.5px] before:w-[4.5px] before:rounded-full before:bg-blue-500">
                  <SummaryMarkdown text={p} className="text-[11.5px] leading-relaxed text-gray-600" />
                </li>
              ))}
            </ul>
          )}
          {!isParent && summary && (
            <>
              <button
                type="button"
                data-testid={`inherited-card-${ancestor.id}-literal-toggle`}
                onClick={() => setLiteralOpen((v) => !v)}
                className="mt-1.5 inline-flex items-center gap-1 text-[10.5px] font-medium text-blue-700 hover:text-blue-900"
              >
                <ChevronDown size={11} className={`transition-transform ${literalOpen ? 'rotate-180' : ''}`} />
                {literalOpen ? S.hideLiteral : S.showLiteral}
              </button>
              {literalOpen && (
                <div className="mt-1.5 border-t border-dashed border-gray-200 pt-1.5" data-testid={`inherited-card-${ancestor.id}-literal`}>
                  <SummaryMarkdown text={summary} />
                </div>
              )}
            </>
          )}
        </>
      ) : summary ? (
        <SummaryMarkdown text={summary} />
      ) : (
        <p className="text-[12px] leading-relaxed text-gray-500">
          {isParent ? S.parentFullText : S.noSummaryYet}
        </p>
      )}
    </div>
  );
}

export function InheritedContextBanner({ ancestors }: Props) {
  // UI-Texte in der App language — re-rendert beim Sprachwechsel mit.
  const S = useStrings().inheritedContext;
  const [open, setOpen] = useState(false);
  if (ancestors.length === 0) return null;

  return (
    <div data-testid="inherited-context-banner">
      <button
        type="button"
        data-testid="inherited-context-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-2 bg-blue-50/70 border-b border-blue-100 text-[11.5px] text-gray-700 hover:bg-blue-50 transition-colors"
      >
        <GitBranch size={13} className="text-blue-700 shrink-0" />
        <span className="truncate">
          {S.carries(ancestors.length)}
        </span>
        <span className="ml-auto shrink-0 inline-flex items-center gap-1 font-semibold text-blue-700">
          {open ? S.hide : S.show}
          {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </span>
      </button>
      {/* max-h in vh, NICHT in %: eine Prozent-Höhe gegen den Auto-Höhen-
          Wrapper ist zirkulär — Chrome layoutet erst ungedeckelt (Wrapper
          wächst auf volle Kartenhöhe), kappt dann nur den Body, und die
          Differenz bleibt als weiße Leerfläche im Wrapper stehen
          (Nutzer-Screenshot 2026-07-23). */}
      {open && (
        <div
          data-testid="inherited-context-body"
          className="flex flex-col gap-2 px-4 py-3 bg-blue-50/40 border-b border-blue-100 max-h-[40vh] overflow-y-auto"
        >
          {ancestors.map((a, i) => (
            <AncestorCard key={a.id} ancestor={a} isParent={i === ancestors.length - 1} />
          ))}
          <div className="flex items-center gap-1.5 pt-1 text-[10.5px] text-gray-500">
            <Send size={11} className="text-gray-400 shrink-0" />
            {S.sentWithEvery}
          </div>
        </div>
      )}
    </div>
  );
}
