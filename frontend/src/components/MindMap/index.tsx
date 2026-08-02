import { useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  getStraightPath,
  useInternalNode,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type EdgeProps,
  type InternalNode,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { CornerDownRight, MessageSquare, Home } from 'lucide-react';
import { InlineMarkdown } from '../ChatArea/InlineMarkdown';
import { MathText, hasMath, plainMathText } from '../MathText';
import { useStrings } from '../../strings';
import type { Chat } from '../../types';

// Returns the half-width/half-height of a node. Falls back to the
// dimensions configured on the node object when the ResizeObserver
// hasn't measured the DOM yet — without this fallback, custom-typed
// nodes render their first frame with measured.width === undefined,
// which collapses every floating edge to a zero-length path
// (invisible line).
function nodeHalfSize(n: InternalNode) {
  const w = (n.measured?.width ?? n.width ?? 200) / 2;
  const h = (n.measured?.height ?? n.height ?? 80) / 2;
  return { w, h };
}

// Where a line from outerNode's center to innerNode's center crosses
// innerNode's rectangular border. Lets edges terminate at the bubble edge
// instead of the center, so arrowheads stay visible outside the node.
function getNodeIntersection(innerNode: InternalNode, outerNode: InternalNode) {
  const ip = innerNode.internals.positionAbsolute;
  const op = outerNode.internals.positionAbsolute;
  const { w, h } = nodeHalfSize(innerNode);
  const { w: ow, h: oh } = nodeHalfSize(outerNode);

  const x2 = ip.x + w;
  const y2 = ip.y + h;
  const x1 = op.x + ow;
  const y1 = op.y + oh;

  const xx1 = (x1 - x2) / (2 * w) - (y1 - y2) / (2 * h);
  const yy1 = (x1 - x2) / (2 * w) + (y1 - y2) / (2 * h);
  const a = 1 / (Math.abs(xx1) + Math.abs(yy1) || 1);
  const xx3 = a * xx1;
  const yy3 = a * yy1;
  return {
    x: w * (xx3 + yy3) + x2,
    y: h * (-xx3 + yy3) + y2,
  };
}

function FloatingEdge({ id, source, target, markerEnd, style, label, labelStyle }: EdgeProps) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  // Kompakt vs. voll: Labels sind oft ganze markierte Sätze. Zusammengeklappt
  // (eine Zeile, Ellipse) kollidieren sie nicht; beim Hover klappt das Label
  // mehrzeilig auf — gleiche Geste wie die Knoten-Vorschau.
  const [hovered, setHovered] = useState(false);

  if (!sourceNode || !targetNode) return null;

  const sp = getNodeIntersection(sourceNode, targetNode);
  const tp = getNodeIntersection(targetNode, sourceNode);

  const [edgePath, labelX, labelY] = getStraightPath({
    sourceX: sp.x,
    sourceY: sp.y,
    targetX: tp.x,
    targetY: tp.y,
  });

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      {label != null && label !== '' && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan syflo-map-edge-label"
            data-testid="mindmap-edge-label"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              padding: '2px 6px',
              borderRadius: '4px',
              pointerEvents: 'all',
              // Branch words can be whole selected sentences from a PDF.
              // Without a cap the label renders as one enormous unwrapped
              // line that collides with every node it crosses. Collapsed:
              // one clipped line. Hovered: the full text, wrapped, floating
              // above nodes and other labels.
              ...(hovered
                ? {
                    maxWidth: 280,
                    whiteSpace: 'normal',
                    overflowWrap: 'break-word',
                    zIndex: 1000,
                    boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
                  }
                : {
                    maxWidth: 180,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
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

const edgeTypes = { floating: FloatingEdge };

// Inhalt eines Mindmap-Knotens. Zeigt den Verzweigungsanlass, den Titel
// und einen Auszug aus der ersten Nutzer-Frage — beim Hover wird der
// Auszug nicht mehr gekürzt, damit man den vollen Text sehen kann.
interface ChatNodeData {
  title: string;
  parentWord?: string | null;
  preview?: string | null;
  messageCount?: number;
  isRoot: boolean;
  isActive: boolean;
}

// Titel-Kürzung: Ein Klick auf den Knoten springt ohnehin an die Stelle im
// Chat — der Knoten muss den Text also nicht komplett zeigen. Ohne Clamp
// sprengen Branch-Titel aus langen Markierungen („About: <ganzer Absatz>")
// die Karte (Nutzerkorrektur 2026-07-22).
const TITLE_CLAMP_LINES = 3;

function ChatNodeView({ data }: NodeProps) {
  // UI-Texte in der App language — re-rendert beim Sprachwechsel mit.
  const S = useStrings().mindMap;
  const { title, parentWord, preview, messageCount, isRoot, isActive } =
    data as unknown as ChatNodeData;
  const [hovered, setHovered] = useState(false);

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
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`relative transition-all duration-150 syflo-map-node${isRoot ? ' syflo-map-node-root' : ''}`}
      style={{
        width: isRoot ? 360 : 220,
        padding: isRoot ? '22px 26px' : '12px 14px',
        transform: hovered ? 'scale(1.03)' : 'scale(1)',
      }}
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

      {/* Verzweigungs-Badge: das Wort, durch das dieser Chat entstanden ist */}
      {parentWord && (
        <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider opacity-80 mb-1">
          <CornerDownRight size={10} />
          <span className={hasMath(parentWord) ? 'syflo-math-fade' : 'truncate'}><InlineMarkdown text={parentWord} /></span>
        </div>
      )}

      {/* Titel — geklammert auf TITLE_CLAMP_LINES Zeilen; der volle Text
          steht als natives Tooltip zur Verfügung. */}
      <div
        className="font-semibold leading-tight break-words"
        style={titleStyle}
        title={plainMathText(title)}
        data-testid="mindmap-node-title"
      >
        <MathText text={title} />
      </div>

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

interface Props {
  chats: Chat[];
  activeChatId?: string | null;
  onSelect: (id: string) => void;
}

// Radial layout: root sits at the origin, children radiate outward. Each
// non-root parent fans its children in an arc centered on its own outward
// direction, so a subtree always extends *away* from the center — never back
// toward it and never collapsed onto a single ray.
// Radius zwischen Tiefenebenen. Vergrößert gegenüber dem ursprünglichen Wert,
// damit die jetzt größeren, mehrzeiligen Knoten nicht überlappen.
const RADIUS_STEP = 360;
// Maximum angular spread for a non-root parent's children. Prevents single-
// child chains from collapsing onto one straight line: even with one child,
// a small offset is applied so descendants curve outward instead of stacking.
const MAX_FAN = (Math.PI * 2) / 3; // 120°

export function buildLayout(
  chats: Chat[],
  activeChatId?: string | null
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const posMap: Record<string, { x: number; y: number }> = {};

  const roots = chats.filter(c => !c.parent_id);

  // myAngle: the polar angle from the origin to this node.
  // mySlice: the angular range this node's subtree is allowed to occupy.
  const placeSubtree = (chat: Chat, depth: number, myAngle: number, mySlice: number) => {
    if (depth === 0) {
      posMap[chat.id] = { x: 0, y: 0 };
    } else {
      const radius = depth * RADIUS_STEP;
      posMap[chat.id] = {
        x: Math.cos(myAngle) * radius,
        y: Math.sin(myAngle) * radius,
      };
    }

    const children = chat.children || [];
    if (children.length === 0) return;

    let fanWidth: number;
    let fanCenter: number;

    if (depth === 0) {
      // Root: distribute children around the full circle.
      fanWidth = Math.PI * 2;
      // Start from the top (-π/2 in screen coords) so the first child sits
      // above the root rather than to its left.
      fanCenter = -Math.PI / 2 + Math.PI;
    } else {
      // Non-root: fan children in an arc on the *outward* side of this node,
      // centered on its own outward direction. Cap the arc so children stay
      // close to the parent's direction even when the inherited slice is huge.
      fanWidth = Math.min(mySlice, MAX_FAN);
      fanCenter = myAngle;
    }

    // For a single child, place it slightly offset from the parent's outward
    // direction (perpendicular nudge) so chains of singletons curve instead
    // of collapsing into one straight ray.
    if (children.length === 1 && depth > 0) {
      const offset = MAX_FAN / 6; // ~20°
      const childAngle = fanCenter + (depth % 2 === 0 ? offset : -offset);
      placeSubtree(children[0], depth + 1, childAngle, fanWidth);
      return;
    }

    const start = fanCenter - fanWidth / 2;
    const childSlice = fanWidth / children.length;
    children.forEach((child, i) => {
      const childAngle = start + childSlice * (i + 0.5);
      placeSubtree(child, depth + 1, childAngle, childSlice);
    });
  };

  roots.forEach(root => placeSubtree(root, 0, 0, Math.PI * 2));

  // Build nodes & edges
  const addNodes = (chat: Chat, depth: number) => {
    const isRoot = depth === 0;
    // Maße direkt am Node-Objekt setzen, damit React Flow sie ab dem ersten
    // Render kennt. Sonst rechnet FloatingEdge mit width/height = 0 und der
    // Edge-Pfad kollabiert zu Länge 0 → unsichtbare Linie.
    const width = isRoot ? 360 : 220;
    // Titelhöhe: grob Zeichen pro Zeile schätzen, gedeckelt durch das
    // Line-Clamp der Node-Ansicht — lange Titel machen den Knoten sonst
    // in der Schätzung endlos hoch und die Edge-Anker wandern weg.
    const charsPerLine = isRoot ? 26 : 30;
    // Plain length: raw $…$ LaTeX inflates the character count far beyond
    // what KaTeX actually renders.
    const titleLines = Math.min(TITLE_CLAMP_LINES, Math.max(1, Math.ceil(plainMathText(chat.title).length / charsPerLine)));
    const titleHeight = (isRoot ? 32 : 22) + (titleLines - 1) * (isRoot ? 26 : 16);
    const estimatedHeight = (isRoot ? 22 : 0) + (chat.parent_word ? 18 : 0) + titleHeight + (chat.preview ? 36 : 0) + ((chat.message_count ?? 0) > 0 ? 18 : 0) + (isRoot ? 44 : 24);
    const isActive = chat.id === activeChatId;
    nodes.push({
      id: chat.id,
      type: 'chat',
      position: posMap[chat.id] || { x: 0, y: 0 },
      width,
      height: estimatedHeight,
      // Der aktive Knoten liegt über seinen Nachbarn, damit sein Ring nicht
      // von überlappenden Karten verdeckt wird (wie in syflo-2).
      zIndex: isActive ? 5 : 0,
      data: {
        title: chat.title,
        parentWord: chat.parent_word,
        preview: chat.preview,
        messageCount: chat.message_count,
        isRoot,
        isActive,
      },
    });

    if (chat.parent_id) {
      // Kein stroke/marker inline: Kantenfarbe, -stärke und -stil kommen aus
      // index.css (.syflo-mindmap-pane .react-flow__edge-path), damit sie die
      // Linientinte des aktiven Themes tragen. Pfeilspitzen entfallen wie im
      // Mockup — die Richtung ergibt sich aus dem radialen Layout.
      edges.push({
        id: `${chat.parent_id}-${chat.id}`,
        source: chat.parent_id,
        target: chat.id,
        label: chat.parent_word || '',
        labelStyle: { fontSize: '11px', fontWeight: '500' },
        type: 'floating',
      });
    }

    (chat.children || []).forEach(child => addNodes(child, depth + 1));
  };

  roots.forEach(root => addNodes(root, 0));
  return { nodes, edges };
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

// Manuell verschobene Knoten-Positionen, pro Baum in localStorage — damit
// eine per Drag zurechtgelegte Map Chat-Wechsel, View-Toggles und Reloads
// überlebt (das Layout-Rebuild setzte sonst jede Verschiebung zurück).
function positionsKey(rootId: string) {
  return `syflo.mindmap-pos.${rootId}`;
}

function loadSavedPositions(rootId: string | undefined): Record<string, { x: number; y: number }> {
  if (!rootId) return {};
  try {
    return JSON.parse(localStorage.getItem(positionsKey(rootId)) || '{}');
  } catch {
    return {};
  }
}

export function MindMap({ chats, activeChatId, onSelect }: Props) {
  // UI-Texte in der App language — re-rendert beim Sprachwechsel mit.
  const S = useStrings().mindMap;
  // Only show the tree of the currently active chat's root.
  const activeTree = useMemo(() => {
    const root = findRoot(chats, activeChatId);
    return root ? [root] : chats.slice(0, 1); // fallback: first root
  }, [chats, activeChatId]);
  const rootId = activeTree[0]?.id;

  // Radiales Layout, überlagert mit den gespeicherten manuellen Positionen.
  const applySaved = (n: Node[]): Node[] => {
    const saved = loadSavedPositions(rootId);
    return n.map(node => (saved[node.id] ? { ...node, position: saved[node.id] } : node));
  };

  const { nodes: initialNodes, edges: initialEdges } = useMemo(
    () => buildLayout(activeTree, activeChatId),
    [activeTree, activeChatId]
  );
  const [nodes, setNodes, onNodesChange] = useNodesState(applySaved(initialNodes));
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  useEffect(() => {
    const { nodes: n, edges: e } = buildLayout(activeTree, activeChatId);
    setNodes(applySaved(n));
    setEdges(e);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTree, activeChatId]);

  // Nach jedem Drag die neue Position merken.
  const handleNodeDragStop = (_: unknown, node: Node) => {
    if (!rootId) return;
    const saved = loadSavedPositions(rootId);
    saved[node.id] = { x: node.position.x, y: node.position.y };
    try {
      localStorage.setItem(positionsKey(rootId), JSON.stringify(saved));
    } catch {
      // localStorage voll/gesperrt — Verschieben funktioniert trotzdem,
      // nur eben nicht über Reloads hinweg.
    }
  };

  if (chats.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center text-gray-400 text-sm">
        {S.noChats}
      </div>
    );
  }

  return (
    // syflo-mindmap-pane: Canvas-Fläche, Punktraster, Kanten und Knoten
    // werden in index.css pro Theme eingefärbt (mockup-mindmap-themes.html).
    <div className="w-full h-full syflo-mindmap-pane">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) => onSelect(node.id)}
        onNodeDragStop={handleNodeDragStop}
        fitView
        fitViewOptions={{ padding: 0.3 }}
      >
        {/* Punktfarbe als CSS-Variable, damit sie dem Theme folgt (SVG-fill akzeptiert var()) */}
        <Background color="var(--syflo-map-dots)" gap={20} />
        <Controls />
      </ReactFlow>
    </div>
  );
}
