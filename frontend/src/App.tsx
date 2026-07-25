/**
 * App.tsx
 *
 * Root component that owns all application state and orchestrates communication
 * between the sidebar, chat area, mind map, and floating popup.
 *
 * Key responsibility: streaming state management.
 * When the user sends a message, App.tsx immediately adds two temporary messages
 * (the user's message and an empty assistant placeholder) to the active chat.
 * As text chunks arrive from the backend, it updates the placeholder in place so
 * the user sees the response building word-by-word. Once streaming finishes, the
 * temporary messages are swapped for the real persisted versions from the server.
 * Streams are per-chat and keep running in the background when the user switches
 * chats (buffer in activeStreamsRef; the sidebar shows animated dots for them).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { FileText } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { ChatArea, type ChatAreaHandle } from './components/ChatArea';
import { ModelPicker } from './components/ChatArea/ModelPicker';
import { SettingsModal, type SettingsTab } from './components/SettingsModal';
import { MindMap } from './components/MindMap';
import { ParentContextPane } from './components/ParentContextPane';
import { PdfView, type PdfHighlightSelection, type PdfViewHandle } from './components/PdfView';
import { HighlightActionsMenu } from './components/PdfView/HighlightActionsMenu';
import { PaperSearchModal } from './components/PaperSearch';
import { YouTubeSearchModal } from './components/YouTubeSearch';
import { structurePrompt } from './components/YouTubeSearch/autoPrompt';
import { getAppLanguage } from './appLanguage';
import { useStrings } from './strings';
import { VideoBanner } from './components/VideoBanner';
import { TranscriptDrawer } from './components/TranscriptDrawer';
import { FloatingPopup } from './components/FloatingPopup';
import { HighlightsDrawer } from './components/HighlightsDrawer';
import { api, StreamFailedError, TreeHasSourceError } from './api';
import { orderMessages } from './chat/messageOrder';
import { useHighlights } from './hooks/useHighlights';
import { useChatHighlights } from './hooks/useChatHighlights';
import { contextAroundSelection } from './pdf/selection';
import { FAILED_MARKER, INTERRUPTED_MARKER } from './types';
import type { Chat, ChatAncestor, ChatDetail, ChatSelection, ComposerQuote, Highlight, HighlightColor, LocalAttachment, Message, MessageHighlight, OllamaModelInfo, Paper, SearchResult, SearchSource, Settings, SystemRecommendation, ToolEvent, TreeHighlight, Video, VideoSearchResult, WordPopup } from './types';

// Ein laufender Antwort-Stream. Antworten laufen beim Chat-Wechsel im
// Hintergrund weiter (Nutzerkorrektur 2026-07-22) — der Puffer hält den
// bisher gestreamten Stand außerhalb des React-States, damit Deltas auch
// ankommen, während ein anderer Chat angezeigt wird, und der Teilstand beim
// Zurückwechseln sofort wieder erscheint. Es kann MEHRERE Streams pro Chat
// geben (das Backend beantwortet sie FIFO): die Registry ist deshalb nach
// tempAssistantId geschlüsselt, nicht nach Chat — der frühere Chat-Schlüssel
// ließ ein zweites Senden den ersten Eintrag überschreiben und das finally
// des ersten den zweiten löschen (Bug 2026-07-24).
interface ActiveStream {
  chatId: string;
  tempUserId: string;
  tempAssistantId: string;
  // Inhalt der optimistischen User-Frage — für die Wiederherstellung beim
  // Chat-Wechsel, solange der Job wartet (die Frage wird erst beim Job-Start
  // serverseitig persistiert und fehlt bis dahin in der GET-Antwort).
  userContent: string;
  content: string;
  reasoning: string;
  sources: SearchSource[];
  createdAt: string;
  // Warteschlangen-Status des Backends: Zahl der Jobs davor, null = läuft
  // (oder war nie eingereiht). started kippt mit dem started-Event.
  queuedAhead: number | null;
  started: boolean;
  // Prefill-ETA (Sekunden) des laufenden Jobs — null, sobald das erste
  // Token/Reasoning eintrifft (der Countdown-Balken verschwindet).
  prefillEta: number | null;
  // Retry eines persistierten '*Failed*'-Markers: es gibt keine optimistische
  // User-Blase, und ein Abbruch im Wartezustand stellt die Fehlerzeile wieder
  // her, statt Blasen zu entfernen.
  isRegenerate: boolean;
  abort: AbortController;
}

export default function App() {
  // UI-Texte in der App language — re-rendert beim Sprachwechsel mit.
  const S = useStrings().app;
  // chats: the full tree shown in the sidebar
  const [chats, setChats] = useState<Chat[]>([]);

  // activeChat: the currently open chat including its messages
  const [activeChat, setActiveChat] = useState<ChatDetail | null>(null);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);

  const [viewMode, setViewMode] = useState<'chat' | 'mindmap'>('chat');
  const [loadingChat, setLoadingChat] = useState(false);

  // Whether the left sidebar is collapsed to a slim rail. Persisted so the
  // preference survives reloads.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => localStorage.getItem('syflo.sidebarCollapsed') === '1',
  );
  const toggleSidebar = () => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      localStorage.setItem('syflo.sidebarCollapsed', next ? '1' : '0');
      return next;
    });
  };

  // Active LLM settings — die Composer-Pille zeigt das aktive Modell, das
  // Settings-Modal (App-eigen) verwaltet die Bibliothek.
  const [settings, setSettings] = useState<Settings | null>(null);

  // Installierte Vision-Modelle (Backend filtert) + Hardware-Empfehlung —
  // beides füttert die Composer-Pille und die Settings-Bibliothek.
  const [ollamaModels, setOllamaModels] = useState<OllamaModelInfo[]>([]);
  const [recommendation, setRecommendation] = useState<SystemRecommendation | null>(null);

  // Settings-Modal gehört der App (der Picker und die Sidebar öffnen es).
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('appearance');
  const openSettings = useCallback((tab: SettingsTab) => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);

  // Thinking pro Chat (Grill 2026-07-21): der Schalter gilt für den Chat,
  // bis er wieder ausgeschaltet wird — nicht global, nicht pro Nachricht.
  const [thinkByChat, setThinkByChat] = useState<Record<string, boolean>>({});

  // Warnung, wenn das aktive Modell nur teilweise im GPU-Speicher liegt
  // (CPU-Offloading = 10–20× langsamer) — gemeldet vom Prefix-Warm-up.
  const [gpuWarning, setGpuWarning] = useState<string | null>(null);

  // Wertet das Warm-up-Ergebnis aus: GPU-Warnung setzen oder aufräumen.
  const handleWarmupResult = (r: import('./types').WarmupResult) => {
    if (!r?.gpu) return;
    setGpuWarning(
      r.gpu.vramPercent < 100 ? S.gpuWarning(r.gpu.vramPercent) : null,
    );
  };

  // Laufende Streams, geschlüsselt nach tempAssistantId — mehrere pro Chat
  // möglich (Backend-FIFO). Der Stop-Button bricht alle Streams des gerade
  // sichtbaren Chats ab.
  const activeStreamsRef = useRef<Map<string, ActiveStream>>(new Map());
  // Spiegel für die UI: Punkte in der Sidebar für antwortende Chats, Uhr für
  // Chats, deren Fragen nur in der Warteschlange stehen, und die IDs der
  // Assistant-Platzhalter (pro Nachricht statt "letzte Nachricht" — bei
  // mehreren Streams in einem Chat ist der Platzhalter nicht mehr zwingend
  // die letzte Nachricht).
  const [streamingChatIds, setStreamingChatIds] = useState<Set<string>>(new Set());
  const [queuedChatIds, setQueuedChatIds] = useState<Set<string>>(new Set());
  const [streamingMessageIds, setStreamingMessageIds] = useState<Set<string>>(new Set());
  // Live-Spiegel der aktiven Chat-ID für Stream-Callbacks (der State im
  // Closure wäre veraltet, sobald der Nutzer den Chat wechselt).
  const activeChatIdRef = useRef<string | null>(null);

  const streamsForChat = (chatId: string): ActiveStream[] =>
    [...activeStreamsRef.current.values()].filter(s => s.chatId === chatId);

  // Leitet alle UI-Spiegel aus der Registry ab — nach JEDER Mutation aufrufen.
  // Ein Chat mit generierendem UND wartendem Stream zeigt die Punkte.
  const syncStreamIndicators = () => {
    const streaming = new Set<string>();
    const queued = new Set<string>();
    const messageIds = new Set<string>();
    for (const s of activeStreamsRef.current.values()) {
      messageIds.add(s.tempAssistantId);
      if (!s.started && s.queuedAhead !== null) queued.add(s.chatId);
      else streaming.add(s.chatId);
    }
    for (const id of streaming) queued.delete(id);
    setStreamingChatIds(streaming);
    setQueuedChatIds(queued);
    setStreamingMessageIds(messageIds);
  };

  // treePaper: the PDF bound to the active chat's tree (ADR-0002: one per
  // tree). Non-null switches the app into the three-column layout — tree in
  // the left sidebar, PDF center, active branch's chat right.
  const [treePaper, setTreePaper] = useState<Paper | null>(null);

  // pendingAttach: an attach attempt (local file, search-import URL, or a
  // YouTube video) that was rejected with 'tree-has-source'. While set, the
  // new-tree prompt is shown; confirming attaches it to a fresh tree
  // (ADR-0002/0005: one source per tree).
  const [pendingAttach, setPendingAttach] = useState<
    | { kind: 'file'; file: File }
    | { kind: 'url'; url: string; title: string; fallbacks: string[] }
    | { kind: 'video'; youtubeId: string; title: string }
    | null
  >(null);

  // Paper-Such-Modal (Slice 07), geöffnet über "Research paper" im Plus-Menü.
  const [paperSearchOpen, setPaperSearchOpen] = useState(false);

  // treeVideo: das YouTube transcript des aktiven Baums (ADR-0005: eine
  // Quelle pro Baum). Non-null rendert das Quellen-Banner über dem Verlauf.
  const [treeVideo, setTreeVideo] = useState<Video | null>(null);
  // Video-Such-Modal, geöffnet über "YouTube Transcript" im Plus-Menü.
  const [youtubeSearchOpen, setYoutubeSearchOpen] = useState(false);
  // Roh-Transkript-Drawer (Banner-Klick).
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  // Width of the right chat column in the three-column PDF layout. The user
  // drags the divider between PDF and chat to resize; persisted so the
  // preferred width survives reloads.
  const CHAT_PANE_MIN = 300;
  const CHAT_PANE_MAX = 800;
  const [chatPaneWidth, setChatPaneWidth] = useState<number>(() => {
    const stored = Number(localStorage.getItem('syflo.chatPaneWidth'));
    return Number.isFinite(stored) && stored >= CHAT_PANE_MIN && stored <= CHAT_PANE_MAX
      ? stored
      : 340;
  });
  // Live drag state — kept in a ref so pointermove doesn't fight React state.
  const chatPaneResizeRef = useRef<{ startX: number; startWidth: number; last: number } | null>(null);
  const handleChatPaneResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    chatPaneResizeRef.current = { startX: e.clientX, startWidth: chatPaneWidth, last: chatPaneWidth };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const handleChatPaneResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = chatPaneResizeRef.current;
    if (!drag) return;
    // The chat pane sits at the right window edge, so dragging the divider
    // left widens it by exactly the pointer delta.
    const next = Math.min(CHAT_PANE_MAX, Math.max(CHAT_PANE_MIN, drag.startWidth + (drag.startX - e.clientX)));
    drag.last = next;
    setChatPaneWidth(next);
  };
  const handleChatPaneResizeEnd = () => {
    const drag = chatPaneResizeRef.current;
    if (!drag) return;
    chatPaneResizeRef.current = null;
    localStorage.setItem('syflo.chatPaneWidth', String(drag.last));
  };

  // Height of the mind-map pane (as % of the column), when the mind-map view
  // is open above the chat. Same drag pattern as the chat column divider;
  // stored as a percentage so it adapts to window resizes.
  const MAP_PANE_MIN_PCT = 20;
  const MAP_PANE_MAX_PCT = 80;
  const [mapPaneHeightPct, setMapPaneHeightPct] = useState<number>(() => {
    const stored = Number(localStorage.getItem('syflo.mapPaneHeight'));
    return Number.isFinite(stored) && stored >= MAP_PANE_MIN_PCT && stored <= MAP_PANE_MAX_PCT
      ? stored
      : 50;
  });
  const mapPaneResizeRef = useRef<{ startY: number; startPct: number; containerH: number; last: number } | null>(null);
  const handleMapPaneResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const containerH = (e.currentTarget.parentElement as HTMLElement).clientHeight || 1;
    mapPaneResizeRef.current = { startY: e.clientY, startPct: mapPaneHeightPct, containerH, last: mapPaneHeightPct };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const handleMapPaneResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = mapPaneResizeRef.current;
    if (!drag) return;
    const deltaPct = ((e.clientY - drag.startY) / drag.containerH) * 100;
    const next = Math.min(MAP_PANE_MAX_PCT, Math.max(MAP_PANE_MIN_PCT, drag.startPct + deltaPct));
    drag.last = next;
    setMapPaneHeightPct(next);
  };
  const handleMapPaneResizeEnd = () => {
    const drag = mapPaneResizeRef.current;
    if (!drag) return;
    mapPaneResizeRef.current = null;
    localStorage.setItem('syflo.mapPaneHeight', String(drag.last));
  };

  // popup: the word the user right-clicked on, plus its screen coordinates
  const [popup, setPopup] = useState<WordPopup | null>(null);
  const [explanation, setExplanation] = useState('');
  const [loadingExplanation, setLoadingExplanation] = useState(false);

  // Persistent colored highlights on the tree's PDF (Slice 04). Scoped to
  // the bound paper; empty while no PDF is open.
  const {
    highlights,
    create: createHighlight,
    update: updateHighlight,
    remove: removeHighlight,
  } = useHighlights(treePaper?.id ?? null);

  // Selection captured by PdfView at right-click time — read when the user
  // picks a color or opens a branch, so the highlight can be saved even
  // though the live Selection collapses when focus moves into the popup.
  const pendingPdfSelectionRef = useRef<PdfHighlightSelection | null>(null);
  // Highlight already saved for the current popup's selection (first color
  // pick creates it; further picks recolor it; "Open as new chat" links it).
  const savedHighlightIdRef = useRef<string | null>(null);
  // Whether the open popup came from a PDF selection — only then does it
  // show the color row.
  const [popupHasPdfSelection, setPopupHasPdfSelection] = useState(false);
  // The color the next highlight gets (ring + checkmark in the popup).
  const [activeColor, setActiveColor] = useState<HighlightColor>('yellow');
  // Actions menu for an existing highlight (recolor / delete / open chat).
  const [highlightMenu, setHighlightMenu] = useState<{
    highlight: Highlight;
    x: number;
    y: number;
  } | null>(null);

  // ─── Chat-Text-Highlights + "Ask in chat" (mockup-chat-highlights-…) ──────

  // No-PDF branch layout: while a branch chat is active and its tree has no
  // PDF, the parent chat renders in the center pane as read-only context.
  const [parentContext, setParentContext] = useState<ChatDetail | null>(null);
  // Vorfahren-Pfad (Wurzel → … → Eltern) des aktiven Branches inkl. gecachter
  // Summaries — gerendert als Kette + Karten über dem Parent-Kontext
  // (mockup section 04).
  const [ancestors, setAncestors] = useState<ChatAncestor[]>([]);

  // Message-anchored highlights, one hook instance per visible chat pane.
  const activeChatHl = useChatHighlights(activeChatId);
  const parentChatHl = useChatHighlights(parentContext?.id ?? null);
  // Route create/recolor/remove to the pane that owns the chat.
  const hlApiFor = (chatId: string) =>
    chatId === parentContext?.id ? parentChatHl : activeChatHl;

  // Selection captured from a chat bubble at right-click time — the chat twin
  // of pendingPdfSelectionRef.
  const pendingChatSelectionRef = useRef<ChatSelection | null>(null);
  const savedChatHighlightIdRef = useRef<string | null>(null);
  const [popupHasChatSelection, setPopupHasChatSelection] = useState(false);

  // Actions menu for an existing chat-text highlight (recolor / delete).
  const [chatHighlightMenu, setChatHighlightMenu] = useState<{
    highlight: MessageHighlight;
    x: number;
    y: number;
  } | null>(null);

  // Die "blaue Markierung" sichtbar halten, solange das Popup offen ist
  // (Nutzerkorrektur 2026-07-22): die native Selektion kollabiert beim Klick
  // ins Popup. Chat: die erfasste Auswahl wird als Pending-Overlay gemalt;
  // PDF: PdfView hält sein transientes Auswahl-Overlay fest.
  const [pendingChatSelection, setPendingChatSelection] = useState<ChatSelection | null>(null);
  const [holdPdfSelection, setHoldPdfSelection] = useState(false);

  // "Open as new chat" aus einer Chat-Selektion: Ursprungs-Nachricht merken,
  // damit das Parent-Context-Pane dorthin scrollt statt an den Anfang
  // (Nutzer-Report 2026-07-22 — der Kontext der Auswahl soll sichtbar bleiben).
  const [parentScrollTarget, setParentScrollTarget] = useState<{
    chatId: string;
    messageId: string;
  } | null>(null);

  // Highlights-Drawer über der Chat-Spalte (mockup-highlights-overview.html,
  // Variante A). Startet geschlossen, wird nicht persistiert (Grill 2026-07-21).
  const [highlightsOpen, setHighlightsOpen] = useState(false);
  // Sprungziele für Drawer-Karten (Grill-Entscheidung 8: punktgenau + Flash).
  const pdfViewRef = useRef<PdfViewHandle>(null);
  const chatAreaRef = useRef<ChatAreaHandle>(null);
  // Chat-Karte eines ANDEREN Branches: erst Branch laden, dann scrollen —
  // der Effekt unten feuert, sobald der Ziel-Chat aktiv geworden ist.
  const pendingChatScrollRef = useRef<{
    chatId: string;
    messageId: string;
    // Offsets + Farbe der Markierung: lässt die Markierung selbst in ihrer
    // Highlight-Farbe aufblinken statt der ganzen Bubble (Nutzerkorrekturen
    // 2026-07-22).
    startOffset?: number;
    endOffset?: number;
    color?: HighlightColor;
  } | null>(null);

  // "Ask in chat" quote waiting in a chat's composer. Keyed by chatId so a
  // quote never leaks into a different chat's composer.
  const [composerQuote, setComposerQuote] = useState<(ComposerQuote & { chatId: string }) | null>(null);

  // Load the parent chat for the center context view — only when the active
  // chat is a branch and the tree has no PDF (with a PDF the center belongs
  // to the PDF, unchanged). Die Vorfahren-Kette dagegen wird für JEDEN
  // Branch-Chat geladen: sie füttert das Kontext-Banner in der Chat-Spalte
  // (Variante 3a), das unabhängig vom PDF erscheint.
  useEffect(() => {
    const parentId = activeChat?.parent_id;
    if (!parentId) {
      setParentContext(null);
      setAncestors([]);
      return;
    }
    let active = true;
    if (treePaper) {
      setParentContext(null);
    } else {
      api
        .getChat(parentId)
        .then((c) => {
          if (active) setParentContext(c);
        })
        .catch(() => {
          if (active) setParentContext(null);
        });
    }
    // Fehler degradieren still zur leeren Kette (kein Banner).
    api
      .getAncestors(activeChat.id)
      .then((a) => {
        if (active) setAncestors(a);
      })
      .catch(() => {
        if (active) setAncestors([]);
      });
    return () => {
      active = false;
    };
  }, [activeChat?.id, activeChat?.parent_id, treePaper]);

  // Re-fetch the sidebar tree whenever a chat is created, renamed, or deleted.
  const refreshTree = useCallback(async () => {
    const tree = await api.getTree();
    setChats(tree);
  }, []);

  // Load the sidebar tree on initial render.
  useEffect(() => { refreshTree(); }, [refreshTree]);

  // Modell-System beim Start: (1) Auto-Default anwenden (setzt das empfohlene
  // Modell, falls installiert und nie manuell gewählt — Download-Gate bleibt),
  // (2) Settings, installierte Vision-Modelle und Hardware-Empfehlung laden.
  // Alles non-fatal — ohne Backend rendert die Pille schlicht nichts.
  const refreshModelSystem = useCallback(async () => {
    const [s, models, rec] = await Promise.all([
      api.getSettings().catch(() => null),
      api.getOllamaModels().catch(() => []),
      api.getSystemRecommendation().catch(() => null),
    ]);
    if (s) setSettings(s);
    setOllamaModels(models);
    if (rec) setRecommendation(rec);
  }, []);

  useEffect(() => {
    api.applyRecommendedModel()
      .catch(() => {})
      .finally(() => { refreshModelSystem(); });
  }, [refreshModelSystem]);

  // Modellwechsel aus der Composer-Pille: nur installierte Modelle, wird als
  // manuelle Wahl gespeichert (model_source 'manual' — Automatik bleibt weg).
  const handleSelectModel = async (name: string) => {
    try {
      const s = await api.updateSettings({ ollama_model: name });
      setSettings(s);
    } catch (err) {
      console.error('Failed to switch model:', err);
    }
  };

  // The mindmap toggle is hidden when no chat is active. If the user was in
  // mindmap view and the active chat goes away (e.g. deleted), drop them back
  // into chat view so they don't get stuck without the toggle.
  useEffect(() => {
    if (!activeChatId && viewMode === 'mindmap') setViewMode('chat');
  }, [activeChatId, viewMode]);

  // Verlassene leere Chats aufräumen (Nutzerkorrektur 2026-07-22): Wer einen
  // neuen Chat anlegt, nichts sendet und wegnavigiert, will ihn nicht in der
  // Seitenleiste behalten. Nur unzweifelhaft wertlose Chats werden gelöscht:
  // keine Nachrichten, keine Branches, kein gebundenes PDF, kein laufender
  // Stream — und nur Wurzel-Chats (Branches tragen ihr parent_word als Kontext).
  const cleanupAbandonedChat = (nextId: string) => {
    const prev = activeChat;
    if (
      prev &&
      prev.id !== nextId &&
      !prev.parent_id &&
      prev.messages.length === 0 &&
      prev.children.length === 0 &&
      treePaper === null &&
      streamsForChat(prev.id).length === 0
    ) {
      api.deleteChat(prev.id).then(() => refreshTree()).catch(() => {});
    }
  };

  // Load a chat's messages and mark it as active in the sidebar. The tree's
  // paper is fetched alongside so the three-column view survives a reload
  // (and closes when switching to a tree without a PDF).
  const handleSelectChat = async (id: string) => {
    cleanupAbandonedChat(id);
    setActiveChatId(id);
    activeChatIdRef.current = id;
    setLoadingChat(true);
    try {
      const [chat, paper, video] = await Promise.all([
        api.getChat(id),
        api.getTreePaper(id).catch(() => null),
        api.getTreeVideo(id).catch(() => null),
      ]);
      // Laufen in diesem Chat noch Hintergrund-Streams, deren Teilstand
      // wieder anhängen. Gestartete Jobs: die User-Frage ist serverseitig
      // persistiert (Teil der GET-Antwort), nur die entstehende Assistant-
      // Nachricht kommt aus dem Puffer. Noch WARTENDE Jobs: auch die Frage
      // existiert nur lokal (Insert passiert erst beim Job-Start) — beide
      // Blasen aus dem Puffer wiederherstellen.
      const streams = streamsForChat(id);
      setActiveChat(
        streams.length > 0
          ? { ...chat, messages: [...chat.messages, ...streams.flatMap(materializeStreamMessages)] }
          : chat,
      );
      setTreePaper(paper);
      setTreeVideo(video);
      setTranscriptOpen(false);
      // Prefix-Warm-up (fire-and-forget): das lokale Modell liest Paper +
      // Historie schon jetzt ein — die erste Frage trifft auf warmen Cache.
      // Nicht während ein Stream in diesem Chat läuft (der Prefix ist dann
      // ohnehin heiß; das Backend lehnt Warm-ups bei belegter Warteschlange
      // ohnehin ab).
      if (streams.length === 0) api.warmupChat(id).then(handleWarmupResult).catch(() => {});
    } finally {
      setLoadingChat(false);
    }
  };

  // Der aktuelle Zwischenstand eines Hintergrund-Streams als anzeigbare
  // Nachrichten (gleiche temp-IDs wie beim Absenden, damit weitere Deltas
  // sie nahtlos weiterschreiben). Wartende Jobs liefern auch die User-Frage
  // mit — sie ist noch nirgends persistiert.
  const materializeStreamMessages = (s: ActiveStream): Message[] => {
    const assistant: Message = {
      id: s.tempAssistantId,
      chat_id: s.chatId,
      role: 'assistant',
      content: s.content,
      created_at: s.createdAt,
      ...(s.sources.length > 0 ? { sources: [...s.sources] } : null),
      ...(s.reasoning ? { reasoning: s.reasoning } : null),
      ...(!s.started && s.queuedAhead !== null ? { queuedAhead: s.queuedAhead } : null),
      ...(s.prefillEta !== null ? { prefillEta: s.prefillEta } : null),
    };
    if (s.started || s.isRegenerate) return [assistant];
    const user: Message = {
      id: s.tempUserId,
      chat_id: s.chatId,
      role: 'user',
      content: s.userContent,
      created_at: s.createdAt,
    };
    return [user, assistant];
  };

  // Create a blank chat and immediately open it.
  const handleNewChat = async () => {
    const chat = await api.createChat(S.newChatTitle);
    await refreshTree();
    await handleSelectChat(chat.id);
  };

  // Delete a chat; if it was the active chat, clear the chat area.
  const handleDeleteChat = async (id: string) => {
    // Noch laufende/wartende Streams dieses Chats wären verwaist — abbrechen.
    streamsForChat(id).forEach(s => s.abort.abort());
    await api.deleteChat(id);
    if (activeChatId === id) {
      setActiveChatId(null);
      activeChatIdRef.current = null;
      setActiveChat(null);
      setTreePaper(null);
      setTreeVideo(null);
    }
    await refreshTree();
  };

  // "Upload file" from the plus menu: bind the PDF to the active chat's tree.
  // A 409 from the backend means the tree already has one (ADR-0002) — hold
  // the file and show the new-tree prompt instead.
  const handleUploadPdf = async (file: File) => {
    if (!activeChatId) return;
    try {
      const paper = await api.uploadPaper(activeChatId, file);
      setTreePaper(paper);
      await refreshTree(); // the root node now shows its PDF tag
      // Die Quelle steckt ab jetzt im System-Prompt — der alte KV-Prefix ist
      // wertlos. Sofort wärmen, damit der Paper-Prefill (~60 s kalt, Messung
      // 2026-07-25) läuft, während der Nutzer noch das PDF ansieht, statt
      // erst bei seiner ersten Frage.
      if (activeChatIdRef.current === activeChatId) {
        api.warmupChat(activeChatId).then(handleWarmupResult).catch(() => {});
      }
    } catch (err) {
      if (err instanceof TreeHasSourceError) {
        setPendingAttach({ kind: 'file', file });
        return;
      }
      console.error('Failed to upload PDF:', err);
    }
  };

  // Import from the paper-search modal (Slice 07): download server-side and
  // bind to the active tree. 409 → same new-tree prompt as the upload path.
  // Other errors re-throw so the modal can render them inline.
  const handleImportPaper = async (result: SearchResult) => {
    if (!activeChatId || !result.open_access_pdf_url) return;
    const fallbacks = (result.pdf_candidates || []).filter(
      (u) => u && u !== result.open_access_pdf_url,
    );
    try {
      const paper = await api.importPaperFromUrl(
        activeChatId,
        result.open_access_pdf_url,
        result.title,
        fallbacks,
      );
      setTreePaper(paper);
      setPaperSearchOpen(false);
      await refreshTree();
      // Wie beim Upload: neue Quelle = neuer Prefix → im Hintergrund wärmen.
      if (activeChatIdRef.current === activeChatId) {
        api.warmupChat(activeChatId).then(handleWarmupResult).catch(() => {});
      }
    } catch (err) {
      if (err instanceof TreeHasSourceError) {
        setPaperSearchOpen(false);
        setPendingAttach({
          kind: 'url',
          url: result.open_access_pdf_url,
          title: result.title,
          fallbacks,
        });
        return;
      }
      throw err;
    }
  };

  // Import aus dem "YouTube Transcript"-Modal (ADR-0005): Transkript holen
  // und an den aktiven Baum binden, dann den sichtbaren Auto-Prompt in der
  // App language senden (Amendment 2026-07-24; vorher Untertitel-Spur) —
  // die Antwort ist die Video overview.
  // 409 → gleicher Neuer-Tree-Dialog wie bei Papers; andere Fehler werfen
  // weiter, damit das Modal sie inline zeigt (z. B. no-transcript).
  const handleImportVideo = async (result: VideoSearchResult) => {
    if (!activeChatId) return;
    try {
      const video = await api.importYouTubeVideo(activeChatId, result.youtube_id);
      setYoutubeSearchOpen(false);
      setTreeVideo(video);
      await refreshTree(); // der Root-Knoten zeigt jetzt seinen YT-Tag
      void handleSendMessage(structurePrompt(getAppLanguage()));
    } catch (err) {
      if (err instanceof TreeHasSourceError) {
        setYoutubeSearchOpen(false);
        setPendingAttach({ kind: 'video', youtubeId: result.youtube_id, title: result.title });
        return;
      }
      throw err;
    }
  };

  // Banner-Klick: Drawer öffnen; das Transkript lazy nachladen, wenn nur die
  // Import-Antwort (ohne Transkript) im State liegt.
  const handleOpenTranscript = async () => {
    setTranscriptOpen(true);
    if (treeVideo && !treeVideo.transcript && activeChatId) {
      const full = await api.getTreeVideo(activeChatId).catch(() => null);
      if (full) setTreeVideo(full);
    }
  };

  // Confirmed the new-tree prompt: create a fresh root chat, attach the held
  // source (PDF upload, URL import, or YouTube video) there, and switch to
  // it (handleSelectChat re-fetches the tree's source).
  const handleStartNewTreeWithPdf = async () => {
    const pending = pendingAttach;
    setPendingAttach(null);
    if (!pending) return;
    try {
      const chat = await api.createChat(S.newChatTitle);
      let importedVideo: Video | null = null;
      if (pending.kind === 'file') {
        await api.uploadPaper(chat.id, pending.file);
      } else if (pending.kind === 'url') {
        await api.importPaperFromUrl(chat.id, pending.url, pending.title, pending.fallbacks);
      } else {
        importedVideo = await api.importYouTubeVideo(chat.id, pending.youtubeId);
      }
      await refreshTree();
      await handleSelectChat(chat.id);
      // Auto-Prompt in den frischen Baum — explizite Chat-ID, weil der
      // activeChatId-State in diesem Tick noch den alten Chat trägt.
      if (importedVideo) {
        void handleSendMessage(structurePrompt(getAppLanguage()), [], chat.id);
      }
    } catch (err) {
      console.error('Failed to start a new tree with the source:', err);
    }
  };

  // Rename a chat. Also patch the active chat so the header updates instantly.
  const handleRenameChat = async (id: string, title: string) => {
    await api.renameChat(id, title);
    if (activeChatId === id && activeChat) {
      setActiveChat({ ...activeChat, title });
    }
    await refreshTree();
  };

  // Send a message with optimistic UI and real-time streaming. Der Stream
  // gehört dem Chat, in dem gesendet wurde — wechselt der Nutzer den Chat,
  // läuft er im Hintergrund weiter (Puffer in activeStreamsRef); alle
  // React-State-Updates sind auf prev.id === chatId gewacht, damit Deltas
  // nie in einen fremden Chat schreiben. Resolves, sobald der Stream
  // GESTARTET ist (nicht wenn er fertig ist) — der Composer ist damit sofort
  // wieder frei, weitere Fragen landen in der Backend-Warteschlange (FIFO).
  const handleSendMessage = async (content: string, attachments: LocalAttachment[] = [], targetChatId?: string) => {
    // targetChatId: für programmatische Sends in einen gerade erst
    // gewechselten Chat (Auto-Prompt nach Video-Import in einen neuen Baum) —
    // der activeChatId-State hinkt dem Wechsel um einen Render hinterher.
    const chatId = targetChatId ?? activeChatId;
    if (!chatId) return;

    // Create temporary IDs for the optimistic messages.
    const tempUserId = `temp-user-${crypto.randomUUID()}`;
    const tempAssistantId = `temp-assistant-${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    // Optimistische Anhänge: nur die Felder, die das UI braucht, mit Object-URLs als Vorschau.
    const optimisticAttachments = attachments.map((a, i) => ({
      id: `temp-att-${Date.now()}-${i}`,
      alias: a.alias,
      filename: a.file.name,
      mimetype: a.file.type,
      size: a.file.size,
      url: a.previewUrl || '',
    }));

    // Immediately add the user's message and an empty assistant placeholder
    // so the UI feels instant and shows the streaming cursor right away.
    const tempUser: Message = { id: tempUserId, chat_id: chatId, role: 'user', content, created_at: now, attachments: optimisticAttachments };
    const tempAssistant: Message = { id: tempAssistantId, chat_id: chatId, role: 'assistant', content: '', created_at: now };

    const stream: ActiveStream = {
      chatId,
      tempUserId,
      tempAssistantId,
      userContent: content,
      content: '',
      reasoning: '',
      sources: [],
      createdAt: now,
      queuedAhead: null,
      started: false,
      prefillEta: null,
      isRegenerate: false,
      abort: new AbortController(),
    };
    activeStreamsRef.current.set(tempAssistantId, stream);
    syncStreamIndicators();

    setActiveChat(prev =>
      prev && prev.id === chatId
        ? { ...prev, messages: [...prev.messages, tempUser, tempAssistant] }
        : prev,
    );

    // Objekt-URLs der Vorschau-Bilder erst freigeben, wenn der Stream endet
    // (dann ersetzen die persistierten Server-URLs die optimistische Blase).
    const revokePreviews = () => {
      attachments.forEach(a => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
    };

    void runMessageStream(stream, (h) =>
      api.sendMessageStream(chatId, content, h.onDelta, attachments, h.onToolEvent, {
        think: thinkByChat[chatId] || undefined,
        ...h.opts,
      }),
    ).finally(revokePreviews);
  };

  // Gemeinsamer Kern von Senden und Retry: verdrahtet die Stream-Callbacks
  // mit dem Puffer + React-State, behandelt Warteschlange, Fehler und
  // Abbruch, und räumt die Registry am Ende auf.
  const runMessageStream = async (
    stream: ActiveStream,
    start: (handlers: {
      onDelta: (delta: string) => void;
      onToolEvent: (evt: ToolEvent) => void;
      opts: {
        signal: AbortSignal;
        onThinking: () => void;
        onReasoning: (delta: string) => void;
        onQueued: (ahead: number) => void;
        onStarted: (userMessage: Message) => void;
        onPrefill: (seconds: number) => void;
      };
    }) => Promise<{ userMessage: Message; assistantMessage: Message }>,
  ) => {
    const { chatId, tempUserId, tempAssistantId } = stream;

    // Patcht die Platzhalter-Nachricht — aber nur, wenn ihr Chat gerade
    // sichtbar ist. Der Puffer in `stream` bleibt immer aktuell.
    const patchAssistant = (patch: Partial<Message>) => {
      setActiveChat(prev => {
        if (!prev || prev.id !== chatId) return prev;
        return {
          ...prev,
          messages: prev.messages.map(m => (m.id === tempAssistantId ? { ...m, ...patch } : m)),
        };
      });
    };

    // Denk-Phase dieses Streams: Startzeitpunkt fürs "Thought for Xs"-Label.
    let thinkingStartedAt: number | null = null;

    try {
      const { userMessage, assistantMessage } = await start({
        onDelta: (delta) => {
          stream.content += delta;
          // Erstes Token = Prefill vorbei; die ETA-Zeile verschwindet mit dem
          // Indicator, der Stream-Puffer wird trotzdem sauber gehalten.
          if (stream.prefillEta !== null) stream.prefillEta = null;
          patchAssistant({ content: stream.content });
        },
        onToolEvent: (evt) => {
          // Tool-event from the LLM. Phase 'result' for web_search carries
          // the sources we want to display under the assistant's answer.
          if (evt.phase !== 'result' || evt.name !== 'web_search' || !evt.result?.results) return;
          stream.sources = [...stream.sources, ...evt.result.results];
          patchAssistant({ sources: stream.sources });
        },
        opts: {
          signal: stream.abort.signal,
          onThinking: () => {
            thinkingStartedAt = Date.now();
            // Denk-Phase beginnt = Prefill vorbei.
            if (stream.prefillEta !== null) {
              stream.prefillEta = null;
              patchAssistant({ prefillEta: undefined });
            }
          },
          onReasoning: (delta) => {
            stream.reasoning += delta;
            patchAssistant({ reasoning: stream.reasoning });
          },
          onQueued: (ahead) => {
            stream.queuedAhead = ahead;
            syncStreamIndicators();
            patchAssistant({ queuedAhead: ahead });
          },
          onPrefill: (seconds) => {
            stream.prefillEta = seconds;
            patchAssistant({ prefillEta: seconds });
          },
          onStarted: (userMessage) => {
            // Der Job ist an der Reihe; die Frage ist jetzt persistiert.
            // Optimistische Frage durch die persistierte ersetzen (echter
            // Zeitstempel → chronologisch richtige Position hinter allen
            // inzwischen fertigen Antworten) und den Platzhalter angleichen.
            stream.started = true;
            stream.queuedAhead = null;
            stream.createdAt = userMessage.created_at;
            syncStreamIndicators();
            setActiveChat(prev => {
              if (!prev || prev.id !== chatId) return prev;
              return {
                ...prev,
                messages: prev.messages.map(m =>
                  m.id === tempUserId
                    ? userMessage
                    : m.id === tempAssistantId
                      ? { ...m, created_at: userMessage.created_at, queuedAhead: undefined }
                      : m,
                ),
              };
            });
          },
        },
      });

      // Replace the temporary messages with the real persisted ones from the
      // server — only if this chat is still on screen (a re-select merged the
      // partial back in; the drop-set also covers the real IDs from that GET).
      const thoughtForSeconds = thinkingStartedAt !== null
        ? (Date.now() - thinkingStartedAt) / 1000
        : undefined;
      setActiveChat(prev => {
        if (!prev || prev.id !== chatId) return prev;
        const finalAssistant: Message = {
          ...assistantMessage,
          ...(stream.sources.length > 0 ? { sources: stream.sources } : null),
          ...(thoughtForSeconds !== undefined ? { thoughtForSeconds } : null),
          ...(stream.reasoning ? { reasoning: stream.reasoning } : null),
        };
        const drop = new Set([tempUserId, tempAssistantId, userMessage.id, assistantMessage.id]);
        const filtered = prev.messages.filter(m => !drop.has(m.id));
        return { ...prev, messages: [...filtered, userMessage, finalAssistant] };
      });

      // Refresh the sidebar to pick up the auto-generated title after the first message.
      await refreshTree();

      // Re-Warm-up (fire-and-forget): Nebenaufrufe wie Titel-Generierung oder
      // Summary-Refreshes können Ollamas KV-Prefix verdrängt haben. Aber nur,
      // wenn der Nutzer diesen Chat noch ansieht — sonst würde der Warm-up
      // den Prefix des inzwischen aktiven Chats verdrängen (1 KV-Slot!).
      if (activeChatIdRef.current === chatId) {
        api.warmupChat(chatId).then(handleWarmupResult).catch(() => {});
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        if (!stream.started) {
          // Abbruch im Wartezustand: das Backend hat nichts persistiert —
          // die Frage gilt als nie gestellt. Beim Retry eines persistierten
          // Fehlers bleibt stattdessen die Fehlerzeile stehen.
          if (stream.isRegenerate) {
            patchAssistant({ content: FAILED_MARKER, reasoning: undefined, sources: undefined, queuedAhead: undefined });
          } else {
            setActiveChat(prev => {
              if (!prev || prev.id !== chatId) return prev;
              return {
                ...prev,
                messages: prev.messages.filter(m => m.id !== tempUserId && m.id !== tempAssistantId),
              };
            });
          }
        } else {
          // Stop-Button (Nutzerentscheid 2026-07-22): der Teiltext wird
          // verworfen, es bleibt nur die "Interrupted"-Markierung — das
          // Backend persistiert denselben Marker.
          patchAssistant({ content: INTERRUPTED_MARKER, reasoning: undefined, sources: undefined, queuedAhead: undefined });
          refreshTree().catch(() => {});
          // Der Marker ersetzt die halb generierte Antwort — der KV-Zustand
          // im Slot passt nicht mehr zur Historie, und das Hybrid-Modell
          // (qwen3.5) kann nicht auf den gemeinsamen Punkt zurückspulen:
          // Ohne Warm-up kostet die nächste Frage den vollen Paper-Prefill
          // (82–103 s gemessen, 2026-07-25). Deshalb wie nach normalen
          // Antworten wärmen, solange der Chat noch angezeigt wird.
          if (activeChatIdRef.current === chatId) {
            api.warmupChat(chatId).then(handleWarmupResult).catch(() => {});
          }
        }
      } else if (err instanceof StreamFailedError && err.assistantMessage) {
        // Das Backend hat Frage + '*Failed*'-Marker persistiert: Temps durch
        // die persistierten Nachrichten ersetzen — die Fehlerzeile trägt den
        // Retry-Button und überlebt Reloads.
        const failedUser = err.userMessage;
        const failedAssistant = err.assistantMessage;
        setActiveChat(prev => {
          if (!prev || prev.id !== chatId) return prev;
          const drop = new Set(
            [tempUserId, tempAssistantId, failedUser?.id, failedAssistant.id].filter(Boolean) as string[],
          );
          const filtered = prev.messages.filter(m => !drop.has(m.id));
          return {
            ...prev,
            messages: [...filtered, ...(failedUser && !stream.isRegenerate ? [failedUser] : []), failedAssistant],
          };
        });
        console.error('Failed to generate answer:', err);
        // Auch der persistierte '*Failed*'-Marker ändert die Historie —
        // gleicher Cache-Bruch wie beim Stop-Button (siehe oben).
        if (activeChatIdRef.current === chatId) {
          api.warmupChat(chatId).then(handleWarmupResult).catch(() => {});
        }
      } else {
        // Netzwerk-/Clientfehler ohne persistierte Spur: lokale Fehlerzeile
        // mit Retry — nichts verschwindet mehr stumm (Vorfall 2026-07-24).
        patchAssistant({ content: FAILED_MARKER, reasoning: undefined, sources: undefined, queuedAhead: undefined });
        console.error('Failed to send message:', err);
      }
    } finally {
      // Nur den EIGENEN Eintrag entfernen — der Chat kann weitere Streams haben.
      activeStreamsRef.current.delete(tempAssistantId);
      syncStreamIndicators();
    }
  };

  // Retry-Button der Fehlerzeile. Zwei Fälle: Die Frage wurde nie persistiert
  // (lokaler Sendefehler, temp-ID) → komplett neu senden. Die Frage ist
  // persistiert ('*Failed*'-Marker vom Backend) → regenerate, damit die
  // Frage nicht dupliziert wird.
  const handleRetryMessage = (failed: Message) => {
    const chat = activeChat;
    if (!chat) return;
    const chatId = chat.id;
    const ordered = orderMessages(chat.messages);
    const idx = ordered.findIndex(m => m.id === failed.id);
    if (idx === -1) return;
    const userMsg = ordered.slice(0, idx).reverse().find(m => m.role === 'user');
    if (!userMsg) return;

    if (userMsg.id.startsWith('temp-')) {
      // Frage existiert nur lokal: beide Blasen entfernen und neu senden.
      setActiveChat(prev =>
        prev && prev.id === chatId
          ? { ...prev, messages: prev.messages.filter(m => m.id !== failed.id && m.id !== userMsg.id) }
          : prev,
      );
      void handleSendMessage(userMsg.content, [], chatId);
      return;
    }

    // Frage ist persistiert → Fehlerzeile weicht einem frischen Platzhalter,
    // das Backend erzeugt die Antwort neu (und räumt den Marker weg).
    const tempAssistantId = `temp-assistant-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const stream: ActiveStream = {
      chatId,
      tempUserId: `temp-user-${crypto.randomUUID()}`,
      tempAssistantId,
      userContent: userMsg.content,
      content: '',
      reasoning: '',
      sources: [],
      createdAt: now,
      queuedAhead: null,
      started: false,
      prefillEta: null,
      isRegenerate: true,
      abort: new AbortController(),
    };
    activeStreamsRef.current.set(tempAssistantId, stream);
    syncStreamIndicators();
    setActiveChat(prev =>
      prev && prev.id === chatId
        ? {
            ...prev,
            messages: [
              ...prev.messages.filter(m => m.id !== failed.id),
              { id: tempAssistantId, chat_id: chatId, role: 'assistant', content: '', created_at: now },
            ],
          }
        : prev,
    );

    void runMessageStream(stream, (h) =>
      api.regenerateMessage(chatId, h.onDelta, h.onToolEvent, {
        think: thinkByChat[chatId] || undefined,
        ...h.opts,
      }),
    );
  };

  // Stop-Button im Composer: bricht alle Streams des SICHTBAREN Chats ab
  // (laufende UND wartende) — Hintergrund-Streams anderer Chats laufen weiter.
  const handleStopStreaming = () => {
    if (!activeChatId) return;
    streamsForChat(activeChatId).forEach(s => s.abort.abort());
  };

  // Fetch an explanation for a right-clicked word and show the floating popup.
  const handleWordRightClick = async (wordPopup: WordPopup) => {
    // Word-at-point right-clicks have no selection behind them — reset both
    // selection states so no color row leaks into the definition popup.
    pendingPdfSelectionRef.current = null;
    savedHighlightIdRef.current = null;
    setPopupHasPdfSelection(false);
    pendingChatSelectionRef.current = null;
    savedChatHighlightIdRef.current = null;
    setPopupHasChatSelection(false);
    setPendingChatSelection(null);
    setHoldPdfSelection(false);
    await openPopupWithExplanation(wordPopup);
  };

  // Right-click with a live selection in a chat bubble (right pane or parent
  // context pane): open the popup with the color row + "Ask in chat".
  const handleChatSelection = (sel: ChatSelection, context: string, x: number, y: number) => {
    pendingPdfSelectionRef.current = null;
    savedHighlightIdRef.current = null;
    setPopupHasPdfSelection(false);
    pendingChatSelectionRef.current = sel;
    savedChatHighlightIdRef.current = null;
    setPopupHasChatSelection(true);
    // Auswahl sichtbar halten, bis eine Aktion erfolgt oder das Popup schließt.
    setPendingChatSelection(sel);
    setHoldPdfSelection(false);
    void openPopupWithExplanation({ word: sel.text, context, x, y });
  };

  const openPopupWithExplanation = async (wordPopup: WordPopup) => {
    setPopup(wordPopup);
    setExplanation('');
    setLoadingExplanation(true);
    try {
      // chatId für KV-Prefix-Sharing: die Erklärung nutzt den Gesprächs-
      // Cache, statt ihn zu verdrängen (2026-07-25).
      const res = await api.explainWord(wordPopup.word, wordPopup.context, activeChatIdRef.current ?? undefined);
      setExplanation(res.explanation || S.noDefinition);
    } catch (err) {
      // Without a catch, a backend/Ollama failure produced an empty popup with
      // no feedback. Surface the error so the user knows what happened.
      const msg = err instanceof Error ? err.message : S.unknownError;
      setExplanation(S.couldNotLoadDefinition(msg));
      console.error('explainWord failed:', err);
    } finally {
      setLoadingExplanation(false);
    }
  };

  // Right-click over the PDF: PdfView already captured the selection into
  // pendingPdfSelectionRef (its onCaptureHighlight fires before this). Open
  // the popup with the selected text; the definition uses the surrounding
  // lines as context (Issue 06), not just the selection itself.
  const handlePdfContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const sel = pendingPdfSelectionRef.current;
    if (!sel) return; // no live selection — nothing to define or highlight
    savedHighlightIdRef.current = null;
    setPopupHasPdfSelection(true);
    setPendingChatSelection(null);
    // PdfView hält das Auswahl-Overlay fest, bis Aktion oder Schließen.
    setHoldPdfSelection(true);
    void openPopupWithExplanation({
      word: sel.text,
      context: contextAroundSelection(sel.text),
      x: e.clientX,
      y: e.clientY,
    });
  };

  // Swatch click in the popup (Slice 04): the first pick persists a highlight
  // on the captured selection; further picks recolor that same highlight so
  // trying colors doesn't leave a trail of duplicates. Same contract for chat
  // selections, just against the message-anchored store.
  const handlePickColor = async (color: HighlightColor) => {
    setActiveColor(color);
    // Ab jetzt zeigt das echte (pastellfarbene) Highlight die Auswahl — das
    // Pending-Overlay würde nur doppelt darüberliegen.
    setPendingChatSelection(null);
    setHoldPdfSelection(false);
    if (popupHasChatSelection) {
      const sel = pendingChatSelectionRef.current;
      if (!sel) return;
      const saved = savedChatHighlightIdRef.current;
      if (saved) {
        await hlApiFor(sel.chatId).recolor(saved, color);
        return;
      }
      const created = await hlApiFor(sel.chatId).create({
        messageId: sel.messageId,
        color,
        text: sel.text,
        startOffset: sel.startOffset,
        endOffset: sel.endOffset,
      });
      if (created) savedChatHighlightIdRef.current = created.id;
      return;
    }
    const saved = savedHighlightIdRef.current;
    if (saved) {
      await updateHighlight(saved, { color });
      return;
    }
    const sel = pendingPdfSelectionRef.current;
    if (!sel) return;
    const created = await createHighlight({
      color,
      text: sel.text,
      pageNumber: sel.pageNumber,
      rects: sel.rects,
    });
    if (created) savedHighlightIdRef.current = created.id;
  };

  // Create a child chat branched from the word shown in the popup, then open
  // it. When the popup came from a PDF selection (Slice 06), also save a
  // highlight in the active color linked to the new branch — or link the
  // highlight a swatch click already created.
  const handleOpenChildChat = async (word: string) => {
    if (!activeChatId) return;
    const fromPdf = popupHasPdfSelection;
    const sel = pendingPdfSelectionRef.current;
    const saved = savedHighlightIdRef.current;
    // For chat selections, branch from the chat the selection lives in — that
    // can be the parent-context pane, not just the active chat.
    const chatSel = pendingChatSelectionRef.current;
    const savedChatHl = savedChatHighlightIdRef.current;
    const parentId = popupHasChatSelection && chatSel ? chatSel.chatId : activeChatId;

    // Create the chat FIRST. If the backend is unreachable this used to be an
    // unhandled rejection that left the app dead after the popup had already
    // closed (reported 2026-07-20). Now the popup stays open and shows the
    // error in its body, same pattern as the explainWord failure above.
    let child: Awaited<ReturnType<typeof api.createChat>>;
    try {
      child = await api.createChat(S.aboutChatTitle(word), parentId, word);
    } catch (err) {
      const msg = err instanceof Error ? err.message : S.unknownError;
      setExplanation(S.couldNotCreateChat(msg));
      console.error('createChat failed:', err);
      return;
    }
    setPopup(null);
    pendingPdfSelectionRef.current = null;
    savedHighlightIdRef.current = null;
    pendingChatSelectionRef.current = null;
    savedChatHighlightIdRef.current = null;
    setPopupHasChatSelection(false);
    setPendingChatSelection(null);
    setHoldPdfSelection(false);
    if (!fromPdf && chatSel) {
      setParentScrollTarget({ chatId: chatSel.chatId, messageId: chatSel.messageId });
    }
    try {
      if (fromPdf) {
        if (saved) {
          await updateHighlight(saved, { chatId: child.id });
        } else if (sel) {
          await createHighlight({
            color: activeColor,
            text: sel.text,
            pageNumber: sel.pageNumber,
            rects: sel.rects,
            chatId: child.id,
          });
        }
      } else if (chatSel && !savedChatHl) {
        // Mockup Sektion 03: "The selection that spawned the branch stays
        // visibly highlighted in the parent." Ohne vorherigen Swatch-Klick
        // wird die Selektion in der aktiven Farbe markiert.
        await hlApiFor(chatSel.chatId).create({
          messageId: chatSel.messageId,
          color: activeColor,
          text: chatSel.text,
          startOffset: chatSel.startOffset,
          endOffset: chatSel.endOffset,
        });
      }
      await refreshTree();
      await handleSelectChat(child.id);
    } catch (err) {
      // The chat exists at this point — a failed highlight link or tree
      // refresh must not take the whole app down with it.
      console.error('Open as new chat: follow-up step failed:', err);
    }
  };

  // "Ask in chat" (mockup-chat-highlights-ask-in-chat.html): drop the
  // selection as a removable quote into the ACTIVE chat's composer — no
  // branch is created (that stays "Open as new chat"). Works for selections
  // from the PDF, the parent-context pane, and the active chat itself.
  // Chat-Selektionen werden dabei immer dauerhaft markiert (Nutzerentscheid
  // 2026-07-21): ohne Swatch-Klick entsteht ein Highlight in der aktiven
  // Farbe. Nur PDF-Selektionen bleiben ohne Farbwahl unmarkiert (graue
  // Quote-Leiste).
  const handleAskInChat = (word: string) => {
    if (!activeChatId) return;
    setPopup(null);
    const fromPdf = popupHasPdfSelection;
    const chatSel = pendingChatSelectionRef.current;
    if (chatSel && !savedChatHighlightIdRef.current) {
      void hlApiFor(chatSel.chatId).create({
        messageId: chatSel.messageId,
        color: activeColor,
        text: chatSel.text,
        startOffset: chatSel.startOffset,
        endOffset: chatSel.endOffset,
      });
    }
    const quoteColor =
      savedHighlightIdRef.current || savedChatHighlightIdRef.current || chatSel
        ? activeColor
        : null;
    pendingPdfSelectionRef.current = null;
    savedHighlightIdRef.current = null;
    pendingChatSelectionRef.current = null;
    savedChatHighlightIdRef.current = null;
    setPopupHasPdfSelection(false);
    setPopupHasChatSelection(false);
    setPendingChatSelection(null);
    setHoldPdfSelection(false);

    const sourceLabel = fromPdf
      ? treePaper?.title ?? 'PDF'
      : (chatSel?.chatId === parentContext?.id ? parentContext?.title : activeChat?.title) ??
        S.chatFallbackLabel;
    setComposerQuote({ chatId: activeChatId, text: word, sourceLabel, color: quoteColor });
  };

  // Close the popup and forget the captured selection. A highlight created
  // via a swatch click stays — picking a color IS the save (Issue 04).
  const handleClosePopup = () => {
    setPopup(null);
    pendingPdfSelectionRef.current = null;
    savedHighlightIdRef.current = null;
    setPopupHasPdfSelection(false);
    pendingChatSelectionRef.current = null;
    savedChatHighlightIdRef.current = null;
    setPopupHasChatSelection(false);
    setPendingChatSelection(null);
    setHoldPdfSelection(false);
  };

  // Recolor from the highlight actions menu. The menu stays open (matches
  // Syflo) so adjacent highlights can be compared; patch the menu's copy so
  // the ring moves to the new color immediately.
  const handleMenuChangeColor = async (color: HighlightColor) => {
    const menu = highlightMenu;
    if (!menu) return;
    setHighlightMenu({ ...menu, highlight: { ...menu.highlight, color } });
    await updateHighlight(menu.highlight.id, { color });
  };

  const handleMenuDelete = async () => {
    const menu = highlightMenu;
    setHighlightMenu(null);
    if (menu) await removeHighlight(menu.highlight.id);
  };

  const handleMenuOpenChat = async () => {
    const menu = highlightMenu;
    setHighlightMenu(null);
    if (menu?.highlight.chatId) await handleSelectChat(menu.highlight.chatId);
  };

  // Recolor/delete for an existing chat-text highlight — same menu component
  // and same stays-open recolor semantics as the PDF variant.
  const handleChatMenuChangeColor = async (color: HighlightColor) => {
    const menu = chatHighlightMenu;
    if (!menu) return;
    setChatHighlightMenu({ ...menu, highlight: { ...menu.highlight, color } });
    await hlApiFor(menu.highlight.chatId).recolor(menu.highlight.id, color);
  };

  const handleChatMenuDelete = async () => {
    const menu = chatHighlightMenu;
    setChatHighlightMenu(null);
    if (menu) await hlApiFor(menu.highlight.chatId).remove(menu.highlight.id);
  };

  // ─── Highlights-Drawer (mockup-highlights-overview.html, Variante A) ──────

  // Rechtsklick auf eine Drawer-Karte → dasselbe HighlightActionsMenu wie im
  // Dokument. Die Drawer-Items tragen alle Felder der jeweiligen
  // Highlight-Form, nur `kind` (und bei Chat `chatTitle`) kommt weg.
  const handleDrawerItemContextMenu = (item: TreeHighlight, x: number, y: number) => {
    if (item.kind === 'pdf') {
      const { kind: _kind, ...highlight } = item;
      setHighlightMenu({ highlight, x, y });
    } else {
      const { kind: _kind, chatTitle: _title, ...highlight } = item;
      setChatHighlightMenu({ highlight, x, y });
    }
  };

  // Klick auf eine Drawer-Karte (Grill-Entscheidungen 1+8): PDF-Karten
  // scrollen das PDF punktgenau — der Drawer bleibt offen, das PDF ist ja
  // daneben sichtbar. Chat-Karten wechseln ggf. den Branch, schließen den
  // Drawer (der gescrollte Chat liegt darunter frei) und blinken die
  // Ziel-Nachricht an.
  const handleDrawerJump = (item: TreeHighlight) => {
    if (item.kind === 'pdf') {
      pdfViewRef.current?.scrollToHighlight(item.id);
      return;
    }
    // Panel-Modus (kein PDF/Parent-Kontext, Highlights als rechte Spalte):
    // der Chat liegt frei sichtbar daneben — das Panel bleibt beim Sprung
    // offen (Nutzerkorrektur 2026-07-22). Nur bei Chat-Wechseln schließen:
    // das Ziel kann ein Branch sein, dessen 3-Spalten-Layout den Drawer als
    // Overlay ÜBER den Chat legen würde.
    const panelMode = !treePaper && !parentContext;
    if (!panelMode || item.chatId !== activeChatId) setHighlightsOpen(false);
    const range = { startOffset: item.startOffset, endOffset: item.endOffset, color: item.color };
    if (item.chatId === activeChatId) {
      chatAreaRef.current?.scrollToMessage(item.messageId, range);
    } else {
      pendingChatScrollRef.current = { chatId: item.chatId, messageId: item.messageId, ...range };
      handleSelectChat(item.chatId);
    }
  };

  // Nachgelagertes Scrollen nach einem Branch-Wechsel aus dem Drawer: sobald
  // der Ziel-Chat geladen und gerendert ist, zur Nachricht springen.
  useEffect(() => {
    const pending = pendingChatScrollRef.current;
    if (pending && activeChat?.id === pending.chatId) {
      pendingChatScrollRef.current = null;
      chatAreaRef.current?.scrollToMessage(
        pending.messageId,
        pending.startOffset !== undefined &&
          pending.endOffset !== undefined &&
          pending.color !== undefined
          ? { startOffset: pending.startOffset, endOffset: pending.endOffset, color: pending.color }
          : undefined,
      );
    }
  }, [activeChat]);

  // Klick auf das "Branched from"-Zitat: nicht nur zum Elternchat wechseln,
  // sondern punktgenau zur Quelle des Branches springen (Nutzerkorrektur
  // 2026-07-22) — wie die Drawer-Sprünge: scrollen + aufblinken.
  //   PDF-Branch:  das verlinkte PDF-Highlight (chatId = dieser Chat).
  //   Chat-Branch: das beim Branchen erzeugte Highlight im Elternchat,
  //                gefunden über den Zitat-Text (parent_word).
  //   Ohne Treffer (z. B. Highlight gelöscht): schlichter Wechsel wie bisher.
  const handleBranchedFromClick = async () => {
    const chat = activeChat;
    if (!chat?.parent_id) return;
    const parentId = chat.parent_id;
    const linkedPdfHighlight = highlights.find((h) => h.chatId === chat.id);
    if (linkedPdfHighlight) {
      await handleSelectChat(parentId);
      pdfViewRef.current?.scrollToHighlight(linkedPdfHighlight.id);
      return;
    }
    try {
      const parentHighlights = await api.listMessageHighlights(parentId);
      const quote = chat.parent_word?.trim();
      const match = quote
        ? parentHighlights.find((h) => h.text.trim() === quote)
        : undefined;
      if (match) {
        pendingChatScrollRef.current = {
          chatId: parentId,
          messageId: match.messageId,
          startOffset: match.startOffset,
          endOffset: match.endOffset,
          color: match.color,
        };
      }
    } catch {
      /* Backend nicht erreichbar — dann wenigstens den Chat wechseln */
    }
    await handleSelectChat(parentId);
  };

  return (
    <div className="flex h-screen overflow-hidden bg-white">
      {/* Sidebar: chat list, new chat button, and mind map toggle */}
      <Sidebar
        chats={chats}
        activeChatId={activeChatId}
        onSelect={handleSelectChat}
        onNewChat={handleNewChat}
        onDelete={handleDeleteChat}
        onRename={handleRenameChat}
        viewMode={viewMode}
        onToggleView={() => setViewMode(v => v === 'chat' ? 'mindmap' : 'chat')}
        onOpenSettings={openSettings}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={toggleSidebar}
        streamingChatIds={streamingChatIds}
        queuedChatIds={queuedChatIds}
      />

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Mind map view: shown above the chat when the toggle is active.
            The divider below it drags to resize the map vertically
            (20–80% of the column, persisted). */}
        {viewMode === 'mindmap' && (
          <>
            <div style={{ height: `${mapPaneHeightPct}%` }}>
              <MindMap
                chats={chats}
                activeChatId={activeChatId}
                onSelect={handleSelectChat}
              />
            </div>
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label={S.resizeMindMap}
              data-testid="mindmap-pane-resizer"
              onPointerDown={handleMapPaneResizeStart}
              onPointerMove={handleMapPaneResizeMove}
              onPointerUp={handleMapPaneResizeEnd}
              onPointerCancel={handleMapPaneResizeEnd}
              className="h-1.5 shrink-0 cursor-row-resize bg-gray-200 hover:bg-blue-300 active:bg-blue-400 transition-colors"
            />
          </>
        )}

        {/* Chat area: takes full height in chat mode, or the bottom half in mind map mode.
            With a tree PDF open this becomes the three-column layout
            (design/mockup-pdf-layout.html): PDF center, active branch's chat
            right — the tree stays in the left sidebar. */}
        <div className={`${viewMode === 'mindmap' ? 'flex-1 min-h-0' : 'h-full'} flex overflow-hidden`}>
          {treePaper && activeChatId && (
            <PdfView
              ref={pdfViewRef}
              pdfUrl={treePaper.pdf_url}
              title={treePaper.title ?? undefined}
              highlights={highlights}
              onCaptureHighlight={(sel) => { pendingPdfSelectionRef.current = sel; }}
              onContextMenu={handlePdfContextMenu}
              onColorHighlightClick={(h, e) =>
                setHighlightMenu({ highlight: h, x: e.clientX, y: e.clientY })
              }
              keepSelectionVisible={holdPdfSelection && popup !== null}
            />
          )}
          {/* No-PDF branch layout (mockup-chat-highlights-ask-in-chat.html,
              section 03): the parent chat takes the center pane as read-only
              context while the branch lives in the right pane. */}
          {!treePaper && parentContext && activeChatId && (
            <ParentContextPane
              chat={parentContext}
              highlights={parentChatHl.highlights}
              onOpenChat={handleSelectChat}
              onSelectChat={handleSelectChat}
              onWordRightClick={handleWordRightClick}
              onChatSelection={handleChatSelection}
              onHighlightContextMenu={(h, x, y) => setChatHighlightMenu({ highlight: h, x, y })}
              pendingSelection={pendingChatSelection}
              scrollToMessageId={
                parentScrollTarget?.chatId === parentContext.id
                  ? parentScrollTarget.messageId
                  : null
              }
              onScrollTargetConsumed={() => setParentScrollTarget(null)}
            />
          )}
          {/* Divider between center pane (PDF or parent context) and chat —
              drag to resize the chat column sideways (min 300px, max 800px).
              Only present in the three-column layout. */}
          {(treePaper || parentContext) && activeChatId && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={S.resizeChatColumn}
              data-testid="chat-pane-resizer"
              onPointerDown={handleChatPaneResizeStart}
              onPointerMove={handleChatPaneResizeMove}
              onPointerUp={handleChatPaneResizeEnd}
              onPointerCancel={handleChatPaneResizeEnd}
              className="w-1.5 shrink-0 cursor-col-resize bg-gray-200 hover:bg-blue-300 active:bg-blue-400 transition-colors"
            />
          )}
          <div
            className={
              (treePaper || parentContext) && activeChatId
                ? 'shrink-0 flex overflow-hidden border-l border-gray-200'
                : 'flex-1 flex overflow-hidden'
            }
            style={(treePaper || parentContext) && activeChatId ? { width: chatPaneWidth } : undefined}
            data-testid={(treePaper || parentContext) && activeChatId ? 'chat-pane-right' : undefined}
          >
            <ChatArea
              ref={chatAreaRef}
              chat={activeChat}
              loading={loadingChat}
              streaming={activeChatId ? streamingChatIds.has(activeChatId) || queuedChatIds.has(activeChatId) : false}
              streamingMessageIds={streamingMessageIds}
              onSendMessage={handleSendMessage}
              onRetryMessage={handleRetryMessage}
              onWordRightClick={handleWordRightClick}
              onSelectChat={handleSelectChat}
              onBranchedFromClick={handleBranchedFromClick}
              onUploadPdf={handleUploadPdf}
              onOpenPaperSearch={() => setPaperSearchOpen(true)}
              onOpenYouTubeSearch={() => setYoutubeSearchOpen(true)}
              videoBanner={
                treeVideo ? (
                  <VideoBanner video={treeVideo} onOpenTranscript={() => void handleOpenTranscript()} />
                ) : undefined
              }
              transcriptDrawer={
                treeVideo && transcriptOpen ? (
                  <TranscriptDrawer video={treeVideo} onClose={() => setTranscriptOpen(false)} />
                ) : undefined
              }
              chatHighlights={activeChatHl.highlights}
              onChatSelection={handleChatSelection}
              onHighlightContextMenu={(h, x, y) => setChatHighlightMenu({ highlight: h, x, y })}
              pendingSelection={pendingChatSelection}
              composerQuote={composerQuote && composerQuote.chatId === activeChat?.id ? composerQuote : null}
              onClearComposerQuote={() => setComposerQuote(null)}
              onToggleHighlights={() => setHighlightsOpen((o) => !o)}
              highlightsOpen={highlightsOpen}
              onStopStreaming={handleStopStreaming}
              ancestors={ancestors}
              modelPicker={
                settings?.llm_provider === 'ollama' && activeChatId ? (
                  <ModelPicker
                    activeModel={settings.ollama_model}
                    models={ollamaModels}
                    recommendedModel={recommendation?.recommendedModel ?? null}
                    onSelectModel={handleSelectModel}
                    think={Boolean(thinkByChat[activeChatId])}
                    onToggleThink={() =>
                      setThinkByChat(prev => ({ ...prev, [activeChatId]: !prev[activeChatId] }))
                    }
                    onOpenSettings={() => openSettings('model')}
                    disabled={streamingChatIds.has(activeChatId)}
                    gpuWarning={gpuWarning}
                  />
                ) : null
              }
              highlightsDrawer={
                // Nur im 3-Spalten-Layout als Overlay über der Chat-Spalte —
                // ohne PDF/Parent-Kontext rendert die rechte Panel-Spalte unten.
                highlightsOpen && activeChatId && (treePaper || parentContext) ? (
                  <HighlightsDrawer
                    chatId={activeChatId}
                    onClose={() => setHighlightsOpen(false)}
                    onJump={handleDrawerJump}
                    onItemContextMenu={handleDrawerItemContextMenu}
                  />
                ) : null
              }
            />
          </div>
          {/* Chat allein in voller Breite (kein PDF, kein Parent-Kontext):
              Highlights als eigene RECHTE Seitenspalte neben dem Chat statt
              als Overlay über der ganzen Seite (Nutzerentscheidung
              2026-07-22) — Highlights und Chat bleiben gleichzeitig
              sichtbar. */}
          {!treePaper && !parentContext && activeChatId && highlightsOpen && (
            <div className="w-96 shrink-0 overflow-hidden" data-testid="highlights-panel-right">
              <HighlightsDrawer
                variant="panel"
                chatId={activeChatId}
                onClose={() => setHighlightsOpen(false)}
                onJump={handleDrawerJump}
                onItemContextMenu={handleDrawerItemContextMenu}
              />
            </div>
          )}
        </div>
      </div>

      {/* New-tree prompt: shown when an attach hit a tree that already has a
          source (ADR-0002/0005). Confirming moves it into a fresh chat tree. */}
      {pendingAttach && (
        <div
          className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center"
          data-testid="new-tree-prompt"
        >
          <div className="bg-white rounded-xl shadow-xl w-[26rem] max-w-[calc(100vw-2rem)] p-6">
            <div className="flex items-center gap-2.5 mb-2">
              <FileText size={18} className="text-blue-500 shrink-0" />
              <h3 className="text-[15px] font-medium text-gray-900">{S.newTreeTitle}</h3>
            </div>
            <p className="text-sm text-gray-600 leading-relaxed mb-5">
              {S.newTreeLead}{' '}
              {S.newTreeAskPrefix}
              <span className="font-medium text-gray-800">
                {pendingAttach.kind === 'file' ? pendingAttach.file.name : pendingAttach.title}
              </span>
              {S.newTreeAskSuffix}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setPendingAttach(null)}
                className="px-3.5 py-1.5 rounded-lg text-sm text-gray-700 border border-gray-200 hover:bg-gray-50 transition-colors"
                data-testid="new-tree-cancel"
              >
                {S.cancel}
              </button>
              <button
                onClick={handleStartNewTreeWithPdf}
                className="px-3.5 py-1.5 rounded-lg text-sm text-white bg-blue-500 hover:bg-blue-600 transition-colors"
                data-testid="new-tree-confirm"
              >
                {S.startNewTree}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Settings-Modal — App-eigen, damit Sidebar-Zahnrad UND Composer-Pille
          es öffnen können. onSaved hält die Pille synchron; nach Downloads/
          Löschungen in der Bibliothek wird das Modell-System neu geladen. */}
      <SettingsModal
        open={settingsOpen}
        onClose={() => { setSettingsOpen(false); refreshModelSystem(); }}
        onSaved={setSettings}
        initialTab={settingsTab}
        recommendation={recommendation}
        onLibraryChanged={async () => {
          // Nach einem Download darf die Automatik greifen (nur bei
          // model_source 'auto' — manuelle Wahl gewinnt immer).
          await api.applyRecommendedModel().catch(() => {});
          await refreshModelSystem();
        }}
      />

      {/* Floating popup: appears near the right-clicked word with its explanation.
          For PDF selections it also shows the highlight color row. */}
      <FloatingPopup
        popup={popup}
        explanation={explanation}
        loading={loadingExplanation}
        onClose={handleClosePopup}
        onOpenChildChat={handleOpenChildChat}
        onPickColor={popupHasPdfSelection || popupHasChatSelection ? handlePickColor : undefined}
        activeColor={activeColor}
        onAskInChat={popupHasPdfSelection || popupHasChatSelection ? handleAskInChat : undefined}
      />

      {/* Paper-search modal (Slice 07): search OpenAlex + arXiv and import
          an open-access PDF into the active chat tree. */}
      {paperSearchOpen && activeChatId && (
        <PaperSearchModal
          onClose={() => setPaperSearchOpen(false)}
          onImport={handleImportPaper}
        />
      )}

      {/* Video-Such-Modal (ADR-0005): YouTube über die lokale SearXNG-
          Instanz durchsuchen und das Transkript an den aktiven Baum binden. */}
      {youtubeSearchOpen && activeChatId && (
        <YouTubeSearchModal
          onClose={() => setYoutubeSearchOpen(false)}
          onImport={handleImportVideo}
        />
      )}

      {/* Actions menu for an existing highlight: recolor / delete / open
          linked chat (Slice 06). */}
      {highlightMenu && (
        <HighlightActionsMenu
          highlight={highlightMenu.highlight}
          x={highlightMenu.x}
          y={highlightMenu.y}
          onClose={() => setHighlightMenu(null)}
          onChangeColor={handleMenuChangeColor}
          onDelete={handleMenuDelete}
          onOpenChat={handleMenuOpenChat}
        />
      )}

      {/* Actions menu for an existing chat-text highlight: recolor / delete.
          chatId: null hides "Open linked chat" — chat highlights don't link
          to branches (the message itself lives in a chat already). */}
      {chatHighlightMenu && (
        <HighlightActionsMenu
          highlight={{ color: chatHighlightMenu.highlight.color, chatId: null }}
          x={chatHighlightMenu.x}
          y={chatHighlightMenu.y}
          onClose={() => setChatHighlightMenu(null)}
          onChangeColor={handleChatMenuChangeColor}
          onDelete={handleChatMenuDelete}
          onOpenChat={() => setChatHighlightMenu(null)}
        />
      )}
    </div>
  );
}
