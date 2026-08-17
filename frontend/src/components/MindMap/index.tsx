import { useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  ViewportPortal,
  getSmoothStepPath,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type EdgeProps,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { MessageSquare, Home } from 'lucide-react';
import { InlineMarkdown } from '../ChatArea/InlineMarkdown';
import { MathText, plainMathText } from '../MathText';
import { useStrings } from '../../strings';
import { useLabels } from '../../hooks/useLabels';
import { KindFilterBar } from './KindFilterBar';
import { HIGHLIGHT_COLORS } from '../../types';
import type { Chat, HighlightColor } from '../../types';

function TreeEdge({
  id, sourceX, sourceY, targetX, targetY, markerEnd, style, label, labelStyle, data,
}: EdgeProps) {
  // Kompakt vs. voll: Labels sind ganze markierte Passagen. Zusammengeklappt
  // steht eine Zeile in der Lücke über der Karte, beim Hover klappt der Rest
  // nach OBEN auf — in die kartenfreie Lane, nicht über die eigene Karte.
  const [hovered, setHovered] = useState(false);
  const edgeData = data as
    | { clampLines?: number; dimmed?: boolean; laneY?: number; labelWidth?: number }
    | undefined;
  const clampLines = edgeData?.clampLines ?? EDGE_LABEL_CLAMP_LINES;
  const dimmedEdge = Boolean(edgeData?.dimmed) && !hovered;
  const collapsedWidth = edgeData?.labelWidth ?? NODE_WIDTH;

  // Down out of the parent's bottom edge, along the shared trunk in the lane,
  // down into the child's top edge. centerY is the lane the layout reserved —
  // see the edge's data in buildLayout.
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition: Position.Bottom,
    targetX,
    targetY,
    targetPosition: Position.Top,
    borderRadius: EDGE_CORNER_RADIUS,
    ...(edgeData?.laneY != null ? { centerY: edgeData.laneY } : {}),
  });

  // The quote sits directly above the card it leads to: anchored at the card's
  // top edge, the label grows upward when it opens.
  const labelX = targetX;
  const labelY = targetY - EDGE_LABEL_GAP;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={dimmedEdge ? { ...style, opacity: 0.22 } : style}
      />
      {label != null && label !== '' && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan syflo-map-edge-label"
            data-testid="mindmap-edge-label"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            style={{
              position: 'absolute',
              // -100% in y: the label hangs ABOVE the anchor, so opening it
              // pushes text up into the lane instead of down over the card.
              transform: `translate(-50%, -100%) translate(${labelX}px, ${labelY}px)`,
              padding: '2px 6px',
              borderRadius: '4px',
              pointerEvents: 'all',
              ...(dimmedEdge ? { opacity: 0.25 } : {}),
              // Branch words can be whole selected paragraphs from a PDF.
              // Without a cap the label renders as one enormous block that
              // covers every node it crosses. Collapsed: one line, never wider
              // than its own card, or it would reach into the neighbouring
              // column. Hovered: the full passage, above nodes and labels.
              ...(hovered
                ? {
                    maxWidth: 300,
                    whiteSpace: 'normal',
                    overflowWrap: 'break-word',
                    zIndex: 1000,
                    boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
                  }
                : {
                    maxWidth: collapsedWidth,
                    whiteSpace: 'normal',
                    overflowWrap: 'break-word',
                    display: '-webkit-box',
                    WebkitBoxOrient: 'vertical',
                    WebkitLineClamp: clampLines,
                    overflow: 'hidden',
                    lineHeight: 1.35,
                  }),
              ...(labelStyle as React.CSSProperties),
            }}
          >
            {/* parent_word can carry inline math ($…$) — render it, don't
                show raw LaTeX (user report 2026-07-26). */}
            {typeof label === 'string' ? <InlineMarkdown text={label} /> : (label as React.ReactNode)}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = { tree: TreeEdge };

// How many lines of the marked passage an edge label shows before clipping.
// One since the tree runs top-down (design/mockup-mindmap-fan.html): the label
// no longer sits in a wide gap between two columns but in the lane above its
// card, and every extra line there pushes the whole next row down.
const EDGE_LABEL_CLAMP_LINES = 1;

// Rounding of the two corners where a line turns into the trunk and out of it.
const EDGE_CORNER_RADIUS = 12;

// Air between the label's lower edge and the top of the card it belongs to.
const EDGE_LABEL_GAP = 8;

// Inhalt eines Mindmap-Knotens. Zeigt den Verzweigungsanlass, den Titel
// und einen Auszug aus der ersten Nutzer-Frage — beim Hover wird der
// Auszug nicht mehr gekürzt, damit man den vollen Text sehen kann.
interface ChatNodeData {
  title: string;
  parentWord?: string | null;
  preview?: string | null;
  messageCount?: number;
  // Real answers (failure markers excluded) — decides whether the outcome
  // placeholder is honest; see outcomeState.
  answerCount?: number;
  highlightColor?: HighlightColor | null;
  outcome?: string | null;
  // Faded because the kind filter above the map excludes this branch.
  dimmed?: boolean;
  isRoot: boolean;
  isActive: boolean;
}

/**
 * Which second line a node shows (design/mockup-mindmap-node-final.html §01):
 *   'outcome' — the finding, once the title call delivered it
 *   'pending' — a placeholder of the SAME height while the branch has an
 *               answer but no finding yet, so the card does not jump
 *   'none'    — freshly opened branch, or one whose only answer failed
 *
 * The second argument is the count of REAL answers, not of messages: a branch
 * whose answer ended in '*Failed*' or '*Interrupted*' established nothing, so
 * "Ergebnis folgt …" would be a promise nobody is going to keep (2026-08-03).
 */
export function outcomeState(
  outcome: string | null | undefined,
  answerCount: number | undefined,
): 'outcome' | 'pending' | 'none' {
  if (outcome && outcome.trim()) return 'outcome';
  return (answerCount ?? 0) > 0 ? 'pending' : 'none';
}

// Deep tones of the five highlight colors — the node's left color bar carries
// the highlight kind a branch was opened from. Literal hex, never token
// classes: a highlight's identity color is a fixed product constant, while
// the themes remap blue-*/green-* (same reasoning as DOT_BG in
// HighlightsDrawer). Matrix dims the fills but keeps these bars bright.
const KIND_BAR: Record<HighlightColor, string> = {
  yellow: '#CA8A04',
  green: '#16A34A',
  blue: '#2563EB',
  pink: '#DB2777',
  orange: '#EA580C',
};

// Titel-Kürzung: Ein Klick auf den Knoten springt ohnehin an die Stelle im
// Chat — der Knoten muss den Text also nicht komplett zeigen. Ohne Clamp
// sprengen Branch-Titel aus langen Markierungen („About: <ganzer Absatz>")
// die Karte (Nutzerkorrektur 2026-07-22).
const TITLE_CLAMP_LINES = 3;

function ChatNodeView({ id, data }: NodeProps) {
  // UI-Texte in der App language — re-rendert beim Sprachwechsel mit.
  const S = useStrings().mindMap;
  const { title, parentWord, preview, messageCount, answerCount, highlightColor, outcome, dimmed, isRoot, isActive } =
    data as unknown as ChatNodeData;
  const [hovered, setHovered] = useState(false);
  // Second line of the node: the finding, a placeholder, or nothing.
  const secondLine = isRoot ? 'none' : outcomeState(outcome, answerCount);

  // Inline-Style statt Tailwind-Klasse (gleiche Begründung wie previewStyle).
  const titleStyle: React.CSSProperties = {
    fontSize: isRoot ? 22 : 13,
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: TITLE_CLAMP_LINES,
    overflow: 'hidden',
  };

  // Inline-Style statt Tailwind-Klasse für das line-clamp — vermeidet
  // mögliche Cascade-Layer-Konflikte mit Tailwind v4.
  const previewStyle: React.CSSProperties = hovered
    ? { display: 'block' }
    : {
        display: '-webkit-box',
        WebkitBoxOrient: 'vertical',
        WebkitLineClamp: 2,
        overflow: 'hidden',
      };

  // Unsichtbare Handles als Anker für Floating Edges — React Flow braucht
  // mindestens je einen Source- und Target-Handle, sonst sind die Edges
  // null-gehandled und werden gar nicht erst gerendert (Fehler #008).
  const handleStyle: React.CSSProperties = {
    opacity: 0,
    width: 1,
    height: 1,
    border: 'none',
    background: 'transparent',
    pointerEvents: 'none',
  };

  // Farben, Rahmen, Radius und Schatten kommen komplett aus index.css
  // (.syflo-map-node / .syflo-map-node-root), damit die Karte der
  // Designsprache des aktiven Themes folgt (design/mockup-mindmap-themes.html).
  // Prominenz der Wurzel: Größe, Akzentfläche, stärkerer Offset-Schatten.
  return (
    <div
      // One keyboard item per node (ADR-0011). Inside the map the arrows
      // follow what it shows: left/right are siblings, up/down change
      // generation.
      data-focus-item={id}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`relative transition-all duration-150 syflo-map-node${isRoot ? ' syflo-map-node-root' : ''}`}
      style={{
        width: isRoot ? 360 : 220,
        padding: isRoot ? '22px 26px' : '12px 14px',
        transform: hovered ? 'scale(1.03)' : 'scale(1)',
        // Filtered out: fade instead of hide, so the tree keeps its shape.
        // Hovering brings a faded card back to full strength — reading it
        // must stay possible without clearing the filter.
        ...(dimmed && !hovered ? { opacity: 0.28, boxShadow: 'none' } : {}),
        // Color bar for the highlight kind this branch was opened from
        // (mockup-mindmap-node-final.html). Applied as a left border so it
        // follows the card's radius; the theme's own border stays on the
        // other three sides via index.css.
        ...(highlightColor && !isRoot
          ? { borderLeft: `5px solid ${KIND_BAR[highlightColor]}` }
          : {}),
      }}
      // The branch quote lives on the EDGE now (user decision 2026-08-02) —
      // as a tooltip it stays reachable from the card as well.
      title={parentWord ? plainMathText(parentWord) : undefined}
    >
      <Handle type="target" position={Position.Top} style={handleStyle} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} style={handleStyle} isConnectable={false} />

      {/* Aktiv-Ring („marching ants", aus syflo-2 portiert): markiert den
          Knoten des gerade geöffneten Chats. Farbe/Easing pro Theme über
          index.css (.syflo-map-active-ring). */}
      {isActive && <span aria-hidden className="syflo-map-active-ring" />}

      {/* Root-Badge: macht sofort klar, dass dies der Wurzelknoten ist.
          Gleiche Optik wie das Verzweigungs-Badge bei Kindern (Icon + Versalien),
          nur etwas prominenter (font-semibold + bisschen mehr opacity). */}
      {isRoot && (
        <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider opacity-90 font-semibold mb-2">
          <Home size={12} />
          <span>{S.mainTopic}</span>
        </div>
      )}

      {/* Titel — geklammert auf TITLE_CLAMP_LINES Zeilen; der volle Text
          steht als natives Tooltip zur Verfügung. Das Verzweigungswort steht
          nicht mehr im Knoten: es beschriftet die Kante und sagte hier
          zweimal dasselbe (Nutzerentscheidung 2026-08-02). */}
      <div
        className="font-semibold leading-tight break-words"
        style={titleStyle}
        data-testid="mindmap-node-title"
      >
        <MathText text={title} />
      </div>

      {/* Ergebniszeile: was das Gespräch ergeben hat. Der Platzhalter hält
          dieselbe Höhe, damit die Karte beim Eintreffen nicht springt.
          No left rule any more (user decision 2026-08-08): size and weight
          already separate title from outcome, and a second colored line next
          to the kind bar only competed with it. */}
      {secondLine !== 'none' && (
        <div
          className="mt-1.5 text-[11px] leading-snug break-words"
          style={secondLine === 'pending' ? { opacity: 0.55, fontStyle: 'italic' } : undefined}
          data-testid="mindmap-node-outcome"
        >
          {secondLine === 'outcome' ? <MathText text={outcome as string} /> : S.outcomePending}
        </div>
      )}

      {/* Auszug aus der ersten Nutzer-Frage — beim Hover wird das Clamp aufgehoben */}
      {preview && (
        <div
          className="mt-1.5 text-[11px] italic leading-snug opacity-90 break-words"
          style={previewStyle}
        >
          „<InlineMarkdown text={preview} />"
        </div>
      )}

      {/* Footer: Anzahl Nachrichten */}
      {typeof messageCount === 'number' && messageCount > 0 && (
        <div className="mt-2 flex items-center gap-1 text-[10px] opacity-70">
          <MessageSquare size={10} />
          <span>{messageCount}</span>
        </div>
      )}
    </div>
  );
}

