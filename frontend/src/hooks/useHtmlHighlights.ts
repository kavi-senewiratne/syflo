/**
 * hooks/useHtmlHighlights.ts
 *
 * The marks of the tree's HTML source (ADR-0013). They belong to the SOURCE,
 * so every branch of the tree shows the same ones — like PDF highlights. Each
 * mutation patches the local list and invalidates the tree-wide drawer cache,
 * the same freshness rule as the other highlight hooks.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { invalidateTreeHighlights } from './useTreeHighlights';
import type { HighlightColor, HtmlAnchor, HtmlHighlight } from '../types';

export interface HtmlHighlightApi {
  highlights: HtmlHighlight[];
  create: (p: { color: HighlightColor; anchor: HtmlAnchor; section?: string | null; chatId?: string | null }) => Promise<HtmlHighlight>;
  recolor: (id: string, color: HighlightColor) => Promise<void>;
  linkChat: (id: string, chatId: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  reload: () => void;
}

const EMPTY: HtmlHighlight[] = [];

export function useHtmlHighlights(sourceId: string | null): HtmlHighlightApi {
  // The list is stored WITH the source it belongs to: switching sources (or
  // closing one) shows an empty list at once instead of the old one until the
  // fetch lands, and no state has to be reset inside an effect.
  const [data, setData] = useState<{ sourceId: string | null; list: HtmlHighlight[] }>({ sourceId: null, list: [] });
  const highlights = data.sourceId === sourceId ? data.list : EMPTY;
  const setHighlights = useCallback(
    (update: (prev: HtmlHighlight[]) => HtmlHighlight[]) =>
      setData((d) => (d.sourceId === sourceId ? { sourceId, list: update(d.list) } : d)),
    [sourceId],
  );
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!sourceId) return;
    let cancelled = false;
    // Wrapped in Promise.resolve: a transport that throws synchronously must
    // not take the pane down — the marks are an enhancement, the page is not.
    void Promise.resolve()
      .then(() => api.listHtmlHighlights(sourceId))
      .then((list) => { if (!cancelled && Array.isArray(list)) setData({ sourceId, list }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [sourceId, nonce]);

  const create = useCallback<HtmlHighlightApi['create']>(async (p) => {
    if (!sourceId) throw new Error('No HTML source');
    const created = await api.createHtmlHighlight(sourceId, p);
    setHighlights((prev) => [...prev, created]);
    invalidateTreeHighlights();
    return created;
  }, [sourceId, setHighlights]);

  const patch = useCallback(async (id: string, change: { color?: HighlightColor; chatId?: string | null }) => {
    const updated = await api.updateHtmlHighlight(id, change);
    if (updated) setHighlights((prev) => prev.map((h) => (h.id === id ? updated : h)));
    invalidateTreeHighlights();
  }, [setHighlights]);

  const recolor = useCallback((id: string, color: HighlightColor) => patch(id, { color }), [patch]);
  const linkChat = useCallback((id: string, chatId: string) => patch(id, { chatId }), [patch]);

  const remove = useCallback(async (id: string) => {
    await api.deleteHtmlHighlight(id);
    setHighlights((prev) => prev.filter((h) => h.id !== id));
    invalidateTreeHighlights();
  }, [setHighlights]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { highlights, create, recolor, linkChat, remove, reload };
}
