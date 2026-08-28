/**
 * hooks/usePaneResize.ts
 *
 * One draggable pane divider: a clamped, localStorage-backed size plus the
 * four pointer handlers the divider needs.
 *
 * App.tsx carried this algorithm twice — once for the chat column's width in
 * the three-column PDF layout, once for the mind-map pane's height above the
 * chat. Both did the same four things: read a stored value and clamp it on
 * first render, remember the drag origin in a ref so pointermove never fights
 * React state, clamp every move into [min, max], and write the last value back
 * to localStorage on pointerup. Only the geometry differed — px along X versus
 * a percentage of the parent's height along Y — so that part stays with the
 * caller as `startDrag` / `nextValue`.
 *
 * The value is deliberately NOT persisted on every move: a drag fires dozens
 * of pointermove events, and only where the user let go is worth storing.
 */

import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

export interface PaneResizeHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
}

interface Options<S> {
  /** localStorage key holding the last size the user dragged to. */
  storageKey: string;
  /** Size used when nothing is stored, or the stored value is out of bounds. */
  fallback: number;
  min: number;
  max: number;
  /**
   * Snapshot of everything the move handler needs about where the drag began
   * — pointer origin, the size at that moment, and any measurement (like the
   * container height) that must be taken before the pointer moves.
   */
  startDrag: (e: ReactPointerEvent<HTMLDivElement>, current: number) => S;
  /** Unclamped size for the current pointer position. */
  nextValue: (e: ReactPointerEvent<HTMLDivElement>, start: S) => number;
}

export function usePaneResize<S>({
  storageKey,
  fallback,
  min,
  max,
  startDrag,
  nextValue,
}: Options<S>): [number, PaneResizeHandlers] {
  const [size, setSize] = useState<number>(() => {
    const stored = Number(localStorage.getItem(storageKey));
    return Number.isFinite(stored) && stored >= min && stored <= max ? stored : fallback;
  });

  // `last` rides along in the ref so pointerup can persist the final size
  // without waiting for a re-render to observe it.
  const drag = useRef<{ start: S; last: number } | null>(null);

  const handlers: PaneResizeHandlers = {
    onPointerDown: (e) => {
      e.preventDefault();
      drag.current = { start: startDrag(e, size), last: size };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    onPointerMove: (e) => {
      const active = drag.current;
      if (!active) return;
      const next = Math.min(max, Math.max(min, nextValue(e, active.start)));
      active.last = next;
      setSize(next);
    },
    onPointerUp: () => {
      const active = drag.current;
      if (!active) return;
      drag.current = null;
      localStorage.setItem(storageKey, String(active.last));
    },
    onPointerCancel: () => handlers.onPointerUp(),
  };

  return [size, handlers];
}
