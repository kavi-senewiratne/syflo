/**
 * components/FloatingPopup/index.tsx
 *
 * A small card that floats near the right-clicked word and shows:
 * 1. The word as a heading
 * 2. A short AI-generated definition (fetched by App.tsx)
 * 3. When the right-click captured a PDF selection (onPickColor set): a row
 *    of 5 color swatches with labels — clicking one persists a highlight on
 *    the selection (parent owns the save), plus a pencil icon that swaps the
 *    row into an inline edit mode for renaming each color's label.
 * 4. A button to open a new branched chat focused on the word.
 *
 * Positioning: the popup tries to appear just to the right and below the
 * click point, but clamps to the viewport edges so it never gets cut off —
 * against its MEASURED height (a ResizeObserver re-clamps when the content
 * grows, e.g. once the definition arrives or edit mode opens). On very small
 * windows the card caps at the viewport height and scrolls internally. The
 * header doubles as a drag handle so the user can move the popup around.
 *
 * Design: 1:1 port of Syflo's FloatingPopup — the color row mirrors
 * design/mockup-popup-edit-labels.html; both states use the same blue-50
 * primary button so switching modes feels like a transformation, not a
 * separate dialog.
 */

import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { X, GitBranch, Loader2, Copy, Check, MessageSquare, Pencil, RotateCcw } from 'lucide-react';
import type { HighlightColor, WordPopup } from '../../types';
import { HIGHLIGHT_COLORS } from '../../types';
import { useLabels } from '../../hooks/useLabels';
import { useStrings } from '../../strings';
import { MathText, clipMathText, hasMath, plainMathText } from '../MathText';

interface Props {
  popup: WordPopup | null;
  explanation: string;
  loading: boolean;
  onClose: () => void;
  onOpenChildChat: (word: string, context: string) => void;
  // When the user picks a color, the parent saves the highlight against the
  // captured PDF selection. Absent for chat-message right-clicks — the color
  // section doesn't render then (nothing to highlight).
  onPickColor?: (color: HighlightColor) => void;
  // The color a highlight created via "Open as new chat" would get, and the
  // swatch that shows the ring + checkmark. Defaults to yellow.
  activeColor?: HighlightColor;
  // "Ask in chat" (mockup-chat-highlights-ask-in-chat.html): drop the
  // selection as a quote into the active chat's composer — no branch. Only
  // set when the popup came from a selection (PDF or chat text); it renders
  // as the primary footer button and demotes "Open as new chat" to secondary.
  onAskInChat?: (word: string, context: string) => void;
}

// Tailwind doesn't pick up dynamic class names, so we keep an explicit map.
// Pastel-saturated tones that match the design mockups and play nicely with
// black body text in the rendered PDF.
const SWATCH_BG: Record<HighlightColor, string> = {
  yellow: 'bg-[#FEF08A]',
  green: 'bg-[#BBF7D0]',
  blue: 'bg-[#BFDBFE]',
  pink: 'bg-[#FBCFE8]',
  orange: 'bg-[#FED7AA]',
};

