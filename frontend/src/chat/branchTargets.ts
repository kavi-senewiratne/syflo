/**
 * chat/branchTargets.ts
 *
 * Where a `/branch <topic>` may land (design/mockup-branch-command.html §02,
 * variant C). The default is the chat the user stands in; the picker offers
 * the rest of the SAME tree — a branch never crosses into another tree,
 * because a tree is bound to one source (ADR-0002).
 */

import { findRoot } from '../components/MindMap';
import type { BranchTarget, Chat } from '../types';

/**
 * The active chat's tree, flattened in display order: root first, then each
 * branch depth-first, with the depth the picker indents by.
 */
export function branchTargetsFor(chats: Chat[], activeChatId: string | null | undefined): BranchTarget[] {
  const root = findRoot(chats, activeChatId);
  if (!root) return [];
  const targets: BranchTarget[] = [];
  const walk = (chat: Chat, depth: number) => {
    targets.push({ id: chat.id, title: chat.title, depth });
    for (const child of chat.children || []) walk(child, depth + 1);
  };
  walk(root, 0);
  return targets;
}
