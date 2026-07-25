/**
 * components/HighlightsDrawer/index.tsx
 *
 * Baum-weite Highlight-Übersicht als Drawer über der Chat-Spalte —
 * design/mockup-highlights-overview.html (Variante A, final) ist die Quelle
 * der Wahrheit. Grill-Entscheidungen 2026-07-21:
 *   - Gruppen nach Color label in fester Farbreihenfolge, leere ausgeblendet
 *   - Chips mit Mehrfachauswahl; "All" (einziger Ort der Gesamtzahl) setzt
 *     zurück; Filterauswahl lebt nur im Komponenten-State (pro Sitzung)
 *   - Karten: Zitat (2 Zeilen), Quelle (PDF · p. N / Chat · Branch-Name),
 *     Erstellungsdatum klein rechts
 *   - Klick springt zum Highlight (Callback), Rechtsklick öffnet das
 *     bestehende HighlightActionsMenu (Callback — der Owner rendert es)
 *   - Esc schließt
 *
 * Daten kommen aus useTreeHighlights (immer aktuell durch Invalidierung aus
 * den CRUD-Hooks); Labels global aus useLabels — eine Umbenennung irgendwo
 * erscheint hier sofort.
 */

import { useEffect, useMemo, useState } from 'react';
import { FileText, Highlighter, MessageSquare, X } from 'lucide-react';
import { useTreeHighlights } from '../../hooks/useTreeHighlights';
import { useLabels } from '../../hooks/useLabels';
import { useStrings } from '../../strings';
import { HIGHLIGHT_COLORS } from '../../types';
import type { HighlightColor, TreeHighlight } from '../../types';

// Satte Punkt-Farben für Chips und Gruppenköpfe (Mockup: --hl-*-deep).
const DOT_BG: Record<HighlightColor, string> = {
  yellow: 'bg-yellow-600',
  green: 'bg-green-600',
  blue: 'bg-blue-600',
  pink: 'bg-pink-600',
  orange: 'bg-orange-600',
};

// Farbbalken links auf jeder Karte. Eigene Map mit wörtlichen Klassen —
// Tailwind erkennt nur vollständige Klassennamen im Quelltext, kein
// `before:${…}`-Kompositum.
const BAR_BG: Record<HighlightColor, string> = {
  yellow: 'before:bg-yellow-600',
  green: 'before:bg-green-600',
  blue: 'before:bg-blue-600',
  pink: 'before:bg-pink-600',
  orange: 'before:bg-orange-600',
};

interface Props {
  chatId: string;
  onClose: () => void;
  onJump: (item: TreeHighlight) => void;
  onItemContextMenu: (item: TreeHighlight, x: number, y: number) => void;
  // 'overlay' (Default): Drawer ÜBER der Chat-Spalte (3-Spalten-Layout mit
  // PDF/Parent-Kontext). 'panel': eigene rechte Seitenspalte NEBEN dem Chat,
  // wenn der Chat allein die volle Breite hat (Nutzerentscheidung
  // 2026-07-22) — Highlights und Chat bleiben gleichzeitig sichtbar.
  variant?: 'overlay' | 'panel';
}

// Locale folgt der App language ('de-DE' bei Deutsch, sonst 'en-US').
function formatDay(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

export function HighlightsDrawer({ chatId, onClose, onJump, onItemContextMenu, variant = 'overlay' }: Props) {
  // UI-Texte in der App language — re-rendert beim Sprachwechsel mit.
  const S = useStrings().highlightsDrawer;
  const { items, loading } = useTreeHighlights(chatId);
  const { labels } = useLabels();
  // Leere Auswahl = "All". Ein Set statt Einzelwert wegen Mehrfachauswahl
  // (z. B. Question + Disagree = "alles, was ich noch klären muss").
  const [selected, setSelected] = useState<Set<HighlightColor>>(new Set());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const counts = useMemo(() => {
    const c = { yellow: 0, green: 0, blue: 0, pink: 0, orange: 0 } as Record<HighlightColor, number>;
    for (const item of items) c[item.color] += 1;
    return c;
  }, [items]);

  const visible = selected.size === 0 ? items : items.filter((i) => selected.has(i.color));
  const groups = HIGHLIGHT_COLORS
    .map((color) => ({ color, groupItems: visible.filter((i) => i.color === color) }))
    .filter((g) => g.groupItems.length > 0);

  const toggleColor = (color: HighlightColor) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(color)) next.delete(color);
      else next.add(color);
      return next;
    });
  };

  return (
    <div
      data-testid="highlights-drawer"
      className={
        variant === 'panel'
          ? 'flex h-full w-full flex-col bg-white border-l border-gray-200'
          : 'absolute inset-0 z-20 flex flex-col bg-white shadow-[-10px_0_28px_rgba(15,23,42,0.10)]'
      }
    >
      <div className="border-b border-gray-100 px-4 pt-4 pb-3">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold text-gray-900">
            <Highlighter size={15} className="text-gray-400" />
            {S.title}
          </h2>
          <button
            type="button"
            aria-label={S.close}
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
          >
            <X size={15} />
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            aria-pressed={selected.size === 0}
            onClick={() => setSelected(new Set())}
            className={`rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium transition-colors ${
              selected.size === 0
                ? 'border-gray-900 bg-gray-900 text-white'
                : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            {S.all} <span className={selected.size === 0 ? 'text-white/70' : 'text-gray-400'}>{items.length}</span>
          </button>
          {HIGHLIGHT_COLORS.map((color) => {
            const active = selected.has(color);
            return (
              <button
                key={color}
                type="button"
                aria-pressed={active}
                onClick={() => toggleColor(color)}
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium transition-colors ${
                  active
                    ? 'border-gray-900 bg-gray-900 text-white'
                    : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${DOT_BG[color]}`} />
                {labels[color]} <span className={active ? 'text-white/70' : 'text-gray-400'}>{counts[color]}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {!loading && items.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <Highlighter size={22} className="text-gray-300" />
            <p className="text-[13px] leading-relaxed text-gray-400">
              {S.empty}
            </p>
          </div>
        )}
        {groups.map(({ color, groupItems }) => (
          <div key={color} className="mb-4">
            <h3 className="mb-2 flex items-center gap-1.5 px-1 text-[10.5px] font-semibold uppercase tracking-wider text-gray-500">
              <span className={`h-[7px] w-[7px] rounded-full ${DOT_BG[color]}`} />
              {labels[color]}
              <span className="font-medium normal-case tracking-normal text-gray-400">· {groupItems.length}</span>
            </h3>
            {groupItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onJump(item)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onItemContextMenu(item, e.clientX, e.clientY);
                }}
                className={`relative mb-2 w-full rounded-lg border border-gray-100 bg-white py-2.5 pl-4 pr-3 text-left transition-all hover:-translate-y-px hover:border-gray-200 hover:shadow-sm before:absolute before:bottom-2.5 before:left-1.5 before:top-2.5 before:w-[3px] before:rounded-sm before:opacity-55 before:content-[''] ${BAR_BG[item.color]}`}
              >
                <span className="line-clamp-2 block text-xs leading-normal text-gray-700">{item.text}</span>
                <span className="mt-1.5 flex items-center gap-1.5 text-[10.5px] font-medium text-gray-400">
                  {item.kind === 'pdf' ? <FileText size={10} /> : <MessageSquare size={10} />}
                  {item.kind === 'pdf' ? S.pdfSource(item.pageNumber) : S.chatSource(item.chatTitle)}
                  <span className="ml-auto font-normal">{formatDay(item.createdAt, S.dateLocale)}</span>
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