export function FloatingPopup({
  popup,
  explanation,
  loading,
  onClose,
  onOpenChildChat,
  onPickColor,
  activeColor = 'yellow',
  onAskInChat,
}: Props) {
  // UI-Texte in der App language — re-rendert beim Sprachwechsel mit.
  const S = useStrings().floatingPopup;
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const cardRef = useRef<HTMLDivElement>(null);
  // Solange der Nutzer nicht selbst gezogen hat, darf jede Neumessung die
  // Position re-clampen; nach einem Drag bleibt die gewählte Position stehen
  // (nur noch an den Viewport geklemmt).
  const draggedRef = useRef(false);
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
  const [copied, setCopied] = useState(false);
  // Long-phrase header truncation/expand state.
  const [expanded, setExpanded] = useState(false);
  // Edit-labels mode replaces the color row with a list of editable inputs.
  const [editingLabels, setEditingLabels] = useState(false);
  // Local copy of the labels while in edit mode so the user can type freely;
  // commits happen on Save into the global `useLabels` store.
  const { labels, renameLabel } = useLabels();
  const [labelDraft, setLabelDraft] = useState(labels);

  // Re-sync the draft whenever the canonical labels change or we re-enter
  // edit mode — the popup re-uses the same instance across multiple right-
  // clicks, so without this the draft would carry over stale state.
  useEffect(() => {
    setLabelDraft(labels);
  }, [labels]);
  useEffect(() => {
    if (editingLabels) setLabelDraft(labels);
  }, [editingLabels, labels]);

  // Clamp a position so the card stays fully inside the viewport, using the
  // card's real rendered size (falls back to the nominal width before the
  // first paint).
  const clampToViewport = (x: number, y: number) => {
    const w = cardRef.current?.offsetWidth ?? 340;
    const h = cardRef.current?.offsetHeight ?? 0;
    return {
      x: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
    };
  };

  // Recalculate the popup position whenever a new word is right-clicked.
  useEffect(() => {
    if (!popup) return;
    draggedRef.current = false;
    setPos(clampToViewport(popup.x + 12, popup.y + 12));
    setCopied(false);
    setExpanded(false);
    setEditingLabels(false);
  }, [popup]);

  // Klick außerhalb der Karte oder Escape schließt das Popup (Nutzer-Report
  // 2026-07-22, 3. Runde): Ohne das blieb der Pending-Selektions-Zustand
  // aktiv und funkte jeder NEUEN Textauswahl dazwischen (einfache Klicks
  // stellten das alte Zitat wieder her, die Markierung wechselte beim
  // Wegklicken sichtbar den Stil). mousedown statt click, damit der Zustand
  // schon aufgeräumt ist, BEVOR eine neue Auswahl beginnt — React flusht
  // den State-Update synchron am Ende des mousedown-Handlers.
  useEffect(() => {
    if (!popup) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const card = cardRef.current;
      if (card && e.target instanceof Node && card.contains(e.target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [popup, onClose]);

  // Re-clamp against the MEASURED height after render and whenever the card
  // grows (definition loaded, color row appeared, edit mode opened) — the
  // fixed estimate used before let the footer slide below small viewports.
  // After a manual drag the user's position wins; we only keep it on-screen.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card || !popup) return;
    const reclamp = () => {
      setPos((p) => {
        const base = draggedRef.current ? p : { x: popup.x + 12, y: popup.y + 12 };
        const next = clampToViewport(base.x, base.y);
        return next.x === p.x && next.y === p.y ? p : next;
      });
    };
    reclamp();
    const ro = new ResizeObserver(reclamp);
    ro.observe(card);
    window.addEventListener('resize', reclamp);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', reclamp);
    };
  }, [popup]);

  // Drag am Header: Buttons im Header bleiben klickbar (kein Drag-Start auf
  // ihnen); während des Drags hält Pointer-Capture die Bewegung stabil.
  const handleDragPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button, input')) return;
    e.preventDefault();
    dragRef.current = { pointerId: e.pointerId, offsetX: e.clientX - pos.x, offsetY: e.clientY - pos.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const handleDragPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    draggedRef.current = true;
    setPos(clampToViewport(e.clientX - drag.offsetX, e.clientY - drag.offsetY));
  };
  const handleDragPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null;
  };

  const handleCopy = async () => {
    if (!popup) return;
    try {
      await navigator.clipboard.writeText(popup.word);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
  };

  // Commit every changed label in the draft, then leave edit mode. We don't
  // bail on the first failure — each rename is independent, so we keep going
  // and let the optimistic-update layer in useLabels handle rollback.
  const handleSaveLabels = async () => {
    const renames: Array<Promise<void>> = [];
    for (const color of HIGHLIGHT_COLORS) {
      if (labelDraft[color] !== labels[color]) {
        renames.push(renameLabel(color, labelDraft[color]));
      }
    }
    await Promise.all(renames);
    setEditingLabels(false);
  };

  if (!popup) return null;

  const showColors = !!onPickColor;
  const wordCount = popup.word.trim().split(/\s+/).length;
  const isPhrase = wordCount > 3 || popup.word.length > 60;
  const collapsed = isPhrase && !expanded;
  // clipMathText: a plain slice could cut through a $…$ span and the
  // dangling `$` would swallow the rest of the heading once rendered.
  const headerText =
    collapsed && popup.word.length > 60 ? clipMathText(popup.word, 60) : popup.word;

  return (
    <div
      ref={cardRef}
      style={{ left: pos.x, top: pos.y, width: 340, maxHeight: 'calc(100vh - 16px)' }}
      className="fixed z-50 flex flex-col bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden"
    >
      {/* Header — doubles as the drag handle (cursor signals it). */}
      <div
        onPointerDown={handleDragPointerDown}
        onPointerMove={handleDragPointerMove}
        onPointerUp={handleDragPointerEnd}
        onPointerCancel={handleDragPointerEnd}
        data-testid="popup-drag-handle"
        className="shrink-0 flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-gray-100 cursor-move select-none touch-none"
      >
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-medium uppercase tracking-wider text-gray-400 mb-0.5">
            {S.definition}
            {isPhrase && (
              <span className="ml-1 normal-case text-gray-300">{S.wordCount(wordCount)}</span>
            )}
          </p>
          {isPhrase ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              title={expanded ? S.collapse : plainMathText(popup.word)}
              aria-expanded={expanded}
              className={`font-semibold text-sm text-gray-900 text-left w-full hover:text-blue-600 transition-colors ${
                collapsed ? (hasMath(popup.word) ? 'syflo-math-fade' : 'truncate') : 'break-words'
              }`}
            >
              "<MathText text={headerText} />"
            </button>
          ) : (
            <p className="font-semibold text-sm text-gray-900 break-words">"<MathText text={headerText} />"</p>
          )}
        </div>
        <div className="shrink-0 flex items-center gap-0.5 -mr-1 -mt-0.5">
          <button
            onClick={handleCopy}
            aria-label={copied ? S.copiedAria : S.copyText}
            title={copied ? S.copiedTitle : S.copyText}
            className="p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          >
            {copied ? <Check size={15} className="text-green-600" /> : <Copy size={15} />}
          </button>
          <button
            onClick={onClose}
            aria-label={S.close}
            className="p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {/* Body — the flexible section: on very small viewports it shrinks
          below max-h-52 and scrolls, so the color row + footer stay visible. */}
      <div className="px-5 py-4 max-h-52 min-h-0 overflow-y-auto">
        {loading ? (
          <div className="flex items-center gap-2 text-gray-400 text-sm">
            <Loader2 size={14} className="animate-spin" />
            <span>{S.loadingDefinition}</span>
          </div>
        ) : (
          <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap"><MathText text={explanation} /></p>
        )}
      </div>

      {/* Color section — section header + row of swatches OR edit list.
          Only rendered when the parent captured a PDF selection. */}
      {showColors && (
        <div className="shrink-0 border-t border-gray-100 px-5 pt-3 pb-2" data-testid="popup-color-section">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              {editingLabels ? S.renameColors : S.highlightColor}
            </p>
            {editingLabels ? (
              <button
                type="button"
                onClick={() => setEditingLabels(false)}
                className="text-xs text-gray-500 hover:text-gray-700 hover:underline"
              >
                {S.cancel}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setEditingLabels(true)}
                aria-label={S.renameLabels}
                title={S.renameLabels}
                className="p-1 rounded-md text-gray-400 hover:text-blue-600 hover:bg-gray-100 transition-colors"
              >
                <Pencil size={13} />
              </button>
            )}
          </div>

          {editingLabels ? (
            // Edit mode — vertical list, one row per color with input + reset.
            <div className="flex flex-col gap-2 pb-1">
              {HIGHLIGHT_COLORS.map((color) => (
                <div key={color} className="flex items-center gap-2.5">
                  <span
                    className={`w-6 h-6 rounded-full ring-1 ring-gray-200/60 flex-shrink-0 ${SWATCH_BG[color]}`}
                    aria-hidden="true"
                  />
                  <input
                    type="text"
                    value={labelDraft[color]}
                    onChange={(e) =>
                      setLabelDraft({ ...labelDraft, [color]: e.target.value })
                    }
                    maxLength={24}
                    placeholder={labels[color]}
                    aria-label={S.labelFor(color)}
                    className="flex-1 px-2.5 py-1.5 text-sm text-gray-900 border border-gray-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15"
                  />
                  <button
                    type="button"
                    onClick={() => setLabelDraft({ ...labelDraft, [color]: '' })}
                    disabled={labelDraft[color] === ''}
                    aria-label={S.resetToDefault}
                    title={S.resetToDefault}
                    className="p-1 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <RotateCcw size={12} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            // Picker mode — horizontal row of 5 swatches with labels under each.
            <div className="flex justify-between items-start gap-1 pb-1">
              {HIGHLIGHT_COLORS.map((color) => {
                const isActive = color === activeColor;
                return (
                  <button
                    key={color}
                    type="button"
                    onClick={() => onPickColor?.(color)}
                    className="flex flex-col items-center gap-1 px-1 py-1 rounded-md hover:bg-gray-50 transition-colors flex-1 min-w-0"
                    aria-label={S.highlightAs(labels[color])}
                    title={labels[color]}
                  >
                    <span
                      className={`w-6 h-6 rounded-full flex items-center justify-center transition-transform ${SWATCH_BG[color]} ${
                        isActive ? 'ring-2 ring-gray-900' : 'ring-1 ring-gray-200/60'
                      }`}
                    >
                      {isActive && <Check size={11} className="text-gray-900" strokeWidth={3.5} />}
                    </span>
                    <span
                      className={`text-[10px] leading-tight text-center truncate w-full ${
                        isActive ? 'font-semibold text-gray-900' : 'font-medium text-gray-500'
                      }`}
                    >
                      {labels[color]}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Footer. Edit mode: single Save button. Otherwise: with a selection
          behind the popup, "Ask in chat" is primary and "Open as new chat"
          drops to secondary (mockup-chat-highlights-ask-in-chat.html); with
          no selection the single blue "Open as new chat" stays. */}
      <div className="shrink-0 px-3 py-3 border-t border-gray-100 bg-gray-50 flex flex-col gap-1.5">
        {editingLabels ? (
          <button
            onClick={() => void handleSaveLabels()}
            className="flex items-center justify-center gap-2 w-full px-3 py-2 rounded-lg text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 transition-colors"
          >
            <Check size={14} />
            {S.saveLabels}
          </button>
        ) : (
          <>
            {onAskInChat && (
              <button
                onClick={() => onAskInChat(popup.word, popup.context)}
                className="flex items-center justify-center gap-2 w-full px-3 py-2 rounded-lg text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 transition-colors"
                data-testid="popup-ask-in-chat"
              >
                <MessageSquare size={14} />
                {S.askInChat}
              </button>
            )}
            <button
              onClick={() => onOpenChildChat(popup.word, popup.context)}
              // Bewusst identisch zum "Ask in chat"-Button (Nutzer-Entscheidung
              // 2026-07-20): gleiche Fläche, gleiche Farbe, gleiche Theme-Outline —
              // die Reihenfolge allein kommuniziert die Priorität.
              className="flex items-center justify-center gap-2 w-full px-3 py-2 rounded-lg text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 transition-colors"
            >
              <GitBranch size={14} />
              {S.openAsNewChat}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
