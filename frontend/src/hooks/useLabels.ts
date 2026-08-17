/**
 * hooks/useLabels.ts
 *
 * Global per-color labels for the highlight feature. Loaded once from the
 * backend on first mount, then shared across every consumer via a tiny
 * module-level cache + subscribe-pattern. When the user renames a label in
 * the FloatingPopup, every other open popup and the sidebar receive the new
 * name in the same render cycle.
 *
 * Two sources, merged here (user request 2026-08-06):
 *   - the DEFAULT name of each color is UI copy and lives in strings.ts, so
 *     it follows the App language and switches with it instantly;
 *   - an OVERRIDE the user typed in the popup's edit mode lives in the
 *     database and wins over the language, in every language.
 * The backend therefore stores only overrides; every color it knows nothing
 * about comes back as null.
 *
 * Mirrors the cache shape in useReferences.ts so the two hooks read the same
 * way and can be maintained together. Differences:
 *   - The data is a single object (not per-paper), so the cache is one slot.
 *   - We expose a setter (renameLabel) since labels are user-editable —
 *     useReferences is read-only.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useStrings } from '../strings';
import { HIGHLIGHT_COLORS } from '../types';
import type { HighlightColor, HighlightLabelOverrides, HighlightLabels } from '../types';

interface State {
  labels: HighlightLabels;
  loading: boolean;
  error: string | null;
}

const NO_OVERRIDES: HighlightLabelOverrides = {
  yellow: null,
  green: null,
  blue: null,
  pink: null,
  orange: null,
};

// Module-level state. We deliberately don't put this in React context so the
// hook can be used from anywhere without wrapping providers (this is internal
// to the app, not a published library).
let cached: HighlightLabelOverrides | null = null;
let inFlight: Promise<HighlightLabelOverrides> | null = null;
const subscribers = new Set<(overrides: HighlightLabelOverrides) => void>();

// Imperative reset for tests so each test starts from a clean cache. Not
// exported from the public hook API.
export function _resetLabelsCacheForTests() {
  cached = null;
  inFlight = null;
  subscribers.clear();
}

/**
 * Language default + user override → the name a color actually shows.
 * Exported for tests; components read it through the hook.
 */
export function resolveLabels(
  defaults: HighlightLabels,
  overrides: HighlightLabelOverrides | null,
): HighlightLabels {
  const out = { ...defaults };
  for (const color of HIGHLIGHT_COLORS) {
    const own = overrides?.[color];
    if (typeof own === 'string' && own.trim()) out[color] = own;
  }
  return out;
}

// A GET may be missing keys (older backend, partial migration) — normalize to
// all five colors so `resolveLabels` never reads undefined.
function normalize(raw: Partial<HighlightLabelOverrides>): HighlightLabelOverrides {
  const out = { ...NO_OVERRIDES };
  for (const color of HIGHLIGHT_COLORS) {
    const value = raw[color];
    out[color] = typeof value === 'string' && value.trim() ? value : null;
  }
  return out;
}

function broadcast(next: HighlightLabelOverrides) {
  cached = next;
  for (const fn of subscribers) fn(next);
}

async function fetchOverrides(): Promise<HighlightLabelOverrides> {
  if (cached) return cached;
  if (inFlight) return inFlight;
  inFlight = api
    .getHighlightLabels()
    .then((overrides) => {
      cached = normalize(overrides ?? {});
      inFlight = null;
      broadcast(cached);
      return cached;
    })
    .catch((err) => {
      inFlight = null;
      // Fall back to the language defaults if the backend is unreachable —
      // the popup must still render. The error is logged but not surfaced to
      // the user; a failed label fetch is a degraded experience, not a broken
      // one.
      console.warn('useLabels: falling back to defaults', err);
      cached = { ...NO_OVERRIDES };
      broadcast(cached);
      return cached;
    });
  return inFlight;
}

/**
 * Subscribe to the global labels. Returns the current names plus a renamer.
 *
 * The renamer fires the PUT *and* updates the cache optimistically so all
 * subscribers re-render before the server round-trip completes. If the server
 * rejects the change, we roll back to the previous value.
 */
export function useLabels(): State & {
  renameLabel: (color: HighlightColor, label: string) => Promise<void>;
} {
  // Defaults in the App language — this also re-renders every consumer when
  // the language changes, which is exactly when the names have to flip.
  const defaults = useStrings().highlightLabels;
  const [overrides, setOverrides] = useState<HighlightLabelOverrides>(
    cached ?? NO_OVERRIDES,
  );
  const [loading, setLoading] = useState<boolean>(cached === null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (cached === null) {
      fetchOverrides().then(() => {
        if (active) setLoading(false);
      });
    } else {
      setLoading(false);
    }
    const update = (next: HighlightLabelOverrides) => {
      if (active) setOverrides(next);
    };
    subscribers.add(update);
    return () => {
      active = false;
      subscribers.delete(update);
    };
  }, []);

  const labels = useMemo(() => resolveLabels(defaults, overrides), [defaults, overrides]);

  const renameLabel = async (color: HighlightColor, label: string) => {
    const previous = cached ?? { ...NO_OVERRIDES };
    // Optimistic: broadcast the new value immediately so the inline input
    // commits without a flash of stale text. An empty name is not a name —
    // it drops the override and the language default takes over again.
    broadcast({ ...previous, [color]: label.trim() || null });
    try {
      const result = await api.setHighlightLabel(color, label);
      // Server may have truncated / dropped the override — broadcast the
      // canonical value so all subscribers agree with what's actually stored.
      broadcast({ ...(cached ?? previous), [color]: result.label ?? null });
      setError(null);
    } catch (err) {
      // Roll back. Tell the user nothing — a transient network failure
      // shouldn't pop a toast when the worst that happens is the rename
      // didn't stick.
      broadcast(previous);
      const message = err instanceof Error ? err.message : 'Failed to rename';
      setError(message);
      console.warn('useLabels: rename failed, rolled back', err);
    }
  };

  return { labels, loading, error, renameLabel };
}
