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
import { FileText, TvMinimalPlay, ArrowDown } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { useKeyboardNavigation } from './hooks/useKeyboardNavigation';
import { usePaneResize } from './hooks/usePaneResize';
import { useStreamRegistry, type ActiveStream } from './hooks/useStreamRegistry';
import type { FocusPosition } from './keyboard/focusMap';
import { findItem } from './keyboard/readScreen';
import { MatrixRain } from './components/MatrixRain';
import { ChatArea, type ChatAreaHandle } from './components/ChatArea';
import { ModelPicker } from './components/ChatArea/ModelPicker';
import { SettingsModal, type SettingsTab } from './components/SettingsModal';
import { FeedbackDialog } from './components/FeedbackDialog';
import { MindMap, findRoot } from './components/MindMap';
import { branchSourceJump } from './chat/branchSource';
import { ParentContextPane } from './components/ParentContextPane';
import { MathText } from './components/MathText';
import { PdfView, type PdfHighlightSelection, type PdfViewHandle } from './components/PdfView';
import { HighlightActionsMenu } from './components/PdfView/HighlightActionsMenu';
import { PaperSearchModal } from './components/PaperSearch';
import { YouTubeSearchModal } from './components/YouTubeSearch';
import { structurePrompt } from './components/YouTubeSearch/autoPrompt';
import { getAppLanguage } from './appLanguage';
import { useStrings } from './strings';
import { VideoPane, type VideoPaneHandle } from './components/VideoPane';
import { pickOverviewMessage, overviewStopsShort } from './markdown/chapters';
import { formatDuration } from './video/format';
import { FloatingPopup } from './components/FloatingPopup';
import { HighlightsDrawer } from './components/HighlightsDrawer';
import { api, StreamFailedError, TreeHasSourceError } from './api';
import { TextSmoother } from './streaming/TextSmoother';
import { orderMessages } from './chat/messageOrder';
import { buildPickerGroups } from './chat/pickerGroups';
import { buildFreeProviderOffer, buildVisionGate } from './chat/modelOffers';
import { awaitTitle, startPassageTitle, type PendingTitle } from './chat/passageTitle';
import { branchTargetsFor } from './chat/branchTargets';
import { useHighlights } from './hooks/useHighlights';
import { createFulltextQueue } from './hooks/fulltextQueue';
import { useCitations } from './hooks/useCitations';
import { CitationCard, browserUrlFor, type CitationCardTarget } from './components/CitationCard';
import { useChatHighlights } from './hooks/useChatHighlights';
import { invalidateTreeHighlights } from './hooks/useTreeHighlights';
import { contextAroundSelection } from './pdf/selection';
import { CLOUD_PROVIDERS, FAILED_MARKER, INTERRUPTED_MARKER } from './types';
import type { Aside, Category, Chat, ChatDetail, ChatSelection, ComposerQuote, FailoverInfo, Highlight, HighlightColor, LLMProvider, LocalAttachment, Message, MessageHighlight, OllamaModelInfo, Paper, PaperReference, Registry, SearchResult, Settings, ToolEvent, TranscriptHighlight, TreeHighlight, Video, VideoSearchResult, WordPopup } from './types';

/**
 * Every chat id in a node's subtree, the node itself included. Deleting a chat
 * takes its branched chats with it, so the frontend needs the whole list to
 * know which local state (streams, active selection) the deletion invalidates.
 */
function subtreeIds(chat: Chat): string[] {
  return [chat.id, ...(chat.children ?? []).flatMap(subtreeIds)];
}

/**
 * The runaway guard on writing a cut-off Video overview to its end
 * (mockup-video-overview-progress §01, variant A) — NOT a budget. The overview
 * is finished when the provider stops cutting it, and that is the real stop;
 * this number only exists so a provider that never finishes cannot spend calls
 * forever.
 *
 * It had to be raised from 4 on the day it was built (user report 2026-08-18):
 * gemini-flash-latest ends its stream with `finish_reason=MISSING` after as
 * little as 68 tokens, so four rounds carried a 59:48 video only to 34:52 —
 * the reader was back to clicking. Twenty rounds cover that, and the two
 * cheaper stops below (nothing appended, round failed) end most runs long
 * before it.
 */
export const AUTO_CONTINUE_MAX = 20;

/** What a continuation round ended with — null when it failed outright. */
type ContinueResult = { content: string; truncated: boolean } | null;

