import { describe, it, expect } from 'vitest';
import { branchTargetsFor } from '../chat/branchTargets';
import type { Chat } from '../types';

/**
 * The parents `/branch` may hang a typed topic under
 * (design/mockup-branch-command.html §02, variant C): every chat of the tree
 * the user is standing in — and nothing from any other tree, because a branch
 * never crosses into a different source.
 */

const chat = (id: string, children: Chat[] = []): Chat => ({
  id,
  title: id,
  parent_id: null,
  parent_word: null,
  created_at: '2026-08-08T00:00:00Z',
  children,
});

const tree: Chat[] = [
  chat('attention', [
    chat('scaled-dot', [chat('softmax')]),
    chat('curse'),
  ]),
  chat('other-paper', [chat('other-branch')]),
];

describe('branchTargetsFor', () => {
  it('lists the whole tree of the active chat, root first, with its depth', () => {
    expect(branchTargetsFor(tree, 'softmax')).toEqual([
      { id: 'attention', title: 'attention', depth: 0 },
      { id: 'scaled-dot', title: 'scaled-dot', depth: 1 },
      { id: 'softmax', title: 'softmax', depth: 2 },
      { id: 'curse', title: 'curse', depth: 1 },
    ]);
  });

  it('never offers a chat from another tree', () => {
    const ids = branchTargetsFor(tree, 'scaled-dot').map((t) => t.id);
    expect(ids).not.toContain('other-paper');
    expect(ids).not.toContain('other-branch');
  });

  it('yields nothing for an unknown chat', () => {
    expect(branchTargetsFor(tree, 'nope')).toEqual([]);
    expect(branchTargetsFor(tree, null)).toEqual([]);
  });
});