const nodeTypes = { chat: ChatNodeView };

/**
 * The depth stripes behind the tree. They live in a ViewportPortal, so they pan
 * and zoom with the map; z-index -1 keeps them behind the edge and node layers
 * inside the viewport's own stacking context.
 *
 * How far they reach sideways is not the tree's width but the SCREEN's: the
 * user scrolls past the right-most card of a 2300 px row, and a stripe that
 * stopped at the tree would end in mid-air. `spread` therefore over-draws
 * generously on both sides — a rectangle costs nothing.
 */
function RowBands({ rows }: { rows: RowBand[] }) {
  if (rows.length === 0) return null;
  const spread = 20000;
  return (
    <ViewportPortal>
      <div
        data-testid="mindmap-row-bands"
        style={{ position: 'absolute', top: 0, left: 0, zIndex: -1, pointerEvents: 'none' }}
      >
        {rows.map(row =>
          // Every second depth only: two neighbouring stripes of the same tone
          // would be one stripe.
          row.depth % 2 === 1 ? (
            <div
              key={row.depth}
              className="syflo-map-row-band"
              style={{
                position: 'absolute',
                left: -spread,
                top: row.top,
                width: spread * 2,
                height: row.height,
              }}
            />
          ) : null,
        )}
      </div>
    </ViewportPortal>
  );
}

