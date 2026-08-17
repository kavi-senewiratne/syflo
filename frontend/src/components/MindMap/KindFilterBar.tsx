/**
 * components/MindMap/KindFilterBar.tsx
 *
 * Filter chips above the mind map — design/mockup-mindmap-lens-final.html §01
 * is the source of truth. Decisions 2026-08-02:
 *   - No "Colour by" switch: highlight kind is the ONLY lens (user decision).
 *   - "All" plus one chip per kind, multi-select ("Question + Disagree" =
 *     everything still to be settled).
 *   - Kinds without a single branch are hidden — you cannot filter for what
 *     is not there, and the bar is tight enough as it is.
 *   - While "All" is active NOTHING is faded: a bar full of greyed-out chips
 *     reads as "everything is off".
 *   - Active chip = accent border + bold, not a filled surface: the fill
 *     collided with the highlight colour of the dot.
 */

import { HIGHLIGHT_COLORS } from '../../types';
import type { HighlightColor, HighlightLabels } from '../../types';
import { useStrings } from '../../strings';

// Deep tones of the five highlight colours, as square dots matching the
// node's colour bar. Literal hex for the same reason as KIND_BAR: a
// highlight's identity colour is a product constant, the themes must not
// remap it.
const DOT: Record<HighlightColor, string> = {
  yellow: '#CA8A04',
  green: '#16A34A',
  blue: '#2563EB',
  pink: '#DB2777',
  orange: '#EA580C',
};

interface Props {
  labels: HighlightLabels;
  counts: Record<HighlightColor, number> & { total: number };
  selected: Set<HighlightColor>;
  onToggle: (color: HighlightColor) => void;
  onClear: () => void;
  shown: number;
}

export function KindFilterBar({ labels, counts, selected, onToggle, onClear, shown }: Props) {
  const S = useStrings().mindMap;
  const filtering = selected.size > 0;
  const kinds = HIGHLIGHT_COLORS.filter((color) => counts[color] > 0);

  // Nothing to filter: no bar at all rather than an empty one.
  if (kinds.length === 0) return null;

  const chip = (active: boolean, faded: boolean) =>
    `flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-[3px] text-[11px] transition-all ${
      active
        ? 'border-blue-600 text-blue-700 font-bold'
        : 'border-gray-200 text-gray-700 font-medium hover:bg-gray-50'
    }${faded ? ' opacity-40' : ''}`;

  return (
    <div
      data-testid="mindmap-kind-filter"
      className="flex flex-wrap items-center gap-1.5 border-b border-gray-200 bg-white px-3 py-2"
    >
      <button
        type="button"
        // The chip row is the map's top row: ↑ from the root node reaches it
        // (user report 2026-08-11).
        data-focus-item="kind-filter-all"
        aria-pressed={!filtering}
        onClick={onClear}
        className={chip(!filtering, false)}
      >
        {S.filterAll} <span className={filtering ? 'text-gray-400' : 'text-blue-400'}>{counts.total}</span>
      </button>
      {kinds.map((color) => {
        const active = selected.has(color);
        return (
          <button
            key={color}
            type="button"
            data-focus-item={`kind-filter-${color}`}
            aria-pressed={active}
            onClick={() => onToggle(color)}
            className={chip(active, filtering && !active)}
          >
            <span className="h-2 w-2 shrink-0 rounded-[3px]" style={{ background: DOT[color] }} />
            {labels[color]}{' '}
            <span className={active ? 'text-blue-400' : 'text-gray-400'}>{counts[color]}</span>
          </button>
        );
      })}
      {filtering && (
        <span className="ml-auto whitespace-nowrap text-[10.5px] text-gray-500">
          {S.filterHidden(shown, counts.total)}
        </span>
      )}
    </div>
  );
}
