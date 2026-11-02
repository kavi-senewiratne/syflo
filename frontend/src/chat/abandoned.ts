/**
 * chat/abandoned.ts
 *
 * The Abandoned chat definition (CONTEXT.md): a root chat that is
 * unambiguously worthless — no messages, no branches, no source, not pinned.
 * The frontend deletes one when it is left; the backend sweeps the stragglers
 * at startup (backend/cleanup.js). The two MUST stay identical: a source is a
 * paper, a video OR an HTML source (ADR-0013).
 */

interface ChatLike {
  parent_id: string | null;
  messages: unknown[];
  children: unknown[];
  pinned_at?: string | null;
}

export interface SourceState {
  paper: unknown | null;
  video: unknown | null;
  html: unknown | null;
  /** A stream is still running for this chat. */
  streaming: boolean;
}

export function isAbandonedChat(chat: ChatLike, s: SourceState): boolean {
  return (
    !chat.parent_id &&
    chat.messages.length === 0 &&
    chat.children.length === 0 &&
    !chat.pinned_at &&
    s.paper === null &&
    s.video === null &&
    s.html === null &&
    !s.streaming
  );
}