interface Props {
  chats: Chat[];
  activeChatId?: string | null;
  onSelect: (id: string) => void;
}

// Top-down tree (user decision 2026-08-04, design/mockup-mindmap-fan.html
// variant F1): the root sits on top, every depth is one row below the last —
// the shape a tree is drawn in. The radial layout it replaces sent straight
// lines from center to center, which cut through the cards in between.
//
// No line may cross a card, and the geometry alone guarantees it:
//   * every card of a depth stands in a ROW BAND whose height is that depth's
//     tallest card, so nothing sticks out into the gap;
//   * between two bands lies a LANE of ROW_GAP px in which no card may stand —
//     the horizontal trunk of every edge runs there (LANE_OFFSET below the
//     band), the vertical parts stay in their own column.
const NODE_WIDTH = 220;
const ROOT_WIDTH = 360;

// Corridor between two cards of the same half-row. Also the width of the gap
// a staggered card's line falls through — see STAGGER_FROM.
const COL_GAP = 26;

// The card-free lane between two depths. Wide enough for the trunk plus the
// one-line quote that sits directly above the child's card.
const ROW_GAP = 84;

// How far below the row band the horizontal trunk runs. Every child of a
// parent shares this one line, so a fork reads as a single shape.
const LANE_OFFSET = 26;

