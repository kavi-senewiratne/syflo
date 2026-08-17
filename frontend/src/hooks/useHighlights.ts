/**
 * hooks/useHighlights.ts
 *
 * Per-paper persistent colored highlights. Loaded once on mount, then
 * mutated in-place via create/update/delete with optimistic updates so the
 * overlay never lags behind the user's click.
 *
 * Unlike useLabels (which has a global subscribe-pattern because labels are
 * cross-paper), this hook is paper-scoped — each chat tree's PDF has its own
 * highlight list, so the state lives in the hook's caller rather than a
 * module-level cache. 1:1 port of Syflo's useHighlights (Slice 04).
 */

import { useEffect, useState, useCallback } from 'react';
import { api } from '../api';
import { invalidateTreeHighlights } from './useTreeHighlights';
import type { CreateHighlightPayload, Highlight, HighlightColor } from '../types';

interface State {
  highlights: Highlight[];
  loading: boolean;
  error: string | null;
}

export function useHighlights(paperId: string | null) {
  const [state, setState] = useState<State>({
    highlights: [],
    loading: true,
    error: null,
  });

  // Bumped by reload() below to re-run the effect without a paper change.
  const [reloadToken, setReloadToken] = useState(0);

  // (Re)load whenever the paper changes. Empty-string / null paperId skips
  // the fetch — used while no PDF is bound to the active chat tree.
  useEffect(() => {
    if (!paperId) {
      setState({ highlights: [], loading: false, error: null });
      return;
    }
    let active = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    api
      .listHighlights(paperId)
      .then((hs) => {
        if (active) setState({ highlights: hs, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const message = err instanceof Error ? err.message : 'Failed to load highlights';
        setState({ highlights: [], loading: false, error: message });
      });
    return () => {
      active = false;
    };
  }, [paperId, reloadToken]);

  // Re-fetch the list for the SAME paper. Needed whenever the server changes a
  // highlight behind this hook's back: deleting a chat clears chat_id on every
  // highlight that pointed at it (ON DELETE SET NULL), and without a reload the
  // menu kept offering "Open linked chat" for a chat that was gone
  // (user report 2026-08-10).
  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  // Create — optimistic insert with a temp ID. The temp row is replaced
  // when the server responds; on failure we remove it and surface the
  // error so the caller can decide whether to toast.
  const create = useCallback(
    async (payload: CreateHighlightPayload): Promise<Highlight | null> => {
      if (!paperId) return null;
      const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const optimistic: Highlight = {
        id: tempId,
        paperId,
        color: payload.color,
        text: payload.text,
        pageNumber: payload.pageNumber,
        rects: payload.rects,
        prefix: payload.prefix ?? null,
        suffix: payload.suffix ?? null,
        quoteHash: payload.quoteHash ?? null,
        chatId: payload.chatId ?? null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setState((s) => ({ ...s, highlights: [...s.highlights, optimistic] }));
      try {
        const created = await api.createHighlight(paperId, payload);
        setState((s) => ({
          ...s,
          highlights: s.highlights.map((h) => (h.id === tempId ? created : h)),
        }));
        // Der Highlights-Drawer liest die baum-weite Liste — nach jeder
        // erfolgreichen Mutation invalidieren, damit er synchron bleibt.
        invalidateTreeHighlights();
        return created;
      } catch (err) {
        setState((s) => ({
          ...s,
          highlights: s.highlights.filter((h) => h.id !== tempId),
          error: err instanceof Error ? err.message : 'Failed to create',
        }));
        console.warn('useHighlights: create failed', err);
        return null;
      }
    },
    [paperId],
  );

  const update = useCallback(
    async (hid: string, patch: { color?: HighlightColor; chatId?: string | null }) => {
      // Snapshot for rollback. Optimistic-update the row in place.
      let previous: Highlight | undefined;
      setState((s) => {
        previous = s.highlights.find((h) => h.id === hid);
        return {
          ...s,
          highlights: s.highlights.map((h) => (h.id === hid ? { ...h, ...patch } : h)),
        };
      });
      try {
        const updated = await api.updateHighlight(hid, patch);
        setState((s) => ({
          ...s,
          highlights: s.highlights.map((h) => (h.id === hid ? updated : h)),
        }));
        invalidateTreeHighlights();
        return updated;
      } catch (err) {
        if (previous) {
          const rollback = previous;
          setState((s) => ({
            ...s,
            highlights: s.highlights.map((h) => (h.id === hid ? rollback : h)),
          }));
        }
        console.warn('useHighlights: update failed', err);
        return null;
      }
    },
    [],
  );

  const remove = useCallback(async (hid: string) => {
    let previous: Highlight | undefined;
    setState((s) => {
      previous = s.highlights.find((h) => h.id === hid);
      return { ...s, highlights: s.highlights.filter((h) => h.id !== hid) };
    });
    try {
      await api.deleteHighlight(hid);
      invalidateTreeHighlights();
      return true;
    } catch (err) {
      if (previous) {
        const rollback = previous;
        setState((s) => ({ ...s, highlights: [...s.highlights, rollback] }));
      }
      console.warn('useHighlights: delete failed', err);
      return false;
    }
  }, []);

  return {
    highlights: state.highlights,
    loading: state.loading,
    error: state.error,
    create,
    update,
    remove,
    reload,
  };
}