export default function App() {
  // UI-Texte in der App language — re-rendert beim Sprachwechsel mit.
  const STR = useStrings();
  const S = STR.app;
  // chats: the full tree shown in the sidebar
  const [chats, setChats] = useState<Chat[]>([]);
  // Sidebar categories — the user's own grouping of root chats, one nesting
  // level deep (design/mockup-sidebar-categories-v2.html). Kept flat here
  // exactly as the backend stores it; the sidebar nests them for display.
  const [categories, setCategories] = useState<Category[]>([]);

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

  // Registry of the running streams plus the UI mirrors derived from it —
  // see hooks/useStreamRegistry.ts for the invariant they share.
  const {
    streams: activeStreamsRef,
    streamingChatIds,
    queuedChatIds,
    streamingMessageIds,
    continuingChatIds,
    streamsForChat,
    syncIndicators: syncStreamIndicators,
    markAnswering,
  } = useStreamRegistry();

  // Live-Spiegel der aktiven Chat-ID für Stream-Callbacks (der State im
  // Closure wäre veraltet, sobald der Nutzer den Chat wechselt).
  const activeChatIdRef = useRef<string | null>(null);

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

  // Die Video overview, aus der die Kapitel unter dem Player entstehen
  // (mockup-youtube-embed-layout.html §02, Variante C). Sie steht im Chat, in
  // dem der Import lief — also in der Wurzel. Ein Zweig-Chat holt deshalb
  // einmal die Wurzel-Historie nach, damit der Player auch dort navigierbar
  // bleibt.
  // The Video overview as a MESSAGE, not just text (mockup-truncated-answer
  // §02): the chapter list needs to know whether it was cut short and which
  // message "continue" means — and that message may live in the ROOT chat
  // while a branch is open, hence the chat id travels with it.
  const [videoOverview, setVideoOverview] = useState<{ chatId: string; message: Message } | null>(null);
  // Per cut-off overview: how many rounds were spent, and the length the last
  // one started from — a second attempt from the SAME point is either a stale
  // copy of the state or a round that wrote nothing, and neither deserves a
  // paid call. Refs, not state: they must never cause a render, because a
  // render is what starts the next round.
  const autoContinueRounds = useRef<Map<string, { rounds: number; from: number }>>(new Map());
  const autoContinueBusy = useRef(false);

  // Width of the right chat column in the three-column PDF layout. The user
  // drags the divider between PDF and chat to resize; persisted so the
  // preferred width survives reloads.
  const CHAT_PANE_MIN = 300;
  const CHAT_PANE_MAX = 800;
  // Width the center pane (PDF desk or parent context) keeps no matter how wide
  // the chat column is dragged — see the maxWidth on the chat column below.
  const CENTER_PANE_MIN = 320;
  const [chatPaneWidth, chatPaneResize] = usePaneResize({
    storageKey: 'syflo.chatPaneWidth',
    fallback: 340,
    min: CHAT_PANE_MIN,
    max: CHAT_PANE_MAX,
    startDrag: (e, width) => ({ startX: e.clientX, startWidth: width }),
    // The chat pane sits at the right window edge, so dragging the divider
    // left widens it by exactly the pointer delta.
    nextValue: (e, start) => start.startWidth + (start.startX - e.clientX),
  });

  // Height of the mind-map pane (as % of the column), when the mind-map view
  // is open above the chat. Same drag pattern as the chat column divider;
  // stored as a percentage so it adapts to window resizes.
  const MAP_PANE_MIN_PCT = 20;
  const MAP_PANE_MAX_PCT = 80;
  const [mapPaneHeightPct, mapPaneResize] = usePaneResize({
    storageKey: 'syflo.mapPaneHeight',
    fallback: 50,
    min: MAP_PANE_MIN_PCT,
    max: MAP_PANE_MAX_PCT,
    // The container height must be read at pointerdown: once the drag starts,
    // the pane it belongs to is the thing being resized.
    startDrag: (e, pct) => ({
      startY: e.clientY,
      startPct: pct,
      containerH: (e.currentTarget.parentElement as HTMLElement).clientHeight || 1,
    }),
    nextValue: (e, start) =>
      start.startPct + ((e.clientY - start.startY) / start.containerH) * 100,
  });

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
    reload: reloadHighlights,
  } = useHighlights(treePaper?.id ?? null);

  // ─── Reference links (design/mockup-paper-reference-links.html) ───────────
  // The citations this paper prints, their click rects, and the card one
  // click opens. Loaded in the background after import; 'none' means this
  // PDF has no citation links and never will.
  const citationsData = useCitations(treePaper?.id ?? null);
  const [citationCard, setCitationCard] = useState<CitationCardTarget | null>(null);
  // Which reference is being fetched, and which one just failed. Syflo has no
  // toast system — the card itself reports both (§ 07 of the mockup).
  const [citationLoadingId, setCitationLoadingId] = useState<string | null>(null);
  const [citationFailedId, setCitationFailedId] = useState<string | null>(null);
  // referenceId → chatId for works already opened in Syflo. The card's second
  // door then reads "Go to tree" and can never create a duplicate.
  const [citedTrees, setCitedTrees] = useState<Map<string, string>>(new Map());
  // The silent full-text search, prefetched by proximity
  // (design/mockup-citation-card-standard.html § 05): the citations of the
  // page on screen, and whatever the mouse points at, ahead of them. One
  // request at a time — a burst of them gets the search engines to serve
  // captchas instead of results.
  const ensureFulltext = citationsData.ensureFulltext;
  const fulltextQueue = useMemo(
    // Two seconds apart: twenty back-to-back searches got every engine behind
    // the search to answer with a CAPTCHA (measured in the running app
    // 2026-08-10), and a blocked search looks exactly like "nothing found".
    () => createFulltextQueue((referenceId) => ensureFulltext(referenceId), { spacingMs: 2000 }),
    [ensureFulltext],
  );
  // The card renders the LIVE reference, not the one captured at click time:
  // the silent search fills `pdfUrl` and `fulltextHost` seconds after the
  // card opens (§ 04), and with a frozen snapshot the door never appeared.
  const citationReference = citationCard
    ? citationsData.referenceById(citationCard.reference.id) ?? citationCard.reference
    : null;

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

  // Whether that pane is actually ON SCREEN. The parent chat is loaded for
  // every branch chat outside a PDF tree, but a VIDEO tree gives the center
  // column to the video — the pane is then loaded and invisible. Every jump
  // that lands "in the parent pane" has to ask this, not merely whether
  // parentContext exists: aiming at the invisible pane looks to the user like
  // a dead link (report 2026-08-19, the way back out of a transcript branch).
  const parentPaneVisible = !treePaper && !treeVideo && parentContext !== null;

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
  // A branch is being created right now. The click blocks on the title lookup
  // above (measured 0.5 s, capped at TITLE_WAIT_MS), so the popup shows a
  // loading state instead of a dead button (user report 2026-08-08). The ref
  // is the actual re-entrancy guard — state alone can't stop a second click
  // dispatched before React has re-rendered the disabled button.
  const [creatingChild, setCreatingChild] = useState(false);
  const creatingChildRef = useRef(false);
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
  // Highlight the drawer should lift into view — set when a mind-map node
  // click jumped to its source (2026-08-02). Cleared by the drawer once it
  // has scrolled, so a second click on the same node works again.
  const [focusedHighlightId, setFocusedHighlightId] = useState<string | null>(null);
  // Sprungziele für Drawer-Karten (Grill-Entscheidung 8: punktgenau + Flash).
  const pdfViewRef = useRef<PdfViewHandle>(null);
  // Der eingebettete Player der Mittelspalte (mockup-youtube-embed-layout.html):
  // Zeitmarken im Chat springen über diesen Griff, statt YouTube zu öffnen.
  const videoPaneRef = useRef<VideoPaneHandle>(null);
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
  // Rückweg einer Abzweigung ohne Passage (mockup-branch-trace.html §07):
  // Elternchat laden, dann die Abzweig-Zeile DIESES Zweigs anleuchten. Gleiche
  // Mechanik wie oben, nur ist das Ziel eine Zeile statt einer Nachricht.
  const pendingTraceScrollRef = useRef<{ chatId: string; branchChatId: string } | null>(null);

  // "Ask in chat" quote waiting in a chat's composer. Keyed by chatId so a
  // quote never leaks into a different chat's composer.
  const [composerQuote, setComposerQuote] = useState<(ComposerQuote & { chatId: string }) | null>(null);

  // /btw side questions, keyed by chatId (design/mockup-btw-composer-fold.html).
  // The aside belongs to its CHAT, not to the screen: opening another branch or
  // the mind map leaves it behind untouched and coming back finds it where it
  // was. At most one per chat — a second /btw replaces the first. Deliberately
  // plain React state and nothing else: a reload clears every aside, which is
  // exactly what "not saved" means.
  const [asides, setAsides] = useState<Record<string, Aside>>({});

  // Räumt die Nebenfrage des Chats weg. Drei Gesten enden hier (Tippen,
  // Escape, ×) und keine wird in der UI erklärt — dazu die beiden Aktionen,
  // nachdem sie die Nebenfrage dauerhaft gemacht haben.
  const dismissAside = (chatId: string) =>
    setAsides((prev) => {
      if (!prev[chatId]) return prev;
      const next = { ...prev };
      delete next[chatId];
      return next;
    });

  // "Im Chat behalten": Frage + Antwort ans Ende des Threads. Ab jetzt sind
  // es gewöhnliche Nachrichten — ohne Abzeichen, dass sie mal eine
  // Nebenfrage waren (Mockup §03).
  const handleKeepAside = async () => {
    const chatId = activeChatId;
    const aside = chatId ? asides[chatId] : null;
    if (!chatId || !aside || aside.streaming) return;
    dismissAside(chatId);
    try {
      const messages = await api.keepAside(chatId, aside.answer, aside.question);
      setActiveChat((prev) =>
        prev && prev.id === chatId ? { ...prev, messages: [...prev.messages, ...messages] } : prev,
      );
    } catch (err) {
      console.error('Keep in chat failed:', err);
    }
  };

  // "Verzweigen": der Zweig trägt die Frage als Zitat in der Kopfzeile, also
  // wird nur die Antwort geschrieben — sie ist die erste Blase (Nutzer-
  // entscheidung 2026-08-08). Der aktuelle Thread bleibt unberührt.
  const handleBranchAside = async () => {
    const chatId = activeChatId;
    const aside = chatId ? asides[chatId] : null;
    if (!chatId || !aside || aside.streaming) return;
    dismissAside(chatId);
    try {
      // Der Zweigtitel wird verkürzt wie bei jedem anderen Zweig — eine
      // Nebenfrage kann ein ganzer Satz sein, und der Baum soll keine Sätze
      // tragen. Schlägt die Kürzung fehl oder dauert sie zu lange, steht die
      // Frage selbst im Titel; ein Titel ist nie ein Grund zu warten.
      const { title } = await awaitTitle(startPassageTitle(aside.question), aside.question);
      // 'btw' lässt den Elternchat eine Abzweig-Zeile an genau der Stelle
      // zeichnen, an der die Nebenfrage gestellt wurde
      // (mockup-branch-trace.html).
      const child = await api.createChat(
        S.aboutChatTitle(title), chatId, aside.question, undefined, undefined, 'btw',
      );
      await api.keepAside(child.id, aside.answer);
      await refreshTree();
      await handleSelectChat(child.id);
    } catch (err) {
      console.error('Make a branch failed:', err);
    }
  };

  // /branch <topic> — the other door into the tree
  // (design/mockup-branch-command.html). No passage was selected, so the
  // branch gets NO parent_word: its header shows the parent link alone and
  // its map node has no highlight kind. The topic is asked verbatim as the
  // first message (mockup §03 A) — one command, one answer, and the outcome
  // line is written by the title call that already follows that answer.
  // Die wählbaren Eltern für /branch: der Baum, in dem der aktive Chat steht.
  const branchTargets = useMemo(() => branchTargetsFor(chats, activeChatId), [chats, activeChatId]);

  const handleOpenTopicBranch = async (topic: string, parentId: string) => {
    try {
      // Same title path as every other branch: the tree never shows a raw
      // passage, and a slow model never holds the branch hostage.
      const { title } = await awaitTitle(startPassageTitle(topic), topic);
      const child = await api.createChat(
        S.aboutChatTitle(title), parentId, undefined, undefined, undefined, 'topic',
      );
      await refreshTree();
      await handleSelectChat(child.id, parentId);
      // targetChatId: activeChatId lags the switch by one render.
      await handleSendMessage(topic, [], child.id);
    } catch (err) {
      console.error('/branch failed:', err);
    }
  };

  const handleAskAside = async (question: string) => {
    const chatId = activeChatId;
    if (!chatId) return;
    setAsides((prev) => ({ ...prev, [chatId]: { question, answer: '', streaming: true } }));
    // Dieselbe Glättung wie im Chat (TextSmoother, 85 Zeichen/s): ein Modell
    // liefert ganze Absätze in einem Paket, und ohne sie stand die Antwort
    // schlagartig im Panel („es kommt alles auf einmal", Nutzerbericht
    // 2026-08-20). Der Smoother besitzt den Text; das Panel zeigt immer nur
    // den aufgedeckten Anfang.
    const show = (visible: string) =>
      setAsides((prev) => {
        const current = prev[chatId];
        // A newer aside (or a dismissal) has taken over — drop the text
        // instead of resurrecting a panel the user already left behind.
        if (!current || current.question !== question) return prev;
        return { ...prev, [chatId]: { ...current, answer: visible } };
      });
    const smoother = new TextSmoother({ onReveal: show });
    try {
      const { answer, model, truncated } = await api.askAside(
        chatId,
        question,
        (delta) => smoother.push(delta),
        undefined,
        () => {
          // Das Modell, das angefangen hatte, ist gestorben. Seine halbe
          // Antwort verschwindet — auch die noch ungezeigte —, das Panel steht
          // wieder auf "denkt nach"; sonst schriebe das nächste Modell unter
          // einen abgerissenen Satz.
          smoother.reset();
          show('');
        },
      );
      // Erst das Aufdecken zu Ende laufen lassen, dann den fertigen Zustand
      // setzen — sonst überspränge das Ende genau die Glättung.
      await smoother.finish();
      setAsides((prev) => {
        const current = prev[chatId];
        if (!current || current.question !== question) return prev;
        return { ...prev, [chatId]: { question, answer, streaming: false, model, truncated } };
      });
    } catch (err) {
      smoother.reset();
      const message = err instanceof Error ? err.message : S.unknownError;
      const reason = (err as { reason?: string } | null)?.reason === 'timeout' ? 'timeout' : null;
      setAsides((prev) => {
        const current = prev[chatId];
        if (!current || current.question !== question) return prev;
        return {
          ...prev,
          [chatId]: { question, answer: '', streaming: false, error: message, errorReason: reason },
        };
      });
    }
  };

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
  // keepId: ein Chat, der gerade zum Elternteil geworden ist. Die Kinderzahl
  // in `activeChat` ist dann noch die alte (der Baum wird nebenher neu
  // geladen), und ohne diesen Schutz löscht /branch in einem frischen,
  // leeren Wurzel-Chat genau den Chat, unter den es eben verzweigt hat.
  const cleanupAbandonedChat = (nextId: string, keepId?: string) => {
    const prev = activeChat;
    if (
      prev &&
      prev.id !== nextId &&
      prev.id !== keepId &&
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
  const handleSelectChat = async (id: string, keepChatId?: string) => {
    cleanupAbandonedChat(id, keepChatId);
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
      ...(s.searchWish ? { searchWish: s.searchWish } : null),
      ...(s.reasoning ? { reasoning: s.reasoning } : null),
      ...(!s.started && s.queuedAhead !== null
        ? {
            queuedAhead: s.queuedAhead,
            ...(s.queuedModel !== null ? { queuedModel: s.queuedModel } : null),
            ...(s.queuedCurrent !== null ? { queuedCurrent: s.queuedCurrent } : null),
          }
        : null),
      ...(s.rateLimit !== null ? { rateLimit: s.rateLimit } : null),
      ...(s.overloaded !== null ? { overloaded: s.overloaded } : null),
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

  // ─── The two doors of a citation card ─────────────────────────────────────

  // Door A — the browser. Syflo changes nothing at all: no tree, no entry, no
  // state. That is the point of the door: a look that costs nothing.
  const handleCitationBrowser = (reference: PaperReference) => {
    const url = browserUrlFor(reference);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  };

  // Door B — Syflo. A tree holds one source (ADR-0005), so the cited paper
  // becomes its OWN tree, imported through the existing from-url path. The
  // view deliberately does NOT jump: being thrown out of the paragraph you
  // were reading is worse than one extra click, so the card's button simply
  // becomes "Go to tree" when the download lands.
  const handleCitationOpenInSyflo = async (reference: PaperReference) => {
    if (!reference.pdfUrl) return;
    setCitationLoadingId(reference.id);
    setCitationFailedId(null);
    try {
      const chat = await api.createChat(reference.title || S.newChatTitle);
      try {
        await api.importPaperFromUrl(chat.id, reference.pdfUrl, reference.title ?? undefined);
      } catch (err) {
        // The empty tree would linger as a stray "New chat" in the sidebar.
        await api.deleteChat(chat.id).catch(() => {});
        throw err;
      }
      await refreshTree();
      setCitedTrees((prev) => new Map(prev).set(reference.id, chat.id));
    } catch {
      setCitationFailedId(reference.id);
    } finally {
      setCitationLoadingId(null);
    }
  };

  // Create a blank chat and immediately open it.
  const handleNewChat = async () => {
    const chat = await api.createChat(S.newChatTitle);
    await refreshTree();
    await handleSelectChat(chat.id);
  };

  // Delete a chat — and, on the backend, its whole branched subtree.
  //
  // Staying in the current view matters (user report 2026-08-08): clearing the
  // active chat closed the mind map and dropped the user on the empty start
  // screen, so the deletion was never seen happening. The selection climbs to
  // the deleted node's PARENT instead (user decision 2026-08-08), which keeps
  // the mind map open and shows the node vanishing from the tree. Only when
  // the deletion leaves no parent — a whole root tree — is the chat area
  // cleared, and the effect above then falls back to chat view.
  const handleDeleteChat = async (id: string) => {
    const node = findChatInTree(chats, id);
    // Noch laufende/wartende Streams wären verwaist — abbrechen. Das gilt für
    // den ganzen Teilbaum: die Branches verschwinden mit.
    const doomed = node ? subtreeIds(node) : [id];
    doomed.forEach(chatId => streamsForChat(chatId).forEach(s => s.abort.abort()));

    await api.deleteChat(id);
    await refreshTree();

    // Die markierte Stelle überlebt ihren Zweig, die VERKNÜPFUNG nicht: das
    // Backend setzt highlights.chat_id bzw. message_highlights.child_chat_id
    // auf NULL. Beide Listen hängen im Frontend aber an paperId/chatId und die
    // ändern sich beim Löschen eines Zweigs nicht — ohne diesen Neuaufbau bot
    // das Highlight-Menü weiter "Zum verknüpften Chat" für einen Chat an, den
    // es nicht mehr gibt (Nutzerreport 2026-08-10). Auch der baum-weite Drawer
    // führt die Verknüpfung, darum wird sein Cache mit invalidiert.
    reloadHighlights();
    activeChatHl.reload();
    parentChatHl.reload();
    invalidateTreeHighlights();

    // Does the deletion take the active chat with it? A descendant loses its
    // home just like the deleted chat itself.
    const activeIsDoomed = activeChatId !== null && doomed.includes(activeChatId);
    if (!activeIsDoomed) return;

    if (node?.parent_id) {
      await handleSelectChat(node.parent_id);
      return;
    }
    setActiveChatId(null);
    activeChatIdRef.current = null;
    setActiveChat(null);
    setTreePaper(null);
    setTreeVideo(null);
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
      void handleSendMessage(structurePrompt(getAppLanguage()), [], undefined, null, { overview: true });
    } catch (err) {
      if (err instanceof TreeHasSourceError) {
        setYoutubeSearchOpen(false);
        setPendingAttach({ kind: 'video', youtubeId: result.youtube_id, title: result.title });
        return;
      }
      throw err;
    }
  };

  // Lädt das Transkript nach, ohne den Drawer zu öffnen — die Transkript-
  // Ansicht des Players braucht denselben Text (nur nach dem Import fehlt er).
  const ensureTranscript = async () => {
    if (!treeVideo || treeVideo.transcript || !activeChatId) return;
    const full = await api.getTreeVideo(activeChatId).catch(() => null);
    if (full) setTreeVideo(full);
  };

  // Kapitel-Quelle bestimmen: erst im offenen Chat suchen, sonst in der Wurzel
  // des Baums. Läuft mit den Nachrichten mit, also erscheinen die Kapitel,
  // sobald die Übersicht fertig gestreamt ist.
  useEffect(() => {
    if (!treeVideo || !activeChatId) {
      setVideoOverview(null);
      return;
    }
    // Der offene Chat wird erst eine Runde später geladen (handleSelectChat
    // setzt activeChatId sofort, activeChat nach der Antwort). Solange die
    // beiden auseinanderlaufen, weiß niemand etwas Neues — und aus dem NOCH
    // sichtbaren alten Chat zu schließen, hieße: beim Rückweg aus einem Zweig
    // stand kurz "Noch keine Kapitel" in der Mittelspalte, weil der Zweig
    // keine Übersicht hat (Nutzer-Report 2026-08-19). Die Kapitel bleiben
    // stehen, bis der neue Chat da ist.
    if (activeChat?.id !== activeChatId) return;
    const own = pickOverviewMessage(activeChat?.messages ?? []);
    if (own) {
      setVideoOverview({ chatId: activeChatId, message: own });
      return;
    }
    const root = findRoot(chats, activeChatId);
    if (!root || root.id === activeChatId) {
      setVideoOverview(null);
      return;
    }
    let cancelled = false;
    void api
      .getChat(root.id)
      .then((detail) => {
        if (cancelled) return;
        const picked = pickOverviewMessage(detail.messages);
        setVideoOverview(picked ? { chatId: root.id, message: picked } : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [treeVideo, activeChatId, activeChat?.messages, chats]);

  // The transcript's marks belong to the VIDEO, so they are loaded once per
  // tree and shown in every branch of it — like PDF highlights.
  useEffect(() => {
    if (!treeVideo) {
      setTranscriptHighlights([]);
      return;
    }
    let cancelled = false;
    // Wrapped in Promise.resolve: a transport that throws SYNCHRONOUSLY (an
    // old backend without the route, a stubbed client) must not take the
    // whole pane down with it — the marks are an enhancement, the video is not.
    void Promise.resolve()
      .then(() => api.listTranscriptHighlights(treeVideo.id))
      .then((list) => { if (!cancelled && Array.isArray(list)) setTranscriptHighlights(list); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [treeVideo]);

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
        void handleSendMessage(structurePrompt(getAppLanguage()), [], chat.id, null, { overview: true });
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

  // Pin or unpin a root chat. Der Baum wird danach neu geladen — die
  // Seitenleiste entscheidet allein anhand von pinned_at, in welchem
  // Abschnitt der Chat landet (design/mockup-pinned-chats.html, Variante A).
  const handleTogglePin = async (id: string, pinned: boolean) => {
    await api.setChatPinned(id, pinned);
    await refreshTree();
  };

  // ---- Categories ---------------------------------------------------------
  // Every mutation re-reads the list rather than patching it locally: the
  // backend owns the two-level cap and the "chats survive a delete" rule, and
  // a hand-patched copy would be the place those two truths drift apart.
  const refreshCategories = useCallback(async () => {
    setCategories(await api.getCategories());
  }, []);

  // Returns the created category: the sidebar may have a chat waiting to be
  // filed into it, and the id only exists once the backend has written it.
  const handleCreateCategory = async (name: string, parentId: string | null) => {
    const created = await api.createCategory(name, parentId);
    await refreshCategories();
    return created;
  };

  const handleRenameCategory = async (id: string, name: string) => {
    await api.updateCategory(id, { name });
    await refreshCategories();
  };

  const handleDeleteCategory = async (id: string) => {
    await api.deleteCategory(id);
    // Both, and in this order: the chats it held are now uncategorised, so the
    // tree is as stale as the category list.
    await refreshCategories();
    await refreshTree();
  };

  const handleToggleCategoryCollapsed = async (id: string, collapsed: boolean) => {
    // Optimistic: opening a category must feel like opening a folder, not like
    // a round trip. The refresh behind it corrects a failed write.
    setCategories(prev => prev.map(c => (c.id === id ? { ...c, collapsed: collapsed ? 1 : 0 } : c)));
    await api.updateCategory(id, { collapsed });
    await refreshCategories();
  };

  const handleMoveChatToCategory = async (chatId: string, categoryId: string | null) => {
    await api.setChatCategory(chatId, categoryId);
    await refreshTree();
  };

  // Categories load once, alongside the tree. A failure is not fatal: the
  // sidebar falls back to the date sections, which is the sidebar as it was.
  useEffect(() => { refreshCategories().catch(() => {}); }, [refreshCategories]);

  // Send a message with optimistic UI and real-time streaming. Der Stream
  // gehört dem Chat, in dem gesendet wurde — wechselt der Nutzer den Chat,
  // läuft er im Hintergrund weiter (Puffer in activeStreamsRef); alle
  // React-State-Updates sind auf prev.id === chatId gewacht, damit Deltas
  // nie in einen fremden Chat schreiben. Resolves, sobald der Stream
  // GESTARTET ist (nicht wenn er fertig ist) — der Composer ist damit sofort
  // wieder frei, weitere Fragen landen in der Backend-Warteschlange (FIFO).
  const handleSendMessage = async (
    content: string,
    attachments: LocalAttachment[] = [],
    targetChatId?: string,
    // quoteHighlightId: der Composer schickt den Anker des Zitats mit, das er
    // gerade in den Text eingebaut hat — die persistierte Frage bleibt damit
    // anklickbar (mockup-quote-jump-to-source.html).
    quoteHighlightId?: string | null,
    // overview: nur die beiden structurePrompt-Sends setzen das. Das Backend
    // lässt das Transkript dann im Volltext, statt in den Retrieval-Modus zu
    // kippen — sonst gliedert das Modell ein Video, von dem es nur Skelett
    // und ein paar Ausschnitte gesehen hat (Nutzerentscheid 2026-08-20).
    opts?: { overview?: boolean },
  ) => {
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
    const tempUser: Message = { id: tempUserId, chat_id: chatId, role: 'user', content, created_at: now, attachments: optimisticAttachments, quote_highlight_id: quoteHighlightId ?? null };
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
      overloaded: null,
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
        overview: opts?.overview,
        quoteHighlightId: quoteHighlightId ?? null,
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
        // Visible retry on the SAME model after a 503 (mockup-truncated-answer
        // §02): the shape the SSE event carries, mirroring api.sendMessage.
        onOverloaded: (info: { retryInSeconds: number; attempt: number; maxAttempts: number; provider?: string }) => void;
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
          // Tokens flowing again = the retry succeeded, whichever wait it was.
          if (stream.rateLimit !== null) {
            stream.rateLimit = null;
            patchAssistant({ rateLimit: undefined });
          }
          if (stream.overloaded !== null) {
            stream.overloaded = null;
            patchAssistant({ overloaded: undefined });
          }
          // Content is revealed smoothly — the smoother updates
          // stream.content + the bubble via onReveal.
          stream.smoother?.push(delta);
        },
        onToolEvent: (evt) => {
          // Tool-event from the LLM. Phase 'result' for web_search carries
          // either the sources we display under the answer, or — since W2
          // (§06) — the news that the model WANTED to search and nobody
          // looked. The second case is the whole point of offering the tool
          // without a key: the wish is only visible because the call happened.
          if (evt.phase !== 'result' || evt.name !== 'web_search') return;
          if (evt.result?.error) {
            stream.searchWish = { query: evt.result.query ?? '', error: evt.result.error };
            patchAssistant({ searchWish: stream.searchWish });
            return;
          }
          if (!evt.result?.results) return;
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
            // Reasoning chunks flowing = the retry succeeded.
            if (stream.rateLimit !== null) {
              stream.rateLimit = null;
              patchAssistant({ reasoning: stream.reasoning, rateLimit: undefined });
              return;
            }
            if (stream.overloaded !== null) {
              stream.overloaded = null;
              patchAssistant({ reasoning: stream.reasoning, overloaded: undefined });
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
          onOverloaded: (info) => {
            // The provider is busy and the backend is retrying the SAME
            // model. Announced in the same spot as the 429 countdown — the
            // user is waiting either way and deserves to know on whom.
            stream.overloaded = info;
            patchAssistant({ overloaded: info });
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
          // W2 (§06): the reason the finished answer may be out of date. Found
          // in the running app 2026-08-25 — without this line the card
          // rendered mid-stream and vanished the moment the answer landed.
          ...(stream.searchWish ? { searchWish: stream.searchWish } : null),
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
          patchAssistant({ content: INTERRUPTED_MARKER, reasoning: undefined, sources: undefined, queuedAhead: undefined, queuedModel: undefined, queuedCurrent: undefined, rateLimit: undefined, overloaded: undefined });
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
        patchAssistant({ content: INTERRUPTED_MARKER, reasoning: undefined, sources: undefined, queuedAhead: undefined, queuedModel: undefined, queuedCurrent: undefined, rateLimit: undefined, overloaded: undefined });
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
          overloaded: undefined,
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
      overloaded: null,
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

  // Continue an answer the provider cut short (mockup-truncated-answer §01).
  // Deliberately NOT built on runMessageStream: that machinery creates a new
  // assistant bubble, and the whole point here is that no second bubble
  // appears — the deltas are appended to the message that already exists, so
  // the chapter list keeps seeing ONE overview.
  const handleContinueMessage = (cut: Message): Promise<ContinueResult> => {
    const chat = activeChat;
    if (!chat) return Promise.resolve(null);
    const chatId = chat.id;
    // A continuation IS the answer being written — the app just never said so.
    // Without this the bubble looked finished while rounds were still running
    // in the background, and the composer invited a question that would have
    // queued behind them (user report 2026-08-18).
    markAnswering(chatId, true);
    const patch = (fields: Partial<Message>) =>
      setActiveChat(prev =>
        prev && prev.id === chatId
          ? { ...prev, messages: prev.messages.map(m => (m.id === cut.id ? { ...m, ...fields } : m)) }
          : prev,
      );

    // The card goes as the continuation starts — it would otherwise sit under
    // a text that is visibly still growing.
    let grown = cut.content;
    patch({ truncated: 0 });

    return api
      .continueMessage(
        chatId,
        cut.id,
        (delta) => {
          grown += delta;
          patch({ content: grown });
        },
        { think: thinkByChat[chatId] || undefined },
      )
      .then(({ assistantMessage }) => {
        // The server's version wins: it knows whether THIS round finished or
        // was cut short again.
        patch({ content: assistantMessage.content, truncated: assistantMessage.truncated ?? 0 });
        return { content: assistantMessage.content, truncated: Boolean(assistantMessage.truncated) };
      })
      .catch((err) => {
        // Nothing was appended — put the card back, the answer is still cut.
        patch({ content: cut.content, truncated: 1 });
        console.error('Failed to continue message:', err);
        return null;
      })
      .finally(() => markAnswering(chatId, false));
  };

  // Continue from the chapter list. Usually the same click as the card in the
  // chat — but the overview can live in the ROOT chat while a branch is open,
  // and then there is no bubble on screen to patch: only the pane updates.
  const handleContinueOverview = (): Promise<ContinueResult> => {
    if (!videoOverview) return Promise.resolve(null);
    const { chatId, message } = videoOverview;
    if (chatId === activeChatId) {
      return handleContinueMessage(message);
    }
    let grown = message.content;
    const patchPane = (fields: Partial<Message>) =>
      setVideoOverview(v => (v && v.message.id === message.id ? { ...v, message: { ...v.message, ...fields } } : v));
    patchPane({ truncated: 0 });
    markAnswering(chatId, true);
    return api
      .continueMessage(chatId, message.id, (delta) => {
        grown += delta;
        patchPane({ content: grown });
      }, {})
      .then(({ assistantMessage }) => {
        patchPane({ content: assistantMessage.content, truncated: assistantMessage.truncated ?? 0 });
        return { content: assistantMessage.content, truncated: Boolean(assistantMessage.truncated) };
      })
      .catch((err) => {
        patchPane({ content: message.content, truncated: 1 });
        console.error('Failed to continue the overview:', err);
        return null;
      })
      .finally(() => markAnswering(chatId, false));
  };

  /**
   * The overview reads as finished and still stops well short of the video's
   * end. The `truncated` flag cannot see this: the provider ended cleanly and
   * believes it is done (Flash Lite, 16:16 of a 1:06:31 video, user report
   * 2026-08-18). The overview's own time ranges say otherwise, and the same
   * rule runs in `backend/overview-progress.js` for the endpoint.
   */
  const overviewStoppedEarly = Boolean(
    videoOverview
    && !videoOverview.message.truncated
    && overviewStopsShort(videoOverview.message.content, treeVideo?.duration_seconds),
  );

  /**
   * A cut-off answer writes itself to the end (mockup-video-overview-progress
   * §01, variant A, user decision 2026-08-18; extended from the overview to
   * EVERY answer on user request 2026-08-26). A provider that stops mid-
   * sentence used to leave a card and wait for a click that is always the same
   * answer — "yes, carry on". The app now appends by itself; the answering
   * spinner already says that writing is going on.
   *
   * It runs until the answer is WHOLE — the provider dropping the `truncated`
   * flag is the stop. Three things end it early, because a continuation is a
   * paid call carrying the whole text so far:
   * - A round that appends NOTHING. Repeating it would buy the same nothing
   *   over and over.
   * - A failed round — the card comes back and the reader decides.
   * - AUTO_CONTINUE_MAX as a runaway guard, never as a budget.
   *
   * The card in the bubble is therefore the FALLBACK, not the normal path: it
   * is what the reader sees once the automat has given up.
   */
  useEffect(() => {
    if (autoContinueBusy.current) return;

    // The overview the pane already knows — it has chapters, so it parsed.
    // Unfinished means two things here: the provider CUT it, or it reads as
    // finished and stops well before the video ends. The second is the case
    // that has no flag at all (Flash Lite, 16:16 of 1:06:31, `finish=stop`,
    // user report 2026-08-18) — the overview's own time marks are the witness.
    const known = treeVideo && videoOverview && (videoOverview.message.truncated || overviewStoppedEarly)
      ? videoOverview
      : null;
    // …or a cut answer in the OPEN chat, overview or not. Hanging the automat
    // on the parsed overview alone left the case the user hit (2026-08-18)
    // untouched — the answer broke off after its first heading, no chapter
    // parsed, and the card sat there waiting for a click.
    const fresh = !known
      ? [...(activeChat?.messages ?? [])].reverse().find(m => m.role === 'assistant' && m.truncated)
      : undefined;

    const cut = known ?? (fresh && activeChatId ? { chatId: activeChatId, message: fresh } : null);
    if (!cut) return;
    // Never on top of a running stream — the answer is not finished being cut.
    if (streamingChatIds.has(cut.chatId) || queuedChatIds.has(cut.chatId)) return;

    const id = cut.message.id;
    const before = cut.message.content.length;
    const seen = autoContinueRounds.current.get(id);
    // Already asked from exactly this point. Two things wear that disguise:
    // a state copy that has not caught up with the round just finished (the
    // pane and the chat learn of it one render apart), and a round that
    // appended nothing at all. Both must not spend another call.
    if (seen && before <= seen.from) return;
    if ((seen?.rounds ?? 0) >= AUTO_CONTINUE_MAX) return;
    autoContinueRounds.current.set(id, { rounds: (seen?.rounds ?? 0) + 1, from: before });
    autoContinueBusy.current = true;
    void (known ? handleContinueOverview() : handleContinueMessage(cut.message))
      .then((result) => {
        // Gave up, or wrote nothing: stop asking. Both leave the overview
        // visibly unfinished, so the card appears and the exit is the reader's.
        if (!result || result.content.length <= before) {
          autoContinueRounds.current.set(id, { rounds: AUTO_CONTINUE_MAX, from: before });
        }
      })
      .finally(() => {
        autoContinueBusy.current = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeVideo, videoOverview, overviewStoppedEarly, activeChat?.messages, activeChatId, streamingChatIds, queuedChatIds]);

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
      overloaded: null,
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
  // A passage selected in the transcript (mockup-transcript-selection.html,
  // variant A). Its own pending ref for the same reason the PDF and the chat
  // have theirs: the popup's actions have to know which SOURCE the passage
  // came from, because that decides where a branch hangs.
  const pendingTranscriptSelectionRef = useRef<{
    text: string; seconds: number | null; startOffset: number; endOffset: number;
    x: number; y: number; markSource?: 'transcript' | 'chapter';
  } | null>(null);
  // Renders the popup's "Ask in chat" for transcript passages. The color row
  // stays hidden for now: nothing persists a transcript highlight yet, and a
  // swatch that saves nothing is worse than no swatch.
  const [popupHasTranscriptSelection, setPopupHasTranscriptSelection] = useState(false);
  // Anchored in the transcript (colorable) as opposed to a chapter passage,
  // which can be quoted and branched from but not marked.
  const [popupHasTranscriptMark, setPopupHasTranscriptMark] = useState(false);
  // The marks of the tree's transcript. They belong to the VIDEO, so every
  // branch of the tree shows the same ones.
  const [transcriptHighlights, setTranscriptHighlights] = useState<TranscriptHighlight[]>([]);
  const savedTranscriptHighlightIdRef = useRef<string | null>(null);
  const transcriptHighlightCreatePromiseRef = useRef<Promise<TranscriptHighlight> | null>(null);

  const handleTranscriptSelection = (sel: {
    text: string; seconds: number | null; startOffset: number; endOffset: number;
    x: number; y: number; markSource?: 'transcript' | 'chapter';
  }) => {
    pendingPdfSelectionRef.current = null;
    savedHighlightIdRef.current = null;
    setPopupHasPdfSelection(false);
    pendingChatSelectionRef.current = null;
    savedChatHighlightIdRef.current = null;
    setPopupHasChatSelection(false);
    setPendingChatSelection(null);
    setHoldPdfSelection(false);
    pendingTranscriptSelectionRef.current = sel;
    savedTranscriptHighlightIdRef.current = null;
    setPopupHasTranscriptSelection(true);
    setPopupHasTranscriptMark(sel.startOffset >= 0);
    void openPopupWithExplanation({
      word: sel.text,
      context: contextAroundSelection(sel.text),
      x: sel.x,
      y: sel.y,
    });
  };

  // A passage selected in a CHAPTER (user request 2026-08-16). It goes through
  // the same popup and opens the same kind of branch, but it saves no colored
  // mark: chapters are rendered from the overview MESSAGE, so a mark here
  // would have to anchor into that message — a different anchor for what looks
  // like the same gesture. Quote and branch work; the color row stays hidden.
  const handleChapterSelection = (sel: { text: string; seconds: number | null; x: number; y: number }) => {
    // The anchor of a chapter mark is the OVERVIEW text the chapter list is
    // rendered from (user request 2026-08-16, chapters became colorable). The
    // pane reports the passage as it reads on screen, so its place in the
    // overview is found by searching — unambiguous in practice, because a
    // selection long enough to be worth keeping rarely repeats verbatim.
    const source = videoOverview?.message.content ?? '';
    const at = source.indexOf(sel.text);
    handleTranscriptSelection({
      ...sel,
      startOffset: at >= 0 ? at : -1,
      endOffset: at >= 0 ? at + sel.text.length : -1,
      markSource: 'chapter',
    });
  };

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
    const isPassage = Boolean(
      pendingPdfSelectionRef.current || pendingChatSelectionRef.current || pendingTranscriptSelectionRef.current,
    );
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
    const transcriptSel = pendingTranscriptSelectionRef.current;
    // startOffset < 0 means "no anchor in the transcript" — a chapter passage.
    if (transcriptSel && transcriptSel.startOffset >= 0 && treeVideo) {
      // Same contract as the other two surfaces: the FIRST pick persists the
      // mark, further picks recolor that same one — trying colors must not
      // leave a trail of duplicates.
      const saved = savedTranscriptHighlightIdRef.current;
      if (saved) {
        const updated = await api.updateTranscriptHighlight(saved, { color });
        if (updated) setTranscriptHighlights(prev => prev.map(h => (h.id === saved ? updated : h)));
        return;
      }
      const createPromise = api.createTranscriptHighlight(treeVideo.id, {
        color,
        text: transcriptSel.text,
        startOffset: transcriptSel.startOffset,
        endOffset: transcriptSel.endOffset,
        startSeconds: transcriptSel.seconds,
        source: transcriptSel.markSource ?? 'transcript',
      });
      transcriptHighlightCreatePromiseRef.current = createPromise;
      try {
        const created = await createPromise;
        if (created) {
          savedTranscriptHighlightIdRef.current = created.id;
          setTranscriptHighlights(prev => [...prev, created]);
        }
      } catch (err) {
        console.error('Failed to save the transcript highlight:', err);
      } finally {
        transcriptHighlightCreatePromiseRef.current = null;
      }
      return;
    }
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
    if (creatingChildRef.current) return;
    creatingChildRef.current = true;
    setCreatingChild(true);
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
    // The parent follows the ORIGIN of the selection, not whichever chat
    // happens to be active (user report 2026-08-06: selecting PDF text while a
    // grandchild chat was open hung the branch under that grandchild). A chat
    // selection branches from the chat it lives in; a PDF selection belongs to
    // the tree ROOT, because that is where the source is bound
    // (ADR-0002 / backend/routes/papers.js binds the paper to root.id).
    const transcriptSel = pendingTranscriptSelectionRef.current;
    const parentId = popupHasChatSelection && chatSel
      ? chatSel.chatId
      // A transcript passage belongs to the tree ROOT for the same reason a
      // PDF passage does: that is where the source is bound (ADR-0005).
      : fromPdf || transcriptSel
        ? findRoot(chats, activeChatId)?.id ?? activeChatId
        : activeChatId;

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
      // quote: the same passage with its math restored — display only, so
      // the branch header shows a set formula while parent_word stays the
      // verbatim extraction (decision 2026-08-02, option B).
      const { title, quote } = await awaitTitle(pendingTitleRef.current, word);
      pendingTitleRef.current = null;
      child = await api.createChat(
        S.aboutChatTitle(title), parentId, word,
        fromPdf && context ? context : undefined,
        quote ?? undefined,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : S.unknownError;
      setExplanation(S.couldNotCreateChat(msg));
      console.error('createChat failed:', err);
      // The popup stays open with the error in its body, so the button has to
      // become clickable again — the user's retry is the only way forward.
      creatingChildRef.current = false;
      setCreatingChild(false);
      return;
    }
    // The chat exists; the popup closes now, so the loading state has done its
    // job. Everything below is bookkeeping the user no longer waits on.
    creatingChildRef.current = false;
    setCreatingChild(false);
    setPopup(null);
    pendingPdfSelectionRef.current = null;
    savedHighlightIdRef.current = null;
    pendingChatSelectionRef.current = null;
    savedChatHighlightIdRef.current = null;
    pendingTranscriptSelectionRef.current = null;
    setPopupHasChatSelection(false);
    setPendingChatSelection(null);
    setHoldPdfSelection(false);
    if (!fromPdf && chatSel) {
      setParentScrollTarget({ chatId: chatSel.chatId, messageId: chatSel.messageId });
    }
    // A transcript branch leaves its mark behind, exactly like a PDF branch:
    // either the one the color pick already saved, or a fresh one in the
    // active color — otherwise the passage this chat came from would be
    // invisible in the transcript.
    if (transcriptSel && transcriptSel.startOffset >= 0 && treeVideo) {
      if (transcriptHighlightCreatePromiseRef.current) {
        await transcriptHighlightCreatePromiseRef.current.catch(() => null);
      }
      const savedTh = savedTranscriptHighlightIdRef.current;
      try {
        if (savedTh) {
          const updated = await api.updateTranscriptHighlight(savedTh, { childChatId: child.id });
          if (updated) setTranscriptHighlights(prev => prev.map(h => (h.id === savedTh ? updated : h)));
        } else {
          const created = await api.createTranscriptHighlight(treeVideo.id, {
            color: activeColor,
            text: transcriptSel.text,
            startOffset: transcriptSel.startOffset,
            endOffset: transcriptSel.endOffset,
            startSeconds: transcriptSel.seconds,
            source: transcriptSel.markSource ?? 'transcript',
            childChatId: child.id,
          });
          if (created) setTranscriptHighlights(prev => [...prev, created]);
        }
      } catch (err) {
        console.error('Failed to link the transcript highlight:', err);
      }
      savedTranscriptHighlightIdRef.current = null;
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
  const handleAskInChat = async (word: string) => {
    if (!activeChatId) return;
    const quoteChatId = activeChatId;
    setPopup(null);
    const fromPdf = popupHasPdfSelection;
    const transcriptSel = pendingTranscriptSelectionRef.current;
    const chatSel = pendingChatSelectionRef.current;
    // The highlight this quote will be anchored to, so the sent message can
    // jump back to it (mockup-quote-jump-to-source.html, variant A). A swatch
    // click may still be creating it — the same race "Open as new chat"
    // guards against; here the quote is shown at once and its anchor patched
    // in when the create settles, so the composer never waits on the network.
    const savedPdfHl = savedHighlightIdRef.current;
    const savedChatHl = savedChatHighlightIdRef.current;
    let pendingCreate: Promise<MessageHighlight | null> | null = null;
    if (chatSel && !savedChatHl) {
      pendingCreate = hlApiFor(chatSel.chatId).create({
        messageId: chatSel.messageId,
        color: activeColor,
        text: chatSel.text,
        startOffset: chatSel.startOffset,
        endOffset: chatSel.endOffset,
      });
    }
    const quoteColor = savedPdfHl || savedChatHl || chatSel ? activeColor : null;
    pendingPdfSelectionRef.current = null;
    savedHighlightIdRef.current = null;
    pendingChatSelectionRef.current = null;
    savedChatHighlightIdRef.current = null;
    pendingTranscriptSelectionRef.current = null;
    setPopupHasTranscriptSelection(false);
    setPopupHasTranscriptMark(false);
    setPopupHasPdfSelection(false);
    setPopupHasChatSelection(false);
    setPendingChatSelection(null);
    setHoldPdfSelection(false);

    const sourceLabel = transcriptSel
      // The transcript quote names its MOMENT (mockup-transcript-selection
      // §02): "Transcript · 8:58". The chat title would say nothing the
      // reader cannot already see, while the time is the way back.
      ? `${STR.videoPane.transcript}${transcriptSel.seconds !== null ? ` · ${formatDuration(transcriptSel.seconds)}` : ''}`
      : fromPdf
        ? treePaper?.title ?? 'PDF'
        : (chatSel?.chatId === parentContext?.id ? parentContext?.title : activeChat?.title) ??
          S.chatFallbackLabel;
    setComposerQuote({
      chatId: quoteChatId,
      text: word,
      sourceLabel,
      color: quoteColor,
      // A PDF selection without a color pick saves no highlight at all
      // (decision 2026-07-21) — that quote stays unanchored and renders as
      // plain text, exactly as before.
      highlightId: savedPdfHl ?? savedChatHl ?? savedTranscriptHighlightIdRef.current ?? null,
    });

    if (pendingCreate) {
      const created = await pendingCreate.catch(() => null);
      if (created) {
        setComposerQuote((prev) =>
          prev && prev.chatId === quoteChatId && prev.text === word
            ? { ...prev, highlightId: created.id }
            : prev,
        );
      }
    }
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
    } else if (item.kind === 'chat') {
      const { kind: _kind, chatTitle: _title, ...highlight } = item;
      setChatHighlightMenu({ highlight, x, y });
    }
    // Video marks (transcript/chapter, since 2026-08-16) have no chatId and no
    // messageId, so neither menu can act on them — they carry no menu yet.
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
    // A video mark lives in the pane, not in a chat: the pane opens the right
    // view, seeks the player and lets it glow (2026-08-16). Asked as "not a
    // chat mark" rather than kind-by-kind so everything below is narrowed to
    // TreeChatHighlight — a two-value discriminant ('transcript' | 'chapter')
    // does not narrow the union away on its own.
    if (item.kind !== 'chat') {
      videoPaneRef.current?.showHighlight(item.id);
      return;
    }
    // Branch layout (no PDF, parent context in the center pane): a card
    // pointing into the parent chat scrolls the visible center pane instead
    // of switching chats — the drawer stays open, target and list remain
    // visible side by side (user correction 2026-07-29).
    if (parentPaneVisible && parentContext && item.chatId === parentContext.id) {
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

  // Click on the quote inside a user bubble (mockup-quote-jump-to-source.html,
  // variant A): jump to the passage the quote was taken from — the same
  // landing as a drawer card, so PDF, parent chat and same chat all behave
  // exactly as the user already knows them.
  //
  // The message stores only the highlight id; WHICH kind it is (PDF or chat
  // text) and where it lives are resolved from the tree-highlight list. That
  // lookup doubles as the existence check: a highlight the user has since
  // deleted simply isn't in the list, and the click does nothing rather than
  // scrolling somewhere wrong.
  const handleQuoteJump = async (message: Message) => {
    const anchorId = message.quote_highlight_id;
    if (!anchorId || !activeChatId) return;
    // A transcript or chapter mark lives in the video pane, not in the chat
    // or the PDF — it glows there instead (user request 2026-08-16).
    if (transcriptHighlights.some((h) => h.id === anchorId)) {
      videoPaneRef.current?.showHighlight(anchorId);
      return;
    }
    let items: TreeHighlight[] = [];
    try {
      items = await api.listTreeHighlights(activeChatId);
    } catch {
      return; // Backend unreachable — better nothing than a wrong jump
    }
    const target = items.find((h) => h.id === anchorId);
    if (!target) return;
    setFocusedHighlightId(target.id);
    handleDrawerJump(target);
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

  // Gegenstück für den Rückweg zur Abzweig-Zeile: der Elternchat ist da, die
  // Zeile darf leuchten. Eingeklappte Stapel klappt ChatArea selbst auf.
  useEffect(() => {
    const pending = pendingTraceScrollRef.current;
    if (pending && activeChat?.id === pending.chatId) {
      pendingTraceScrollRef.current = null;
      chatAreaRef.current?.scrollToBranchTrace(pending.branchChatId);
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
    // Same move for a video tree (user report 2026-08-16: "going back from the
    // chat does not make it glow"): the mark that opened this branch lives in
    // the transcript or in a chapter, so the pane shows it — right view, right
    // second, and the glow.
    const linkedTranscriptMark = transcriptHighlights.find((h) => h.childChatId === chat.id);
    if (linkedTranscriptMark && treeVideo) {
      videoPaneRef.current?.showHighlight(linkedTranscriptMark.id);
      return;
    }
    // Zweig ohne Passage (`/btw`, `/branch`): sein Rückweg ist die eigene
    // Abzweig-Zeile im Elternchat (mockup-branch-trace.html §07). Die
    // Highlight-Suche unten fände nichts — es gibt keine markierte Stelle,
    // nur einen Zeitpunkt. Anders als beim Passagen-Zweig wird hier bewusst
    // GEWECHSELT: die Zeile steht im Verlauf des Elternchats, und der
    // Eltern-Kontext-Streifen zeigt nur Nachrichten, keine Abzweigungen.
    if (chat.branch_origin) {
      pendingTraceScrollRef.current = { chatId: parentId, branchChatId: chat.id };
      await handleSelectChat(parentId);
      return;
    }
    let match: MessageHighlight | undefined;
    try {
      const parentHighlights = await api.listMessageHighlights(parentId);
      const quote = chat.parent_word?.trim();
      // The link back is the anchor, the quote text only its fallback: a mark
      // created on branching already names this chat, while its text can
      // differ from parent_word once the model restores math in the quote.
      match =
        parentHighlights.find((h) => h.childChatId === chat.id) ??
        (quote ? parentHighlights.find((h) => h.text.trim() === quote) : undefined);
    } catch {
      /* Backend unreachable — at least switch to the parent chat below */
    }
    if (match && parentPaneVisible && parentContext?.id === parentId) {
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

  // Find a chat anywhere in the loaded tree — the mind map hands back only
  // an id, but the jump needs the node's parent_id.
  const findChatInTree = (list: Chat[], id: string): Chat | null => {
    for (const chat of list) {
      if (chat.id === id) return chat;
      const hit = chat.children ? findChatInTree(chat.children, id) : null;
      if (hit) return hit;
    }
    return null;
  };

  // Titel des Elternchats für den Rückweg-Link eines Topic branch — der
  // geladene Baum weiß ihn bereits, ein eigener Request wäre Verschwendung.
  const activeParentTitle = useMemo(
    () => (activeChat?.parent_id ? findChatInTree(chats, activeChat.parent_id)?.title ?? null : null),
    [chats, activeChat?.parent_id],
  );

  // Click on a mind-map node (user request 2026-08-02): open the chat AND
  // jump to the passage it was opened from — the PDF highlight is scrolled to
  // and blinks, the drawer lifts the matching card. Same mechanics as the
  // "Branched from" link, the decision itself lives in chat/branchSource.ts.
  // A branch without a highlight keeps the old behaviour: switch only.
  // ── Keyboard navigation (ADR-0011, design/mockup-keyboard-navigation.html)
  // Escape hands focus to the structure once nothing is left to close, arrows
  // walk the regions, Enter acts, any printable key gives the composer back.
  // The regions themselves are read off the DOM, so this only has to supply
  // what the DOM cannot say: what is open, and what "activate" means.

  // Collapse state of the chat tree, lifted here so ← can collapse a node
  // before the key overflows into the region to the left.
  const [collapsedChatIds, setCollapsedChatIds] = useState<Set<string>>(new Set());
  const treeCollapse = useMemo(
    () => ({
      collapsedIds: collapsedChatIds,
      onToggle: (chatId: string, expanded: boolean) =>
        setCollapsedChatIds(prev => {
          const next = new Set(prev);
          if (expanded) next.delete(chatId);
          else next.add(chatId);
          return next;
        }),
    }),
    [collapsedChatIds],
  );

  // A modal takes the keyboard entirely — nothing behind it can be navigated.
  // Listed explicitly rather than sniffed from the DOM: Escape's chain is a
  // promise to the user, and a forgotten entry would silently break a close
  // gesture.
  const modalOpen =
    settingsOpen ||
    feedbackOpen ||
    paperSearchOpen ||
    youtubeSearchOpen;

  // These only take Escape away. The highlights drawer is a REGION the ring
  // can walk into, so freezing the arrows with it locked navigation entirely
  // while it was open (user report 2026-08-11).
  const escapeTaken =
    modalOpen ||
    popup !== null ||
    // The highlight actions menus are MENUS, not modals: the ring walks into
    // them and their colour swatches answer to ← → (user request 2026-08-12).
    // Listing them as modal froze every arrow key while one was open.
    highlightMenu !== null ||
    chatHighlightMenu !== null ||
    highlightsOpen ||
    (activeChatId ? asides[activeChatId] !== undefined : false);

  const handleKeyboardActivate = (position: FocusPosition) => {
    // A control is pressed, whatever region it sits in — the sidebar's header
    // and footer, the composer's row, a menu entry, a PDF highlight.
    //
    // NOT `el.click()`: a synthetic click carries clientX/clientY = 0, so the
    // highlight actions menu opened in the screen's top-left corner instead of
    // beside the highlight (user report 2026-08-11). The event is dispatched
    // from the element's own centre so every handler that reads coordinates
    // gets the truth.
    // `role="button"` counts as a control too, not only a real <button>: the
    // video pane's chapters and transcript blocks have to be divs — text
    // inside a <button> cannot be dragged over in Chrome, and those rows must
    // do both — so a tag check alone left the whole middle column dead under
    // ↵ (user report 2026-08-17).
    const el = findItem(position.region, position.item);
    if (el?.tagName === 'BUTTON' || el?.getAttribute('role') === 'button') {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
        }),
      );
      return;
    }

    if (position.region === 'sidebar' || position.region === 'map') {
      void handleSelectChat(position.item);
      return;
    }
    if (position.region === 'chat') {
      if (position.item === 'composer') {
        chatAreaRef.current?.focusComposer();
        return;
      }
      // Enter takes the bubble whole and opens the usual selection popup —
      // colours, "Open as new chat", "Ask in chat" (decision 2026-08-10).
      chatAreaRef.current?.selectWholeMessage?.(position.item);
    }
  };

  useKeyboardNavigation({
    escapeTaken,
    modalOpen,
    onActivate: handleKeyboardActivate,
    onToggleNode: (chatId, expanded) => treeCollapse.onToggle(chatId, expanded),
    onReturnToComposer: text => chatAreaRef.current?.focusComposer(text),
  });

  const handleMindMapSelect = async (chatId: string) => {
    const node = findChatInTree(chats, chatId);
    await handleSelectChat(chatId);
    if (!node?.parent_id) return;

    let parentHighlights: MessageHighlight[] = [];
    try {
      parentHighlights = await api.listMessageHighlights(node.parent_id);
    } catch {
      /* Backend unreachable — the chat switch above already happened */
    }
    const jump = branchSourceJump(chatId, { pdfHighlights: highlights, parentHighlights });
    if (!jump) return;

    // The drawer, if open, lifts the same highlight into view.
    setFocusedHighlightId(jump.highlightId);
    if (jump.kind === 'pdf') {
      if (treePaper) pdfViewRef.current?.scrollToHighlight(jump.highlightId);
      return;
    }
    // Chat-text source: the parent pane shows it when the branch layout has
    // one; otherwise remember it for the parent chat.
    if (parentContext?.id === jump.chatId) {
      setParentScrollTarget({ chatId: jump.chatId, messageId: jump.messageId });
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-white relative isolate">
      <MatrixRain />
      {/* Sidebar: chat list, new chat button, and mind map toggle */}
      <Sidebar
        collapse={treeCollapse}
        chats={chats}
        activeChatId={activeChatId}
        onSelect={handleSelectChat}
        onNewChat={handleNewChat}
        onDelete={handleDeleteChat}
        onRename={handleRenameChat}
        onTogglePin={handleTogglePin}
        categories={categories}
        onCreateCategory={handleCreateCategory}
        onRenameCategory={handleRenameCategory}
        onDeleteCategory={handleDeleteCategory}
        onToggleCategoryCollapsed={handleToggleCategoryCollapsed}
        onMoveChatToCategory={handleMoveChatToCategory}
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
            <div data-focus-region="map" style={{ height: `${mapPaneHeightPct}%` }}>
              <MindMap
                chats={chats}
                activeChatId={activeChatId}
                onSelect={handleMindMapSelect}
              />
            </div>
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label={S.resizeMindMap}
              data-testid="mindmap-pane-resizer"
              {...mapPaneResize}
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
              citations={citationsData.citations}
              onCitationClick={(citation, point) => {
                const reference = citationsData.referenceFor(citation);
                if (!reference) return;
                setCitationFailedId(null);
                setCitationCard({ reference, x: point.clientX, y: point.clientY });
                // Nothing is looked up at import time (that rate-limited
                // OpenAlex), so an unresolved reference is searched exactly
                // now — while the reader looks at its card. The result
                // replaces the row in place.
                void citationsData.resolve(reference).then((filled) => {
                  if (filled !== reference) {
                    setCitationCard((open) =>
                      open && open.reference.id === filled.id ? { ...open, reference: filled } : open,
                    );
                  }
                  // …and if the paper linked no PDF for it, the web is asked
                  // for one. Usually this has already run while the page was
                  // drawn or the mouse hovered (§ 05), in which case it is a
                  // no-op and the door is there before the card is.
                  // Not through the queue: an opened card is an explicit
                  // request, so it asks even when prefetching has backed off.
                  if (!filled.pdfUrl) void citationsData.ensureFulltext(filled.id).catch(() => {});
                });
              }}
              // Hovering a citation mark is the earliest honest signal that
              // it is about to be clicked (§ 05).
              onCitationHover={(citation) => {
                const reference = citationsData.referenceFor(citation);
                if (reference && !reference.pdfUrl) fulltextQueue.prioritize(reference.id);
              }}
              // Whatever page is on screen, its citations get their full text
              // looked up quietly — about four per page, instead of ~25 in one
              // burst at import (measured 2026-08-10).
              onVisibleCitationsChange={(visible) => {
                fulltextQueue.clearPending();
                fulltextQueue.enqueue(
                  visible
                    .map((c) => citationsData.referenceFor(c))
                    .filter((r): r is PaperReference => Boolean(r) && !r!.pdfUrl)
                    .map((r) => r.id),
                );
              }}
            />
          )}
          {/* Video tree: the player takes the center pane, the chapters of the
              Video overview stand under it (mockup-youtube-embed-layout.html,
              variant C). A tree has exactly one source (ADR-0005), so this
              never competes with the PDF pane. */}
          {treeVideo && activeChatId && (
            <VideoPane
              ref={videoPaneRef}
              video={treeVideo}
              overview={videoOverview?.message.content ?? null}
              overviewStreaming={
                // The whole time the answer is being written — not only until
                // the first heading lands. The old rule ("once headings are in,
                // the list itself is the progress") let the CARD through while
                // the first answer was still streaming: it offered to continue
                // an overview that was being written at that very moment (user
                // report with picture 2026-08-18). One state, one meaning:
                // while this chat is answering, the pane says so and the card
                // stays quiet.
                Boolean(activeChatId && (streamingChatIds.has(activeChatId) || queuedChatIds.has(activeChatId)))
              }
              overviewTruncated={Boolean(videoOverview?.message.truncated)}
              overviewStoppedEarly={overviewStoppedEarly}
              overviewContinuing={Boolean(videoOverview && continuingChatIds.has(videoOverview.chatId))}
              onContinueOverview={handleContinueOverview}
              onTranscriptSelection={handleTranscriptSelection}
              transcriptHighlights={transcriptHighlights}
              onChapterSelection={handleChapterSelection}
              onOpenHighlightChat={(chatId) => void handleSelectChat(chatId)}
              onRequestTranscript={() => void ensureTranscript()}
            />
          )}
          {/* No-PDF branch layout (mockup-chat-highlights-ask-in-chat.html,
              section 03): the parent chat takes the center pane as read-only
              context while the branch lives in the right pane. */}
          {parentPaneVisible && parentContext && activeChatId && (
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
              onQuoteClick={handleQuoteJump}
            />
          )}
          {/* Divider between center pane (PDF or parent context) and chat —
              drag to resize the chat column sideways (min 300px, max 800px).
              Only present in the three-column layout. */}
          {(treePaper || treeVideo || parentContext) && activeChatId && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={S.resizeChatColumn}
              data-testid="chat-pane-resizer"
              {...chatPaneResize}
              className="w-1.5 shrink-0 cursor-col-resize bg-gray-200 hover:bg-blue-300 active:bg-blue-400 transition-colors"
            />
          )}
          {/* The chat column. maxWidth reserves CENTER_PANE_MIN for the center
              pane on narrow windows — chatPaneWidth alone squeezes it down to a
              sliver (user report 2026-08-08); the max() keeps the chat itself
              usable once not even that fits. */}
          <div
            className={
              (treePaper || treeVideo || parentContext) && activeChatId
                ? 'shrink-0 flex overflow-hidden border-l border-gray-200'
                : 'flex-1 flex overflow-hidden'
            }
            style={
              (treePaper || treeVideo || parentContext) && activeChatId
                ? {
                    width: chatPaneWidth,
                    maxWidth: `max(${CHAT_PANE_MIN}px, calc(100% - ${CENTER_PANE_MIN}px))`,
                  }
                : undefined
            }
            data-testid={(treePaper || treeVideo || parentContext) && activeChatId ? 'chat-pane-right' : undefined}
          >
            <ChatArea
              ref={chatAreaRef}
              chat={activeChat}
              videoYoutubeId={treeVideo?.youtube_id}
              onTimeMarkClick={treeVideo ? (seconds) => videoPaneRef.current?.seekTo(seconds) : undefined}
              loading={loadingChat}
              streaming={activeChatId ? streamingChatIds.has(activeChatId) || queuedChatIds.has(activeChatId) || continuingChatIds.has(activeChatId) : false}
              streamingMessageIds={streamingMessageIds}
              onSendMessage={handleSendMessage}
              onOpenFeedback={(initialText) => { setFeedbackInitialText(initialText); setFeedbackOpen(true); }}
              onAskAside={handleAskAside}
              onOpenTopicBranch={handleOpenTopicBranch}
              branchTargets={branchTargets}
              aside={activeChatId ? asides[activeChatId] ?? null : null}
              onDismissAside={() => activeChatId && dismissAside(activeChatId)}
              onKeepAside={handleKeepAside}
              onBranchAside={handleBranchAside}
              onRetryMessage={handleRetryMessage}
              onContinueMessage={handleContinueMessage}
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
              // §04 V1+V2: the image gate is computed once, from the same
              // registry the picker reads, and handed to the composer.
              visionGate={
                settings
                  ? buildVisionGate({ settings, registry, ollamaModels, ollamaReachable })
                  : undefined
              }
              onSwitchVisionModel={(target) => void handleSelectModel(target.provider, target.model)}
              onOpenSettingsForProvider={(provider) => openSettings('model', provider)}
              // §07 G2: the free provider still missing a key. Never the one
              // whose limit just hit — offering it back would be absurd.
              freeProviderOffer={
                settings
                  ? buildFreeProviderOffer({
                      settings,
                      registry,
                      labels: {
                        requestsPerDay: STR.modelPicker.freeQuotaRequestsPerDay,
                        tokensPerDay: STR.modelPicker.freeQuotaTokensPerDay,
                      },
                    })
                  : null
              }
              onAddFreeProvider={(provider) => openSettings('model', provider)}
              onRetryFreeModel={(m) => void handleRetryFreeModel(m)}
              onResendUnanswered={handleResendUnanswered}
              // W2 (§06): the key arrives from the card under an answer the
              // model could not look up — so storing it is only half the
              // gesture. The other half is ASKING AGAIN.
              //
              // Asking, not regenerating: handleRetryMessage was tried first
              // and the running app answered 409 "nothing to regenerate"
              // (2026-08-25). That endpoint replaces a *Failed*/*Interrupted*
              // marker, and this answer succeeded — it was only older than the
              // question. So the stale answer stays as the record of what the
              // model knew, and the new one arrives beneath it with a search
              // behind it.
              onSaveSearchKey={async (key, message) => {
                const s = await api.updateSettings({ tavily_api_key: key });
                setSettings(s);
                const chat = activeChat;
                if (!chat) return;
                const ordered = orderMessages(chat.messages);
                const idx = ordered.findIndex(m => m.id === message.id);
                const question = idx === -1
                  ? null
                  : ordered.slice(0, idx).reverse().find(m => m.role === 'user');
                if (question) void handleSendMessage(question.content, [], chat.id);
              }}
              searchKeyStored={settings?.tavily_api_key_set ?? false}
              modelLabels={modelLabels}
              onWordRightClick={handleWordRightClick}
              onSelectChat={handleSelectChat}
              onBranchedFromClick={handleBranchedFromClick}
              parentTitle={activeParentTitle}
              onQuoteClick={handleQuoteJump}
              onUploadPdf={handleUploadPdf}
              onOpenPaperSearch={() => setPaperSearchOpen(true)}
              onOpenYouTubeSearch={() => setYoutubeSearchOpen(true)}
              chatHighlights={activeChatHl.highlights}
              onChatSelection={handleChatSelection}
              onHighlightContextMenu={(h, x, y) => setChatHighlightMenu({ highlight: h, x, y })}
              pendingSelection={pendingChatSelection}
              composerQuote={composerQuote && composerQuote.chatId === activeChat?.id ? composerQuote : null}
              onClearComposerQuote={() => setComposerQuote(null)}
              onToggleHighlights={() => setHighlightsOpen((o) => !o)}
              highlightsOpen={highlightsOpen}
              onStopStreaming={handleStopStreaming}
              // O2 (mockup-onboarding-flow §03, chosen 2026-08-15): the three
              // locked affordances — send button, Enter, model pill — all lead
              // here, to the path choice, with the typed question left standing.
              onOpenSetup={() => openSettings('model')}
              firstRun={
                // Active cloud provider without a key (ADR-0008, grill 12b).
                // Since O2 this only locks sending and shows the notice strip —
                // the app is usable before the user has paid for anything. The
                // three-path card it replaced is gone (2026-08-22).
                Boolean(
                  settings && settings.llm_provider !== 'ollama' &&
                  !settings[`${settings.llm_provider}_api_key_set`]
                )
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
                      setup: STR.modelPicker.setupGroup,
                    })}
                    ollamaReachable={ollamaReachable}
                    cloudCount={CLOUD_PROVIDERS.filter(p => settings[`${p}_api_key_set`]).length}
                    onSelectModel={(provider, name) => void handleSelectModel(provider, name)}
                    think={Boolean(thinkByChat[activeChatId])}
                    onToggleThink={() =>
                      setThinkByChat(prev => ({ ...prev, [activeChatId]: !prev[activeChatId] }))
                    }
                    onOpenSettings={() => openSettings('model')}
                    // G3 (§07): a "to set up" row is not a model choice — it
                    // opens that provider's key form.
                    onSetupProvider={(provider) => openSettings('model', provider)}
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
                highlightsOpen && activeChatId && (treePaper || treeVideo || parentContext) ? (
                  <HighlightsDrawer
                    chatId={activeChatId}
                    onClose={() => setHighlightsOpen(false)}
                    onJump={handleDrawerJump}
                    onItemContextMenu={handleDrawerItemContextMenu}
                    focusHighlightId={focusedHighlightId}
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
                focusHighlightId={focusedHighlightId}
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
          data-overlay
        >
          <div className="bg-white rounded-xl shadow-xl w-[26rem] max-w-[calc(100vw-2rem)] p-6">
            <div className="flex items-center gap-2.5 mb-2">
              <FileText size={18} className="text-blue-500 shrink-0" />
              <h3 className="text-[15px] font-medium text-gray-900">{S.newTreeTitle}</h3>
            </div>
            {/* Variante C (Nutzerwahl 2026-08-15,
                design/mockup-new-tree-prompt.html): die beiden Quellen als
                Karten untereinander, statt den Titel in einen Satz zu setzen.

                Zwei Gründe. Erstens die Lesbarkeit: der Titel stand mitten im
                Satz („Neuen Baum mit <Titel> starten?"), und bei 368 px
                Textbreite braucht ein Video-Titel schon mal drei Zeilen — das
                „starten?" landete allein in der vierten. Zweitens die
                Auskunft: die Überschrift behauptet „hat bereits eine Quelle",
                nannte sie aber nicht. Der Baum kennt sie längst.

                Die Frage im Text entfällt ganz — der Bestätigen-Knopf sagt
                schon, was passiert. */}
            <p className="text-sm text-gray-600 leading-relaxed mb-3.5">{S.newTreeLead}</p>

            {/* Die Quelle, die schon im Baum hängt. Gedämpft, weil sie hier
                nur der Bezugspunkt ist — gehandelt wird mit der neuen. */}
            {(treeVideo || treePaper) && (
              <>
                <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-gray-400 mb-1.5">
                  {S.newTreeCurrent}
                </p>
                <div className="flex items-start gap-2.5 rounded-[10px] border border-gray-200 bg-gray-50 px-2.5 py-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-gray-100 text-gray-500">
                    {treeVideo ? <TvMinimalPlay size={13} /> : <FileText size={13} />}
                  </span>
                  <span className="min-w-0">
                    {/* line-clamp-2 + title: ein sehr langer Name darf den
                        Dialog nicht wachsen lassen, muss aber vollständig
                        erreichbar bleiben. */}
                    <span
                      className="line-clamp-2 text-[13px] font-medium leading-snug text-gray-600"
                      title={treeVideo ? treeVideo.title : (treePaper?.title ?? undefined)}
                    >
                      {treeVideo
                        ? <MathText text={treeVideo.title} />
                        : <MathText text={treePaper?.title ?? S.newTreeUntitledPdf} />}
                    </span>
                    <span className="mt-0.5 block text-[11.5px] text-gray-500">
                      {treeVideo
                        ? `${S.newTreeKindVideo}${treeVideo.channel ? ` · ${treeVideo.channel}` : ''}`
                        : `${S.newTreeKindPdf}${treePaper?.authors?.[0] ? ` · ${treePaper.authors[0]}` : ''}`}
                    </span>
                  </span>
                </div>
                <div className="grid place-items-center py-1 text-gray-300" aria-hidden="true">
                  <ArrowDown size={15} />
                </div>
              </>
            )}

            <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-gray-400 mb-1.5">
              {S.newTreeNext}
            </p>
            <div
              className="flex items-start gap-2.5 rounded-[10px] border border-gray-200 bg-gray-50 px-2.5 py-2"
              data-testid="new-tree-next-source"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-blue-50 text-blue-700">
                {pendingAttach.kind === 'video' ? <TvMinimalPlay size={13} /> : <FileText size={13} />}
              </span>
              <span className="min-w-0">
                <span
                  className="line-clamp-2 text-[13px] font-semibold leading-snug text-gray-900"
                  title={pendingAttach.kind === 'file' ? pendingAttach.file.name : pendingAttach.title}
                >
                  {pendingAttach.kind === 'file'
                    ? pendingAttach.file.name
                    : <MathText text={pendingAttach.title} />}
                </span>
                <span className="mt-0.5 block text-[11.5px] text-gray-500">
                  {pendingAttach.kind === 'video' ? S.newTreeKindVideo : S.newTreeKindPdf}
                </span>
              </span>
            </div>
            {/* mt-5: der Abstand hing vorher am mb-5 des Fließtext-Absatzes,
                den Variante C ersetzt hat. */}
            <div className="mt-5 flex justify-end gap-2">
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
      {/* The citation card — same surface for a mark in the running text and
          for a row of the reference list, because those are the same thing. */}
      <CitationCard
        // The card renders the LIVE reference, not the one captured at click
        // time. The silent search fills `pdfUrl` and `fulltextHost` seconds
        // after the card opens — with a frozen snapshot the door never
        // appeared and a blocked search still read "no full text found"
        // (seen in the running app 2026-08-10).
        target={citationCard && citationReference ? { ...citationCard, reference: citationReference } : null}
        existingChatId={citationCard ? citedTrees.get(citationCard.reference.id) ?? null : null}
        loading={citationCard?.reference.id === citationLoadingId}
        failed={citationCard?.reference.id === citationFailedId}
        // The silent search, as far as the card is allowed to know it
        // (§ 04): still looking, looked and found nothing, or could not look.
        searching={
          citationCard
            ? citationsData.fulltextState[citationCard.reference.id] === 'searching'
            : false
        }
        searchDone={
          citationCard
            ? citationsData.fulltextState[citationCard.reference.id] === 'done'
            : false
        }
        searchFailed={Boolean(citationReference?.fulltextSearchFailed)}
        searchRetryAt={citationReference?.fulltextRetryAt ?? null}
        // W1 (§06): no search is set up at all. The card asks for the key
        // here, where a search would have run.
        searchUnavailable={Boolean(citationReference?.fulltextSearchUnavailable)}
        searchReason={citationReference?.fulltextSearchReason ?? null}
        onSaveSearchKey={async (key) => {
          const s = await api.updateSettings({ tavily_api_key: key });
          setSettings(s);
          // The miss was never recorded (references.js returns early without
          // setting fulltext_done), so asking again actually asks.
          if (citationReference) {
            await citationsData.ensureFulltext(citationReference.id).catch(() => {});
          }
        }}
        onRetrySearch={() => {
          if (citationReference) void citationsData.ensureFulltext(citationReference.id).catch(() => {});
        }}
        onClose={() => setCitationCard(null)}
        onOpenInSyflo={handleCitationOpenInSyflo}
        onOpenInBrowser={handleCitationBrowser}
        onGoToTree={(chatId) => {
          setCitationCard(null);
          void handleSelectChat(chatId);
        }}
      />

      <FloatingPopup
        popup={popup}
        explanation={explanation}
        loading={loadingExplanation}
        onClose={handleClosePopup}
        onOpenChildChat={handleOpenChildChat}
        onPickColor={
          popupHasPdfSelection || popupHasChatSelection || popupHasTranscriptMark
            ? handlePickColor
            : undefined
        }
        activeColor={activeColor}
        onAskInChat={
          popupHasPdfSelection || popupHasChatSelection || popupHasTranscriptSelection
            ? handleAskInChat
            : undefined
        }
        creating={creatingChild}
      />

      {/* Paper-search modal (Slice 07): search OpenAlex + arXiv and import
          an open-access PDF into the active chat tree. */}
      {paperSearchOpen && activeChatId && (
        <PaperSearchModal
          onClose={() => setPaperSearchOpen(false)}
          onImport={handleImportPaper}
        />
      )}

      {/* Video-Such-Modal (ADR-0005): YouTube über die InnerTube-
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
