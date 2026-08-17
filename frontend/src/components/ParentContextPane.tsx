/**
 * components/ParentContextPane.tsx
 *
 * Center pane of the no-PDF branch layout
 * (design/mockup-chat-highlights-ask-in-chat.html, section 03).
 *
 * When a branch chat is active and its tree has no PDF, the center column is
 * not wasted: the parent chat renders here as a read-only context view — the
 * selection that spawned the branch stays visibly highlighted. With a PDF
 * attached this pane never mounts (the PDF keeps the center, unchanged).
 *
 * Die Vorfahren-Karten („What the model inherits") zogen 2026-07-22 in ein
 * Banner der Chat-Spalte um und sind 2026-08-01 ersatzlos entfallen: die
 * Leiste wirkte überladen und erzählte nach, was diese Pane ohnehin in voller
 * Länge zeigt. Diese Pane zeigt den Elternchat — sonst nichts.
 *
 * Read-only means: no composer, no header editing. Text interactions still
 * work — selecting text and right-clicking opens the same popup (color row +
 * "Ask in chat"), and right-clicking an existing highlight opens the
 * recolor/delete menu, exactly like in the right-pane chat.
 */

import { useLayoutEffect, useRef } from 'react';
import { ExternalLink, MessageSquare } from 'lucide-react';
import { MessageBubble } from './ChatArea/MessageBubble';
import { MathText, hasMath, plainMathText } from './MathText';
import { useStrings } from '../strings';
import type { ChatDetail, ChatSelection, Message, MessageHighlight, WordPopup } from '../types';

interface Props {
  chat: ChatDetail;
  highlights: MessageHighlight[];
  // Jump back into the parent chat (toolbar button).
  onOpenChat: (id: string) => void;
  onSelectChat: (id: string) => void;
  onWordRightClick: (popup: WordPopup) => void;
  onChatSelection: (sel: ChatSelection, context: string, x: number, y: number) => void;
  onHighlightContextMenu: (highlight: MessageHighlight, x: number, y: number) => void;
  // Erfasste Auswahl des offenen Popups — bleibt als Overlay sichtbar
  // (gleiche Mechanik wie in ChatArea).
  pendingSelection?: ChatSelection | null;
  // Ursprungs-Nachricht des gerade geöffneten Branches: die Pane scrollt
  // beim Mount dorthin statt an den Anfang, damit der Kontext der Auswahl
  // sichtbar bleibt (Nutzer-Report 2026-07-22). Nach dem Scrollen meldet
  // onScrollTargetConsumed, damit die App das Ziel verwirft.
  scrollToMessageId?: string | null;
  onScrollTargetConsumed?: () => void;
  // Klick auf das Zitat einer Frage im Elternchat: springt zu deren Quelle,
  // genau wie in der aktiven Spalte (mockup-quote-jump-to-source.html).
  onQuoteClick?: (message: Message) => void;
}

export function ParentContextPane({
  chat,
  highlights,
  onOpenChat,
  onSelectChat,
  onWordRightClick,
  onChatSelection,
  onHighlightContextMenu,
  pendingSelection,
  scrollToMessageId,
  onScrollTargetConsumed,
  onQuoteClick,
}: Props) {
  // UI-Texte in der App language — re-rendert beim Sprachwechsel mit.
  const S = useStrings().parentContext;
  const paneRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!scrollToMessageId) return;
    const row = paneRef.current?.querySelector(
      `[data-testid="parent-msg-${scrollToMessageId}"]`,
    );
    if (!row) return; // Nachricht (noch) nicht da — Ziel behalten, nächster Commit versucht es erneut
    row.scrollIntoView({ block: 'center' });
    onScrollTargetConsumed?.();
  }, [scrollToMessageId, chat.id, chat.messages.length]);

  const branchWords = chat.children
    .filter((c) => c.parent_word)
    .map((c) => ({ word: c.parent_word!, chatId: c.id }));

  return (
    <div
      ref={paneRef}
      className="flex-1 min-w-0 flex flex-col overflow-hidden bg-gray-50"
      data-testid="parent-context-pane"
    >
      {/* Toolbar — mirrors the PDF pane's toolbar row */}
      <div className="h-11 shrink-0 flex items-center justify-between px-4 bg-white border-b border-gray-200">
        <div className="flex items-center gap-2 min-w-0">
          <MessageSquare size={14} className="text-gray-400 shrink-0" />
          <span className={`text-[13px] font-medium text-gray-900 ${hasMath(chat.title) ? 'syflo-math-fade' : 'truncate'}`} title={plainMathText(chat.title)}>
            <MathText text={chat.title} />
          </span>
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-gray-400 bg-gray-50 border border-gray-200 rounded px-1.5 py-px">
            {S.badge}
          </span>
        </div>
        <button
          onClick={() => onOpenChat(chat.id)}
          title={S.openChat}
          aria-label={S.openChat}
          data-testid="parent-context-open"
          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-50 transition-colors"
        >
          <ExternalLink size={15} />
        </button>
      </div>

      {/* Message sheet — white card on the muted pane background, read-only */}
      <div className="flex-1 overflow-y-auto">
        <div className="flex justify-center px-7 py-5">
          <div className="w-full max-w-2xl bg-white border border-gray-200 rounded-2xl shadow-sm px-6 py-5 flex flex-col">
            {chat.messages.map((msg, i) => (
              <div
                key={msg.id}
                data-testid={`parent-msg-${msg.id}`}
                style={{ marginTop: i === 0 ? 0 : '1.5rem' }}
              >
                <MessageBubble
                  message={msg}
                  onWordRightClick={(word, context, x, y) =>
                    onWordRightClick({ word, context, x, y })
                  }
                  branchWords={branchWords}
                  onBranchClick={onSelectChat}
                  highlights={highlights}
                  onChatSelection={onChatSelection}
                  onHighlightContextMenu={onHighlightContextMenu}
                  pendingSelection={pendingSelection}
                  onQuoteClick={onQuoteClick}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