// Vertical offset of the lower half-row, and the row width that triggers it.
// A row of 18 siblings is 18 columns wide (4462 px on the user's own tree,
// 20 % zoom in the panel). Staggering every second card halves the width for
// one extra card height. The step then becomes (width + COL_GAP) / 2, which
// puts a lower card's center EXACTLY in the middle of the corridor between
// the two cards above it — that is why its line still reaches it without
// touching anything (design/mockup-mindmap-fan.html §02).
const SUB_GAP = 34;
const STAGGER_FROM = 8;

/**
 * One depth of the tree as a stripe on the canvas. Every second band gets a
 * faint tint so a row reads as a row (design/mockup-mindmap-rows-path.html §01,
 * variant A) — the layout knows these numbers anyway, it just used to keep
 * them to itself.
 */
export interface RowBand {
  depth: number;
  top: number;
  height: number;
  count: number;
}

/**
 * The chain of ids from `chatId` up to its root, itself included. Every edge
 * whose TARGET is in this set lies on the path and lights up — the same rule
 * the sidebar tree follows (design/mockup-tree-path-highlight.html): color the
 * connectors, never the rows.
 */
export function pathToRoot(chats: Chat[], chatId: string | null | undefined): Set<string> {
  const onPath = new Set<string>();
  if (!chatId) return onPath;
  const parents: Record<string, string | null> = {};
  const walk = (chat: Chat, parent: string | null) => {
    parents[chat.id] = parent;
    (chat.children || []).forEach(child => walk(child, chat.id));
  };
  chats.forEach(root => walk(root, null));
  let cursor: string | null | undefined = chatId;
  // A branch that is not in this tree at all leaves the set empty rather than
  // looping: `parents` simply has no entry for it.
  while (cursor && !onPath.has(cursor)) {
    onPath.add(cursor);
    cursor = parents[cursor] ?? null;
  }
  return onPath;
}

