/**
 * hooks/useChatHighlights.ts
 *
 * Chat-scoped persistent text highlights on messages, the chat twin of
 * useHighlights (paper-scoped). Loaded once per chat, mutated with
 * optimistic updates so the tinted spans never lag behind the click.
 *
 * Anchor model: message_id + character offsets into the message's rendered
 * plain text (the bubble's textContent) — see MessageBubble for the
 * capture/re-anchor logic. UI intent:
 * design/mockup-chat-highlights-ask-in-chat.html.
 */

import { useEffect, useState, useCallback } from 'react';
import { api } from '../api';
import { invalidateTreeHighlights } from './useTreeHighlights';
import type { CreateMessageHighlightPayload, HighlightColor, MessageHighlight } from '../types';

interface State {
  highlights: MessageHighlight[];
  loading: boolean;
  error: string | null;
}

export function useChatHighlights(chatId: string | null) {
  const [state, setState] = useState<State>({
    highlights: [],
    loading: true,
    error: null,
  });

  useEffect(() => {
    if (!chatId) {
      setState({ highlights: [], loading: false, error: null });
      return;
    }
    let active = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    api
      .listMessageHighlights(chatId)
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
  }, [chatId]);

  const create = useCallback(
    async (payload: CreateMessageHighlightPayload): Promise<MessageHighlight | null> => {
      if (!chatId) return null;
      const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const optimistic: MessageHighlight = {
        id: tempId,
        messageId: payload.messageId,
        chatId,
        childChatId: payload.childChatId ?? null,
        startOffset: payload.startOffset,
        endOffset: payload.endOffset,
        text: payload.text,
        color: payload.color,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setState((s) => ({ ...s, highlights: [...s.highlights, optimistic] }));
      try {
        const created = await api.createMessageHighlight(chatId, payload);
        setState((s) => ({
          ...s,
          highlights: s.highlights.map((h) => (h.id === tempId ? created : h)),
        }));
        // Baum-weite Drawer-Liste synchron halten (siehe useTreeHighlights).
        invalidateTreeHighlights();
        return created;
      } catch (err) {
        setState((s) => ({
          ...s,
          highlights: s.highlights.filter((h) => h.id !== tempId),
          error: err instanceof Error ? err.message : 'Failed to create',
        }));
        console.warn('useChatHighlights: create failed', err);
        return null;
      }
    },
    [chatId],
  );

  const recolor = useCallback(async (mhid: string, color: HighlightColor) => {
    let previous: MessageHighlight | undefined;
    setState((s) => {
      previous = s.highlights.find((h) => h.id === mhid);
      return {
        ...s,
        highlights: s.highlights.map((h) => (h.id === mhid ? { ...h, color } : h)),
      };
    });
    try {
      const updated = await api.updateMessageHighlight(mhid, { color });
      setState((s) => ({
        ...s,
        highlights: s.highlights.map((h) => (h.id === mhid ? updated : h)),
      }));
      invalidateTreeHighlights();
      return updated;
    } catch (err) {
      if (previous) {
        const rollback = previous;
        setState((s) => ({
          ...s,
          highlights: s.highlights.map((h) => (h.id === mhid ? rollback : h)),
        }));
      }
      console.warn('useChatHighlights: recolor failed', err);
      return null;
    }
  }, []);

  // Link (or unlink) the chat branched from this highlight — the chat twin
  // of useHighlights' PDF-side `update({ chatId })`.
  const linkChat = useCallback(async (mhid: string, childChatId: string | null) => {
    let previous: MessageHighlight | undefined;
    setState((s) => {
      previous = s.highlights.find((h) => h.id === mhid);
      return {
        ...s,
        highlights: s.highlights.map((h) => (h.id === mhid ? { ...h, childChatId } : h)),
      };
    });
    try {
      const updated = await api.updateMessageHighlight(mhid, { childChatId });
      setState((s) => ({
        ...s,
        highlights: s.highlights.map((h) => (h.id === mhid ? updated : h)),
      }));
      invalidateTreeHighlights();
      return updated;
    } catch (err) {
      if (previous) {
        const rollback = previous;
        setState((s) => ({
          ...s,
          highlights: s.highlights.map((h) => (h.id === mhid ? rollback : h)),
        }));
      }
      console.warn('useChatHighlights: linkChat failed', err);
      return null;
    }
  }, []);

  const remove = useCallback(async (mhid: string) => {
    let previous: MessageHighlight | undefined;
    setState((s) => {
      previous = s.highlights.find((h) => h.id === mhid);
      return { ...s, highlights: s.highlights.filter((h) => h.id !== mhid) };
    });
    try {
      await api.deleteMessageHighlight(mhid);
      invalidateTreeHighlights();
      return true;
    } catch (err) {
      if (previous) {
        const rollback = previous;
        setState((s) => ({ ...s, highlights: [...s.highlights, rollback] }));
      }
      console.warn('useChatHighlights: delete failed', err);
      return false;
    }
  }, []);

  return {
    highlights: state.highlights,
    loading: state.loading,
    error: state.error,
    create,
    recolor,
    linkChat,
    remove,
  };
}
