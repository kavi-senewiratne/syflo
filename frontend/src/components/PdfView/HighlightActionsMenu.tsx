/**
 * components/PdfView/HighlightActionsMenu.tsx
 *
 * Tiny popover that opens when the user clicks an existing colored highlight
 * in the PDF (1:1 port of Syflo's HighlightActionsMenu, Slice 06). Three
 * actions:
 *   1. Recolor — pick one of the 5 colors via the same swatch row used in
 *      the FloatingPopup. Stays open after picking so the user can compare
 *      adjacent highlights without re-opening the menu.
 *   2. Open linked chat — only when the highlight is linked to a branch;
 *      hidden when no chat is linked (rather than disabled) — keeps the menu
 *      compact when most highlights are naked marks.
 *   3. Delete — removes the highlight. No confirmation: undo via
 *      re-selecting the text + picking the color again, which is faster
 *      than a modal dance.
 *
 * Closes on outside click and on Escape.
 */

import { useEffect, useRef } from 'react';
import { Check, MessageSquare, Trash2 } from 'lucide-react';
import { HIGHLIGHT_COLORS } from '../../types';
import type { HighlightColor } from '../../types';
import { useLabels } from '../../hooks/useLabels';
import { useStrings } from '../../strings';

const SWATCH_BG: Record<HighlightColor, string> = {
  yellow: 'bg-[#FEF08A]',
  green: 'bg-[#BBF7D0]',
  blue: 'bg-[#BFDBFE]',
  pink: 'bg-[#FBCFE8]',
  orange: 'bg-[#FED7AA]',
};

interface Props {
  // Only the color and (for PDF highlights) the linked branch are needed —
  // keeping the shape minimal lets chat-text highlights reuse this menu
  // (they pass chatId: null, which hides "Open linked chat").
  highlight: { color: HighlightColor; chatId?: string | null };
  x: number;
  y: number;
  onClose: () => void;
  onChangeColor: (color: HighlightColor) => void;
  onDelete: () => void;
  onOpenChat: () => void;
}

export function HighlightActionsMenu({
  highlight,
  x,
  y,
  onClose,
  onChangeColor,
  onDelete,
  onOpenChat,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const { labels } = useLabels();
  // UI-Texte in der App language — re-rendert beim Sprachwechsel mit.
  const S = useStrings().highlightMenu;

  useEffect(() => {
    const onPointer = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Defer attaching the listener until the next tick so the very click
    // that opened the menu doesn't immediately close it.
    const id = window.setTimeout(() => {
      document.addEventListener('mousedown', onPointer);
    }, 0);
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Clamp to viewport so the menu never gets cut off near a screen edge.
  const w = 240;
  const h = highlight.chatId ? 160 : 120;
  const left = Math.min(x + 4, window.innerWidth - w - 12);
  const top = Math.min(y + 4, window.innerHeight - h - 12);

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left, top, width: w }}
      className="fixed z-50 bg-white rounded-xl shadow-2xl border border-gray-100 overflow-hidden"
      data-testid="highlight-actions-menu"
    >
      <div className="px-3 pt-2.5 pb-2 border-b border-gray-100">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1.5">
          {S.changeColor}
        </p>
        <div className="flex justify-between items-center gap-1">
          {HIGHLIGHT_COLORS.map((c) => {
            const isCurrent = c === highlight.color;
            return (
              <button
                key={c}
                type="button"
                onClick={() => onChangeColor(c)}
                aria-label={labels[c]}
                data-tip={labels[c]}
                className={`w-7 h-7 rounded-full flex items-center justify-center transition-transform hover:scale-110 ${SWATCH_BG[c]} ${
                  isCurrent ? 'ring-2 ring-gray-900' : 'ring-1 ring-gray-200/60'
                }`}
              >
                {isCurrent && <Check size={12} className="text-gray-900" strokeWidth={3} />}
              </button>
            );
          })}
        </div>
      </div>
      <div className="py-1">
        {highlight.chatId && (
          <button
            type="button"
            onClick={onOpenChat}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
          >
            <MessageSquare size={14} className="text-gray-500" />
            {S.openLinkedChat}
          </button>
        )}
        <button
          type="button"
          onClick={onDelete}
          className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
        >
          <Trash2 size={14} className="text-gray-500" />
          {S.deleteHighlight}
        </button>
      </div>
    </div>
  );
}