/**
 * Height a card will render at. The layout needs it before React Flow has
 * measured anything: it sets the row band, and a band that is too low would
 * let a card grow into the lane where the lines run.
 */
function estimateHeight(chat: Chat, isRoot: boolean): number {
  // Titelhöhe: grob Zeichen pro Zeile schätzen, gedeckelt durch das
  // Line-Clamp der Node-Ansicht — lange Titel machen den Knoten sonst
  // in der Schätzung endlos hoch und die Kartenreihe zu hoch.
  const charsPerLine = isRoot ? 26 : 30;
  // Plain length: raw $…$ LaTeX inflates the character count far beyond
  // what KaTeX actually renders.
  const titleLines = Math.min(
    TITLE_CLAMP_LINES,
    Math.max(1, Math.ceil(plainMathText(chat.title).length / charsPerLine)),
  );
  const titleHeight = (isRoot ? 32 : 22) + (titleLines - 1) * (isRoot ? 26 : 16);
  // Outcome line: same estimate as the rendered one (two lines of 11 px at
  // ~34 chars each). It must track the view — see ChatNodeView.
  const outcomeShown = !isRoot && outcomeState(chat.outcome, chat.answer_count) !== 'none';
  const outcomeHeight = outcomeShown
    ? 6 + 16 * Math.min(2, Math.max(1, Math.ceil(plainMathText(chat.outcome || '').length / 34)))
    : 0;
  return (
    (isRoot ? 22 : 0) +
    titleHeight +
    outcomeHeight +
    (chat.preview ? 36 : 0) +
    ((chat.message_count ?? 0) > 0 ? 18 : 0) +
    (isRoot ? 44 : 24)
  );
}

/**
 * How many branches of a tree carry each highlight kind — the numbers on the
 * filter chips. `total` counts every branch, including those without a kind,
 * because that is what the "All" chip stands for.
 */
export function countKinds(chats: Chat[]): Record<HighlightColor, number> & { total: number } {
  const counts = { yellow: 0, green: 0, blue: 0, pink: 0, orange: 0, total: 0 };
  const walk = (chat: Chat) => {
    (chat.children || []).forEach((child) => {
      counts.total += 1;
      if (child.highlight_color) counts[child.highlight_color] += 1;
      walk(child);
    });
  };
  chats.forEach(walk);
  return counts;
}

