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

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { FileText } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { MatrixRain } from './components/MatrixRain';
import { ChatArea, type ChatAreaHandle } from './components/ChatArea';
import { ModelPicker } from './components/ChatArea/ModelPicker';
import { CloudSetupNotice } from './components/ChatArea/CloudSetupNotice';
import { SettingsModal, type SettingsTab } from './components/SettingsModal';
import { FeedbackDialog } from './components/FeedbackDialog';
import { MindMap } from './components/MindMap';
import { ParentContextPane } from './components/ParentContextPane';
import { MathText } from './components/MathText';
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
import { TextSmoother } from './streaming/TextSmoother';
import { orderMessages } from './chat/messageOrder';
import { buildPickerGroups } from './chat/pickerGroups';
import { awaitTitle, startPassageTitle, type PendingTitle } from './chat/passageTitle';
import { useHighlights } from './hooks/useHighlights';
import { useChatHighlights } from './hooks/useChatHighlights';
import { contextAroundSelection } from './pdf/selection';
import { CLOUD_PROVIDERS, FAILED_MARKER, INTERRUPTED_MARKER } from './types';
import type { Chat, ChatDetail, ChatSelection, ComposerQuote, FailoverInfo, Highlight, HighlightColor, LLMProvider, LocalAttachment, Message, MessageHighlight, OllamaModelInfo, Paper, Registry, SearchResult, SearchSource, Settings, ToolEvent, TreeHighlight, Video, VideoSearchResult, WordPopup } from './types';

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
  // Queue transparency (mockup-model-flow §07): the local model that will
  // answer this waiting question (chip on the queued note) and the chat +
  // question the queue is answering RIGHT NOW (jump link when it is another
  // chat). Both live only while queuedAhead does.
  queuedModel: string | null;
  queuedCurrent: { chatId: string; question: string } | null;
  started: boolean;
  // Visible auto-retry after a cloud provider 429 (ADR-0008) — null as soon
  // as the next attempt delivers tokens.
  rateLimit: { retryInSeconds: number; attempt: number; scope?: 'requests' | 'tokens'; model?: string } | null;
  // Another provider stepped in for this answer (ADR-0008 failover). Unlike
  // rateLimit this STAYS for the whole answer — it explains who it is from.
  failover: FailoverInfo | null;
  // Smooth reveal of the streamed answer text (fast cloud models would make
  // paragraphs "pop"). Lives on the stream, not in a component, so a chat
  // switch mid-stream loses nothing; `content` above always holds the
  // REVEALED prefix — the persisted final text comes from the backend.
  smoother: TextSmoother | null;
  // Retry eines persistierten '*Failed*'-Markers: es gibt keine optimistische
  // User-Blase, und ein Abbruch im Wartezustand stellt die Fehlerzeile wieder
  // her, statt Blasen zu entfernen.
  isRegenerate: boolean;
  // Die id des ersetzten *Failed*-Markers (anchored retry). Die Restore-Pfade
  // stellen den Marker unter DIESER id wieder her — eine Temp-id würde den
  // nächsten Retry mit einer dem Backend unbekannten messageId losschicken.
  regenerateOfId: string | null;
  abort: AbortController;
}

