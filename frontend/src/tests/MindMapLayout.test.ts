import { describe, it, expect } from 'vitest';
import { buildLayout, findRoot, outcomeState } from '../components/MindMap';
import type { Chat } from '../types';

const mk = (id: string, children: Chat[] = [], parent_id: string | null = null): Chat => ({
  id,
  title: id,
  parent_id,
  parent_word: null,
  children,
  created_at: '2025-01-01T00:00:00Z',
});

describe('MindMap node data', () => {
  it('carries the highlight kind and the outcome line of a branch', () => {
    const branch: Chat = {
      ...mk('branch', [], 'root'),
      title: 'Scaled dot-product',
      parent_word: 'we scale the dot products',
      highlight_color: 'pink',
      outcome: 'Hält die Varianz bei 1',
    };
    const { nodes } = buildLayout([mk('root', [branch])]);
    const node = nodes.find(n => n.id === 'branch')!;
    expect(node.data.highlightColor).toBe('pink');
    expect(node.data.outcome).toBe('Hält die Varianz bei 1');
  });
});

describe('MindMap edge label', () => {
  it('labels the edge with the restored quote, on one line', () => {
    // Decision 2026-08-02: the edge carries the marked passage verbatim (the
    // display fassung with math restored), the node carries title + outcome.
    // Since the tree runs top-down (2026-08-04) the label sits in the lane
    // above its card, so one line — every further line pushes the next row
    // down — and never wider than the card it belongs to.
    const branch: Chat = {
      ...mk('branch', [], 'root'),
      parent_word: 'we scale the dot products by 1/ d k',
      parent_word_display: 'we scale the dot products by $1/\\sqrt{d_k}$',
    };
    const { edges } = buildLayout([mk('root', [branch])]);
    expect(edges[0].label).toBe('we scale the dot products by $1/\\sqrt{d_k}$');
    expect(edges[0].data?.clampLines).toBe(1);
    expect(edges[0].data?.labelWidth).toBe(220);
  });

  it('falls back to the verbatim passage when no display version exists', () => {
    const branch: Chat = { ...mk('branch', [], 'root'), parent_word: 'eight heads' };
    const { edges } = buildLayout([mk('root', [branch])]);
    expect(edges[0].label).toBe('eight heads');
  });
});

describe('MindMap outcome line', () => {
  it('shows the outcome once it exists', () => {
    expect(outcomeState('Hält die Varianz bei 1', 4)).toBe('outcome');
  });

  it('waits visibly while the branch has an answer but no outcome yet', () => {
    // The placeholder keeps the node the same height, so it does not jump
    // when the real line arrives (mockup-mindmap-node-final.html §01).
    expect(outcomeState(null, 1)).toBe('pending');
  });

  it('shows nothing for a freshly opened branch', () => {
    expect(outcomeState(null, 0)).toBe('none');
    expect(outcomeState(null, undefined)).toBe('none');
  });

  it('promises nothing when the branch has messages but no real answer', () => {
    // A question whose answer ended in '*Failed*'/'*Interrupted*' establishes
    // nothing — the backend's answer_count excludes those markers, so the node
    // stays on its title instead of waiting for an outcome that never comes
    // (user report 2026-08-03).
    expect(outcomeState(null, 0)).toBe('none');
  });

  it('reads the answer count, not the message count', () => {
    const branch: Chat = {
      ...mk('branch', [], 'root'),
      message_count: 2,
      answer_count: 0,
      outcome: null,
    };
    const { nodes } = buildLayout([mk('root', [branch])]);
    const node = nodes.find(n => n.id === 'branch')!;
    expect(outcomeState(
      node.data.outcome as string | null,
      node.data.answerCount as number | undefined,
    )).toBe('none');
  });
});

// Rectangle of a laid-out node, in canvas coordinates.
const NODE_WIDTH = 220;
type Box = { left: number; right: number; top: number; bottom: number; centerX: number };
const boxOf = (nodes: ReturnType<typeof buildLayout>['nodes'], id: string): Box => {
  const n = nodes.find(node => node.id === id)!;
  const w = n.width!;
  const h = n.height!;
  return {
    left: n.position.x,
    right: n.position.x + w,
    top: n.position.y,
    bottom: n.position.y + h,
    centerX: n.position.x + w / 2,
  };
};
const overlaps = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

