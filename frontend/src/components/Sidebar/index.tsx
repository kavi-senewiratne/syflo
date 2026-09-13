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
import { SquarePen, GitBranch, ArrowLeft, Pencil, Trash2, FileText, PanelLeftClose, PanelLeftOpen, Settings as SettingsIcon, TvMinimalPlay, MessageSquarePlus, Pin, PinOff, ChevronDown, ChevronRight, Clock, Folder, FolderPlus, MoreHorizontal } from 'lucide-react';
import { ChatTree, QueuedClock, RenameInput, StreamingDots, type CollapseControl } from './ChatTree';
import { groupChatsByDate } from './groupChatsByDate';
import { MathText, hasMath, plainMathText } from '../MathText';
import { overflowTip } from '../../overflowTip';
import { useStrings } from '../../strings';
import { Logo } from '../Logo';
import type { SettingsTab } from '../SettingsModal';
import type { Category, Chat } from '../../types';
import type { ChatGroupLabel } from './groupChatsByDate';

// Date sections of the history that start CLOSED — everything except Today and
// Yesterday (user decision 2026-08-26). Only a default: `COLLAPSE_DEFAULT_FLAG`
// records that it has been applied, so it never overrides what the user opened
// later. The pinned section and the categories are untouched by this.
const DEFAULT_CLOSED_GROUPS: ChatGroupLabel[] = ['This week', 'Last week', 'This month', 'Older'];
const COLLAPSE_DEFAULT_FLAG = 'syflo.sidebarOlderGroupsCollapsed';

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

// The category's own menu — a different object from a chat's, with the
// container's verbs (design/mockup-sidebar-categories-v2.html, §03-B).
interface CategoryMenuState {
  categoryId: string;
  x: number;
  y: number;
}

interface Props {
  chats: Chat[];
  activeChatId: string | null;
  // User-made containers for root chats, one nesting level deep
  // (design/mockup-sidebar-categories-v2.html, decided 2026-08-16). A flat
  // list — parents and children together; the sidebar nests them itself.
  categories: Category[];
  // Resolves to the created category, so a chat waiting on it can be filed
  // straight away — the caller cannot know the id before the backend hands it
  // out. Anything falsy means nothing was created and nothing is filed.
  onCreateCategory: (name: string, parentId: string | null) => Promise<Category | void> | Category | void;
  onRenameCategory: (id: string, name: string) => void | Promise<void>;
  // Deleting a category never deletes chats — they fall back to their date
  // sections, which the menu says out loud.
  onDeleteCategory: (id: string) => void | Promise<void>;
  onToggleCategoryCollapsed: (id: string, collapsed: boolean) => void | Promise<void>;
  // Files a ROOT chat into a category (or out of one, with null).
  onMoveChatToCategory: (chatId: string, categoryId: string | null) => void | Promise<void>;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  // May be async — returns a Promise so the sidebar can await it and surface
  // any failure (e.g. backend unreachable) in the confirmation modal.
  onDelete: (id: string) => void | Promise<void>;
  onRename: (id: string, title: string) => void;
  // Pins or unpins a ROOT chat (design/mockup-pinned-chats.html, variant A).
  // Pinned roots leave the date sections and gather in one section at the top.
  onTogglePin: (id: string, pinned: boolean) => void | Promise<void>;
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
  // Collapse state of the chat tree, owned by App so the keyboard's ←
  // can collapse a node before the key overflows (ADR-0011).
  collapse?: CollapseControl;
}

// Streamt dieser Chat oder irgendein Nachfahre? (Root-Liste zeigt nur Roots.)
function subtreeStreams(chat: Chat, ids?: Set<string>): boolean {
  if (!ids || ids.size === 0) return false;
  if (ids.has(chat.id)) return true;
  return (chat.children ?? []).some(c => subtreeStreams(c, ids));
}

