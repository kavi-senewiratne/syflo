/**
 * chat/branchTrace.ts
 *
 * The BRANCH TRACE — what `/btw` and `/branch` leave behind in the chat they
 * were opened from (design/mockup-branch-trace.html, variant A, decided
 * 2026-08-09).
 *
 * A branch opened from a selection already marks its parent: the passage
 * stays coloured and carries the child chat. The two commands have no
 * passage, so their trace is drawn at the point in TIME they were sent —
 * right after `branch_anchor_message_id`, the last message that existed in
 * the parent back then.
 *
 * This module answers one question for the transcript: which lines go under
 * which message. Selection branches never appear here — a second
 * announcement of the same branch is noise.
 */

import type { Chat, BranchOrigin } from '../types';

export interface BranchTraceEntry {
  chatId: string;
  origin: BranchOrigin;
  /** Branch title — the pill's text (already a real title, not raw input). */
  title: string;
  created_at: string;
}

export interface BranchTraceGroups {
  /**
   * Lines with no resolvable anchor: opened in an empty chat, or anchored to
   * a message that no longer exists. They render ABOVE the first message —
   * the fork happened, its place in the transcript did not survive.
   */
  leading: BranchTraceEntry[];
  /** anchor message id → the branches opened right after that message. */
  byMessageId: Map<string, BranchTraceEntry[]>;
}

/**
 * Group a chat's children into trace lines.
 *
 * @param children     the parent's child chats (as GET /chats/:id ships them)
 * @param messageIds   ids currently rendered in the transcript — an anchor
 *                     outside this set falls back to `leading`
 */
export function groupBranchTraces(
  children: Chat[] | undefined,
  messageIds: Iterable<string>,
): BranchTraceGroups {
  const known = new Set(messageIds);
  const leading: BranchTraceEntry[] = [];
  const byMessageId = new Map<string, BranchTraceEntry[]>();

  const traced = (children ?? [])
    .filter((c): c is Chat & { branch_origin: BranchOrigin } =>
      c.branch_origin === 'btw' || c.branch_origin === 'topic')
    // Oldest first, so several lines at one anchor read in the order the
    // conversation actually forked.
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));

  traced.forEach((c) => {
    const entry: BranchTraceEntry = {
      chatId: c.id,
      origin: c.branch_origin,
      title: c.title,
      created_at: c.created_at,
    };
    const anchor = c.branch_anchor_message_id;
    if (anchor && known.has(anchor)) {
      const list = byMessageId.get(anchor);
      if (list) list.push(entry);
      else byMessageId.set(anchor, [entry]);
    } else {
      leading.push(entry);
    }
  });

  return { leading, byMessageId };
}

/**
 * How many lines a stack shows before it folds (mockup §02): two, then
 * "n more". Four branches off one answer is ordinary while reading a paper,
 * and a transcript that is mostly trace lines has stopped being a transcript.
 */
export const TRACE_VISIBLE = 2;