describe('MindMap spacing', () => {
  // User report 2026-08-02: with many branches the cards sat so close that
  // their texts overlapped.
  it('never lets two cards overlap, however wide the tree gets (18 children)', () => {
    const children = Array.from({ length: 18 }, (_, i) => mk(`c${i}`, [], 'root'));
    const { nodes } = buildLayout([mk('root', children)]);
    const boxes = nodes.map(n => boxOf(nodes, n.id));
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        expect(overlaps(boxes[i], boxes[j])).toBe(false);
      }
    }
  });

  it('keeps two cards of the same half-row a full card width apart', () => {
    // Staggered rows advance by half a step, so only every SECOND card is a
    // neighbour in the same half — those must keep the full gap.
    const children = Array.from({ length: 12 }, (_, i) => mk(`c${i}`, [], 'root'));
    const { nodes } = buildLayout([mk('root', children)]);
    for (let i = 0; i + 2 < children.length; i += 1) {
      const a = boxOf(nodes, `c${i}`);
      const b = boxOf(nodes, `c${i + 2}`);
      expect(b.left - a.left).toBeGreaterThanOrEqual(NODE_WIDTH);
    }
  });
});

describe('MindMap top-down tree', () => {
  // User decision 2026-08-04: root on top, every depth one row below —
  // design/mockup-mindmap-fan.html, variant F1.
  it('puts the root above every one of its children', () => {
    const children = ['a', 'b', 'c'].map(id => mk(id, [], 'root'));
    const { nodes } = buildLayout([mk('root', children)]);
    const root = boxOf(nodes, 'root');
    children.forEach(c => expect(boxOf(nodes, c.id).top).toBeGreaterThan(root.bottom));
  });

  it('puts a small row of siblings on one line', () => {
    const children = ['a', 'b', 'c'].map(id => mk(id, [], 'root'));
    const { nodes } = buildLayout([mk('root', children)]);
    const ys = new Set(children.map(c => boxOf(nodes, c.id).top));
    expect(ys.size).toBe(1);
  });

  it('centers a parent over its children', () => {
    const grandkids = ['plan', 'study', 'system'].map(id => mk(id, [], 'habits'));
    const habits = mk('habits', grandkids, 'root');
    const { nodes } = buildLayout([mk('root', [habits])]);
    const parent = boxOf(nodes, 'habits');
    const first = boxOf(nodes, 'plan');
    const last = boxOf(nodes, 'system');
    expect(parent.centerX).toBeCloseTo((first.left + last.right) / 2, 5);
  });

  it('drops a chain of single children straight down', () => {
    const c = mk('c', [], 'b');
    const b = mk('b', [c], 'a');
    const a = mk('a', [b], 'root');
    const { nodes } = buildLayout([mk('root', [a])]);
    const centers = ['root', 'a', 'b', 'c'].map(id => boxOf(nodes, id).centerX);
    centers.forEach(x => expect(x).toBeCloseTo(centers[0], 5));
    // …and each one strictly below the last.
    const tops = ['root', 'a', 'b', 'c'].map(id => boxOf(nodes, id).top);
    tops.slice(1).forEach((t, i) => expect(t).toBeGreaterThan(tops[i]));
  });

  it('staggers a wide row into two half-rows and leaves a corridor for the lower one', () => {
    const children = Array.from({ length: 12 }, (_, i) => mk(`c${i}`, [], 'root'));
    const { nodes } = buildLayout([mk('root', children)]);
    const boxes = children.map(c => boxOf(nodes, c.id));

    // Two heights, alternating.
    const tops = [...new Set(boxes.map(b => b.top))];
    expect(tops.length).toBe(2);
    boxes.forEach((b, i) => expect(b.top).toBe(i % 2 === 0 ? tops[0] : tops[1]));

    // The corridor: a lower card's center must fall in the gap between the two
    // upper cards beside it — that is the hole its line falls through.
    for (let i = 1; i < boxes.length - 1; i += 2) {
      expect(boxes[i].centerX).toBeGreaterThan(boxes[i - 1].right);
      expect(boxes[i].centerX).toBeLessThan(boxes[i + 1].left);
    }
  });

  it('runs every edge of one parent through the same lane, below its row and above its children', () => {
    const children = Array.from({ length: 12 }, (_, i) => mk(`c${i}`, [], 'root'));
    const { nodes, edges } = buildLayout([mk('root', children)]);
    const root = boxOf(nodes, 'root');
    const lanes = new Set(edges.map(e => e.data!.laneY as number));
    expect(lanes.size).toBe(1);

    const laneY = [...lanes][0];
    expect(laneY).toBeGreaterThan(root.bottom);
    // Above every card of the row it feeds — otherwise the trunk would run
    // across the cards instead of between the rows.
    children.forEach(c => expect(laneY).toBeLessThan(boxOf(nodes, c.id).top));
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

  it('anchors the lines at the bottom and top edge of a card', () => {
    // Without these two the smooth-step path is routed left/right and the
    // trunk ends up beside the cards instead of between the rows.
    const { nodes } = buildLayout([mk('root', [mk('a', [], 'root')])]);
    nodes.forEach(n => {
      expect(n.sourcePosition).toBe('bottom');
      expect(n.targetPosition).toBe('top');
    });
  });

  it('hands out one band per depth, matching where the cards actually stand', () => {
    // The bands are drawn behind the tree, so a wrong height would tint the
    // lane where the lines run (design/mockup-mindmap-rows-path.html §01 A).
    const kids = ['a', 'b'].map(id => mk(id, [], 'root'));
    const { nodes, rows } = buildLayout([mk('root', kids)]);
    expect(rows.map(r => r.depth)).toEqual([0, 1]);
    expect(rows[1].count).toBe(2);

    rows.forEach(row => {
      const inRow = nodes.filter(n => {
        const box = boxOf(nodes, n.id);
        return box.top >= row.top && box.top < row.top + row.height + 1;
      });
      expect(inRow.length).toBe(row.count);
      // No card may stick out of its band into the lane below it.
      inRow.forEach(n => expect(boxOf(nodes, n.id).bottom).toBeLessThanOrEqual(row.top + row.height));
    });
  });

  it('gives a staggered row a band tall enough for both halves', () => {
    const kids = Array.from({ length: 12 }, (_, i) => mk(`c${i}`, [], 'root'));
    const { nodes, rows } = buildLayout([mk('root', kids)]);
    const lower = boxOf(nodes, 'c1');
    expect(lower.bottom).toBeLessThanOrEqual(rows[1].top + rows[1].height);
  });

  it('lights up every edge on the way from the root to the open branch', () => {
    // root → a → b → c, and a second branch that must stay dark.
    const c = mk('c', [], 'b');
    const b = mk('b', [c], 'a');
    const a = mk('a', [b], 'root');
    const other = mk('other', [], 'root');
    const { edges } = buildLayout([mk('root', [a, other])], 'c');

    const lit = edges.filter(e => e.className === 'syflo-map-edge-on-path').map(e => e.target);
    expect(lit.sort()).toEqual(['a', 'b', 'c']);
    expect(edges.find(e => e.target === 'other')?.className).toBeUndefined();
  });

  it('draws the lit edge after its plain siblings, or they paint over it', () => {
    // All children of one parent share the same stem and the same stretch of
    // trunk. Painted in tree order, the later siblings cover the lit line —
    // so the lit ones have to come LAST in the array (SVG has no z-index).
    const kids = ['a', 'b', 'c'].map(id => mk(id, [], 'root'));
    const { edges } = buildLayout([mk('root', kids)], 'a');
    const litIndex = edges.findIndex(e => e.target === 'a');
    expect(litIndex).toBe(edges.length - 1);
    // The plain ones keep their tree order among themselves.
    expect(edges.slice(0, -1).map(e => e.target)).toEqual(['b', 'c']);
  });

  it('lights nothing when no branch is open', () => {
    const a = mk('a', [], 'root');
    const { edges } = buildLayout([mk('root', [a])]);
    expect(edges.every(e => e.className === undefined)).toBe(true);
  });

  it('keeps two sibling subtrees apart instead of interleaving them', () => {
    // left → [l1, l2], right → [r1, r2]. If a row counter were missing, the
    // deeper cards of the two subtrees would end up mixed — and every edge
    // between them would cross.
    const left = mk('left', ['l1', 'l2'].map(id => mk(id, [], 'left')), 'root');
    const right = mk('right', ['r1', 'r2'].map(id => mk(id, [], 'right')), 'root');
    const { nodes } = buildLayout([mk('root', [left, right])]);

    expect(boxOf(nodes, 'l2').right).toBeLessThanOrEqual(boxOf(nodes, 'r1').left);
    expect(boxOf(nodes, 'left').right).toBeLessThanOrEqual(boxOf(nodes, 'right').left);
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