export function Sidebar({ chats, activeChatId, categories, onCreateCategory, onRenameCategory, onDeleteCategory, onToggleCategoryCollapsed, onMoveChatToCategory, onSelect, onNewChat, onDelete, onRename, onTogglePin, viewMode, onToggleView, onOpenSettings, onOpenFeedback, collapsed, onToggleCollapsed, streamingChatIds, queuedChatIds, collapse }: Props) {
  // UI-Texte in der App language — re-rendert beim Sprachwechsel mit.
  const S = useStrings().sidebar;
  const [expandedRootId, setExpandedRootId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pendingDeleteCategoryId, setPendingDeleteCategoryId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingCategoryId, setRenamingCategoryId] = useState<string | null>(null);
  const [categoryMenu, setCategoryMenu] = useState<CategoryMenuState | null>(null);
  const [dropCategoryId, setDropCategoryId] = useState<string | null>(null);
  // Which parent a not-yet-named category is being created under. `undefined`
  // means nothing is being created; `null` means a top-level one.
  const [creatingUnder, setCreatingUnder] = useState<string | null | undefined>(undefined);
  // The chat that is waiting for the category being named. "New category…"
  // lives inside "Move to category", so it is a FILING gesture that happens to
  // need a container first: creating the category and leaving the chat in its
  // date section is the half-done version of what was asked.
  const [chatAwaitingCategory, setChatAwaitingCategory] = useState<string | null>(null);
  // Whether the chat menu's "Move to category" flyout is open.
  const [moveMenuOpen, setMoveMenuOpen] = useState(false);
  const openSettings = onOpenSettings;

  // Which Pinned/date sections the user has closed. A CATEGORY remembers its
  // own state in the database — it has a row to hang off. These two do not, so
  // they live next to the sidebar's own collapsed flag in localStorage
  // (design/mockup-sidebar-categories-v2.html, §04 "Data").
  const [closedSections, setClosedSections] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('syflo.sidebarClosedSections');
      const closed = new Set<string>(raw ? JSON.parse(raw) : []);
      // Only Today and Yesterday start open (user decision 2026-08-26): the
      // four older date sections carry the whole backlog and pushed the recent
      // chats off screen. Applied ONCE per browser, not on every load — after
      // that the user's own toggles are the only thing that decides, and an
      // opened "This week" must not close itself again on the next reload.
      // The flag is separate from the set: an empty set is a legitimate state
      // ("I opened everything") and must not be mistaken for a fresh install.
      if (!localStorage.getItem(COLLAPSE_DEFAULT_FLAG)) {
        for (const label of DEFAULT_CLOSED_GROUPS) closed.add(`date:${label}`);
        localStorage.setItem(COLLAPSE_DEFAULT_FLAG, '1');
        localStorage.setItem('syflo.sidebarClosedSections', JSON.stringify([...closed]));
      }
      return closed;
    } catch {
      return new Set<string>();
    }
  });
  // Closing the chat menu always closes its flyout with it — a stranded
  // submenu over an already-dismissed menu is the classic leak here.
  const closeChatMenu = () => { setContextMenu(null); setMoveMenuOpen(false); };

  const toggleSection = (key: string) => {
    setClosedSections(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      localStorage.setItem('syflo.sidebarClosedSections', JSON.stringify([...next]));
      return next;
    });
  };

  const expandedRoot = expandedRootId ? chats.find(c => c.id === expandedRootId) ?? null : null;
  const pendingDeleteChat = pendingDeleteId ? findChatById(chats, pendingDeleteId) : null;
  const pendingDeleteCategory = pendingDeleteCategoryId
    ? categories.find(c => c.id === pendingDeleteCategoryId) ?? null
    : null;

  // Pinned roots are split off BEFORE the date grouping runs, so a pinned chat
  // is listed exactly once — in its own section at the top, most recently
  // pinned first (design/mockup-pinned-chats.html, variant A). With nothing
  // pinned the section doesn't exist at all: no heading, no reserved space.
  //
  // FILING WINS over pinning (user decision 2026-08-16). A chat that is both
  // is listed in its category only. The morning's rule was the opposite, and
  // it made the gesture look broken: dragging a pinned chat into a category
  // moved it in the database and moved nothing on screen — the user reported
  // exactly that, twice, before we looked in the database and found the chat
  // filed all along.
  //
  // The categories are therefore taken out FIRST, and pinning divides only
  // what is left. The inverse cost is real and accepted: pinning a chat that
  // is already filed now has no visible effect until it is unfiled.
  //
  // A chat whose category_id points at a category that no longer exists is not
  // filed at all — it falls through to pinning and then to the date sections,
  // rather than disappearing.
  const [pinnedRoots, categorisedRoots, datedRoots] = useMemo(() => {
    const known = new Set(categories.map(c => c.id));
    const byCategory = new Map<string, Chat[]>();
    const unfiled: Chat[] = [];
    for (const c of chats) {
      if (c.category_id && known.has(c.category_id)) {
        const bucket = byCategory.get(c.category_id);
        if (bucket) bucket.push(c); else byCategory.set(c.category_id, [c]);
      } else {
        unfiled.push(c);
      }
    }
    const pinned = unfiled.filter(c => !!c.pinned_at)
      .sort((a, b) => (b.pinned_at ?? '').localeCompare(a.pinned_at ?? ''));
    return [pinned, byCategory, unfiled.filter(c => !c.pinned_at)];
  }, [chats, categories]);

  // Parents in their stored order, each with its subcategories. One pass, so a
  // category with no parent that is referenced as a parent still only appears
  // once.
  const categoryTree = useMemo(() => {
    const roots = categories.filter(c => !c.parent_id);
    return roots.map(root => ({
      category: root,
      subcategories: categories.filter(c => c.parent_id === root.id),
    }));
  }, [categories]);

  // How many chats a category holds, counting its subcategories — the number
  // on a closed row, which has to say what is hidden, not what is directly in
  // it (mockup §01, state 3).
  const chatCount = (id: string): number => {
    const own = categorisedRoots.get(id)?.length ?? 0;
    return categories.filter(c => c.parent_id === id)
      .reduce((sum, sub) => sum + (categorisedRoots.get(sub.id)?.length ?? 0), own);
  };

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
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeChatMenu(); };
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
  // Deleting a category asks the same question in the same modal (user
  // request 2026-08-16). Only one of the two pending ids is ever set: the
  // modal is one object, and so is the question it asks.
  const confirmDelete = async () => {
    if (!pendingDeleteId && !pendingDeleteCategoryId) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      if (pendingDeleteId) {
        await onDelete(pendingDeleteId);
        setPendingDeleteId(null);
      } else if (pendingDeleteCategoryId) {
        await onDeleteCategory(pendingDeleteCategoryId);
        setPendingDeleteCategoryId(null);
      }
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : S.deleteFailed);
    } finally {
      setDeleting(false);
    }
  };

  const closeDeleteModal = () => {
    setPendingDeleteId(null);
    setPendingDeleteCategoryId(null);
    setDeleteError(null);
  };

  const handleRenameSubmit = (id: string, title: string) => {
    onRename(id, title);
    setRenamingId(null);
  };

  // One row of the root list. Shared by the Pinned section and the date
  // sections — both list root chats and must look identical; only where the
  // row sits differs (design/mockup-pinned-chats.html, variant A).
  // One heading of the root list: Pinned, or a date section. Both collapse
  // (mockup §03-A) and both carry a chevron that is ALWAYS visible — a gesture
  // only discoverable by hovering is no gesture at all.
  //
  // The count appears only while the section is closed: open, the rows say how
  // many there are; closed, the number is the sole thing that separates
  // "closed" from "empty".
  const renderSectionHeading = (
    key: string,
    label: string,
    opts: {
      testId: string; icon?: React.ReactNode; count?: number; first?: boolean;
      // A heading that heads other headings (the timeline parent) is drawn one
      // step darker. At 11 px gray-400 the only thing separating parent from
      // child would otherwise be 18 px of white, which is not a rank
      // (design/mockup-sidebar-timeline-group.html, strengthening 1).
      parent?: boolean;
      // A heading that sits UNDER the timeline parent. It is deliberately not
      // indented (user decision 2026-08-16, on seeing it): at 11 px uppercase
      // an indent buys almost nothing and costs the left edge its alignment.
      // It keeps the same left inset and the same reserved icon slot as the
      // parent, so "Verlauf" and "Gestern" begin at the identical x — which
      // leaves the gray-500/gray-400 step as the one thing carrying the rank.
      // Only the top padding shrinks, because the parent is right above it.
      nested?: boolean;
    },
  ) => {
    const isClosed = closedSections.has(key);
    return (
      <button
        type="button"
        onClick={() => toggleSection(key)}
        data-testid={opts.testId}
        aria-expanded={!isClosed}
        className={`w-full flex items-center gap-1.5 text-[11px] font-medium pr-2.5 pb-1 uppercase tracking-wider transition-colors ${
          opts.parent ? 'text-gray-500 hover:text-gray-700' : 'text-gray-400 hover:text-gray-600'
        } pl-2.5 ${opts.first ? 'pt-2' : opts.nested ? 'pt-3' : 'pt-5'}`}
      >
        <ChevronDown size={11} className={`shrink-0 transition-transform ${isClosed ? '-rotate-90' : ''}`} />
        {/* No reserved slot (user, 2026-08-16, on seeing it): an EMPTY box
            between the chevron and the word is read as an indent, which is
            exactly what was just taken out of these headings. The slot was
            there to align "PINNED" and "TODAY" on one x — but only two
            headings ever carry a symbol, and making the other five pay a
            visible gap for that alignment is the wrong trade. The chevrons
            still align, so the column keeps a straight left edge; a label
            that starts further right now MEANS something. */}
        {opts.icon && <span className="shrink-0 flex items-center">{opts.icon}</span>}
        <span className="truncate">{label}</span>
        {isClosed && opts.count !== undefined && (
          <span className="ml-auto text-[10px] text-gray-300 tracking-normal tabular-nums">{opts.count}</span>
        )}
      </button>
    );
  };

  // Drop handling is identical for a category row and a subcategory heading —
  // both are places a chat can land. Only the ring differs, because one is a
  // row and the other a label.
  const dropTarget = (categoryId: string) => ({
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setDropCategoryId(categoryId); },
    onDragLeave: () => setDropCategoryId(prev => (prev === categoryId ? null : prev)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const chatId = e.dataTransfer.getData('text/plain');
      setDropCategoryId(null);
      if (chatId) void onMoveChatToCategory(chatId, categoryId);
    },
  });

  // Naming a category finishes the gesture that started it. From the chat
  // menu that gesture was "move this chat", so the chat follows the category
  // into existence; from a category's own menu nothing is waiting and only the
  // container is made. A creation that fails files nothing.
  const finishCreating = async (name: string, parentId: string | null) => {
    const chatId = chatAwaitingCategory;
    setChatAwaitingCategory(null);
    setCreatingUnder(undefined);
    const created = await onCreateCategory(name, parentId);
    if (chatId && created) await onMoveChatToCategory(chatId, created.id);
  };

  const abandonCreating = () => {
    setChatAwaitingCategory(null);
    setCreatingUnder(undefined);
  };

  // A category and, inside it, its chats followed by its subcategories.
  // The two levels are deliberately different objects (§01-B + §02-C): the
  // category is a 13 px row with a hover pill, a folder and a menu button; the
  // subcategory is an 11 px heading with no controls of its own.
  const renderCategory = (category: Category, subcategories: Category[]) => {
    const isClosed = !!category.collapsed;
    const ownChats = categorisedRoots.get(category.id) ?? [];
    const isRenaming = renamingCategoryId === category.id;
    const isMenuTarget = categoryMenu?.categoryId === category.id;
    return (
      <div key={category.id} data-testid={`category-${category.id}`} className="mt-0.5">
        {/* A category is dressed exactly like the timeline parent (user,
            2026-08-16, on seeing them side by side): 11 px uppercase,
            gray-500, with its own symbol. Its subcategories then wear the date
            headings' gray-400, and the sidebar is left with two heading ranks
            and one row type — the chats. */}
        <div
          data-testid={`category-label-${category.id}`}
          onClick={() => !isRenaming && void onToggleCategoryCollapsed(category.id, !isClosed)}
          onContextMenu={e => {
            e.preventDefault();
            setCategoryMenu({ categoryId: category.id, x: e.clientX, y: e.clientY });
          }}
          {...dropTarget(category.id)}
          {...overflowTip(isRenaming ? undefined : category.name)}
          className={`group w-full flex items-center gap-1.5 text-[11px] font-medium pl-2.5 pr-2.5 py-0.5 mt-5 mb-0.5 uppercase tracking-wider cursor-pointer transition-colors ${
            dropCategoryId === category.id
              ? 'text-blue-700 ring-1 ring-inset ring-blue-400 rounded'
              : isMenuTarget ? 'text-gray-700' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <ChevronDown size={11} className={`shrink-0 transition-transform ${isClosed ? '-rotate-90' : ''}`} />
          <Folder size={11} className="shrink-0" />
          {isRenaming ? (
            <RenameInput
              initial={category.name}
              onSubmit={name => { void onRenameCategory(category.id, name); setRenamingCategoryId(null); }}
              onCancel={() => setRenamingCategoryId(null)}
            />
          ) : (
            <>
              <span data-overflow-label="" className="flex-1 truncate">{category.name}</span>
              {/* The count appears only while the category is CLOSED — the
                  same rule the date sections and the subcategory headings
                  already follow. Open, the rows underneath say how many there
                  are and the number only repeats them; closed, it is the one
                  thing that tells "closed" from "empty".
                  The "…" replaces it on hover rather than sitting next to it,
                  so the row never grows under the cursor. */}
              {isClosed && (
                <span className="text-[10px] text-gray-300 tracking-normal tabular-nums group-hover:hidden">
                  {chatCount(category.id)}
                </span>
              )}
              <button
                type="button"
                data-testid={`category-menu-${category.id}`}
                aria-label={S.categoryOptions}
                onClick={e => {
                  e.stopPropagation();
                  const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setCategoryMenu({ categoryId: category.id, x: box.left, y: box.bottom + 2 });
                }}
                className="hidden group-hover:block shrink-0 text-gray-400 hover:text-gray-700"
              >
                <MoreHorizontal size={12} />
              </button>
            </>
          )}
        </div>

        {!isClosed && (
          <div data-testid={`category-body-${category.id}`}>
            <div className="space-y-0.5">{ownChats.map(c => renderRootRow(c))}</div>
            {subcategories.map(sub => {
              const subClosed = !!sub.collapsed;
              const subChats = categorisedRoots.get(sub.id) ?? [];
              return (
                <div key={sub.id} data-testid={`subcategory-${sub.id}`}>
                  {renamingCategoryId === sub.id ? (
                    <div className="flex items-center gap-1.5 pl-2.5 pr-2.5 py-0.5 mt-3 mb-0.5">
                      <RenameInput
                        initial={sub.name}
                        onSubmit={name => { void onRenameCategory(sub.id, name); setRenamingCategoryId(null); }}
                        onCancel={() => setRenamingCategoryId(null)}
                      />
                    </div>
                  ) : (
                    <button
                      type="button"
                      data-testid={`subcategory-label-${sub.id}`}
                      aria-expanded={!subClosed}
                      onClick={() => void onToggleCategoryCollapsed(sub.id, !subClosed)}
                      onContextMenu={e => {
                        e.preventDefault();
                        setCategoryMenu({ categoryId: sub.id, x: e.clientX, y: e.clientY });
                      }}
                      {...dropTarget(sub.id)}
                      className={`w-full flex items-center gap-1.5 text-[11px] font-medium pl-2.5 pr-2.5 py-0.5 mt-3 mb-0.5 uppercase tracking-wider transition-colors ${
                        dropCategoryId === sub.id ? 'text-blue-700' : 'text-gray-400 hover:text-gray-600'
                      }`}
                    >
                      <ChevronDown size={11} className={`shrink-0 transition-transform ${subClosed ? '-rotate-90' : ''}`} />
                      <span className="truncate">{sub.name}</span>
                      {subClosed && (
                        <span className="ml-auto text-[10px] text-gray-300 tracking-normal tabular-nums">
                          {subChats.length}
                        </span>
                      )}
                    </button>
                  )}
                  {!subClosed && (
                    <div className="space-y-0.5" data-testid={`subcategory-body-${sub.id}`}>
                      {subChats.map(c => renderRootRow(c))}
                    </div>
                  )}
                </div>
              );
            })}
            {/* A fresh subcategory is named at the bottom of its parent, in
                the column its heading will occupy. */}
            {creatingUnder === category.id && (
              <div className="flex items-center gap-1.5 pl-2.5 pr-2.5 py-0.5 mt-3 mb-0.5">
                <ChevronDown size={11} className="shrink-0 text-gray-400" />
                <RenameInput
                  initial=""
                  placeholder={S.categoryNamePlaceholder}
                  onSubmit={name => { void finishCreating(name, category.id); }}
                  onCancel={abandonCreating}
                />
              </div>
            )}
            {/* No "this category is empty" hint (user, 2026-08-16): an empty
                category shows nothing under its row, which is already the
                whole message. The two-line instruction was read once and then
                sat under every empty category forever. */}
          </div>
        )}
      </div>
    );
  };

  // NO chat row is indented, filed or not (user, 2026-08-16). A filed chat is
  // marked by the heading above it, exactly the way a chat from yesterday is —
  // so the sidebar keeps one left edge with no exceptions to it.
  const renderRootRow = (chat: Chat) => {
    const isActive = chat.id === activeChatId ||
      !!(chat.children?.some(c => c.id === activeChatId));
    const isRenaming = chat.id === renamingId;
    // Same held pill as in the tree — the backdrop below the menu ends the
    // row's hover the moment the menu opens
    // (design/mockup-context-menu-target.html, variant A).
    const isMenuTarget = chat.id === contextMenu?.chatId;
    return (
      <div
        key={chat.id}
        // Root rows are keyboard items too (ADR-0011) — the default list is
        // what the sidebar shows most of the time, and skipping it would
        // leave the region empty.
        data-focus-item={chat.id}
        data-focus-active={isActive ? 'true' : undefined}
        // Dragging a root row files it. Only roots are draggable — a category
        // holds trees, the same scope as pinning. Not while renaming: the
        // drag would swallow the text selection inside the input.
        draggable={!isRenaming}
        onDragStart={e => e.dataTransfer.setData('text/plain', chat.id)}
        onClick={() => !isRenaming && handleRootClick(chat.id)}
        onContextMenu={e => {
          e.preventDefault();
          openContextMenu(chat.id, e.clientX, e.clientY);
        }}
        {...overflowTip(isRenaming ? undefined : plainMathText(chat.title))}
        className={`flex items-center gap-2.5 pl-2.5 pr-2.5 py-1.5 rounded-md cursor-pointer transition-colors ${
          isActive
            ? isMenuTarget ? 'bg-blue-100 text-blue-700' : 'bg-blue-50 text-blue-700'
            : isMenuTarget
              ? 'bg-gray-100 text-gray-900'
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
          <span data-overflow-label="" className={`flex-1 text-[13px] ${hasMath(chat.title) ? 'syflo-math-fade' : 'truncate'}`}><MathText text={chat.title} /></span>
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
        {/* No unpin button on the row (user decision 2026-08-11): pinning and
            unpinning both live in the right-click menu, so a pinned row looks
            exactly like every other row and the list stays quiet. */}
      </div>
    );
  };

  // Collapsed rail: a slim strip with only the expand toggle and a new-chat
  // button, so the chat/PDF area gets the full width. Everything else is
  // hidden until the user expands the sidebar again.
  if (collapsed) {
    return (
      <div
        // The collapsed rail is a region too. Without this, ← out of the PDF
        // hit a wall and the sidebar was unreachable by keyboard while folded
        // (user report 2026-08-11).
        data-focus-region="sidebar"
        className="syflo-sidebar w-12 bg-white border-r border-gray-200 flex flex-col items-center py-5 shrink-0"
      >
        <button
          onClick={onToggleCollapsed}
          data-focus-item="rail-expand"
          data-tip={S.expand} data-tip-below="" data-tip-start=""
          aria-label={S.expand}
          className="p-2 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors"
        >
          <PanelLeftOpen size={18} />
        </button>
        <button
          onClick={onNewChat}
          data-focus-item="rail-new-chat"
          data-tip={S.newChat} data-tip-below=""
          aria-label={S.newChat}
          className="mt-2 p-2 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors"
        >
          <SquarePen size={16} />
        </button>
        {/* Feedback + Settings pinned to the bottom of the rail — same entry
            points as the expanded sidebar's bottom-left footer (ADR-0010). */}
        <button
          onClick={onOpenFeedback}
          data-focus-item="rail-feedback"
          data-tip={S.feedback}
          aria-label={S.openFeedback}
          className="mt-auto p-2 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors"
        >
          <MessageSquarePlus size={16} />
        </button>
        <button
          onClick={() => openSettings('appearance')}
          data-focus-item="rail-settings"
          data-tip={S.settings}
          aria-label={S.openSettings}
          className="mt-1 p-2 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors"
        >
          <SettingsIcon size={16} />
        </button>
      </div>
    );
  }

  return (
    <div data-focus-region="sidebar" className="syflo-sidebar w-64 bg-white border-r border-gray-200 flex flex-col shrink-0">
      {/* Top bar: app name + action icons */}
      <div className="flex items-center justify-between px-5 py-5 border-b border-gray-100">
        <Logo />
        <div className="flex items-center gap-2">
          {/* Collapse the sidebar to a slim rail */}
          <button
            onClick={onToggleCollapsed}
            data-focus-item="sidebar-collapse"
            data-tip={S.collapse} data-tip-below=""
            aria-label={S.collapse}
            className="p-2 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors"
          >
            <PanelLeftClose size={16} />
          </button>
          {/* Mind map toggle — only meaningful with an active chat, so hide on the
              empty "homepage" state and show as soon as a chat is selected. */}
          {activeChatId && (
            <button
              onClick={onToggleView}
              data-focus-item="sidebar-mindmap"
              data-tip={viewMode === 'chat' ? S.switchToMindMap : S.switchToChat} data-tip-below=""
              aria-label={viewMode === 'chat' ? S.switchToMindMap : S.switchToChat}
              className={`p-2 rounded-lg transition-colors ${
                viewMode === 'mindmap'
                  ? 'text-blue-600 bg-blue-50'
                  : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100'
              }`}
            >
              <GitBranch size={16} />
            </button>
          )}

          {/* No new-category button here (user decision 2026-08-16): the header
              had three icons and the folder-plus was the one nobody reached for.
              Creating a category lives in a chat's right-click menu, under
              "Move to category" → "New category…", which is also where the
              user already is when the wish arises. With no chats at all there
              is no way in — and nothing to file either. */}

          {/* New chat button */}
          <button
            onClick={onNewChat}
            data-focus-item="sidebar-new-chat"
            data-tip={S.newChat} data-tip-below=""
            aria-label={S.newChat}
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
            onClick={closeChatMenu}
            onContextMenu={e => { e.preventDefault(); closeChatMenu(); }}
          />
          <div
            className="fixed z-50 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[140px]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
          {/* Pin sits above Rename and only on ROOT chats — the Pinned section
              lists trees, so a branch has nowhere to be pinned to
              (design/mockup-pinned-chats.html, variant A). */}
          {/* Filing sits above Pin and, like it, only on ROOT chats: a
              category lists trees, so a filed branch would be a row without
              the tree it belongs to. */}
          {chats.some(c => c.id === contextMenu.chatId) && (
            <button
              onClick={() => setMoveMenuOpen(o => !o)}
              aria-expanded={moveMenuOpen}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
            >
              <Folder size={13} />
              {S.moveToCategory}
              <ChevronRight size={12} className="ml-auto text-gray-400" />
            </button>
          )}
          {chats.some(c => c.id === contextMenu.chatId) && (
            <button
              onClick={() => {
                const chat = chats.find(c => c.id === contextMenu.chatId);
                void onTogglePin(contextMenu.chatId, !chat?.pinned_at);
                closeChatMenu();
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
            >
              {chats.find(c => c.id === contextMenu.chatId)?.pinned_at
                ? <><PinOff size={13} />{S.unpin}</>
                : <><Pin size={13} />{S.pin}</>}
            </button>
          )}
          <button
            onClick={() => { setRenamingId(contextMenu.chatId); closeChatMenu(); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
          >
            <Pencil size={13} />
            {S.rename}
          </button>
          <button
            onClick={() => { requestDelete(contextMenu.chatId); closeChatMenu(); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
          >
            <Trash2 size={13} />
            {S.delete}
          </button>
          </div>

          {/* "Move to category" flyout. The subcategories are listed FLAT under
              their parent rather than in a third menu level — the mockup names
              this as the alternative to three nested flyouts, and an indented
              line reads faster than a menu you have to hover open. The parent
              appears as "Robotics itself" so filing into the category rather
              than one of its subcategories needs no backing out. */}
          {moveMenuOpen && (
            <div
              className="fixed z-50 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[162px] max-w-[220px]"
              style={{ left: contextMenu.x + 168, top: contextMenu.y }}
            >
              {categoryTree.map(({ category, subcategories }) => (
                <div key={category.id}>
                  <button
                    data-testid={`move-target-${category.id}`}
                    onClick={() => { void onMoveChatToCategory(contextMenu.chatId, category.id); closeChatMenu(); }}
                    className="w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 truncate"
                  >
                    {subcategories.length > 0 ? S.categoryItself(category.name) : category.name}
                  </button>
                  {subcategories.map(sub => (
                    <button
                      key={sub.id}
                      data-testid={`move-target-${sub.id}`}
                      onClick={() => { void onMoveChatToCategory(contextMenu.chatId, sub.id); closeChatMenu(); }}
                      className="w-full text-left pl-7 pr-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 truncate"
                    >
                      {sub.name}
                    </button>
                  ))}
                </div>
              ))}
              {categories.length > 0 && <div className="h-px bg-gray-100 my-1" />}
              {chats.find(c => c.id === contextMenu.chatId)?.category_id && (
                <button
                  onClick={() => { void onMoveChatToCategory(contextMenu.chatId, null); closeChatMenu(); }}
                  className="w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
                >
                  {S.removeFromCategory}
                </button>
              )}
              <button
                onClick={() => { setChatAwaitingCategory(contextMenu.chatId); setCreatingUnder(null); closeChatMenu(); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
              >
                <FolderPlus size={13} />
                {S.newCategory}…
              </button>
            </div>
          )}
        </>
      )}

      {/* The category's own menu — the container's verbs, which are not the
          chat's. "Collapse all" was dropped (user decision 2026-08-16), so
          what is left is three entries; the line under Delete is the promise
          that a container is not its contents. Delete is NOT red: the shipped
          chat menu renders its Delete in gray-700 too, and red-* stays with
          the confirmation modal. */}
      {categoryMenu && (() => {
        const target = categories.find(c => c.id === categoryMenu.categoryId);
        if (!target) return null;
        const count = chatCount(target.id);
        return (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setCategoryMenu(null)}
              onContextMenu={e => { e.preventDefault(); setCategoryMenu(null); }}
            />
            <div
              className="fixed z-50 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[172px] max-w-[210px]"
              style={{ left: categoryMenu.x, top: categoryMenu.y }}
            >
              {/* Only a top-level category can gain children — depth stops at
                  two, and the backend refuses anything deeper anyway. */}
              {!target.parent_id && (
                <button
                  onClick={() => { setChatAwaitingCategory(null); setCreatingUnder(target.id); setCategoryMenu(null); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
                >
                  <FolderPlus size={13} />
                  {S.newSubcategory}
                </button>
              )}
              <button
                onClick={() => { setRenamingCategoryId(target.id); setCategoryMenu(null); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
              >
                <Pencil size={13} />
                {S.renameCategory}
              </button>
              <div className="h-px bg-gray-100 my-1" />
              <button
                onClick={() => { setPendingDeleteCategoryId(target.id); setCategoryMenu(null); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
              >
                <Trash2 size={13} />
                {S.deleteCategory}
              </button>
              {count > 0 && (
                <p className="text-[11px] text-gray-400 px-3 pl-[35px] pb-1.5 pt-0.5 leading-snug">
                  {S.deleteCategoryNote(count)}
                </p>
              )}
            </div>
          </>
        );
      })()}

      {/* Delete-confirmation modal — one modal for both questions. A category
          asks the same way a chat does (user request 2026-08-16); only the
          copy differs, and the category's copy repeats the promise that its
          chats survive. */}
      {(pendingDeleteChat || pendingDeleteCategory) && (
        <div
          data-overlay
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => { if (!deleting) closeDeleteModal(); }}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-6 pt-6 pb-2">
              <h3 className="text-base font-semibold text-gray-900 mb-1.5">
                {pendingDeleteChat ? S.deleteChatTitle : S.deleteCategoryTitle}
              </h3>
              {/* Subject and consequence used to be one run-on sentence, which
                  turned unreadable with a long or messy chat title (2026-08-29).
                  design/mockup-delete-confirm-restructure.html, variant A: the
                  subject gets its own clamped card, the consequence its own line. */}
              <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 mb-3">
                <p className="text-sm text-gray-700 leading-snug line-clamp-2">
                  <MathText text={pendingDeleteChat
                    ? S.deleteChatSubject(pendingDeleteChat.title)
                    : S.deleteCategorySubject(pendingDeleteCategory!.name)} />
                </p>
              </div>
              <p className="text-sm text-gray-500 leading-relaxed">
                {pendingDeleteChat
                  ? S.deleteChatConsequence
                  : S.deleteCategoryConsequence(chatCount(pendingDeleteCategory!.id))}
              </p>
              {deleteError && (
                <p className="mt-3 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-md border border-red-100">
                  {deleteError}
                </p>
              )}
            </div>
            <div className="flex gap-2 px-6 pb-5 pt-4 justify-end">
              <button
                onClick={closeDeleteModal}
                disabled={deleting}
                className="px-4 py-2 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-50"
              >
                {S.cancel}
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleting}
                data-testid={pendingDeleteChat ? 'confirm-delete-chat' : 'confirm-delete-category'}
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
        {/* "No chats yet" only while there is genuinely nothing to show. A
            user who has made a category but not yet filed anything must see
            the category — otherwise the sidebar denies work they just did. */}
        {chats.length === 0 && categories.length === 0 ? (
          <p className="text-xs text-gray-400 text-center mt-8 px-4">{S.noChats}</p>
        ) : expandedRoot ? (
          // Expanded view: back button + single root with all children
          <>
            <button
              // The way back out of a tree is a keyboard item too: ↑ from the
              // root row reaches it, Enter returns to the full chat list
              // (user report 2026-08-11).
              data-focus-item="sidebar-all-chats"
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
              contextMenuId={contextMenu?.chatId ?? null}
              streamingChatIds={streamingChatIds}
              queuedChatIds={queuedChatIds}
              activePathIds={activePathIds}
              collapse={collapse}
            />
          </>
        ) : (
          // Default view: the Pinned section (if anything is pinned), then the
          // remaining root chats grouped into relative date sections ("Today",
          // "Yesterday", …) by created_at; children stay hidden.
          <>
            {pinnedRoots.length > 0 && (
              <div>
                {/* Das Pin-Symbol ist zurück (Nutzerentscheid 2026-08-16): die
                    Begründung von 2026-08-11 — "keine Überschrift trägt ein
                    Symbol" — stimmt nicht mehr, sobald Kategoriezeilen einen
                    Ordner tragen. Die Datums-Überschriften halten denselben
                    11-px-Platz frei, damit alle Beschriftungen auf einer
                    Fluchtlinie beginnen. */}
                {renderSectionHeading('pinned', S.pinned, {
                  testId: 'pinned-group-label',
                  icon: <Pin size={11} />,
                  count: pinnedRoots.length,
                  first: true,
                  // Same rank as the timeline parent and the categories: a
                  // top-level section with a symbol, so the same gray-500
                  // (user, 2026-08-16). gray-400 is reserved for the level
                  // below — date sections and subcategories.
                  parent: true,
                })}
                {!closedSections.has('pinned') && (
                  <div className="space-y-0.5">{pinnedRoots.map(c => renderRootRow(c))}</div>
                )}
              </div>
            )}

            {/* Categories — the only grouping the user owns. They sit between
                the pinned section and the date sections, and a filed chat has
                left those date sections entirely (§04-A). */}
            {categoryTree.map(({ category, subcategories }) => renderCategory(category, subcategories))}

            {/* A fresh top-level category is named in place, at the end of the
                list where it will appear. Escape or an empty name abandons it —
                nothing is created until it has a name. */}
            {creatingUnder === null && (
              <div className="flex items-center gap-1.5 pl-2.5 pr-2.5 py-0.5 mt-5 mb-0.5">
                <ChevronDown size={11} className="shrink-0 text-gray-400" />
                <Folder size={11} className="shrink-0 text-gray-400" />
                <RenameInput
                  initial=""
                  placeholder={S.categoryNamePlaceholder}
                  onSubmit={name => { void finishCreating(name, null); }}
                  onCancel={abandonCreating}
                />
              </div>
            )}

            {/* The one new separator: above it is the user's order, below it
                the clock. It only earns its place once both sides exist. */}
            {categories.length > 0 && datedRoots.length > 0 && (
              <div className="h-px bg-gray-100 mx-2.5 mt-3" />
            )}

            {/* The date sections are six labels for one idea — the clock. They
                gather under a single parent so the whole clock side of the
                sidebar puts itself away in one click
                (design/mockup-sidebar-timeline-group.html, variant B).
                It only exists while it has something to head: with every chat
                pinned or filed there is no timeline, not an empty one. */}
            {datedRoots.length > 0 && (
              <>
                {renderSectionHeading('timeline', S.timeline, {
                  testId: 'timeline-group-label',
                  icon: <Clock size={11} />,
                  count: datedRoots.length,
                  parent: true,
                  first: pinnedRoots.length === 0 && categories.length === 0,
                })}
                {/* Closing the parent HIDES the date sections; it does not
                    reset them. Each keeps its own key in closedSections, so a
                    section the user closed on purpose is still closed when the
                    timeline comes back. */}
                {!closedSections.has('timeline') && groupChatsByDate(datedRoots).map(group => (
                  <div key={group.label}>
                    {renderSectionHeading(`date:${group.label}`, S.groups[group.label], {
                      testId: 'chat-group-label',
                      count: group.chats.length,
                      nested: true,
                    })}
                    {/* Variant B: the HEADINGS indent, the chats do not. An
                        uncategorised title starts at the same 10 px it always
                        has — that is the whole reason B was chosen over A. */}
                    {!closedSections.has(`date:${group.label}`) && (
                      <div className="space-y-0.5" data-testid={`date-section-${group.label}`}>
                        {group.chats.map(c => renderRootRow(c))}
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>

      {/* Footer: nur noch das Zahnrad (mockup-model-picker.html, Sektion 01) —
          das aktive Modell zeigt die Composer-Pille, der Provider-Status lebt
          in deren Menü-Fußzeile. */}
      <div className="border-t border-gray-100 px-3 py-3">
        <button
          onClick={onOpenFeedback}
          data-focus-item="sidebar-feedback"
          data-tip={S.feedback}
          aria-label={S.openFeedback}
          className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs font-medium text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors"
        >
          <MessageSquarePlus size={15} />
          {S.feedback}
        </button>
        <button
          onClick={() => openSettings('appearance')}
          data-focus-item="sidebar-settings"
          data-tip={S.settings}
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
