/**
 * hooks/useStreamRegistry.ts
 *
 * The registry of running answer streams, and the four UI mirrors derived from
 * it. Pulled out of App.tsx, where the ref, the four `useState` sets and the
 * three helpers sat interleaved with unrelated state; here the invariant they
 * share is stated once, in one place.
 *
 * That invariant: `streams` is the truth, the four sets are DERIVED from it,
 * and `syncIndicators()` is the only thing that writes them. Call it after
 * every mutation of the registry — nothing watches the ref.
 *
 * The two `continuing*` sets are the exception and stay hand-written:
 * `syncIndicators` rebuilds the others from scratch on every call and would
 * drop a flag poked into them, but to a reader they mean the same thing, so the
 * UI merges them wherever it asks "is this still being written?" (user report
 * 2026-08-18: the bubble looked finished while rounds were still running).
 */

import { useRef, useState, useCallback } from 'react';
import type { SearchSource, FailoverInfo } from '../types';
import type { TextSmoother } from '../streaming/TextSmoother';

// One running answer stream. Answers keep running in the background when the
// user switches chat (user correction 2026-07-22) — the buffer holds what has
// streamed so far OUTSIDE React state, so deltas still arrive while another
// chat is on screen and the partial answer reappears the moment the user
// switches back. A chat can have SEVERAL streams (the backend answers them
// FIFO), which is why the registry is keyed by tempAssistantId and not by
// chat: with a chat key, a second send overwrote the first entry and the
// first one's `finally` deleted the second (bug 2026-07-24).
export interface ActiveStream {
  chatId: string;
  tempUserId: string;
  tempAssistantId: string;
  // Text of the optimistic user question — needed to restore it on a chat
  // switch while the job is still waiting: the question is persisted server
  // side only when the job starts, and is missing from the GET until then.
  userContent: string;
  content: string;
  reasoning: string;
  sources: SearchSource[];
  // W2 (§06): the model called web_search and nobody looked. Held on the
  // stream so it survives the re-renders between the tool event and the end of
  // the answer.
  searchWish?: { query: string; error: string };
  createdAt: string;
  // The backend's queue position: how many jobs are ahead, null = running
  // (or never queued). `started` flips with the started event.
  queuedAhead: number | null;
  // Queue transparency (mockup-model-flow §07): the local model that will
  // answer this waiting question (chip on the queued note) and the chat +
  // question the queue is answering RIGHT NOW (jump link when it is another
  // chat). Both live only while queuedAhead does.
  queuedModel: string | null;
  queuedCurrent: { chatId: string; question: string } | null;
  started: boolean;
  // Visible auto-retry after a cloud provider 429 (ADR-0008) — null as soon
  // as the next attempt delivers tokens.
  rateLimit: { retryInSeconds: number; attempt: number; scope?: 'requests' | 'tokens'; model?: string } | null;
  // The provider's servers are busy (503) and the backend retries the same
  // model — like rateLimit, gone as soon as tokens arrive.
  overloaded: { retryInSeconds: number; attempt: number; maxAttempts: number; provider?: string } | null;
  // Another provider stepped in for this answer (ADR-0008 failover). Unlike
  // rateLimit this STAYS for the whole answer — it explains who it is from.
  failover: FailoverInfo | null;
  // Smooth reveal of the streamed answer text (fast cloud models would make
  // paragraphs "pop"). Lives on the stream, not in a component, so a chat
  // switch mid-stream loses nothing; `content` above always holds the
  // REVEALED prefix — the persisted final text comes from the backend.
  smoother: TextSmoother | null;
  // Retry of a persisted '*Failed*' marker: there is no optimistic user
  // bubble, and aborting while queued restores the error line instead of
  // removing bubbles.
  isRegenerate: boolean;
  // Id of the *Failed* marker being replaced (anchored retry). The restore
  // paths put the marker back under THIS id — a temp id would send the next
  // retry with a messageId the backend has never seen.
  regenerateOfId: string | null;
  abort: AbortController;
}

export function useStreamRegistry() {
  // Running streams, keyed by tempAssistantId — several per chat are possible
  // (backend FIFO). The stop button aborts every stream of the chat currently
  // on screen.
  const streams = useRef<Map<string, ActiveStream>>(new Map());

  // Mirrors for the UI: dots in the sidebar for chats that are answering, a
  // clock for chats whose questions are only queued, and the ids of the
  // assistant placeholders — per message rather than "the last message",
  // because with several streams in one chat the placeholder is no longer
  // necessarily last.
  const [streamingChatIds, setStreamingChatIds] = useState<Set<string>>(new Set());
  const [queuedChatIds, setQueuedChatIds] = useState<Set<string>>(new Set());
  const [streamingMessageIds, setStreamingMessageIds] = useState<Set<string>>(new Set());
  const [continuingChatIds, setContinuingChatIds] = useState<Set<string>>(new Set());
  // …and the MESSAGE being grown by that round. The chat-level flag alone left
  // the bubble itself looking finished: MessageBubble reads only
  // `streamingMessageIds`, so a continuation showed neither cursor nor dots
  // while it wrote (user report 2026-08-29, an overview that took eight rounds
  // over 4:50 min and never once said it was working).
  const [continuingMessageIds, setContinuingMessageIds] = useState<Set<string>>(new Set());

  const streamsForChat = useCallback(
    (chatId: string): ActiveStream[] =>
      [...streams.current.values()].filter((s) => s.chatId === chatId),
    [],
  );

  // Derives every UI mirror from the registry — call after EVERY mutation.
  // A chat with both a generating and a waiting stream shows the dots.
  const syncIndicators = useCallback(() => {
    const streaming = new Set<string>();
    const queued = new Set<string>();
    const messageIds = new Set<string>();
    for (const s of streams.current.values()) {
      messageIds.add(s.tempAssistantId);
      if (!s.started && s.queuedAhead !== null) queued.add(s.chatId);
      else streaming.add(s.chatId);
    }
    for (const id of streaming) queued.delete(id);
    setStreamingChatIds(streaming);
    setQueuedChatIds(queued);
    setStreamingMessageIds(messageIds);
  }, []);

  // `messageId` is the answer the round is appending to — pass it wherever
  // there is a bubble, so the text that is growing says so.
  const markAnswering = useCallback((chatId: string, on: boolean, messageId?: string) => {
    setContinuingChatIds((prev) => {
      if (prev.has(chatId) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(chatId);
      else next.delete(chatId);
      return next;
    });
    if (!messageId) return;
    setContinuingMessageIds((prev) => {
      if (prev.has(messageId) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(messageId);
      else next.delete(messageId);
      return next;
    });
  }, []);

  return {
    streams,
    streamingChatIds,
    queuedChatIds,
    streamingMessageIds,
    continuingChatIds,
    continuingMessageIds,
    streamsForChat,
    syncIndicators,
    markAnswering,
  };
}