export function buildLayout(
  chats: Chat[],
  activeChatId?: string | null,
  // Selected highlight kinds. Empty = "All": nothing is dimmed. Otherwise
  // every branch whose kind is not selected fades — it never disappears, or
  // the tree would break into floating islands
  // (design/mockup-mindmap-lens-final.html §01).
  selectedKinds?: Set<HighlightColor>,
): { nodes: Node[]; edges: Edge[]; rows: RowBand[] } {
  const filtering = Boolean(selectedKinds && selectedKinds.size > 0);
  const isDimmed = (chat: Chat, isRoot: boolean) =>
    filtering && !isRoot && !(chat.highlight_color && selectedKinds!.has(chat.highlight_color));
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const posMap: Record<string, { x: number; y: number }> = {};
  // y of the horizontal trunk below each node's row — the edge to a child runs
  // through its PARENT's lane, so the whole fork shares one line.
  const laneMap: Record<string, number> = {};
  const sizeMap: Record<string, { w: number; h: number }> = {};

  const roots = chats.filter(c => !c.parent_id);

  // Pass 1 — how wide and how tall is every card, how many cards stand in each
  // row, and what is the tallest of them. A row only becomes a band once the
  // tallest card in it is known.
  const rowCount: number[] = [];
  const rowCardHeight: number[] = [];
  const measure = (chat: Chat, depth: number) => {
    const isRoot = depth === 0;
    sizeMap[chat.id] = { w: isRoot ? ROOT_WIDTH : NODE_WIDTH, h: estimateHeight(chat, isRoot) };
    rowCount[depth] = (rowCount[depth] ?? 0) + 1;
    rowCardHeight[depth] = Math.max(rowCardHeight[depth] ?? 0, sizeMap[chat.id].h);
    (chat.children || []).forEach(child => measure(child, depth + 1));
  };
  roots.forEach(root => measure(root, 0));

  // Pass 2 — stack the bands. A row of STAGGER_FROM cards or more is laid out
  // as two half-rows and therefore needs a band of two card heights.
  const halves = rowCount.map(count => (count >= STAGGER_FROM ? 2 : 1));
  const rowTop: number[] = [];
  const rowBand: number[] = [];
  let bandY = 0;
  rowCardHeight.forEach((height, depth) => {
    rowBand[depth] = height * halves[depth] + SUB_GAP * (halves[depth] - 1);
    rowTop[depth] = bandY;
    bandY += rowBand[depth] + ROW_GAP;
  });

  // Pass 3 — x from a counter PER ROW, handed out in tree order (post-order,
  // so a subtree is placed before its parent). A parent is centered over its
  // children but never moves back behind its row counter: that keeps the order
  // of every row identical to the order of the branches, which is what makes
  // the tree planar — sibling subtrees cannot interleave, so no two edges can
  // cross either.
  const cursor: number[] = [];
  const placedInRow: number[] = [];
  const place = (chat: Chat, depth: number) => {
    const size = sizeMap[chat.id];
    const children = chat.children || [];
    children.forEach(child => place(child, depth + 1));

    // cursor is undefined for the FIRST card of a row: there is no left
    // neighbour to keep clear of, so centering must be allowed to move it into
    // negative x. Clamping it at 0 instead pushed a wide root off-center above
    // its own single child (found by the chain test 2026-08-04).
    const minX = cursor[depth];
    let x = minX ?? 0;
    if (children.length > 0) {
      const first = posMap[children[0].id];
      const lastChild = children[children.length - 1];
      const last = posMap[lastChild.id];
      const childrenCenter = (first.x + last.x + sizeMap[lastChild.id].w) / 2;
      const centered = childrenCenter - size.w / 2;
      x = minX == null ? centered : Math.max(minX, centered);
    }

    const index = (placedInRow[depth] = (placedInRow[depth] ?? -1) + 1);
    const half = index % halves[depth];
    posMap[chat.id] = { x, y: rowTop[depth] + half * (rowCardHeight[depth] + SUB_GAP) };
    laneMap[chat.id] = rowTop[depth] + rowBand[depth] + LANE_OFFSET;
    // Half step in a staggered row: two cards of the SAME half then sit a full
    // COL_GAP apart again, and the corridor for the card between them appears
    // on its own.
    cursor[depth] = x + (size.w + COL_GAP) / halves[depth];
  };
  roots.forEach(root => place(root, 0));

  // The stripes behind the tree, and the path that lights up.
  const rows: RowBand[] = rowTop.map((top, depth) => ({
    depth,
    top,
    height: rowBand[depth],
    count: rowCount[depth],
  }));
  const onPath = pathToRoot(roots, activeChatId);

  // Build nodes & edges
  const addNodes = (chat: Chat, depth: number) => {
    const isRoot = depth === 0;
    // Maße direkt am Node-Objekt setzen, damit React Flow sie ab dem ersten
    // Render kennt. Sonst rechnet React Flow mit width/height = 0, die Handles
    // sitzen in der Ecke und der Kantenpfad springt beim ersten Messen.
    const { w: width, h: estimatedHeight } = sizeMap[chat.id];
    const isActive = chat.id === activeChatId;
    nodes.push({
      id: chat.id,
      type: 'chat',
      position: posMap[chat.id] || { x: 0, y: 0 },
      width,
      height: estimatedHeight,
      // Lines leave the bottom and enter the top — without these two the
      // smooth-step path would still be routed left/right.
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      // Der aktive Knoten liegt über seinen Nachbarn, damit sein Ring nicht
      // von überlappenden Karten verdeckt wird (wie in syflo-2).
      zIndex: isActive ? 5 : 0,
      data: {
        title: chat.title,
        // Display fassung: math restored where the model managed it
        // (2026-08-02) — the badge is a label, not a search anchor.
        parentWord: chat.parent_word_display || chat.parent_word,
        preview: chat.preview,
        messageCount: chat.message_count,
        answerCount: chat.answer_count,
        // Highlight kind (color bar) and outcome line — the node's two new
        // carriers of information (design/mockup-mindmap-node-final.html).
        highlightColor: chat.highlight_color ?? null,
        outcome: chat.outcome ?? null,
        dimmed: isDimmed(chat, isRoot),
        isRoot,
        isActive,
      },
    });

    if (chat.parent_id) {
      // Kein stroke/marker inline: Kantenfarbe, -stärke und -stil kommen aus
      // index.css (.syflo-mindmap-pane .react-flow__edge-path), damit sie die
      // Linientinte des aktiven Themes tragen. Pfeilspitzen entfallen wie im
      // Mockup — die Richtung ergibt sich aus dem Baum von oben nach unten.
      edges.push({
        id: `${chat.parent_id}-${chat.id}`,
        source: chat.parent_id,
        target: chat.id,
        label: chat.parent_word_display || chat.parent_word || '',
        labelStyle: { fontSize: '11px', fontWeight: '500' },
        // laneY: the one height at which this parent's trunk runs. Passing it
        // explicitly is what keeps the fork a single line — left to itself the
        // path would bend halfway between the two cards, and for a staggered
        // child that halfway point lies INSIDE the row band, i.e. across the
        // cards of the upper half.
        // An edge fades with the node it leads to — a strong line ending at a
        // barely visible card reads as an error.
        data: {
          clampLines: EDGE_LABEL_CLAMP_LINES,
          dimmed: isDimmed(chat, false),
          laneY: laneMap[chat.parent_id],
          labelWidth: NODE_WIDTH,
        },
        // Lines only, no cards: the whole way from the root to the open branch
        // lights up in the theme's accent. Styling lives in index.css so each
        // theme keeps its own line weight (user decision 2026-08-06,
        // design/mockup-mindmap-rows-path.html §02 variant B).
        className: onPath.has(chat.id) ? 'syflo-map-edge-on-path' : undefined,
        // …and it has to be drawn LAST — see the sort below.
        zIndex: onPath.has(chat.id) ? 1 : 0,
        type: 'tree',
      });
    }

    (chat.children || []).forEach(child => addNodes(child, depth + 1));
  };

  roots.forEach(root => addNodes(root, 0));

  // The lit path goes last. All children of one parent share the same stem and
  // the same stretch of trunk, so the plain siblings painted straight over the
  // lit line and left it in pieces — with 18 siblings on one trunk only a stub
  // stayed colored (user report 2026-08-06). SVG has no z-index, and React
  // Flow keeps every edge in ONE layer regardless of the zIndex field
  // (verified in the running app), so the paint order has to be the array
  // order. Sort is stable, so siblings keep their tree order among themselves.
  edges.sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));

  return { nodes, edges, rows };
}

