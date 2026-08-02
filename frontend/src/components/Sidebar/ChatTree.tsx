/**
 * components/Sidebar/ChatTree.tsx
 *
 * Recursively renders the chat hierarchy as an indented tree.
 * Used in the expanded sidebar view to show a root chat and all its children.
 *
 * Interactions:
 * - Click a node to open that chat in the main area
 * - Click the chevron to expand / collapse children
 * - Right-click to open the context menu (rename / delete)
 * - Hover to see the full title in a native tooltip
 * - When a node is being renamed, its title is replaced by an inline input
 */

import { useState, useEffect, useRef } from 'react';
import { ChevronRight, ChevronDown, Clock, FileText, TvMinimalPlay } from 'lucide-react';
import { useStrings } from '../../strings';
import { MathText, hasMath, plainMathText } from '../MathText';
import type { Chat } from '../../types';

interface Props {
  chats: Chat[];
  activeChatId: string | null;
  renamingId: string | null;
  onSelect: (id: string) => void;
  onContextMenu: (id: string, x: number, y: number) => void;
  onRenameSubmit: (id: string, title: string) => void;
  onRenameCancel: () => void;
  // Chats, in denen gerade eine Antwort im Hintergrund generiert wird —
  // ihre Zeilen zeigen die kleinen animierten Punkte.
  streamingChatIds?: Set<string>;
  // Chats, deren Fragen noch in der Backend-Warteschlange stehen (FIFO,
  // ein Ollama-Slot) — ihre Zeilen zeigen die kleine Uhr statt der Punkte.
  queuedChatIds?: Set<string>;
  // Ids auf dem Pfad von der Wurzel zum aktiven Chat (inklusive des aktiven
  // Chats selbst) — die Trunk/Elbow-Segmente, die zu einem dieser Ids
  // hinführen, werden eingefärbt (design/mockup-tree-path-highlight.html,
  // Variante B).
  activePathIds?: Set<string>;
}

// Connector-line thickness that is always a whole number of device pixels.
// A plain 1px line at a fractional zoom factor (Cmd +/- makes
// devicePixelRatio e.g. 2.2) paints as 2 device pixels in some places and 3
// in others depending on where it lands, so the tree lines look thicker in
// spots. floor(dpr)/dpr CSS pixels snap every segment to the same width —
// flooring (not rounding) picks the thinner of the two candidate widths, so
// the lines never get bulkier than at 100% zoom (user correction 2026-07-29).
function hairlinePx(): number {
  const dpr = window.devicePixelRatio || 1;
  return Math.max(1, Math.floor(dpr)) / dpr;
}