export default function App() {
  // UI-Texte in der App language — re-rendert beim Sprachwechsel mit.
  const STR = useStrings();
  const S = STR.app;
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

  // Installierte Vision-Modelle (Backend filtert) — füttert die
  // Composer-Pille und die Settings-Modell-Liste.
  const [ollamaModels, setOllamaModels] = useState<OllamaModelInfo[]>([]);
  // Honest local state (mockup-model-flow §02): running-with-zero-vision-
  // models is a different situation from "not reachable".
  const [ollamaReachable, setOllamaReachable] = useState(true);
  // Bumped after stream errors: the picker refreshes cooldown badges and
  // the pill dot from it (refresh moments, §03 — no polling).
  const [modelSystemSignal, setModelSystemSignal] = useState(0);

  // Model registry (ADR-0008): cloud shortlists for the composer pill.
  // null while not loaded — the pill then shows only the active model.
  const [registry, setRegistry] = useState<Registry | null>(null);

  // Quota card v3 "Modell wechseln": every increment opens the composer's
  // model picker drop-up (counter, so repeated clicks re-open it).
  const [pickerOpenSignal, setPickerOpenSignal] = useState(0);

  // Auto-retry after "Modell wechseln" (user decision 2026-07-29): the card
  // that opened the picker arms its failed message here; the next pick that
  // actually changes the model retries it immediately — one click less than
  // pick + "Erneut versuchen". Closing the menu without a pick disarms, so
  // later unrelated switches via the pill never resurrect an old retry.
  const pickerRetryTargetRef = useRef<Message | null>(null);
  const handlePickerMenuChange = useCallback((open: boolean) => {
    if (!open) pickerRetryTargetRef.current = null;
  }, []);

  // Timestamp of the last settings change — model switch, provider switch
  // or key save (settingsChangedAt generalizes modelSwitchedAt,
  // mockup-model-flow §05): quota and failReason cards older than this show
  // an enabled retry again — the new configuration may succeed where the
  // old one failed. Transient by design, like the cards themselves.
  const [settingsChangedAt, setSettingsChangedAt] = useState<string | null>(null);

  // Display label per model name (all providers flattened) — resolves model
  // names in the failover note. Empty while the registry is not loaded.
  const modelLabels = useMemo(() => {
    const map: Record<string, string> = {};
    if (registry) {
      for (const provider of Object.values(registry.providers)) {
        for (const m of provider.models) map[m.name] = m.label;
      }
    }
    return map;
  }, [registry]);

  // Display label per provider id — resolves the provider named by the
  // no_key/bad_key cards (mockup-model-flow §05). Raw id as fallback.
  const providerLabels = useMemo(() => {
    const map: Record<string, string> = {};
    if (registry) {
      for (const [id, provider] of Object.entries(registry.providers)) {
        if (provider.label) map[id] = provider.label;
      }
    }
    return map;
  }, [registry]);

  // Privacy guard (mockup-model-flow §11): the ONE explicit, named cloud
  // exit of the local_missing card — the first cloud provider with a stored
  // key and its configured model. null hides the button entirely.
  const cloudFallback = useMemo(() => {
    if (!settings) return null;
    for (const p of CLOUD_PROVIDERS) {
      if (settings[`${p}_api_key_set`]) {
        const model = settings[`${p}_model`];
        return {
          provider: p,
          providerLabel: providerLabels[p] ?? p,
          model,
          modelLabel: modelLabels[model] ?? model,
        };
      }
    }
    return null;
  }, [settings, providerLabels, modelLabels]);

  // W4 billing card (cost tiers 2026-07-30): the first FREE model among the
  // keyed cloud providers, active provider first — "Mit Gemini Flash
  // antworten" instead of retrying a model that fails deterministically.
  const freeFallback = useMemo(() => {
    if (!settings || !registry) return null;
    const order = [...CLOUD_PROVIDERS].sort((a, b) =>
      a === settings.llm_provider ? -1 : b === settings.llm_provider ? 1 : 0,
    );
    for (const p of order) {
      if (!settings[`${p}_api_key_set`]) continue;
      const model = registry.providers[p]?.models.find(m => m.free !== false);
      if (model) {
        return {
          provider: p,
          providerLabel: providerLabels[p] ?? p,
          model: model.name,
          modelLabel: model.label ?? model.name,
        };
      }
    }
    return null;
  }, [settings, registry, providerLabels]);

  // Settings-Modal gehört der App (der Picker und die Sidebar öffnen es).
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('appearance');
  // Optional provider preselection (W9 path chooser, 2026-07-30): each
  // setup path lands on the matching provider card.
  const [settingsProvider, setSettingsProvider] = useState<LLMProvider | null>(null);
  const openSettings = useCallback((tab: SettingsTab, provider?: LLMProvider) => {
    setSettingsTab(tab);
    setSettingsProvider(provider ?? null);
    setSettingsOpen(true);
  }, []);

  // Feedback-Dialog (ADR-0010) — gehört der App wie das Settings-Modal:
  // Sidebar-Button und /feedback-Composer-Command öffnen ihn beide.
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackInitialText, setFeedbackInitialText] = useState('');

  // Thinking pro Chat (Grill 2026-07-21): der Schalter gilt für den Chat,
  // bis er wieder ausgeschaltet wird — nicht global, nicht pro Nachricht.
  const [thinkByChat, setThinkByChat] = useState<Record<string, boolean>>({});

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

  // Selection captured by PdfView at mouseup time — read when the user
  // picks a color or opens a branch, so the highlight can be saved even
  // though the live Selection collapses when focus moves into the popup.
  const pendingPdfSelectionRef = useRef<PdfHighlightSelection | null>(null);
  // Highlight already saved for the current popup's selection (first color
  // pick creates it; further picks recolor it; "Open as new chat" links it).
  const savedHighlightIdRef = useRef<string | null>(null);
  // In-flight create request from a swatch click, if any — "Open as new
  // chat" awaits this before reading savedHighlightIdRef, otherwise a click
  // right after a swatch click reads the ref before it's set and creates a
  // second, unlinked highlight on the same selection (reported 2026-07-31).
  const pdfHighlightCreatePromiseRef = useRef<Promise<unknown> | null>(null);
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

  // Message-anchored highlights, one hook instance per visible chat pane.
  const activeChatHl = useChatHighlights(activeChatId);
  const parentChatHl = useChatHighlights(parentContext?.id ?? null);
  // Route create/recolor/remove to the pane that owns the chat.
  const hlApiFor = (chatId: string) =>
    chatId === parentContext?.id ? parentChatHl : activeChatHl;

  // Selection captured from a chat bubble at mouseup time — the chat twin
  // of pendingPdfSelectionRef.
  const pendingChatSelectionRef = useRef<ChatSelection | null>(null);
  const savedChatHighlightIdRef = useRef<string | null>(null);
  // Title lookup for the passage in the open popup — started when the popup
  // opens, consumed when a branch is created (chat/passageTitle.ts).
  const pendingTitleRef = useRef<PendingTitle | null>(null);
  // Chat twin of pdfHighlightCreatePromiseRef — same race, same fix.
  const chatHighlightCreatePromiseRef = useRef<Promise<unknown> | null>(null);
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
  // to the PDF, unchanged).
  //
  // The inherited-context banner that used to sit under the chat header was
  // dropped 2026-08-01 (user request): it read as an overloaded strip and
  // duplicated what the center pane already shows in full. The inheritance
  // itself is unchanged — the backend still sends the ancestor summaries with
  // every message; only the UI that narrated it is gone.
  useEffect(() => {
    const parentId = activeChat?.parent_id;
    if (!parentId) {
      setParentContext(null);
      return;
    }
    if (treePaper) {
      setParentContext(null);
      return;
    }
    let active = true;
    api
      .getChat(parentId)
      .then((c) => {
        if (active) setParentContext(c);
      })
      .catch(() => {
        if (active) setParentContext(null);
      });
    return () => {
      active = false;
    };
    // activeChat?.id stays in the deps although the fetch no longer uses it:
    // switching back from the parent chat into the branch must re-read the
    // parent so the center pane shows messages added in the meantime.
  }, [activeChat?.id, activeChat?.parent_id, treePaper]);

  // Re-fetch the sidebar tree whenever a chat is created, renamed, or deleted.
  const refreshTree = useCallback(async () => {
    const tree = await api.getTree();
    setChats(tree);
    // The chat header reads activeChat.title, a separate state object: mirror
    // the fresh tree title into it, or the header keeps showing the stale
    // "New Chat" after the backend auto-titles the first answer.
    setActiveChat(prev => {
      if (!prev) return prev;
      const findById = (nodes: Chat[], id: string): Chat | null => {
        for (const n of nodes) {
          if (n.id === id) return n;
          const hit = n.children ? findById(n.children, id) : null;
          if (hit) return hit;
        }
        return null;
      };
      const fresh = findById(tree, prev.id);
      return fresh && fresh.title !== prev.title ? { ...prev, title: fresh.title } : prev;
    });
  }, []);

  // Load the sidebar tree on initial render.
  useEffect(() => { refreshTree(); }, [refreshTree]);

  // Model system at startup: load settings, installed vision models and
  // the model registry (ADR-0008). All non-fatal — without a backend the
  // pill simply renders nothing. The hardware-recommendation automation was
  // removed with the ADR-0008 amendment (frozen fallback).
  const refreshModelSystem = useCallback(async () => {
    const [s, ollama, reg] = await Promise.all([
      api.getSettings().catch(() => null),
      api.getOllamaStatus().catch(() => ({ reachable: false, models: [] as OllamaModelInfo[] })),
      api.getRegistry().catch(() => null),
    ]);
    if (s) setSettings(s);
    setOllamaModels(ollama.models);
    setOllamaReachable(ollama.reachable);
    if (reg) setRegistry(reg);
  }, []);

  useEffect(() => { refreshModelSystem(); }, [refreshModelSystem]);

  // Refresh moment "window focus" (§03): the user may have started Ollama
  // or pulled a model since the app lost focus — hasLocalModel and the
  // picker's local state must not stay stale exactly when they matter.
  useEffect(() => {
    const onFocus = () => { void refreshModelSystem(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshModelSystem]);

  // Model switch from the grouped composer pill (mockup-model-flow §02):
  // selecting any row switches provider AND model in one click. Ollama:
  // installed models only. Cloud: the provider's own model field
  // (`<provider>_model`, ADR-0008).
  const handleSelectModel = async (provider: LLMProvider, name: string) => {
    // Consume the armed card retry BEFORE the async write — the menu's
    // close notification fires right after the pick and clears the ref.
    const retryTarget = pickerRetryTargetRef.current;
    pickerRetryTargetRef.current = null;
    const sameAsActive =
      settings !== null &&
      settings.llm_provider === provider &&
      (provider === 'ollama' ? settings.ollama_model : settings[`${provider}_model`]) === name;
    const patch: Parameters<typeof api.updateSettings>[0] = { llm_provider: provider };
    if (provider === 'ollama') patch.ollama_model = name;
    else (patch as Record<string, string>)[`${provider}_model`] = name;
    try {
      const s = await api.updateSettings(patch);
      setSettings(s);
      // Quota/failReason cards created BEFORE this switch re-offer retry
      // (user request 2026-07-26): the newly picked model may have budget
      // the failed ladder did not — the card compares this stamp to its
      // created_at.
      setSettingsChangedAt(new Date().toISOString());
    } catch (err) {
      console.error('Failed to switch model:', err);
      return;
    }
    // Auto-retry (user decision 2026-07-29): a pick that reached the menu
    // via a failure card's "Modell wechseln" retries THAT answer right away
    // — after the settings write, so the regenerate runs on the new model.
    // Re-picking the active model keeps the old behavior (card + enabled
    // retry): the identical request would fail identically.
    if (retryTarget && !sameAsActive) handleRetryMessage(retryTarget);
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
      // Persist-at-enqueue (mockup-model-flow §10): a WAITING job's question
      // now exists twice — as pending row in the GET answer AND as buffered
      // optimistic bubble. The buffer wins (it keeps streaming seamlessly);
      // matching pending rows are dropped from the merged view.
      const waiting = streams.filter(s => !s.started && !s.isRegenerate);
      const merged = waiting.length > 0
        ? chat.messages.filter(
            m => !(m.role === 'user' && m.pending && waiting.some(s => s.userContent === m.content)),
          )
        : chat.messages;
      setActiveChat(
        streams.length > 0
          ? { ...chat, messages: [...merged, ...streams.flatMap(materializeStreamMessages)] }
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
      if (streams.length === 0) api.warmupChat(id).catch(() => {});
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
      ...(!s.started && s.queuedAhead !== null
        ? {
            queuedAhead: s.queuedAhead,
            ...(s.queuedModel !== null ? { queuedModel: s.queuedModel } : null),
            ...(s.queuedCurrent !== null ? { queuedCurrent: s.queuedCurrent } : null),
          }
        : null),
      ...(s.rateLimit !== null ? { rateLimit: s.rateLimit } : null),
      ...(s.failover !== null ? { failover: s.failover } : null),
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
        api.warmupChat(activeChatId).catch(() => {});
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
        api.warmupChat(activeChatId).catch(() => {});
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
      queuedModel: null,
      queuedCurrent: null,
      started: false,
      rateLimit: null,
      failover: null,
      smoother: null,
      isRegenerate: false,
      regenerateOfId: null,
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
        onQueued: (
          ahead: number,
          info?: { model?: string; current?: { chatId: string; question: string } },
        ) => void;
        onStarted: (userMessage: Message) => void;
        onRateLimit: (info: { retryInSeconds: number; attempt: number; scope?: 'requests' | 'tokens'; model?: string }) => void;
        onFailover: (info: FailoverInfo) => void;
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

    // Smooth reveal of the content channel only (reasoning stays raw): the
    // smoother owns `stream.content`, ticking revealed prefixes into the
    // buffer + visible bubble. Flushed on done/error/abort below.
    stream.smoother = new TextSmoother({
      onReveal: (visible) => {
        stream.content = visible;
        patchAssistant({ content: visible });
      },
    });

    // Denk-Phase dieses Streams: Startzeitpunkt fürs "Thought for Xs"-Label.
    let thinkingStartedAt: number | null = null;

    try {
      const { userMessage, assistantMessage } = await start({
        onDelta: (delta) => {
          // Tokens flowing again = the rate-limit retry succeeded.
          if (stream.rateLimit !== null) {
            stream.rateLimit = null;
            patchAssistant({ rateLimit: undefined });
          }
          // Content is revealed smoothly — the smoother updates
          // stream.content + the bubble via onReveal.
          stream.smoother?.push(delta);
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
          },
          onReasoning: (delta) => {
            stream.reasoning += delta;
            // Reasoning chunks flowing = the rate-limit retry succeeded.
            if (stream.rateLimit !== null) {
              stream.rateLimit = null;
              patchAssistant({ reasoning: stream.reasoning, rateLimit: undefined });
              return;
            }
            patchAssistant({ reasoning: stream.reasoning });
          },
          onQueued: (ahead, info) => {
            stream.queuedAhead = ahead;
            // Queue transparency (§07): the model that will answer this
            // waiting question (a switch while waiting updates it live) and
            // the chat+question being answered right now (jump link).
            stream.queuedModel = info?.model ?? null;
            stream.queuedCurrent = info?.current ?? null;
            syncStreamIndicators();
            patchAssistant({
              queuedAhead: ahead,
              queuedModel: info?.model,
              queuedCurrent: info?.current,
            });
          },
          onRateLimit: (info) => {
            // Cloud provider 429: the backend waits out Retry-After and tries
            // again — the bubble shows the countdown meanwhile (same spot as
            // the queued line).
            stream.rateLimit = info;
            patchAssistant({ rateLimit: info });
          },
          onFailover: (info) => {
            // Another provider with a stored key steps in for this answer
            // (limit on the active model; the global setting is unchanged).
            // The note stays with the answer — it explains who it is from.
            // Multi-hop ladders (A→B→C, §11): keep the ORIGINAL from/
            // fromModel of the FIRST hop — the note must name the model the
            // user chose, not the last intermediate hop; destination, model
            // and reason come from the latest event.
            const merged: FailoverInfo = stream.failover
              ? { ...info, from: stream.failover.from, fromModel: stream.failover.fromModel }
              : info;
            stream.failover = merged;
            patchAssistant({ failover: merged });
          },
          onStarted: (userMessage) => {
            // Der Job ist an der Reihe; die Frage ist jetzt persistiert.
            // Optimistische Frage durch die persistierte ersetzen (echter
            // Zeitstempel → chronologisch richtige Position hinter allen
            // inzwischen fertigen Antworten) und den Platzhalter angleichen.
            // Anchored retry: der Platzhalter behält den Marker-Zeitstempel
            // (seine Position), statt zur User-Frage zu springen.
            stream.started = true;
            stream.queuedAhead = null;
            stream.queuedModel = null;
            stream.queuedCurrent = null;
            if (!stream.isRegenerate) stream.createdAt = userMessage.created_at;
            syncStreamIndicators();
            setActiveChat(prev => {
              if (!prev || prev.id !== chatId) return prev;
              return {
                ...prev,
                messages: prev.messages.map(m =>
                  m.id === tempUserId
                    ? userMessage
                    : m.id === tempAssistantId
                      ? { ...m, created_at: stream.createdAt, queuedAhead: undefined, queuedModel: undefined, queuedCurrent: undefined }
                      : m,
                ),
              };
            });
          },
        },
      });

      // Stream done: drain what is still buffered AT THE PACED RATE before
      // the swap below — an instant flush here bypassed the smoothing for
      // very fast models (Groq delivers everything before the first ticks;
      // live report 2026-07-26). Errors/aborts below still flush instantly.
      await stream.smoother?.finish();

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
          ...(stream.failover !== null ? { failover: stream.failover } : null),
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
        api.warmupChat(chatId).catch(() => {});
      }
    } catch (err) {
      // Stop the reveal timer FIRST: the *Failed*/*Interrupted* patches below
      // must not be overwritten by a late reveal tick.
      stream.smoother?.flush();
      if (err instanceof DOMException && err.name === 'AbortError') {
        if (!stream.started) {
          // Abbruch im Wartezustand: das Backend hat nichts persistiert —
          // die Frage gilt als nie gestellt. Beim Retry eines persistierten
          // Fehlers bleibt stattdessen die Fehlerzeile stehen — unter ihrer
          // ORIGINAL-id: der alte Marker existiert serverseitig noch (der
          // Job startete nie), und nur mit echter id trifft der nächste
          // Retry-Klick eine dem Backend bekannte messageId.
          if (stream.isRegenerate) {
            setActiveChat(prev => {
              if (!prev || prev.id !== chatId) return prev;
              return {
                ...prev,
                messages: prev.messages.map(m =>
                  m.id === tempAssistantId
                    ? {
                        id: stream.regenerateOfId ?? tempAssistantId,
                        chat_id: chatId,
                        role: 'assistant' as const,
                        content: FAILED_MARKER,
                        created_at: stream.createdAt,
                      }
                    : m,
                ),
              };
            });
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
          patchAssistant({ content: INTERRUPTED_MARKER, reasoning: undefined, sources: undefined, queuedAhead: undefined, queuedModel: undefined, queuedCurrent: undefined, rateLimit: undefined });
          refreshTree().catch(() => {});
          // Der Marker ersetzt die halb generierte Antwort — der KV-Zustand
          // im Slot passt nicht mehr zur Historie, und das Hybrid-Modell
          // (qwen3.5) kann nicht auf den gemeinsamen Punkt zurückspulen:
          // Ohne Warm-up kostet die nächste Frage den vollen Paper-Prefill
          // (82–103 s gemessen, 2026-07-25). Deshalb wie nach normalen
          // Antworten wärmen, solange der Chat noch angezeigt wird.
          if (activeChatIdRef.current === chatId) {
            api.warmupChat(chatId).catch(() => {});
          }
        }
      } else if (err instanceof StreamFailedError && err.assistantMessage) {
        // Das Backend hat Frage + '*Failed*'-Marker persistiert: Temps durch
        // die persistierten Nachrichten ersetzen — die Fehlerzeile trägt den
        // Retry-Button und überlebt Reloads. failedUser wird IMMER wieder
        // eingefügt: das Drop-Set entfernt eine schon vorhandene Kopie per
        // id, Weglassen wäre also nie nötig — und ließ beim Regenerate die
        // Frage verschwinden, sobald das Fehler-Payload sie mitlieferte
        // (Live-Regression 2026-07-25).
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
            messages: [
              ...filtered,
              ...(failedUser ? [failedUser] : []),
              // quotaExhausted (+ retryAt) transient anheften: die Fehler-
              // zeile bietet dann den Notfall-Weg übers lokale Modell an und
              // taktet ihren Retry-Button nach retryAt (ADR-0008). failReason
              // (+ Provider/Modell) wählt die ehrliche Karte statt der
              // generischen Zeile (mockup-model-flow §05).
              {
                ...failedAssistant,
                // failProvider rides along for quota errors too (§08): the
                // "Raise limit" link targets the provider that hit the limit.
                ...(err.quotaExhausted ? { quotaExhausted: true, retryAt: err.retryAt, quotaReason: err.quotaReason, failProvider: err.failProvider } : null),
                ...(err.failReason ? { failReason: err.failReason, failProvider: err.failProvider, failModel: err.failModel } : null),
              },
            ],
          };
        });
        console.error('Failed to generate answer:', err);
        // Auch der persistierte '*Failed*'-Marker ändert die Historie —
        // gleicher Cache-Bruch wie beim Stop-Button (siehe oben).
        if (activeChatIdRef.current === chatId) {
          api.warmupChat(chatId).catch(() => {});
        }
      } else if (!(err instanceof StreamFailedError) && stream.started && stream.content) {
        // Connection drop MID-ANSWER (mockup-model-flow §09): the backend's
        // catch-all persisted *Interrupted* — render the interrupted row
        // (its retry reconciles via non-anchored regenerate), never a failed
        // row whose anchored retry would 409 forever.
        patchAssistant({ content: INTERRUPTED_MARKER, reasoning: undefined, sources: undefined, queuedAhead: undefined, queuedModel: undefined, queuedCurrent: undefined, rateLimit: undefined });
        console.error('Stream dropped mid-answer:', err);
      } else {
        // Netzwerk-/Clientfehler ohne persistierte Spur: lokale Fehlerzeile —
        // nichts verschwindet mehr stumm (Vorfall 2026-07-24). Fehler, die
        // der Client selbst erkennt (fetch-Rejection, Stream ohne Events),
        // bekommen failReason 'network' — die einzige Karte, deren Retry
        // ehrlich ist (mockup-model-flow §05 C; das Backend sendet 'network'
        // nie selbst).
        patchAssistant({
          content: FAILED_MARKER,
          reasoning: undefined,
          sources: undefined,
          queuedAhead: undefined,
          queuedModel: undefined,
          queuedCurrent: undefined,
          rateLimit: undefined,
          ...(err instanceof StreamFailedError
            ? {
                ...(err.quotaExhausted ? { quotaExhausted: true, retryAt: err.retryAt, quotaReason: err.quotaReason, failProvider: err.failProvider } : null),
                ...(err.failReason ? { failReason: err.failReason, failProvider: err.failProvider, failModel: err.failModel } : null),
              }
            : { failReason: 'network' as const }),
        });
        console.error('Failed to send message:', err);
      }
      // Quota/availability likely changed — refresh cooldown badges, the
      // pill dot and hasLocalModel (refresh moment "after an error", §03).
      setModelSystemSignal(v => v + 1);
      void refreshModelSystem();
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
  // provider 'ollama' = Notfall-Fallback (ADR-0008): DIESE eine Antwort
  // läuft übers lokale Modell, die Einstellungen bleiben unberührt. Nur für
  // persistierte Marker sinnvoll — der Temp-Zweig sendet normal neu.
  const handleRetryMessage = (failed: Message, provider?: 'ollama') => {
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
    // Anchored retry: Platzhalter UND spätere Antwort übernehmen den
    // Zeitstempel des Markers — orderMessages hält sie damit exakt an
    // seiner Position (nie mehr unter der falschen Frage).
    const tempAssistantId = `temp-assistant-${crypto.randomUUID()}`;
    const anchorCreatedAt = failed.created_at;
    const stream: ActiveStream = {
      chatId,
      tempUserId: `temp-user-${crypto.randomUUID()}`,
      tempAssistantId,
      userContent: userMsg.content,
      content: '',
      reasoning: '',
      sources: [],
      createdAt: anchorCreatedAt,
      queuedAhead: null,
      queuedModel: null,
      queuedCurrent: null,
      started: false,
      rateLimit: null,
      failover: null,
      smoother: null,
      isRegenerate: true,
      regenerateOfId: failed.id.startsWith('temp-') ? null : failed.id,
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
              { id: tempAssistantId, chat_id: chatId, role: 'assistant', content: '', created_at: anchorCreatedAt },
            ],
          }
        : prev,
    );

    void runMessageStream(stream, (h) =>
      // Temp-ids (lokal wiederhergestellte Marker) kennt das Backend nicht —
      // dann ohne Anker regenerieren (letzte Frage, altes Verhalten).
      api.regenerateMessage(chatId, stream.regenerateOfId ?? undefined, h.onDelta, h.onToolEvent, {
        think: thinkByChat[chatId] || undefined,
        ...(provider ? { provider } : {}),
        ...h.opts,
      }),
    );
  };

  // Named cloud exit of the local_missing card (mockup-model-flow §11):
  // switch the settings to the keyed cloud provider + its model (same write
  // as the pill switch — the regenerate override only allows 'ollama'),
  // then retry THIS answer anchored. Leaving private mode is the user's
  // explicit, informed click — never an automatic hop.
  const handleRetryCloudModel = async (failed: Message) => {
    if (!cloudFallback) return;
    try {
      const s = await api.updateSettings({
        llm_provider: cloudFallback.provider,
        [`${cloudFallback.provider}_model`]: cloudFallback.model,
      });
      setSettings(s);
      setSettingsChangedAt(new Date().toISOString());
    } catch (err) {
      console.error('Failed to switch to the cloud model:', err);
      return;
    }
    handleRetryMessage(failed);
  };

  // W4 billing card: switch to the first free model, then retry this answer
  // — same write path as the cloud exit above.
  const handleRetryFreeModel = async (failed: Message) => {
    if (!freeFallback) return;
    try {
      const s = await api.updateSettings({
        llm_provider: freeFallback.provider,
        [`${freeFallback.provider}_model`]: freeFallback.model,
      });
      setSettings(s);
      setSettingsChangedAt(new Date().toISOString());
    } catch (err) {
      console.error('Failed to switch to the free model:', err);
      return;
    }
    handleRetryMessage(failed);
  };

  // "Erneut senden" of the unanswered row (mockup-model-flow §10): the
  // trailing question is already persisted (pending or answerless) — a
  // NON-anchored regenerate claims it server-side and answers in place.
  const handleResendUnanswered = (question: Message) => {
    const chat = activeChat;
    if (!chat) return;
    const chatId = chat.id;
    const tempAssistantId = `temp-assistant-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const stream: ActiveStream = {
      chatId,
      tempUserId: `temp-user-${crypto.randomUUID()}`,
      tempAssistantId,
      userContent: question.content,
      content: '',
      reasoning: '',
      sources: [],
      createdAt: now,
      queuedAhead: null,
      queuedModel: null,
      queuedCurrent: null,
      started: false,
      rateLimit: null,
      failover: null,
      smoother: null,
      isRegenerate: true,
      regenerateOfId: null,
      abort: new AbortController(),
    };
    activeStreamsRef.current.set(tempAssistantId, stream);
    syncStreamIndicators();
    setActiveChat(prev =>
      prev && prev.id === chatId
        ? {
            ...prev,
            messages: [
              ...prev.messages,
              { id: tempAssistantId, chat_id: chatId, role: 'assistant', content: '', created_at: now },
            ],
          }
        : prev,
    );
    void runMessageStream(stream, (h) =>
      api.regenerateMessage(chatId, undefined, h.onDelta, h.onToolEvent, {
        think: thinkByChat[chatId] || undefined,
        ...h.opts,
      }),
    );
  };

  // Stop-Button im Composer: bricht alle Streams des SICHTBAREN Chats ab
  // (laufende UND wartende) — Hintergrund-Streams anderer Chats laufen weiter.
  // Stop while QUEUED (mockup-model-flow §10): the question was persisted at
  // enqueue, and an explicit stop "counts as never asked" — the pending row
  // must go too. The queued SSE contract carries no message id, so the
  // trailing pending rows are matched by content after a refetch.
  const handleStopStreaming = () => {
    if (!activeChatId) return;
    const chatId = activeChatId;
    const stopped = streamsForChat(chatId);
    stopped.forEach(s => s.abort.abort());
    const canceled = stopped.filter(s => !s.started && !s.isRegenerate);
    if (canceled.length === 0) return;
    const contents = new Set(canceled.map(s => s.userContent));
    void api
      .getChat(chatId)
      .then(chat => {
        const ordered = orderMessages(chat.messages);
        const doomed: Message[] = [];
        for (let i = ordered.length - 1; i >= 0; i--) {
          const m = ordered[i];
          if (m.role !== 'user' || !m.pending) break;
          if (contents.has(m.content)) doomed.push(m);
        }
        return Promise.all(doomed.map(m => api.deleteMessage(chatId, m.id).then(() => m.id)));
      })
      .then(deletedIds => {
        // Falls die Pending-Zeilen inzwischen im State liegen (Chat-Wechsel
        // während des Wartens), verschwinden sie auch aus der Ansicht.
        if (deletedIds.length === 0) return;
        const drop = new Set(deletedIds);
        setActiveChat(prev =>
          prev && prev.id === chatId
            ? { ...prev, messages: prev.messages.filter(m => !drop.has(m.id)) }
            : prev,
        );
      })
      .catch(() => {
        /* backend unreachable — the pending row stays and renders the
           unanswered row after the next load (§10), never a silent loss */
      });
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

  // Finishing a drag-selection in a chat bubble (right pane or parent
  // context pane, mouseup — no right-click needed, user request
  // 2026-07-31): open the popup with the color row + "Ask in chat".
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
    // Title lookup starts NOW, in parallel with the definition: the user
    // spends a moment reading the popup, so by the time they hit "ask in a
    // new chat" the title is usually there and the branch appears with its
    // formula already set — never with the raw passage
    // (user requirement 2026-08-02, chat/passageTitle.ts).
    // Only for real selections; a right-clicked single word is its own title.
    const isPassage = Boolean(pendingPdfSelectionRef.current || pendingChatSelectionRef.current);
    pendingTitleRef.current = isPassage ? startPassageTitle(wordPopup.word) : null;
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

  // Finishing a drag-selection over the PDF (mouseup, no right-click
  // needed — user request 2026-07-31): PdfView already captured the
  // selection into pendingPdfSelectionRef (its onCaptureHighlight fires
  // before this). Open the popup with the selected text; the definition
  // uses the surrounding lines as context (Issue 06), not just the
  // selection itself.
  const handlePdfSelectionFinalized = (point: { clientX: number; clientY: number }) => {
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
      x: point.clientX,
      y: point.clientY,
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
      const createPromise = hlApiFor(sel.chatId).create({
        messageId: sel.messageId,
        color,
        text: sel.text,
        startOffset: sel.startOffset,
        endOffset: sel.endOffset,
      });
      chatHighlightCreatePromiseRef.current = createPromise;
      try {
        const created = await createPromise;
        if (created) savedChatHighlightIdRef.current = created.id;
      } finally {
        chatHighlightCreatePromiseRef.current = null;
      }
      return;
    }
    const saved = savedHighlightIdRef.current;
    if (saved) {
      await updateHighlight(saved, { color });
      return;
    }
    const sel = pendingPdfSelectionRef.current;
    if (!sel) return;
    const createPromise = createHighlight({
      color,
      text: sel.text,
      pageNumber: sel.pageNumber,
      rects: sel.rects,
    });
    pdfHighlightCreatePromiseRef.current = createPromise;
    try {
      const created = await createPromise;
      if (created) savedHighlightIdRef.current = created.id;
    } finally {
      pdfHighlightCreatePromiseRef.current = null;
    }
  };

  // Create a child chat branched from the word shown in the popup, then open
  // it. When the popup came from a PDF selection (Slice 06), also save a
  // highlight in the active color linked to the new branch — or link the
  // highlight a swatch click already created.
  const handleOpenChildChat = async (word: string, context?: string) => {
    if (!activeChatId) return;
    const fromPdf = popupHasPdfSelection;
    const sel = pendingPdfSelectionRef.current;
    // A swatch click just before this one may still be creating the
    // highlight — wait for it to settle so `saved` below reflects it instead
    // of reading the ref before it's set (which used to create a second,
    // unlinked highlight on the same selection).
    if (pdfHighlightCreatePromiseRef.current) {
      await pdfHighlightCreatePromiseRef.current.catch(() => null);
    }
    const saved = savedHighlightIdRef.current;
    // For chat selections, branch from the chat the selection lives in — that
    // can be the parent-context pane, not just the active chat.
    const chatSel = pendingChatSelectionRef.current;
    if (chatHighlightCreatePromiseRef.current) {
      await chatHighlightCreatePromiseRef.current.catch(() => null);
    }
    const savedChatHl = savedChatHighlightIdRef.current;
    const parentId = popupHasChatSelection && chatSel ? chatSel.chatId : activeChatId;

    // Create the chat FIRST. If the backend is unreachable this used to be an
    // unhandled rejection that left the app dead after the popup had already
    // closed (reported 2026-07-20). Now the popup stays open and shows the
    // error in its body, same pattern as the explainWord failure above.
    let child: Awaited<ReturnType<typeof api.createChat>>;
    try {
      // PDF-selection branches persist the selection's surroundings
      // (decision 2026-07-26): the text layer flattens math notation
      // ("Rm" for R^m), only the surrounding lines make the term
      // interpretable for the model. Chat branches don't need it —
      // parent_word already carries the full selected passage.
      // Title: the lookup started when the popup opened, so it is normally
      // finished by now and the chat is created WITH its rendered formula —
      // the tree never shows the raw passage (user requirement 2026-08-02).
      // If it is still in flight, awaitTitle waits briefly and otherwise
      // hands back the tidied passage; the post-answer path in
      // routes/messages.js still improves the title later either way.
      // Titles keep their $…$ math source — every render site goes through
      // <MathText> (2026-07-26), so "$V$" shows as set math.
      const title = await awaitTitle(pendingTitleRef.current, word);
      pendingTitleRef.current = null;
      child = await api.createChat(
        S.aboutChatTitle(title), parentId, word,
        fromPdf && context ? context : undefined,
      );
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
        // wird die Selektion in der aktiven Farbe markiert, direkt verlinkt
        // mit dem neuen Branch.
        await hlApiFor(chatSel.chatId).create({
          messageId: chatSel.messageId,
          color: activeColor,
          text: chatSel.text,
          startOffset: chatSel.startOffset,
          endOffset: chatSel.endOffset,
          childChatId: child.id,
        });
      } else if (chatSel && savedChatHl) {
        // Ein Swatch-Klick hat die Markierung schon angelegt — jetzt
        // nachträglich mit dem neuen Branch verknüpfen.
        await hlApiFor(chatSel.chatId).linkChat(savedChatHl, child.id);
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

  const handleChatMenuOpenChat = async () => {
    const menu = chatHighlightMenu;
    setChatHighlightMenu(null);
    if (menu?.highlight.childChatId) await handleSelectChat(menu.highlight.childChatId);
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
    // Branch layout (no PDF, parent context in the center pane): a card
    // pointing into the parent chat scrolls the visible center pane instead
    // of switching chats — the drawer stays open, target and list remain
    // visible side by side (user correction 2026-07-29).
    if (parentContext && item.chatId === parentContext.id) {
      setParentScrollTarget({ chatId: item.chatId, messageId: item.messageId });
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

  // Click on the "Branched from" quote: jump precisely to the branch's
  // source (user correction 2026-07-22) — while keeping the branch chat
  // open on the right (user correction 2026-07-29): in both tree layouts
  // the source is already visible in the center pane, so switching chats
  // would only dissolve the three-column layout.
  //   PDF branch:  the linked PDF highlight scrolls the PDF alongside.
  //   Chat branch: the highlight created on branching scrolls the parent
  //                context pane (found via the quote text, parent_word).
  //   Without a visible center pane or without a match (e.g. highlight
  //   deleted): plain switch to the parent chat as before.
  const handleBranchedFromClick = async () => {
    const chat = activeChat;
    if (!chat?.parent_id) return;
    const parentId = chat.parent_id;
    const linkedPdfHighlight = highlights.find((h) => h.chatId === chat.id);
    if (linkedPdfHighlight && treePaper) {
      pdfViewRef.current?.scrollToHighlight(linkedPdfHighlight.id);
      return;
    }
    let match: MessageHighlight | undefined;
    try {
      const parentHighlights = await api.listMessageHighlights(parentId);
      const quote = chat.parent_word?.trim();
      match = quote
        ? parentHighlights.find((h) => h.text.trim() === quote)
        : undefined;
    } catch {
      /* Backend unreachable — at least switch to the parent chat below */
    }
    if (match && parentContext?.id === parentId) {
      setParentScrollTarget({ chatId: parentId, messageId: match.messageId });
      return;
    }
    if (match) {
      pendingChatScrollRef.current = {
        chatId: parentId,
        messageId: match.messageId,
        startOffset: match.startOffset,
        endOffset: match.endOffset,
        color: match.color,
      };
    }
    await handleSelectChat(parentId);
  };

  return (
    <div className="flex h-screen overflow-hidden bg-white relative isolate">
      <MatrixRain />
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
        onOpenFeedback={() => { setFeedbackInitialText(''); setFeedbackOpen(true); }}
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
              onSelectionFinalized={handlePdfSelectionFinalized}
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
              onOpenFeedback={(initialText) => { setFeedbackInitialText(initialText); setFeedbackOpen(true); }}
              onRetryMessage={handleRetryMessage}
              onRetryLocalModel={(m) => handleRetryMessage(m, 'ollama')}
              hasLocalModel={ollamaModels.length > 0}
              billingUrl={settings ? registry?.providers[settings.llm_provider]?.billingUrl ?? null : null}
              billingUrls={registry ? Object.fromEntries(Object.entries(registry.providers).map(([id, p]) => [id, p.billingUrl ?? null])) : undefined}
              onOpenModelPicker={(m) => {
                pickerRetryTargetRef.current = m;
                setPickerOpenSignal((s) => s + 1);
              }}
              settingsChangedAt={settingsChangedAt}
              onOpenSettings={() => openSettings('model')}
              providerLabels={providerLabels}
              localModelName={settings?.ollama_model}
              cloudFallback={cloudFallback}
              onRetryCloudModel={(m) => void handleRetryCloudModel(m)}
              freeFallback={freeFallback}
              onRetryFreeModel={(m) => void handleRetryFreeModel(m)}
              onResendUnanswered={handleResendUnanswered}
              modelLabels={modelLabels}
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
              setupNotice={
                // Guided empty state (ADR-0008, grill decision 12b): active
                // cloud provider without a key — the card replaces the
                // composer instead of blocking silently.
                settings && settings.llm_provider !== 'ollama' &&
                !settings[`${settings.llm_provider}_api_key_set`] ? (
                  <CloudSetupNotice onOpenSettings={(p) => openSettings('model', p)} />
                ) : undefined
              }
              modelPicker={
                settings && activeChatId ? (
                  <ModelPicker
                    activeProvider={settings.llm_provider}
                    activeModel={
                      settings.llm_provider === 'ollama'
                        ? settings.ollama_model
                        : settings[`${settings.llm_provider}_model`]
                    }
                    groups={buildPickerGroups(settings, registry, ollamaModels, {
                      free: STR.modelPicker.freeGroup,
                      paid: STR.modelPicker.paidGroup,
                      local: STR.modelPicker.localGroup,
                    })}
                    ollamaReachable={ollamaReachable}
                    cloudCount={CLOUD_PROVIDERS.filter(p => settings[`${p}_api_key_set`]).length}
                    onSelectModel={(provider, name) => void handleSelectModel(provider, name)}
                    think={Boolean(thinkByChat[activeChatId])}
                    onToggleThink={() =>
                      setThinkByChat(prev => ({ ...prev, [activeChatId]: !prev[activeChatId] }))
                    }
                    onOpenSettings={() => openSettings('model')}
                    disabled={streamingChatIds.has(activeChatId)}
                    openSignal={pickerOpenSignal}
                    refreshSignal={modelSystemSignal}
                    onMenuOpenChange={handlePickerMenuChange}
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
                {pendingAttach.kind === 'file'
                  ? pendingAttach.file.name
                  : <MathText text={pendingAttach.title} />}
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

      {/* Settings modal — owned by App so both the sidebar gear and the
          composer pill can open it. onSaved keeps the pill in sync; closing
          re-fetches the model system (models may have been pulled/removed
          via the terminal meanwhile). */}
      <SettingsModal
        open={settingsOpen}
        onClose={() => { setSettingsOpen(false); refreshModelSystem(); }}
        onSaved={(s) => {
          setSettings(s);
          // A key save or provider change re-arms the cards' retry — the
          // same rule as after a pill model switch (mockup-model-flow §05).
          setSettingsChangedAt(new Date().toISOString());
        }}
        initialTab={settingsTab}
        initialProvider={settingsProvider ?? undefined}
      />

      {/* Feedback dialog — sidebar button + /feedback composer command. */}
      <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} initialText={feedbackInitialText} />

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

      {/* Actions menu for an existing chat-text highlight: recolor / delete /
          open linked chat. chatId here is the menu's generic "linked branch"
          slot — fed from childChatId, NOT MessageHighlight.chatId (the
          containing chat, always set). */}
      {chatHighlightMenu && (
        <HighlightActionsMenu
          highlight={{
            color: chatHighlightMenu.highlight.color,
            chatId: chatHighlightMenu.highlight.childChatId,
          }}
          x={chatHighlightMenu.x}
          y={chatHighlightMenu.y}
          onClose={() => setChatHighlightMenu(null)}
          onChangeColor={handleChatMenuChangeColor}
          onDelete={handleChatMenuDelete}
          onOpenChat={handleChatMenuOpenChat}
        />
      )}
    </div>
  );
}