// True if `chat` or any descendant (at any depth) has the given id.
function containsChat(chat: Chat, chatId: string): boolean {
  if (chat.id === chatId) return true;
  return (chat.children || []).some(c => containsChat(c, chatId));
}

// Find the root chat that contains the given chatId (or is the chatId itself).
// Must search the whole subtree — checking only direct children made the map
// fall back to the first root when a branch two or more levels deep was
// active (bug found 2026-07-28).
export function findRoot(chats: Chat[], chatId: string | null | undefined): Chat | null {
  if (!chatId) return null;
  return chats.find(root => containsChat(root, chatId)) ?? null;
}

// Cards cannot be dragged any more (user decision 2026-08-06), so there are no
// hand-placed positions left to remember: the layout is the single source of
// truth, and only that makes the row bands honest — a dragged card would sit in
// a stripe that no longer belongs to its depth. The old
// `syflo.mindmap-pos*` entries stay in localStorage, unread.

// Selected highlight kinds per tree, in localStorage — switching chats or
// toggling the view must not reset a filter the user set
// (design/mockup-mindmap-lens-final.html §01).
function kindsKey(rootId: string) {
  return `syflo.mindmap-kinds.${rootId}`;
}

function loadSavedKinds(rootId: string | undefined): Set<HighlightColor> {
  if (!rootId) return new Set();
  try {
    const raw = JSON.parse(localStorage.getItem(kindsKey(rootId)) || '[]');
    const valid = Array.isArray(raw)
      ? raw.filter((c): c is HighlightColor => HIGHLIGHT_COLORS.includes(c))
      : [];
    return new Set(valid);
  } catch {
    return new Set();
  }
}

