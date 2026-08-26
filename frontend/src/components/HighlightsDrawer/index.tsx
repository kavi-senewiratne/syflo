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
 * Correction (2026-07-31): aktiver Chip weicht vom Mockup ab — statt
 * hartem bg-gray-900/text-white (in Matrix invertiert die Gray-Rampe,
 * dadurch schlechter Kontrast) jetzt bg-blue-50/text-blue-700 wie
 * ChatArea's Highlights-Toggle; adaptiert so in allen 5 Themes.
 *
 * Daten kommen aus useTreeHighlights (immer aktuell durch Invalidierung aus
 * den CRUD-Hooks); Labels global aus useLabels — eine Umbenennung irgendwo
 * erscheint hier sofort.
 */

import { useEffect, useMemo, useState } from 'react';
import { FileText, Highlighter, MessageSquare, TvMinimalPlay, X } from 'lucide-react';
import { useTreeHighlights } from '../../hooks/useTreeHighlights';
import { useLabels } from '../../hooks/useLabels';
import { useStrings } from '../../strings';
import { MathText, hasMath } from '../MathText';
import { formatDuration } from '../VideoBanner';
import { HIGHLIGHT_COLORS } from '../../types';
import type { HighlightColor, TreeHighlight } from '../../types';

// Deep dot colors for chips and group headers (mockup: --hl-*-deep). Literal
// hex values, NOT token classes: the themes remap blue-*/green-* etc. (Matrix
// turns blue-600 phosphor green, Mushroom turns it red), but a highlight's
// identity color is a fixed product constant. Same deep tones as
// HIGHLIGHT_GLOW_HEX in PdfView.
const DOT_BG: Record<HighlightColor, string> = {
  yellow: 'bg-[#CA8A04]',
  green: 'bg-[#16A34A]',
  blue: 'bg-[#2563EB]',
  pink: 'bg-[#DB2777]',
  orange: 'bg-[#EA580C]',
};

// Color bar on the left edge of each card. Its own map with literal class
// names — Tailwind only picks up complete class names in the source, no
// `before:${…}` composition.
const BAR_BG: Record<HighlightColor, string> = {
  yellow: 'before:bg-[#CA8A04]',
  green: 'before:bg-[#16A34A]',
  blue: 'before:bg-[#2563EB]',
  pink: 'before:bg-[#DB2777]',
  orange: 'before:bg-[#EA580C]',
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
  // Highlight to lift into view — set when a mind-map node click jumped to
  // its source (2026-08-02). The matching card gets the accent border and
  // scrolls itself into the list.
  focusHighlightId?: string | null;
}

// Locale folgt der App language ('de-DE' bei Deutsch, sonst 'en-US').
function formatDay(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

export function HighlightsDrawer({
  chatId, onClose, onJump, onItemContextMenu, variant = 'overlay', focusHighlightId = null,
}: Props) {
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
      data-focus-region="highlights"
      className={
        variant === 'panel'
          ? 'flex h-full w-full flex-col overflow-hidden bg-white border-l border-gray-200'
          : 'absolute inset-0 z-20 flex flex-col overflow-hidden bg-white shadow-[-10px_0_28px_rgba(15,23,42,0.10)]'
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
            data-focus-item="drawer-close"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
          >
            <X size={15} />
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            // The filter chips are a row of controls like any other
            // (user request 2026-08-12).
            data-focus-item="drawer-filter-all"
            aria-pressed={selected.size === 0}
            onClick={() => setSelected(new Set())}
            className={`rounded-full border px-2.5 py-0.5 text-[11.5px] transition-all ${
              selected.size === 0
                ? 'border-blue-600 font-bold text-blue-700'
                : 'border-gray-200 bg-white font-medium text-gray-700 hover:bg-gray-50'
            }`}
          >
            {S.all} <span className={selected.size === 0 ? 'text-blue-400' : 'text-gray-400'}>{items.length}</span>
          </button>
          {HIGHLIGHT_COLORS.map((color) => {
            const active = selected.has(color);
            return (
              <button
                key={color}
                type="button"
                data-focus-item={`drawer-filter-${color}`}
                aria-pressed={active}
                onClick={() => toggleColor(color)}
                // Same chip style as the bar above the mind map
                // (design/mockup-mindmap-lens-final.html §04): the active one
                // wears the accent border, the others fade — but only while a
                // filter is on, otherwise a full bar of greyed-out chips reads
                // as "everything is off".
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11.5px] transition-all ${
                  active
                    ? 'border-blue-600 font-bold text-blue-700'
                    : 'border-gray-200 bg-white font-medium text-gray-700 hover:bg-gray-50'
                }${selected.size > 0 && !active ? ' opacity-40' : ''}`}
              >
                {/* Square dot, matching the node's colour bar (2026-08-02). */}
                <span className={`h-2 w-2 rounded-[3px] ${DOT_BG[color]}`} />
                {labels[color]} <span className={active ? 'text-blue-400' : 'text-gray-400'}>{counts[color]}</span>
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
                data-focus-item={item.id}
                ref={(el) => {
                  // Jumped-to card: pull it into view once it is mounted.
                  if (el && item.id === focusHighlightId) {
                    el.scrollIntoView({ block: 'nearest' });
                  }
                }}
                onClick={() => onJump(item)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onItemContextMenu(item, e.clientX, e.clientY);
                }}
                className={`relative mb-2 w-full rounded-lg border bg-white py-2.5 pl-4 pr-3 text-left transition-all hover:-translate-y-px hover:shadow-sm before:absolute before:bottom-2.5 before:left-1.5 before:top-2.5 before:w-[3px] before:rounded-sm before:opacity-55 before:content-[''] ${
                  item.id === focusHighlightId
                    ? 'border-blue-600 shadow-sm'
                    : 'border-gray-100 hover:border-gray-200'
                } ${BAR_BG[item.color]}`}
              >
                <span className="line-clamp-2 block text-xs leading-normal text-gray-700"><MathText text={item.text} /></span>
                <span className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[10.5px] font-medium text-gray-400">
                  {/* One icon per source: page, video, chat. The video marks
                      joined the drawer on 2026-08-16 and name their MOMENT —
                      that is what identifies a spot in a transcript, the way
                      a page number identifies one in a PDF. */}
                  {item.kind === 'pdf' ? (
                    <FileText size={10} className="shrink-0" />
                  ) : item.kind === 'transcript' || item.kind === 'chapter' ? (
                    <TvMinimalPlay size={10} className="shrink-0" />
                  ) : (
                    <MessageSquare size={10} className="shrink-0" />
                  )}
                  {item.kind === 'pdf' ? (
                    <span className="truncate">{S.pdfSource(item.pageNumber)}</span>
                  ) : item.kind !== 'chat' ? (
                    // Asked as "not a chat mark": a two-value discriminant
                    // ('transcript' | 'chapter') leaves the video form in the
                    // union, so the chat branch below would not narrow.
                    <span className="truncate">
                      {item.kind === 'chapter'
                        ? S.chapterSource(formatDuration(item.startSeconds) ?? '')
                        : S.transcriptSource(formatDuration(item.startSeconds) ?? '')}
                    </span>
                  ) : (
                    <span className={`min-w-0 ${hasMath(item.chatTitle) ? 'syflo-math-fade' : 'truncate'}`}>
                      <MathText text={S.chatSource(item.chatTitle)} />
                    </span>
                  )}
                  <span className="ml-auto shrink-0 font-normal">{formatDay(item.createdAt, S.dateLocale)}</span>
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
