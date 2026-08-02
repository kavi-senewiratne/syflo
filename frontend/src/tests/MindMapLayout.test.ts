import { describe, it, expect } from 'vitest';
import { buildLayout, findRoot } from '../components/MindMap';
import type { Chat } from '../types';

const mk = (id: string, children: Chat[] = [], parent_id: string | null = null): Chat => ({
  id,
  title: id,
  parent_id,
  parent_word: null,
  children,
  created_at: '2025-01-01T00:00:00Z',
});

describe('MindMap radial layout', () => {
  it('places root at origin', () => {
    const tree = [mk('root')];
    const { nodes } = buildLayout(tree);
    const root = nodes.find(n => n.id === 'root')!;
    expect(root.position).toEqual({ x: 0, y: 0 });
  });

  it('spreads 6 children around the root (non-horizontal)', () => {
    const children = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => mk(id, [], 'root'));
    const tree = [mk('root', children)];
    const { nodes } = buildLayout(tree);

    const positions = children.map(c => nodes.find(n => n.id === c.id)!.position);

    // No two children share the same y → not on a horizontal line.
    const ys = new Set(positions.map(p => Math.round(p.y)));
    expect(ys.size).toBeGreaterThan(1);

    // No two children share the same x → not on a vertical line.
    const xs = new Set(positions.map(p => Math.round(p.x)));
    expect(xs.size).toBeGreaterThan(1);

    // All children should be at roughly the same distance from origin.
    // (Exact value matches RADIUS_STEP — bumped when nodes grew in size.)
    const distances = positions.map(p => Math.hypot(p.x, p.y));
    const referenceRadius = distances[0];
    distances.forEach(d => expect(d).toBeCloseTo(referenceRadius, 0));
  });

  it('keeps grandchildren on the outward side of their parent', () => {
    // root → habits → [plan, study, system]
    const grandkids = ['plan', 'study', 'system'].map(id => mk(id, [], 'habits'));
    const habits = mk('habits', grandkids, 'root');
    const tree = [mk('root', [habits])];

    const { nodes } = buildLayout(tree);
    const habitsPos = nodes.find(n => n.id === 'habits')!.position;
    const grandkidPositions = grandkids.map(g => nodes.find(n => n.id === g.id)!.position);

    // Grandchildren should be farther from origin than habits.
    const habitsDist = Math.hypot(habitsPos.x, habitsPos.y);
    grandkidPositions.forEach(p => {
      expect(Math.hypot(p.x, p.y)).toBeGreaterThan(habitsDist);
    });
  });

  it('passes preview, parentWord, and messageCount into each node\'s data', () => {
    const child: Chat = {
      id: 'child',
      title: 'Child Chat',
      parent_id: 'root',
      parent_word: 'Sehnsucht',
      created_at: '2025-01-01T00:00:00Z',
      children: [],
      preview: 'Was bedeutet Sehnsucht im Deutschen?',
      message_count: 7,
    };
    const root: Chat = {
      id: 'root',
      title: 'Root',
      parent_id: null,
      parent_word: null,
      created_at: '2025-01-01T00:00:00Z',
      children: [child],
      preview: 'Eine erste Frage',
      message_count: 3,
    };

    const { nodes } = buildLayout([root]);
    const rootNode = nodes.find(n => n.id === 'root')!;
    const childNode = nodes.find(n => n.id === 'child')!;

    expect(rootNode.type).toBe('chat');
    expect(rootNode.data).toMatchObject({
      title: 'Root',
      preview: 'Eine erste Frage',
      messageCount: 3,
      isRoot: true,
    });
    expect(childNode.data).toMatchObject({
      title: 'Child Chat',
      parentWord: 'Sehnsucht',
      preview: 'Was bedeutet Sehnsucht im Deutschen?',
      messageCount: 7,
      isRoot: false,
    });
  });

  it('does NOT place a chain of single descendants in a horizontal line', () => {
    // root → a → b → c (each has exactly one child)
    const c = mk('c', [], 'b');
    const b = mk('b', [c], 'a');
    const a = mk('a', [b], 'root');
    const tree = [mk('root', [a])];

    const { nodes } = buildLayout(tree);
    const ys = nodes.map(n => Math.round(n.position.y));
    const uniqueYs = new Set(ys);

    // If the layout were horizontal, all y-coords would be 0.
    // The fixed radial layout should put descendants at varying y (or at least
    // not all on the same horizontal line as the root).
    expect(uniqueYs.size).toBeGreaterThan(1);
  });
});

describe('findRoot', () => {
  // Two trees: the newer one first (like the sidebar sorts them), so a failed
  // lookup that falls back to the first root would return the WRONG tree.
  const grandchild = mk('training', [], 'mha');
  const mha = mk('mha', [grandchild], 'attention');
  const attentionRoot = mk('attention', [mha]);
  const marioRoot = mk('mario');
  const chats = [marioRoot, attentionRoot];

  it('finds the root for the root itself', () => {
    expect(findRoot(chats, 'attention')?.id).toBe('attention');
  });

  it('finds the root for a direct child', () => {
    expect(findRoot(chats, 'mha')?.id).toBe('attention');
  });

  it('finds the root for a branch two levels deep (bug 2026-07-28)', () => {
    // Regression: only direct children were checked, so the map fell back to
    // the first root (the wrong tree) when a deep branch was active.
    expect(findRoot(chats, 'training')?.id).toBe('attention');
  });

  it('returns null for an unknown chat id', () => {
    expect(findRoot(chats, 'nope')).toBeNull();
  });
});
