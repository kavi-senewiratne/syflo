/**
 * components/Sidebar/index.tsx
 *
 * Two-level navigation sidebar with a white background.
 *
 * Default view: all root chats, grouped into relative date sections
 * ("Today", "Yesterday", "This week", …) by created_at.
 * Expanded view: back button + one root chat with all its children.
 *
 * Clicking a root chat expands it and opens it in the chat area.
 * The "← All chats" button returns to the flat root list.
 *
 * Right-clicking any chat opens a context menu with rename / delete options.
 * Hovering shows the full chat title as a native tooltip.
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import { SquarePen, GitBranch, ArrowLeft, Pencil, Trash2, FileText, PanelLeftClose, PanelLeftOpen, Settings as SettingsIcon, TvMinimalPlay, MessageSquarePlus } from 'lucide-react';
import { ChatTree, QueuedClock, RenameInput, StreamingDots } from './ChatTree';
import { groupChatsByDate } from './groupChatsByDate';
import { MathText, hasMath, plainMathText } from '../MathText';
import { useStrings } from '../../strings';
import { Logo } from '../Logo';
import type { SettingsTab } from '../SettingsModal';
import type { Chat } from '../../types';

// Recursively look up a chat by id so the delete confirmation can show its title.
function findChatById(chats: Chat[], id: string): Chat | null {
  for (const c of chats) {
    if (c.id === id) return c;
    if (c.children) {
      const inChildren = findChatById(c.children, id);
      if (inChildren) return inChildren;
    }
  }
  return null;
}

// Ids from the root down to `id` (inclusive) — used to color the tree
// connectors that trace the active chat back to its root
// (design/mockup-tree-path-highlight.html, variant B).
function findPathToId(chats: Chat[], id: string): string[] | null {
  for (const c of chats) {
    if (c.id === id) return [c.id];
    if (c.children) {
      const sub = findPathToId(c.children, id);
      if (sub) return [c.id, ...sub];
    }
  }
  return null;
}

interface ContextMenuState {
  chatId: string;
  x: number;
  y: number;
}

interface Props {
  chats: Chat[];
  activeChatId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  // May be async — returns a Promise so the sidebar can await it and surface
  // any failure (e.g. backend unreachable) in the confirmation modal.
  onDelete: (id: string) => void | Promise<void>;
  onRename: (id: string, title: string) => void;
  viewMode: 'chat' | 'mindmap';
  onToggleView: () => void;
  // Öffnet das (App-eigene) Settings-Modal auf dem gewünschten Tab. Das
  // aktive Modell zeigt die Composer-Pille — die Sidebar hat keine
  // Modell-Box mehr (mockup-model-picker.html, Sektion 01).
  onOpenSettings: (tab: SettingsTab) => void;
  // Öffnet den Feedback-Dialog (ADR-0010) — Button in der Rail und im
  // ausgeklappten Footer, direkt über dem Settings-Zahnrad.
  onOpenFeedback: () => void;
  // Whether the sidebar is collapsed to a slim rail, plus the toggle.
  collapsed: boolean;
  onToggleCollapsed: () => void;
  // Chats mit laufender Hintergrund-Antwort — ihre Zeilen (bzw. in der
  // Root-Liste der Baum, der sie enthält) zeigen die animierten Punkte.
  streamingChatIds?: Set<string>;
  // Chats, deren Fragen in der Backend-Warteschlange warten — kleine Uhr
  // statt der Punkte (FIFO über alle Chats, ein Ollama-Slot).
  queuedChatIds?: Set<string>;
}

// Streamt dieser Chat oder irgendein Nachfahre? (Root-Liste zeigt nur Roots.)
function subtreeStreams(chat: Chat, ids?: Set<string>): boolean {
  if (!ids || ids.size === 0) return false;
  if (ids.has(chat.id)) return true;
  return (chat.children ?? []).some(c => subtreeStreams(c, ids));
}

export function Sidebar({ chats, activeChatId, onSelect, onNewChat, onDelete, onRename, viewMode, onToggleView, onOpenSettings, onOpenFeedback, collapsed, onToggleCollapsed, streamingChatIds, queuedChatIds }: Props) {
  // UI-Texte in der App language — re-rendert beim Sprachwechsel mit.
  const S = useStrings().sidebar;
  const [expandedRootId, setExpandedRootId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const openSettings = onOpenSettings;

  const expandedRoot = expandedRootId ? chats.find(c => c.id === expandedRootId) ?? null : null;
  const pendingDeleteChat = pendingDeleteId ? findChatById(chats, pendingDeleteId) : null;

  const activePathIds = useMemo(() => {
    if (!activeChatId) return undefined;
    const path = findPathToId(chats, activeChatId);
    return path ? new Set(path) : undefined;
  }, [chats, activeChatId]);

  // Nutzer-Report 2026-07-22: Nach dem Erstellen eines neuen Chats (Root wie
  // Branch) soll die Sidebar direkt dessen Baum zeigen, damit neu erstellte
  // Kinder sofort sichtbar sind. expandedRootId folgt deshalb dem aktiven
  // Chat — aber nur EINMAL pro Chat-Wechsel (lastAutoExpandedFor): Baum-
  // Refreshes (Rename, Streaming-Titel) dürfen ein bewusstes "← All chats"
  // nicht wieder aufklappen. chats bleibt in den Deps, weil ein frisch
  // erstellter Chat erst nach dem Tree-Refetch im Baum auftaucht.
  const lastAutoExpandedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!activeChatId || lastAutoExpandedFor.current === activeChatId) return;
    const root = chats.find(
      (c) => c.id === activeChatId || !!findChatById(c.children ?? [], activeChatId),
    );
    if (root) {
      lastAutoExpandedFor.current = activeChatId;
      setExpandedRootId(root.id);
    }
  }, [activeChatId, chats]);

  // Close the context menu on Escape. Outside clicks are handled by the
  // backdrop element rendered below the menu — that's more reliable than a
  // window listener, which can race with the buttons' own onClick handlers
  // (React stopPropagation doesn't always stop native DOM bubbling).
  useEffect(() => {
    if (!contextMenu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setContextMenu(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [contextMenu]);

  const handleRootClick = (id: string) => {
    setExpandedRootId(id);
    onSelect(id);
  };

  const openContextMenu = (chatId: string, x: number, y: number) =>
    setContextMenu({ chatId, x, y });

  const requestDelete = (id: string) => setPendingDeleteId(id);

  // Await onDelete (which hits the backend) before closing the modal — that
  // way, if the backend call fails, the parent can surface the error and the
  // modal stays open so the user can retry. Closing optimistically used to
  // hide silent fetch failures (e.g. when the dev server was down).
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const confirmDelete = async () => {
    if (!pendingDeleteId) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete(pendingDeleteId);
      setPendingDeleteId(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : S.deleteFailed);
    } finally {
      setDeleting(false);
    }
  };

  const handleRenameSubmit = (id: string, title: string) => {
    onRename(id, title);
    setRenamingId(null);
  };

  // Collapsed rail: a slim strip with only the expand toggle and a new-chat
  // button, so the chat/PDF area gets the full width. Everything else is
  // hidden until the user expands the sidebar again.
  if (collapsed) {
    return (
      <div className="syflo-sidebar w-12 bg-white border-r border-gray-200 flex flex-col items-center py-5 shrink-0">
        <button
          onClick={onToggleCollapsed}
          title={S.expand}
          className="p-2 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors"
        >
          <PanelLeftOpen size={18} />
        </button>
        <button
          onClick={onNewChat}
          title={S.newChat}
          className="mt-2 p-2 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors"
        >
          <SquarePen size={16} />
        </button>
        {/* Feedback + Settings pinned to the bottom of the rail — same entry
            points as the expanded sidebar's bottom-left footer (ADR-0010). */}
        <button
          onClick={onOpenFeedback}
          title={S.feedback}
          aria-label={S.openFeedback}
          className="mt-auto p-2 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors"
        >
          <MessageSquarePlus size={16} />
        </button>
        <button
          onClick={() => openSettings('appearance')}
          title={S.settings}
          aria-label={S.openSettings}
          className="mt-1 p-2 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors"
        >
          <SettingsIcon size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="syflo-sidebar w-64 bg-white border-r border-gray-200 flex flex-col shrink-0">
      {/* Top bar: app name + action icons */}
      <div className="flex items-center justify-between px-5 py-5 border-b border-gray-100">
        <Logo />
        <div className="flex items-center gap-2">
          {/* Collapse the sidebar to a slim rail */}
          <button
            onClick={onToggleCollapsed}
            title={S.collapse}
            className="p-2 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors"
          >
            <PanelLeftClose size={16} />
          </button>
          {/* Mind map toggle — only meaningful with an active chat, so hide on the
              empty "homepage" state and show as soon as a chat is selected. */}
          {activeChatId && (
            <button
              onClick={onToggleView}
              title={viewMode === 'chat' ? S.switchToMindMap : S.switchToChat}
              className={`p-2 rounded-lg transition-colors ${
                viewMode === 'mindmap'
                  ? 'text-blue-600 bg-blue-50'
                  : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100'
              }`}
            >
              <GitBranch size={16} />
            </button>
          )}

          {/* New chat button */}
          <button
            onClick={onNewChat}
            title={S.newChat}
            className="p-2 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors"
          >
            <SquarePen size={16} />
          </button>
        </div>
      </div>

      {/* Right-click context menu (rename / delete). Positioned at cursor.
          An invisible full-screen backdrop sits at z-40 to capture outside
          clicks reliably — the menu itself is at z-50, so its button clicks
          can never hit the backdrop and never race with a window listener. */}
      {contextMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setContextMenu(null)}
            onContextMenu={e => { e.preventDefault(); setContextMenu(null); }}
          />
          <div
            className="fixed z-50 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[140px]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
          <button
            onClick={() => { setRenamingId(contextMenu.chatId); setContextMenu(null); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
          >
            <Pencil size={13} />
            {S.rename}
          </button>
          <button
            onClick={() => { requestDelete(contextMenu.chatId); setContextMenu(null); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
          >
            <Trash2 size={13} />
            {S.delete}
          </button>
          </div>
        </>
      )}

      {/* Delete-confirmation modal */}
      {pendingDeleteChat && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => { if (!deleting) { setPendingDeleteId(null); setDeleteError(null); } }}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-6 pt-6 pb-2">
              <h3 className="text-base font-semibold text-gray-900 mb-1.5">{S.deleteChatTitle}</h3>
              <p className="text-sm text-gray-500 leading-relaxed">
                <MathText text={S.deleteChatBody(pendingDeleteChat.title)} />
              </p>
              {deleteError && (
                <p className="mt-3 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-md border border-red-100">
                  {deleteError}
                </p>
              )}
            </div>
            <div className="flex gap-2 px-6 pb-5 pt-4 justify-end">
              <button
                onClick={() => { setPendingDeleteId(null); setDeleteError(null); }}
                disabled={deleting}
                className="px-4 py-2 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-50"
              >
                {S.cancel}
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleting}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-red-600 hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deleting ? S.deleting : deleteError ? S.retry : S.delete}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Scrollable chat list */}
      <div className="flex-1 overflow-y-auto px-2 pb-6 pt-2">
        {chats.length === 0 ? (
          <p className="text-xs text-gray-400 text-center mt-8 px-4">{S.noChats}</p>
        ) : expandedRoot ? (
          // Expanded view: back button + single root with all children
          <>
            <button
              onClick={() => setExpandedRootId(null)}
              className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-900 px-2.5 py-1.5 mb-2 rounded-md hover:bg-gray-100 transition-colors w-full"
            >
              <ArrowLeft size={13} />
              {S.allChats}
            </button>
            <ChatTree
              chats={[expandedRoot]}
              activeChatId={activeChatId}
              renamingId={renamingId}
              onSelect={onSelect}
              onContextMenu={openContextMenu}
              onRenameSubmit={handleRenameSubmit}
              onRenameCancel={() => setRenamingId(null)}
              streamingChatIds={streamingChatIds}
              queuedChatIds={queuedChatIds}
              activePathIds={activePathIds}
            />
          </>
        ) : (
          // Default view: root chats grouped into relative date sections
          // ("Today", "Yesterday", …) by created_at; children stay hidden.
          groupChatsByDate(chats).map((group, groupIndex) => (
            <div key={group.label}>
              <p
                className={`text-[11px] text-gray-400 font-medium px-2.5 pb-1 uppercase tracking-wider ${
                  groupIndex === 0 ? 'pt-2' : 'pt-5'
                }`}
                data-testid="chat-group-label"
              >
                {S.groups[group.label]}
              </p>
              <div className="space-y-0.5">
                {group.chats.map(chat => {
                  const isActive = chat.id === activeChatId ||
                    !!(chat.children?.some(c => c.id === activeChatId));
                  const isRenaming = chat.id === renamingId;
                  return (
                    <div
                      key={chat.id}
                      onClick={() => !isRenaming && handleRootClick(chat.id)}
                      onContextMenu={e => {
                        e.preventDefault();
                        openContextMenu(chat.id, e.clientX, e.clientY);
                      }}
                      title={isRenaming ? undefined : plainMathText(chat.title)}
                      className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-md cursor-pointer transition-colors ${
                        isActive
                          ? 'bg-blue-50 text-blue-700'
                          : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'
                      }`}
                    >
                      {isRenaming ? (
                        <RenameInput
                          initial={chat.title}
                          onSubmit={title => handleRenameSubmit(chat.id, title)}
                          onCancel={() => setRenamingId(null)}
                        />
                      ) : (
                        <span className={`flex-1 text-[13px] ${hasMath(chat.title) ? 'syflo-math-fade' : 'truncate'}`}><MathText text={chat.title} /></span>
                      )}
                      {/* Laufende Antwort (Punkte) oder wartende Frage (Uhr)
                          in diesem Baum (Root oder Kind) */}
                      {!isRenaming && subtreeStreams(chat, streamingChatIds) && <StreamingDots />}
                      {!isRenaming && !subtreeStreams(chat, streamingChatIds) && subtreeStreams(chat, queuedChatIds) && <QueuedClock />}
                      {/* PDF tag on trees with a bound paper — same badge as on
                          the tree's root node (design/mockup-pdf-layout.html) */}
                      {!isRenaming && chat.paper_id && (
                        <span
                          className="ml-auto shrink-0 inline-flex items-center gap-[3px] text-[10px] leading-[14px] font-semibold tracking-wide text-gray-500 bg-gray-50 border border-gray-200 rounded-[5px] px-1.5 py-px"
                          data-testid="root-list-pdf-tag"
                        >
                          <FileText size={9} />
                          PDF
                        </span>
                      )}
                      {/* YT tag on trees with a bound YouTube transcript
                          (ADR-0005) — same badge style as the PDF tag. */}
                      {!isRenaming && chat.video_id && (
                        <span
                          className="ml-auto shrink-0 inline-flex items-center gap-[3px] text-[10px] leading-[14px] font-semibold tracking-wide text-gray-500 bg-gray-50 border border-gray-200 rounded-[5px] px-1.5 py-px"
                          data-testid="root-list-yt-tag"
                        >
                          <TvMinimalPlay size={9} />
                          YT
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer: nur noch das Zahnrad (mockup-model-picker.html, Sektion 01) —
          das aktive Modell zeigt die Composer-Pille, der Provider-Status lebt
          in deren Menü-Fußzeile. */}
      <div className="border-t border-gray-100 px-3 py-3">
        <button
          onClick={onOpenFeedback}
          title={S.feedback}
          aria-label={S.openFeedback}
          className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs font-medium text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors"
        >
          <MessageSquarePlus size={15} />
          {S.feedback}
        </button>
        <button
          onClick={() => openSettings('appearance')}
          title={S.settings}
          aria-label={S.openSettings}
          className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs font-medium text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors"
        >
          <SettingsIcon size={15} />
          {S.settings}
        </button>
      </div>
    </div>
  );
}
