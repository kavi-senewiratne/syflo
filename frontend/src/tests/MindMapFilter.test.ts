import { describe, it, expect } from 'vitest';
import { buildLayout, countKinds } from '../components/MindMap';
import type { Chat, HighlightColor } from '../types';

const branch = (id: string, color: HighlightColor | null): Chat => ({
  id,
  title: id,
  parent_id: 'root',
  parent_word: id,
  highlight_color: color,
  created_at: '2026-08-01T00:00:00Z',
});

const tree = (): Chat[] => [{
  id: 'root',
  title: 'Attention Is All You Need',
  parent_id: null,
  parent_word: null,
  created_at: '2026-08-01T00:00:00Z',
  children: [branch('q1', 'pink'), branch('i1', 'yellow'), branch('plain', null)],
}];

describe('MindMap highlight-kind filter', () => {
  it('dims nothing while no kind is selected ("All")', () => {
    const { nodes } = buildLayout(tree(), null, new Set());
    expect(nodes.every(n => !n.data.dimmed)).toBe(true);
  });

  it('dims the branches whose kind is not selected', () => {
    const { nodes } = buildLayout(tree(), null, new Set<HighlightColor>(['pink']));
    expect(nodes.find(n => n.id === 'q1')!.data.dimmed).toBe(false);
    expect(nodes.find(n => n.id === 'i1')!.data.dimmed).toBe(true);
    // A branch opened without a highlight has no kind — it dims too, it does
    // not become a sixth kind (mockup-mindmap-lens-final.html §01).
    expect(nodes.find(n => n.id === 'plain')!.data.dimmed).toBe(true);
  });

  it('never dims the root, so the tree keeps its trunk', () => {
    const { nodes } = buildLayout(tree(), null, new Set<HighlightColor>(['pink']));
    expect(nodes.find(n => n.id === 'root')!.data.dimmed).toBe(false);
  });

  it('dims the edge to a dimmed node so no strong line leads nowhere', () => {
    const { edges } = buildLayout(tree(), null, new Set<HighlightColor>(['pink']));
    expect(edges.find(e => e.target === 'q1')!.data?.dimmed).toBe(false);
    expect(edges.find(e => e.target === 'i1')!.data?.dimmed).toBe(true);
  });

  it('counts how many branches carry each kind', () => {
    expect(countKinds(tree())).toEqual({
      yellow: 1, green: 0, blue: 0, pink: 1, orange: 0, total: 3,
    });
  });
});