// Zoom changes devicePixelRatio and fires a window resize — recompute then.
function useHairline(): number {
  const [px, setPx] = useState(hairlinePx);
  useEffect(() => {
    const update = () => setPx(hairlinePx());
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return px;
}

// Drei hüpfende Mini-Punkte (kompakte Variante der Chat-Ladepunkte) — zeigt
// in der Sidebar an, dass dieser Chat gerade eine Antwort generiert.
export function StreamingDots() {
  const S = useStrings().sidebar;
  return (
    <span
      className="syflo-typing syflo-typing-sm shrink-0"
      role="status"
      aria-label={S.responseInProgress}
      data-testid="sidebar-streaming-dots"
    >
      <span className="syflo-typing-dot" />
      <span className="syflo-typing-dot" />
      <span className="syflo-typing-dot" />
    </span>
  );
}

// Kleine Uhr — die Frage dieses Chats wartet noch in der Warteschlange auf
// den Ollama-Slot (Gegenstück zu StreamingDots fürs Generieren).
export function QueuedClock() {
  const S = useStrings().sidebar;
  return (
    <span
      className="shrink-0 text-gray-400"
      role="status"
      aria-label={S.queuedInQueue}
      title={S.queuedInQueue}
      data-testid="sidebar-queued-clock"
    >
      <Clock size={12} />
    </span>
  );
}

function TreeNode({ chat, activeChatId, renamingId, onSelect, onContextMenu, onRenameSubmit, onRenameCancel, streamingChatIds, queuedChatIds, activePathIds }: {
  chat: Chat;
  activeChatId: string | null;
  renamingId: string | null;
  onSelect: (id: string) => void;
  onContextMenu: (id: string, x: number, y: number) => void;
  onRenameSubmit: (id: string, title: string) => void;
  onRenameCancel: () => void;
  streamingChatIds?: Set<string>;
  queuedChatIds?: Set<string>;
  activePathIds?: Set<string>;
}) {
  const [expanded, setExpanded] = useState(true);
  const hairline = useHairline();
  const hasChildren = chat.children && chat.children.length > 0;
  const isActive = chat.id === activeChatId;
  const isRenaming = chat.id === renamingId;

  // At most one child can sit on the path to the active chat — index of that
  // child, or -1. The colored run below only reaches down to that child's
  // elbow; see the connector block for why the rest must stay neutral.
  const pathChildIndex = activePathIds && hasChildren
    ? chat.children!.findIndex(c => activePathIds.has(c.id))
    : -1;

  return (
    <div>
      {/* Chat row.
          relative + z-[1] lifts the row above the connector spans, which are
          absolutely positioned siblings and would otherwise paint on top of
          it: the elbow reaches 6px past the row's left edge and drew a line
          straight into the selected (or hovered) pill. Stacked this way the
          line simply ends at the pill instead (user report 2026-08-01) —
          rows without a background still show the full elbow as before. */}
      <div
        className={`relative z-[1] flex items-center gap-2 px-2.5 py-1.5 mb-0.5 rounded-md cursor-pointer transition-colors text-sm ${
          isActive
            ? 'bg-blue-50 text-blue-700'
            : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'
        }`}
        onClick={() => !isRenaming && onSelect(chat.id)}
        onContextMenu={e => {
          e.preventDefault();
          onContextMenu(chat.id, e.clientX, e.clientY);
        }}
        title={isRenaming ? undefined : plainMathText(chat.title)}
      >
        {/* Expand/collapse chevron — only for nodes that have children.
            A leaf gets NO placeholder: the reserved 13px slot left an empty
            gap inside the row's pill, so leaf titles now start at the row's
            own padding instead (user request 2026-08-01). Titles of leaves and
            of parents therefore no longer align — that is the intent. */}
        {hasChildren && (
          <button
            onClick={e => { e.stopPropagation(); setExpanded(!expanded); }}
            className="shrink-0 text-gray-400 hover:text-gray-700"
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        )}

        {/* Chat title — replaced by an inline input while this row is being renamed */}
        {isRenaming ? (
          <RenameInput
            initial={chat.title}
            onSubmit={title => onRenameSubmit(chat.id, title)}
            onCancel={onRenameCancel}
          />
        ) : (
          // leading-[18px] statt line-height:normal (≈18,56px bei 13px Schrift):
          // sonst ist die Zeilenhöhe nicht ganzzahlig (32,5625px) und die
          // 1-px-Baumlinien darunter rutschen pro Zeile auf andere Subpixel —
          // manche Linien wirkten dadurch dicker (Nutzer-Screenshot 2026-07-23).
          <span className={`flex-1 text-[13px] leading-[18px] ${hasMath(chat.title) ? 'syflo-math-fade' : 'truncate'}`}><MathText text={chat.title} /></span>
        )}

        {/* Laufende Hintergrund-Antwort (Punkte) oder wartende Frage (Uhr) */}
        {!isRenaming && streamingChatIds?.has(chat.id) && <StreamingDots />}
        {!isRenaming && !streamingChatIds?.has(chat.id) && queuedChatIds?.has(chat.id) && <QueuedClock />}

        {/* PDF tag on the root of a tree with a bound paper
            (design/mockup-pdf-layout.html, ADR-0002).
            leading-[14px] auf den Chips: ohne feste Zeilenhöhe war der
            10-px-Text 14,28 px hoch → Chip 18,28 px → Root-Zeile krumm →
            alle Baumlinien darunter auf Subpixeln; je nach Rundung wirkten
            tiefere Linien dicker (Nutzer-Screenshot 2026-07-24). Gleiche
            Fehlerklasse wie leading-[18px] beim Titel oben. */}
        {!isRenaming && chat.paper_id && (
          <span
            className="ml-auto shrink-0 inline-flex items-center gap-[3px] text-[10px] leading-[14px] font-semibold tracking-wide text-gray-500 bg-gray-50 border border-gray-200 rounded-[5px] px-1.5 py-px"
            data-testid="tree-pdf-tag"
          >
            <FileText size={9} />
            PDF
          </span>
        )}

        {/* YT tag on the root of a tree with a bound YouTube transcript
            (design/mockup-youtube-transcript.html, ADR-0005) */}
        {!isRenaming && chat.video_id && (
          <span
            className="ml-auto shrink-0 inline-flex items-center gap-[3px] text-[10px] leading-[14px] font-semibold tracking-wide text-gray-500 bg-gray-50 border border-gray-200 rounded-[5px] px-1.5 py-px"
            data-testid="tree-yt-tag"
          >
            <TvMinimalPlay size={9} />
            YT
          </span>
        )}
      </div>

      {/* Recursively render child chats when expanded.
          Connector lines (design/mockup-paper-view.html): each child row gets a
          horizontal elbow back to a vertical trunk under the parent. The trunk
          segment is anchored per child wrapper — full height for non-last
          siblings (spans their subtree), stopping at the row middle for the
          last sibling so no line dangles below it. */}
      {hasChildren && expanded && (
        <div className="relative pl-[22px]">
          {chat.children!.map((child, i) => {
            const isLast = i === chat.children!.length - 1;
            // Highlight of the connector that links the active chat back to
            // this row (design/mockup-tree-path-highlight.html, variant B).
            // A trunk segment is anchored in a child's wrapper but belongs to
            // the PARENT's spine: for a non-last sibling it spans that child's
            // whole subtree so the following siblings can hang off it. So the
            // run that actually leads to the on-path child is: every earlier
            // sibling's trunk in full, plus the on-path child's own trunk down
            // to its elbow. Everything below that elbow serves the later
            // siblings and must keep the neutral color — coloring it painted a
            // green line past unrelated rows (user report 2026-08-01).
            const isPathChild = i === pathChildIndex;
            const carriesPath = pathChildIndex !== -1 && i <= pathChildIndex;
            const pathWidth = hairline * 2;
            return (
              <div key={child.id} className="relative" data-testid="tree-child">
                {isPathChild && !isLast ? (
                  <>
                    <span
                      data-testid="tree-trunk-path"
                      className="absolute pointer-events-none bg-blue-400"
                      style={{ left: -8, top: -2, height: 18, width: pathWidth }}
                    />
                    <span
                      data-testid="tree-trunk"
                      className="absolute pointer-events-none bg-slate-300"
                      style={{ left: -8, top: 16, bottom: 0, width: hairline }}
                    />
                  </>
                ) : (
                  <span
                    data-testid={isLast ? 'tree-trunk-end' : 'tree-trunk'}
                    className={`absolute pointer-events-none ${carriesPath ? 'bg-blue-400' : 'bg-slate-300'}`}
                    style={
                      isLast
                        ? { left: -8, top: -2, height: 18, width: carriesPath ? pathWidth : hairline }
                        : { left: -8, top: -2, bottom: 0, width: carriesPath ? pathWidth : hairline }
                    }
                  />
                )}
                {/* Only the on-path child's elbow turns — an earlier sibling
                    carries the vertical run but its own row is off the path. */}
                <span
                  data-testid="tree-elbow"
                  className={`absolute pointer-events-none ${isPathChild ? 'bg-blue-400' : 'bg-slate-300'}`}
                  style={{ left: -8, top: 16, width: 14, height: isPathChild ? pathWidth : hairline }}
                />
                <TreeNode
                  chat={child}
                  activeChatId={activeChatId}
                  renamingId={renamingId}
                  onSelect={onSelect}
                  onContextMenu={onContextMenu}
                  onRenameSubmit={onRenameSubmit}
                  onRenameCancel={onRenameCancel}
                  streamingChatIds={streamingChatIds}
                  queuedChatIds={queuedChatIds}
                  activePathIds={activePathIds}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Inline editor used both in ChatTree and the flat root list. Lives here because
// both lists mount it the same way; extracting it would just add an import.
export function RenameInput({ initial, onSubmit, onCancel }: {
  initial: string;
  onSubmit: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== initial) onSubmit(trimmed);
    else onCancel();
  };

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={e => setValue(e.target.value)}
      onClick={e => e.stopPropagation()}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      }}
      onBlur={commit}
      className="flex-1 min-w-0 bg-white border border-blue-400 rounded px-1.5 py-0.5 text-[13px] text-gray-900 outline-none focus:ring-1 focus:ring-blue-400"
    />
  );
}

export function ChatTree({ chats, activeChatId, renamingId, onSelect, onContextMenu, onRenameSubmit, onRenameCancel, streamingChatIds, queuedChatIds, activePathIds }: Props) {
  return (
    <div>
      {chats.map(chat => (
        <TreeNode
          key={chat.id}
          chat={chat}
          activeChatId={activeChatId}
          renamingId={renamingId}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
          onRenameSubmit={onRenameSubmit}
          onRenameCancel={onRenameCancel}
          streamingChatIds={streamingChatIds}
          queuedChatIds={queuedChatIds}
          activePathIds={activePathIds}
        />
      ))}
    </div>
  );
}