export function MindMap({ chats, activeChatId, onSelect }: Props) {
  // UI-Texte in der App language — re-rendert beim Sprachwechsel mit.
  const S = useStrings().mindMap;
  const { labels } = useLabels();
  // Only show the tree of the currently active chat's root.
  const activeTree = useMemo(() => {
    const root = findRoot(chats, activeChatId);
    return root ? [root] : chats.slice(0, 1); // fallback: first root
  }, [chats, activeChatId]);
  const rootId = activeTree[0]?.id;

  const [selectedKinds, setSelectedKinds] = useState<Set<HighlightColor>>(() => loadSavedKinds(rootId));
  // Switching to another tree loads that tree's own filter.
  useEffect(() => {
    setSelectedKinds(loadSavedKinds(rootId));
  }, [rootId]);

  const persistKinds = (next: Set<HighlightColor>) => {
    setSelectedKinds(next);
    if (!rootId) return;
    try {
      localStorage.setItem(kindsKey(rootId), JSON.stringify([...next]));
    } catch {
      // Storage full or blocked — filtering still works, it just does not
      // survive a reload.
    }
  };

  const toggleKind = (color: HighlightColor) => {
    const next = new Set(selectedKinds);
    if (next.has(color)) next.delete(color);
    else next.add(color);
    persistKinds(next);
  };

  const counts = useMemo(() => countKinds(activeTree), [activeTree]);

  const { nodes: initialNodes, edges: initialEdges, rows: initialRows } = useMemo(
    () => buildLayout(activeTree, activeChatId, selectedKinds),
    [activeTree, activeChatId, selectedKinds]
  );
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [rows, setRows] = useState<RowBand[]>(initialRows);

  useEffect(() => {
    const { nodes: n, edges: e, rows: r } = buildLayout(activeTree, activeChatId, selectedKinds);
    setNodes(n);
    setEdges(e);
    setRows(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTree, activeChatId, selectedKinds]);

  if (chats.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center text-gray-400 text-sm">
        {S.noChats}
      </div>
    );
  }

  const shown = nodes.filter(n => !n.data.dimmed).length - 1; // minus the root

  return (
    // syflo-mindmap-pane: Canvas-Fläche, Punktraster, Kanten und Knoten
    // werden in index.css pro Theme eingefärbt (mockup-mindmap-themes.html).
    <div className="w-full h-full flex flex-col syflo-mindmap-pane">
      <KindFilterBar
        labels={labels}
        counts={counts}
        selected={selectedKinds}
        onToggle={toggleKind}
        onClear={() => persistKinds(new Set())}
        shown={Math.max(0, shown)}
      />
      <div className="flex-1 min-h-0">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) => onSelect(node.id)}
        // Karten stehen fest (Nutzerentscheidung 2026-08-06). Der Baum ist die
        // einzige Quelle der Positionen — nur so bleibt jede Karte in dem
        // Streifen, der ihrer Tiefe gehört. Verschieben bleibt möglich, indem
        // man die Fläche zieht; nur die Karte selbst hängt nicht mehr am Zeiger.
        nodesDraggable={false}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        // React Flow's default floor is 0.5, and fitView never goes below it —
        // with the PDF open the map panel is ~320 px high, so a tree that is
        // 1000 px tall was cut off at the top and the root sat outside the
        // view (found in the running app 2026-08-04).
        minZoom={0.12}
      >
        {/* Ebenen-Streifen: jede zweite Tiefe getönt, hinter Kanten und Karten
            (design/mockup-mindmap-rows-path.html §01, Variante A). */}
        <RowBands rows={rows} />
        {/* Punktfarbe als CSS-Variable, damit sie dem Theme folgt (SVG-fill akzeptiert var()) */}
        <Background color="var(--syflo-map-dots)" gap={20} />
        <Controls />
      </ReactFlow>
      </div>
    </div>
  );
}
