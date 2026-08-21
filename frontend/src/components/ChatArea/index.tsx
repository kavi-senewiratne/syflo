/**
 * components/ChatArea/index.tsx
 *
 * The main conversation panel. Renders the message history, the auto-expanding
 * input field, the send button, and the microphone button for voice dictation.
 */

import { Fragment, useState, useRef, useEffect, useImperativeHandle, useMemo } from 'react';
import { AlertCircle, Cpu, Eye, EyeOff, Loader2, Mic, MicOff, MessageCircleQuestionMark, Plus, ArrowUp, Check, ChevronDown, ChevronRight, CornerDownRight, KeyRound, GitBranch, Highlighter, Image as ImageIcon, ImagePlus, FileText, BookOpen, MessageSquareQuote, MessageSquarePlus, RotateCcw, Square, TvMinimalPlay, X, Zap } from 'lucide-react';
import { MessageBubble } from './MessageBubble';
import { BranchTrace } from './BranchTrace';
import { InlineMarkdown } from './InlineMarkdown';
import { MathText, hasMath, plainMathText } from '../MathText';
import { AttachmentChip } from './AttachmentChip';
import { BtwPanel } from './BtwPanel';
import { Logo } from '../Logo';
import { VoiceWaveform } from './VoiceWaveform';
import { useVoiceInput } from '../../hooks/useVoiceInput';
import { useStrings } from '../../strings';
import { HIGHLIGHT_HEX } from '../../types';
import type { Aside, BranchTarget, ChatDetail, ChatSelection, ComposerQuote, FreeProviderOffer, HighlightColor, LLMProvider, LocalAttachment, Message, MessageHighlight, VisionGate, VisionSwitchTarget, WordPopup } from '../../types';
import { isOverlayOpen } from '../../overlay';
import { rangeFromOffsets } from '../../chat/highlightAnchors';
import { deriveQuestions, currentQuestionIndex } from '../../chat/questionNav';
import { groupBranchTraces } from '../../chat/branchTrace';
import { orderMessages } from '../../chat/messageOrder';
import { QuestionNavButton, QuestionStepper } from './QuestionNav';

interface Props {
  chat: ChatDetail | null;
  // YouTube-Kennung des Baum-Videos, falls der Baum eins hat. Macht die
  // Zeitmarken der Video overview anklickbar (markdown/timeLinks.ts).
  videoYoutubeId?: string;
  // Steht das Video eingebettet in der Mittelspalte, springt ein Klick auf eine
  // Zeitmarke dort hin statt YouTube zu öffnen
  // (mockup-youtube-embed-layout.html §03).
  onTimeMarkClick?: (seconds: number) => void;
  loading: boolean;
  streaming: boolean;
  // targetChatId bleibt den programmatischen Sends der App vorbehalten; der
  // Composer füllt nur quoteHighlightId — den Anker des Zitats, das er gerade
  // in den Text gestellt hat (mockup-quote-jump-to-source.html).
  onSendMessage: (
    content: string,
    attachments: LocalAttachment[],
    targetChatId?: string,
    quoteHighlightId?: string | null,
  ) => Promise<void>;
  onWordRightClick: (popup: WordPopup) => void;
  onSelectChat: (id: string) => void;
  // "Upload file" im Plus-Menü: bindet ein PDF an den Chat tree (ein PDF pro
  // Tree, ADR-0002). Ohne Handler wird der Menüeintrag nicht angeboten.
  onUploadPdf?: (file: File) => void;
  // "Research paper" im Plus-Menü: öffnet das Paper-Such-Modal (Slice 07).
  // Ohne Handler wird der Menüeintrag nicht angeboten.
  onOpenPaperSearch?: () => void;
  // "YouTube Transcript" im Plus-Menü: öffnet das Video-Such-Modal
  // (ADR-0005). Ohne Handler wird der Menüeintrag nicht angeboten.
  onOpenYouTubeSearch?: () => void;
  // Quellen-Banner für Bäume mit YouTube transcript — sitzt fest unter dem
  // Header, kommt fertig komponiert vom Owner (App).
  videoBanner?: React.ReactNode;
  // Roh-Transkript-Drawer über dem Chat-Inhalt — gleicher Slot-Mechanismus
  // wie highlightsDrawer.
  transcriptDrawer?: React.ReactNode;
  // Chat-Text-Highlights dieses Chats — MessageBubble malt die zur jeweiligen
  // Nachricht gehörenden (mockup-chat-highlights-ask-in-chat.html).
  chatHighlights?: MessageHighlight[];
  // Rechtsklick mit Auswahl in einer Bubble → Popup mit Farbreihe + Ask in chat.
  onChatSelection?: (sel: ChatSelection, context: string, x: number, y: number) => void;
  // Rechtsklick auf ein bestehendes Chat-Highlight → Recolor/Delete-Menü.
  onHighlightContextMenu?: (highlight: MessageHighlight, x: number, y: number) => void;
  // Die beim Rechtsklick erfasste Auswahl, solange das Popup offen ist —
  // MessageBubble malt sie als Pending-Overlay weiter (die native Selektion
  // kollabiert beim Klick ins Popup).
  pendingSelection?: ChatSelection | null;
  // Klick auf den "Branched from"-Link: springt punktgenau zur Quelle des
  // Branches (Highlight im Elternchat bzw. im PDF). Ohne Handler fällt der
  // Link auf onSelectChat(parent_id) zurück.
  onBranchedFromClick?: () => void;
  // Titel des Elternchats — für den Rückweg-Link eines Zweigs OHNE Zitat
  // (`/branch`, mockup-branch-trace.html §07). Fehlt er, trägt der Link
  // stattdessen das generische "Branch aus".
  parentTitle?: string | null;
  // Klick auf das Zitat IN einer gesendeten Frage: springt zur Textstelle,
  // aus der zitiert wurde (mockup-quote-jump-to-source.html, Variante A).
  // Ohne Handler bleibt das Zitat toter Text wie zuvor.
  onQuoteClick?: (message: Message) => void;
  // "Ask in chat"-Zitat, das vorbefüllt über der Textarea hängt. Beim Senden
  // wird es als Markdown-Blockquote über die Frage gestellt.
  composerQuote?: ComposerQuote | null;
  onClearComposerQuote?: () => void;
  // /feedback als reiner Composer-Trigger (ADR-0010): öffnet den
  // Feedback-Dialog statt eine Nachricht zu senden; Resttext nach dem
  // Command wird als Startinhalt übernommen.
  onOpenFeedback?: (initialText: string) => void;
  // /btw als zweiter reiner Composer-Trigger (design/mockup-btw-composer-fold.html):
  // stellt eine Nebenfrage, die NIE im Verlauf landet. ChatArea meldet die
  // Frage nur nach oben; die Antwort kommt als `aside` wieder herein und wird
  // über der Textarea ausgeklappt. Ohne Handler bleibt /btw normaler Text.
  onAskAside?: (question: string) => void;
  // /branch als dritter reiner Composer-Trigger
  // (design/mockup-branch-command.html): das getippte Thema wird zu einem
  // Zweig — ohne Auswahl, also ohne Elternzitat. ChatArea entscheidet nichts
  // über den Zweig selbst, es meldet nur Thema und gewähltes Elternteil nach
  // oben. Ohne Handler bleibt /branch normaler Text.
  onOpenTopicBranch?: (topic: string, parentId: string) => void;
  // Die wählbaren Eltern für /branch — der Baum des aktiven Chats in
  // Anzeigereihenfolge. Ohne Liste bleibt der aktuelle Chat das einzige Ziel.
  branchTargets?: BranchTarget[];
  aside?: Aside | null;
  // Räumt die Nebenfrage weg. Drei Gesten lösen es aus — Tippen, Escape, das
  // × im Panel — und keine davon wird in der UI erwähnt.
  onDismissAside?: () => void;
  // Die beiden Aktionen des Panels (Mockup §03): die Nebenfrage als zwei
  // echte Nachrichten ans Thread-Ende hängen bzw. daraus einen Zweig öffnen.
  onKeepAside?: () => void;
  onBranchAside?: () => void;
  // Highlights-Drawer (mockup-highlights-overview.html, Variante A): der
  // Knopf im permanenten Header togglet; der Drawer selbst kommt als Slot
  // vom Owner (App) und legt sich über den Chat-Inhalt unterhalb des Headers.
  // Ohne Handler wird kein Knopf angeboten.
  onToggleHighlights?: () => void;
  highlightsOpen?: boolean;
  highlightsDrawer?: React.ReactNode;
  // Modell-Pille unten rechts im Composer (design/mockup-model-picker.html,
  // Sektion 02) — kommt fertig komponiert vom Owner (App).
  modelPicker?: React.ReactNode;
  // Stop-Button: während des Streamens wird der Senden-Pfeil zum roten
  // Quadrat; der Handler bricht den Stream ab (bereits Gestreamtes bleibt).
  // Tippt der Nutzer schon die nächste Frage, zeigt der Knopf wieder Senden —
  // weitere Fragen sind erlaubt und landen in der Backend-Warteschlange.
  onStopStreaming?: () => void;
  // IDs der Assistant-Platzhalter aller aktiven Streams (App-Registry). Pro
  // Nachricht statt "letzte Nachricht": bei mehreren Streams im selben Chat
  // ist der streamende Platzhalter nicht zwingend die letzte Nachricht.
  streamingMessageIds?: Set<string>;
  // Retry-Button der '*Failed*'-Fehlerzeile (MessageBubble reicht die
  // Nachricht hoch; App entscheidet zwischen Neu-Senden und Regenerate).
  onRetryMessage?: (message: Message) => void;
  // Grows a cut-off answer in place (mockup-truncated-answer §01).
  onContinueMessage?: (message: Message) => void;
  // Guided empty state (ADR-0008, grill 12b): active cloud provider without
  // an API key. Arrives fully composed from the owner (App, CloudSetupNotice)
  // and renders ABOVE the composer row (first run variant O2) — never a silent
  // block, and never a replacement of the row either.
  setupNotice?: React.ReactNode;
  // First run, variant O2 (mockup-onboarding-flow §03, chosen 2026-08-15):
  // opens the path choice. It is the single exit of every locked affordance in
  // the composer — the notice strip, the model pill's stand-in, and the send
  // attempt itself. Without a handler the composer just stays unlocked.
  onOpenSetup?: () => void;
  // Registry display labels per model name — resolves model names in the
  // failover note (MessageBubble).
  modelLabels?: Record<string, string>;
  // Emergency retry via the local model when all cloud quotas are exhausted
  // (ADR-0008); hasLocalModel gates the button (installed vision models).
  onRetryLocalModel?: (message: Message) => void;
  hasLocalModel?: boolean;
  // Quota card v3 (mockup-quota-states): billing page of the active
  // provider ("Limit erhöhen") and opening the composer's model picker
  // ("Modell wechseln", too_large only).
  billingUrl?: string | null;
  billingUrls?: Record<string, string | null | undefined>;
  // Receives the card's failed message — a pick that changes the model
  // retries it immediately (auto-retry, user decision 2026-07-29).
  onOpenModelPicker?: (message: Message) => void;
  // Last settings change (ISO): model/provider switch or key save — quota
  // and failReason cards older than this re-offer retry (mockup-model-flow
  // §05; generalizes the former modelSwitchedAt).
  settingsChangedAt?: string | null;
  // failReason cards (mockup-model-flow §05/§11): Settings · Models exit,
  // provider labels, the local model's name for the vision tooltip, and the
  // one explicit named cloud exit of the local_missing card.
  onOpenSettings?: () => void;
  providerLabels?: Record<string, string>;
  localModelName?: string;
  cloudFallback?: { providerLabel: string; modelLabel: string } | null;
  onRetryCloudModel?: (message: Message) => void;
  // W4 billing card (cost tiers 2026-07-30): primary exit to the first
  // FREE model — switch + auto-retry.
  freeFallback?: { providerLabel: string; modelLabel: string } | null;
  // G2 (§07): the daily-limit card names the free provider that has no key
  // yet. ChatArea only forwards it — the rule lives in chat/modelOffers.ts.
  freeProviderOffer?: FreeProviderOffer | null;
  onAddFreeProvider?: (provider: LLMProvider) => void;
  onRetryFreeModel?: (message: Message) => void;
  // "Erneut senden" of the unanswered row (mockup-model-flow §10): a
  // trailing user message without an answer and without a live stream —
  // the handler runs the non-anchored regenerate that claims the question.
  onResendUnanswered?: (message: Message) => void;
  // Vision gate (mockup-onboarding-flow §04, V1+V2): the image check sits at
  // ATTACH time, not at send time — the user learns that the active model is
  // text-only while the question is still unwritten, so nothing is lost.
  // App computes the gate from the registry; the composer only renders it.
  visionGate?: VisionGate;
  // Display label of the ACTIVE model — the warning chip names the model that
  // V1 exit: switch to the configured model that reads images (the attachment
  // and the typed text survive the switch).
  onSwitchVisionModel?: (target: VisionSwitchTarget) => void;
  // V2 exit: open Settings · Models at the provider whose row was clicked.
  onOpenSettingsForProvider?: (provider: LLMProvider) => void;
  // Nur für Tests: ersetzt den AudioWorklet-Recorder des Diktats durch einen
  // Fake (durchgereicht an useVoiceInput, gleiches Muster wie dort).
  voiceRecorderFactory?: Parameters<typeof useVoiceInput>[0]['recorderFactory'];
  ref?: React.Ref<ChatAreaHandle>;
}

// Imperative Sprung-API für den Highlights-Drawer: App ruft scrollToMessage,
// wenn eine Chat-Karte geklickt wird (Grill-Entscheidung 8: punktgenau+Flash).
// Mit range blinkt die Markierung selbst auf (Nutzerkorrektur 2026-07-22);
// ohne range fällt der Flash auf die ganze Bubble zurück.
export interface ChatAreaHandle {
  scrollToMessage: (
    messageId: string,
    range?: { startOffset: number; endOffset: number; color: HighlightColor },
  ) => void;
  // Rückweg einer Abzweigung (mockup-branch-trace.html §07): scrollt die
  // Abzweig-Zeile dieses Zweigs in die Mitte und lässt sie aufleuchten.
  scrollToBranchTrace: (branchChatId: string) => void;
  // Keyboard navigation (ADR-0011). Any printable key hands the composer back
  // and carries the character; Enter on a bubble takes it whole.
  focusComposer: (text?: string) => void;
  selectWholeMessage: (messageId: string) => void;
}

// Dauer des Aufglühens nach einem Sprung. MUSS zu den Flash-Animationen in
// index.css passen (3 × 0,45 s) — steht der Wert höher, bleibt die Stelle nach
// dem letzten Puls noch sichtbar markiert; steht er tiefer, wird der letzte
// Puls abgeschnitten. Beide Seiten immer zusammen ändern.
// 2026-08-15 von 2 × 0,75 s auf 3 × 0,45 s: zweimal langsam war schwer zu
// bemerken (Nutzer-Report), dreimal kurz liest das Auge als Blinken.
const FLASH_MS = 1350;

// Ab dieser Haltedauer gilt die Leertaste im Eingabefeld als Push-to-Talk
// statt als getipptes Leerzeichen. Kürzer als der macOS-Standard-Key-Repeat
// wäre riskant (versehentliche Aufnahmen beim normalen Tippen), deutlich
// länger fühlte sich das Diktat träge an.
const SPACE_HOLD_MS = 300;

// Wählt eine Alias-Basis je nach MIME-Typ — z. B. "@foto" für Bilder.
function aliasBaseFor(mimetype: string): string {
  if (mimetype.startsWith('image/')) return '@foto';
  if (mimetype.startsWith('text/') || mimetype === 'application/json') return '@text';
  return '@datei';
}

// How close to the bottom (in px) counts as "at the bottom" — decides whether
// the "scroll to latest" button is needed.
const AT_BOTTOM_THRESHOLD = 8;

// Air above a freshly sent question when it is parked at the top of the column.
const QUESTION_ANCHOR_GAP = 12;

// Rendert den Composer-Inhalt für das Highlight-Overlay: färbt ein führendes
// "/feedback" (als vollständiges Wort) ein, der Rest bleibt normale Farbe.
// Ein Trailing-Newline bekommt ein Zero-Width-Space angehängt — sonst zeigt
// eine <textarea> dafür eine zusätzliche Leerzeile, ein `white-space:
// pre-wrap`-div aber nicht (bekannte Diskrepanz bei Highlight-Overlays).
const TRAILING_NEWLINE_FILLER = String.fromCharCode(0x200b); // zero-width space

// Ein Composer-Befehl im Slash-Menü. `fills` unterscheidet die zwei Arten:
// ein Befehl, der noch Text braucht, setzt sich nur ins Feld (btw, branch);
// ein Befehl, der sofort handeln kann, führt direkt aus (feedback).
interface SlashCommand {
  key: string;
  label: string;
  desc: string;
  icon: React.ReactNode;
  fills: string | null;
}

function renderComposerHighlight(text: string): React.ReactNode {
  // Beide reinen Trigger werden im Composer blau markiert, damit sichtbar
  // ist, dass die Zeile kein Chat-Inhalt mehr ist.
  const match = text.match(/^\/(feedback|btw|branch)(?=\s|$)/i);
  const rest = (match ? text.slice(match[0].length) : text) + (text.endsWith('\n') ? TRAILING_NEWLINE_FILLER : '');
  if (!match) return rest;
  return (
    <>
      <span className="text-blue-600">{match[0]}</span>
      {rest}
    </>
  );
}

export function ChatArea({ chat, videoYoutubeId, onTimeMarkClick, loading, streaming, onSendMessage, onWordRightClick, onSelectChat, onUploadPdf, onOpenPaperSearch, onOpenYouTubeSearch, videoBanner, transcriptDrawer, chatHighlights, onChatSelection, onHighlightContextMenu, pendingSelection, onBranchedFromClick, parentTitle, onQuoteClick, composerQuote, onClearComposerQuote, onOpenFeedback, onAskAside, onOpenTopicBranch, branchTargets, aside, onDismissAside, onKeepAside, onBranchAside, onToggleHighlights, highlightsOpen, highlightsDrawer, modelPicker, onStopStreaming, streamingMessageIds, onRetryMessage, onContinueMessage, setupNotice, onOpenSetup, modelLabels, onRetryLocalModel, hasLocalModel, billingUrl, billingUrls, onOpenModelPicker, settingsChangedAt, onOpenSettings, providerLabels, localModelName, cloudFallback, onRetryCloudModel, freeFallback, onRetryFreeModel, onResendUnanswered, freeProviderOffer, onAddFreeProvider, visionGate, onSwitchVisionModel, onOpenSettingsForProvider, voiceRecorderFactory, ref }: Props) {
  // UI-Texte in der App language — re-rendert beim Sprachwechsel mit.
  const S = useStrings().chatArea;
  // First run (O2): a setup card on screen means no model can answer yet. The
  // card is the owner's signal, so ChatArea needs no second source of truth —
  // it only decides which affordances lock. Exactly one does: sending.
  // Declared here, above handleSend, because that is where it is read first.
  const firstRun = Boolean(setupNotice);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  // @-Autocomplete: enthält den aktuell getippten Filter-String, oder null wenn kein @-Modus.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  // Markiert den aktuell hervorgehobenen Vorschlag im Autocomplete-Dropdown.
  const [mentionIndex, setMentionIndex] = useState(0);
  // Steuert das kleine Plus-Popover-Menü ("Files and media", …) — wie bei Claude.
  const [pickerMenuOpen, setPickerMenuOpen] = useState(false);
  // /feedback-Vorschlag (ADR-0010, design/mockup-feedback.html §2): zeigt das
  // Menü, solange der Composer noch am Command-Wort tippt (kein Leerzeichen
  // dahinter) — reines Autocomplete, das eigentliche Öffnen übernimmt
  // handleSend/onOpenFeedback.
  // Die Composer-Befehle (ADR-0010 für /feedback, mockup-btw-composer-fold
  // für /btw). Das Menü ist der Ort, an dem ein Nutzer sie überhaupt
  // entdeckt, deshalb stehen beide in derselben Liste. `fills` unterscheidet
  // sie: /feedback öffnet seinen Dialog sofort, /btw braucht erst noch die
  // Frage und setzt darum nur den Befehl ins Feld.
  const slashCommands = useMemo(() => {
    if (input.length === 0 || input[0] !== '/' || /\s/.test(input)) return [];
    const typed = input.toLowerCase();
    const all: (SlashCommand | null)[] = [
      onAskAside ? {
        key: 'btw',
        label: '/btw',
        desc: S.btwCommandDesc,
        icon: <MessageCircleQuestionMark size={16} className="text-blue-600 shrink-0" />,
        fills: '/btw ',
      } : null,
      onOpenTopicBranch ? {
        key: 'branch',
        label: '/branch',
        desc: S.branchCommandDesc,
        icon: <GitBranch size={16} className="text-blue-600 shrink-0" />,
        fills: '/branch ',
      } : null,
      onOpenFeedback ? {
        key: 'feedback',
        label: '/feedback',
        desc: S.feedbackCommandDesc,
        icon: <MessageSquarePlus size={16} className="text-blue-600 shrink-0" />,
        fills: null,
      } : null,
    ];
    // Typprädikat statt filter(Boolean): sonst behält TypeScript das `null`
    // im Typ und der Produktions-Build bricht ab, obwohl `tsc --noEmit`
    // durchläuft (gemerkt beim ersten echten Build 2026-08-09).
    return all.filter((c): c is SlashCommand => c !== null && c.label.startsWith(typed));
  }, [input, onAskAside, onOpenFeedback, onOpenTopicBranch, S]);


  // /branch-Modus (design/mockup-branch-command.html §01): der Composer tippt
  // gerade ein Zweig-Thema. Wie bei /btw nur am Zeilenanfang erkannt, damit
  // ein "/branch" mitten im Satz nichts auslöst.
  const branchMode = Boolean(onOpenTopicBranch && chat) && /^\/branch(?=\s|$)/.test(input);

  // Der Chat, unter dem der Zweig entstehen wird. `null` heißt: der aktuelle
  // Chat, also der Standard aus Mockup §02 Variante A. Eine getroffene Wahl
  // gilt nur für diesen einen Befehl — sie stirbt mit dem /branch-Modus,
  // damit sie nicht still den nächsten Zweig regiert.
  const [branchTargetId, setBranchTargetId] = useState<string | null>(null);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const branchPickerRef = useRef<HTMLDivElement>(null);
  const branchTargetButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!branchMode) {
      setBranchTargetId(null);
      setBranchPickerOpen(false);
    }
  }, [branchMode]);

  // Der aktuelle Chat steht oben, der Rest des Baums folgt in seiner
  // Reihenfolge — der Chat, in dem man steht, ist der wahrscheinlichste Ort
  // und der einzige, der doppelt vorkommen könnte.
  const orderedBranchTargets = useMemo<BranchTarget[]>(() => {
    if (!chat) return [];
    const rest = (branchTargets ?? []).filter((t) => t.id !== chat.id);
    const own = (branchTargets ?? []).find((t) => t.id === chat.id);
    return [own ?? { id: chat.id, title: chat.title, depth: 0 }, ...rest];
  }, [branchTargets, chat?.id, chat?.title]);

  const effectiveBranchTargetId = branchTargetId ?? chat?.id ?? null;
  const branchTargetTitle = plainMathText(
    orderedBranchTargets.find((t) => t.id === effectiveBranchTargetId)?.title ?? chat?.title ?? ''
  );

  // Popover schließt sich beim Klick außerhalb — wie das Plus-Menü.
  useEffect(() => {
    if (!branchPickerOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (branchPickerRef.current?.contains(target)) return;
      if (branchTargetButtonRef.current?.contains(target)) return;
      setBranchPickerOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [branchPickerOpen]);
  // Der hervorgehobene Eintrag; springt zurück auf den ersten, sobald sich
  // die Liste ändert, damit nie ein Index ins Leere zeigt.
  const [slashIndex, setSlashIndex] = useState(0);
  useEffect(() => { setSlashIndex(0); }, [slashCommands.length]);

  // /feedback öffnet direkt, /btw setzt nur den Befehl ins Feld — die Frage
  // fehlt ja noch.
  const runSlashCommand = (cmd: { fills: string | null }) => {
    if (cmd.fills) {
      setInput(cmd.fills);
      textareaRef.current?.focus();
      return;
    }
    setInput('');
    onOpenFeedback?.('');
  };

  // True, solange Dateien über dem Eingabebereich schweben — zeigt das Drop-Overlay.
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const dragDepthRef = useRef(0);
  const pickerMenuRef = useRef<HTMLDivElement>(null);
  const plusButtonRef = useRef<HTMLButtonElement>(null);
  // Whether the view sits at the latest message — drives the "scroll to
  // latest" button. Since 2026-08-06 nothing scrolls on its own while an
  // answer streams, so this is a pure display concern.
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Highlight-Overlay für /feedback (Nutzerkorrektur 2026-08-01): die echte
  // textarea bekommt transparenten Text + sichtbaren Caret, dieser Layer
  // zeigt den kompletten Inhalt inkl. eingefärbtem Command darüber — muss
  // Höhe und Scroll-Position exakt spiegeln, sonst verrutscht die Deckung.
  const highlightRef = useRef<HTMLDivElement>(null);
  // Enter fiel mit laufender Transkription zusammen → Senden vormerken,
  // sobald das Transkript im Eingabefeld gelandet ist (Effekt unten).
  const pendingSendRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const chatColumnClass = 'shrink-0 px-6 sm:px-8';
  // What the branch header and the quote chip SHOW: the passage with its math
  // restored when the model managed it, otherwise the verbatim extraction
  // (decision 2026-08-02). Never used as a search anchor — branch-word links
  // and highlight matching keep using chat.parent_word.
  const branchQuoteText = chat?.parent_word_display || chat?.parent_word || '';
  // maxWidth 100% (statt calc(100% - 3rem)): in der schmalen Drei-Spalten-
  // Chat-Spalte sind die px-Innenabstände Gutter genug — die zusätzlichen
  // 3rem Außenrand quetschten den Composer, bis der Senden-Knopf aus dem
  // Eingabefeld ragte (Nutzerkorrektur 2026-07-22).
  const chatColumnStyle = { width: '46rem', maxWidth: '100%' };

  // "Branched from" quote in the header row (mockup-branch-header.html §01):
  // always truncated to ONE line; a hover/focus tooltip shows the full quote
  // (§03 — replaces the earlier chevron+dropdown, user report 2026-07-31:
  // the click-to-expand dropdown felt like an extra component to manage,
  // and its border-bottom link styling read as stray underscores around
  // quote marks/math). The tooltip only mounts when the quote is actually
  // cut — measured via ResizeObserver so it stays correct when the chat
  // column is drag-resized.
  const [branchQuoteOverflows, setBranchQuoteOverflows] = useState(false);
  const branchQuoteRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = branchQuoteRef.current;
    if (!el) return;
    const measure = () => setBranchQuoteOverflows(el.scrollWidth - el.clientWidth > 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [chat?.id, chat?.parent_word]);

  // onTranscript wird erst beim Stoppen aufgerufen, mit dem gesammelten Text —
  // wir hängen ihn ans Eingabefeld an (oder schreiben ihn rein, wenn leer).
  const { isListening, isTranscribing, volume, supported, startListening, stopListening } = useVoiceInput({
    onTranscript: (text) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setInput(prev => (prev ? prev + ' ' + trimmed : trimmed));
    },
    recorderFactory: voiceRecorderFactory,
  });

  const handleToggleListening = () => {
    if (isTranscribing) return; // Whisper arbeitet noch am letzten Diktat
    if (isListening) stopListening();
    else startListening();
  };

  const setPinned = (pinned: boolean) => {
    setIsPinnedToBottom(pinned);
  };

  // Pin/unpin logic uses two signals:
  //   (1) `scroll` event — for re-pinning when the user scrolls back to the
  //       bottom on their own. Not reliable for *detecting* user input during
  //       streaming because it also fires for our own programmatic scrollIntoView
  //       and races against rapid delta updates.
  //   (2) `wheel` + `touchmove` events — fired the instant the user expresses
  //       intent to scroll. We use these to unpin immediately, before any
  //       potential auto-scroll can yank them back down.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      // Only re-pin here (when user reaches the bottom). Unpinning is owned by
      // the wheel/touch handlers below, so this never fights the user's input.
      if (distanceFromBottom < AT_BOTTOM_THRESHOLD) {
        setPinned(true);
      }
    };

    // Wheel (mouse + trackpad): negative deltaY means scrolling up.
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) setPinned(false);
    };

    // Touch: track the previous Y so we can tell direction. Moving the finger
    // down on screen scrolls the content up, which is what we want to catch.
    let lastTouchY = 0;
    const onTouchStart = (e: TouchEvent) => {
      lastTouchY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const curY = e.touches[0]?.clientY ?? 0;
      if (curY > lastTouchY) setPinned(false);
      lastTouchY = curY;
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
    };
    // Depend on chat?.id so the listeners get attached as soon as a chat
    // actually mounts the scroll container. Without this dep, the effect
    // runs once on the empty-state render (when scrollContainerRef.current
    // is null because of the early `if (!chat) return ...` above) and never
    // again — leaving wheel/touch unpinning permanently broken.
  }, [chat?.id]);

  // Where the view goes when messages change (user request 2026-08-06):
  //   - opening a chat  → the latest message, as before;
  //   - a new question  → that question moves to the top of the column and
  //                       STAYS there while the answer streams in;
  //   - answer deltas   → nothing at all.
  // Following the growing answer used to drag the reader down the column, so
  // the question they had just asked scrolled out of sight. Moving down is now
  // the user's own decision — the ↓ button jumps to the latest.
  const scrollAnchorRef = useRef<{ chatId: string | null; questionId: string | null }>({
    chatId: null,
    questionId: null,
  });
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!chat || !el) return;
    const lastQuestion = [...chat.messages].reverse().find((m) => m.role === 'user');
    const questionId = lastQuestion?.id ?? null;
    const anchor = scrollAnchorRef.current;

    if (anchor.chatId !== chat.id) {
      scrollAnchorRef.current = { chatId: chat.id, questionId };
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
      return;
    }
    if (!questionId || questionId === anchor.questionId) return;
    scrollAnchorRef.current = { chatId: chat.id, questionId };

    // Put the question just below the top edge. Not scrollIntoView: that would
    // also scroll ancestor panes (the PDF column) on a short chat.
    const row = el.querySelector(`[data-testid="message-row-${questionId}"]`);
    if (row) {
      const delta = row.getBoundingClientRect().top - el.getBoundingClientRect().top;
      el.scrollTop += delta - QUESTION_ANCHOR_GAP;
    }
    // The view is now parked at the question, not at the bottom — so the ↓
    // button has to appear.
    setPinned(false);
  }, [chat?.id, chat?.messages]);

  // Reset to pinned when the user opens a different chat.
  useEffect(() => {
    setPinned(true);
  }, [chat?.id]);

  // Antworten laufen pro Chat im Hintergrund weiter (App verwaltet die
  // Streams). `sending` gehört zum Chat, in dem gesendet wurde — beim
  // Wechsel zurücksetzen, damit der Composer anderer Chats nicht blockiert;
  // im streamenden Chat übernimmt das `streaming`-Prop.
  useEffect(() => {
    setSending(false);
    pendingSendRef.current = false;
  }, [chat?.id]);

  const scrollToBottom = () => {
    setPinned(true);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Expand the textarea vertically as the user types, capped at 144px.
  const autosizeTextarea = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const h = `${Math.min(Math.max(ta.scrollHeight, 44), 144)}px`;
    ta.style.height = h;
    // Highlight-Overlay bekommt exakt dieselbe Höhe — beide Layer scrollen
    // sonst unabhängig voneinander aus dem Deckungsgleichen.
    if (highlightRef.current) highlightRef.current.style.height = h;
  };
  useEffect(autosizeTextarea, [input]);
  // Scroll-Sync: sobald die textarea intern scrollt (Inhalt > 144px-Deckel),
  // muss der Highlight-Layer im selben Moment mitscrollen.
  const syncHighlightScroll = () => {
    if (textareaRef.current && highlightRef.current) {
      highlightRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  // Auch bei Breitenänderungen neu messen (Sidebar ein-/ausklappen, Spalten-
  // Drag): der Text bricht dann anders um und die alte Höhe stimmt nicht
  // mehr — das Eingabefeld blieb sonst zu hoch/zu niedrig stehen. Nur auf
  // Breitenwechsel reagieren, damit unsere eigene Höhenänderung den
  // Observer nicht in eine Schleife schickt.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta || typeof ResizeObserver === 'undefined') return;
    let lastWidth = ta.offsetWidth;
    const ro = new ResizeObserver(() => {
      const width = ta.offsetWidth;
      if (width !== lastWidth) {
        lastWidth = width;
        autosizeTextarea();
      }
    });
    ro.observe(ta);
    return () => ro.disconnect();
  }, [chat?.id]);

  // "Ask in chat": Zitat frisch injiziert → Cursor direkt ins Eingabefeld,
  // damit die Frage ohne Extra-Klick losgetippt werden kann.
  useEffect(() => {
    if (composerQuote) textareaRef.current?.focus();
  }, [composerQuote]);

  const handleSend = async () => {
    // First run (O2): every send attempt — Enter in the field, the global
    // Enter handler, a queued transcript — turns into the path choice instead.
    // The input is deliberately NOT cleared: the question the user just typed
    // is the reason they are setting a model up at all, and it has to be there
    // when they come back.
    if (firstRun) {
      onOpenSetup?.();
      return;
    }
    // Während der Aufnahme nicht senden — User muss erst stoppen, damit das
    // Transkript fertig ans Eingabefeld angehängt wird.
    if (isListening) return;
    // Whisper arbeitet noch: Enter direkt nach dem Loslassen der Leertaste
    // soll nicht ins Leere laufen — Senden vormerken, der Effekt unten
    // schickt die Nachricht ab, sobald das Transkript im Eingabefeld steht.
    if (isTranscribing) {
      pendingSendRef.current = true;
      return;
    }
    const text = input.trim();
    // /feedback ist ein reiner Trigger, kein Chat-Inhalt (ADR-0010): öffnet
    // den Dialog, übernimmt den Resttext, sendet nichts an den Chat.
    const feedbackMatch = text.match(/^\/feedback(?:\s+([\s\S]*))?$/);
    if (feedbackMatch && onOpenFeedback) {
      setInput('');
      setMentionQuery(null);
      onOpenFeedback(feedbackMatch[1]?.trim() ?? '');
      return;
    }
    // /btw ist der zweite reine Trigger (design/mockup-btw-composer-fold.html):
    // die Frage geht an die Nebenfragen-Route und NIE in den Verlauf. Ohne
    // Fragetext passiert nichts — ein nacktes "/btw" ist ein halb getippter
    // Befehl, keine Frage.
    const asideMatch = text.match(/^\/btw(?:\s+([\s\S]*))?$/);
    if (asideMatch && onAskAside) {
      const question = asideMatch[1]?.trim() ?? '';
      if (!question) return;
      setInput('');
      setMentionQuery(null);
      onAskAside(question);
      return;
    }
    // /branch ist der dritte reine Trigger (design/mockup-branch-command.html):
    // das Thema wird zum Zweig, nicht zur Nachricht. Ein nacktes "/branch"
    // ohne Thema tut nichts — ein halb getippter Befehl, kein leerer Zweig.
    const branchMatch = text.match(/^\/branch(?:\s+([\s\S]*))?$/);
    if (branchMatch && onOpenTopicBranch && chat) {
      const topic = branchMatch[1]?.trim() ?? '';
      if (!topic) return;
      setInput('');
      setMentionQuery(null);
      onOpenTopicBranch(topic, branchTargetId ?? chat.id);
      return;
    }
    if ((!text && attachments.length === 0) || sending || !chat) return;
    // Zitat als Markdown-Blockquote über die Frage stellen — so landet es im
    // LLM-Kontext und MessageBubble rendert es als Zitatblock in der Bubble.
    const usesQuote = Boolean(composerQuote && text);
    const content = composerQuote && text
      ? composerQuote.text.split('\n').map((l) => `> ${l}`).join('\n') + '\n\n' + text
      : text;
    // Der Anker reist nur mit, wenn das Zitat auch wirklich im Text steht —
    // sonst bekäme eine Frage ohne Zitatblock einen Sprung-Anker, der nirgends
    // gerendert wird.
    const quoteHighlightId = usesQuote ? composerQuote?.highlightId ?? null : null;
    const sentAttachments = attachments;
    setInput('');
    setAttachments([]);
    setMentionQuery(null);
    if (composerQuote) onClearComposerQuote?.();
    setSending(true);
    try {
      // Resolves beim Stream-START (nicht -Ende): der Composer ist sofort
      // wieder frei, weitere Fragen reihen sich in die Backend-Warteschlange.
      // Die Objekt-URLs der Vorschau-Bilder gibt App am Stream-Ende frei.
      await onSendMessage(content, sentAttachments, undefined, quoteHighlightId);
    } finally {
      setSending(false);
    }
  };

  // Vorgemerktes Senden (Enter während Whisper noch transkribierte) —
  // feuert, sobald isTranscribing auf false kippt; `input` enthält dann
  // bereits das angehängte Transkript, weil onTranscript und
  // setIsTranscribing(false) im selben React-Batch landen.
  useEffect(() => {
    if (!isTranscribing && pendingSendRef.current) {
      pendingSendRef.current = false;
      void handleSend();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTranscribing]);

  // Leertaste-Halten IM Eingabefeld: kurzer Tipp = normales Leerzeichen,
  // Halten über SPACE_HOLD_MS = Diktat (das eine schon getippte Leerzeichen
  // wird wieder entfernt). Key-Repeats werden geschluckt, damit Halten keine
  // Leerzeichen-Salve tippt.
  const spaceHoldTimerRef = useRef<number | null>(null);
  const clearSpaceHold = () => {
    if (spaceHoldTimerRef.current !== null) {
      window.clearTimeout(spaceHoldTimerRef.current);
      spaceHoldTimerRef.current = null;
    }
  };
  useEffect(() => clearSpaceHold, [chat?.id]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Escape für die Nebenfrage hängt am Fenster, nicht hier — siehe den
    // useEffect weiter unten. Nur die Mention-Navigation muss davon wissen:
    // ein offenes Panel gewinnt gegen ein offenes Dropdown.
    // Tastatur im Befehlsmenü: hoch/runter blättert, Tab und Enter wählen.
    // Enter darf hier NICHT durchfallen — sonst schickt handleSend den halb
    // getippten Befehl als Frage los.
    if (slashCommands.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        setSlashIndex((i) => (i + dir + slashCommands.length) % slashCommands.length);
        return;
      }
      const chosen = slashCommands[slashIndex] ?? slashCommands[0];
      // Tab vervollständigt nur — so lässt sich noch Text anhängen, bevor der
      // Befehl läuft (bisheriges /feedback-Verhalten, jetzt für beide).
      if (e.key === 'Tab') {
        e.preventDefault();
        setInput(chosen.fills ?? `${chosen.label} `);
        return;
      }
      // Enter führt aus. Es darf NICHT durchfallen, sonst schickt handleSend
      // den halb getippten Befehl als Frage los.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        runSlashCommand(chosen);
        return;
      }
    }
    // Wenn das Mention-Dropdown gerade Vorschläge zeigt, übernimmt die Tastatur
    // die Navigation: Pfeiltasten blättern, Enter wählt, Escape schließt.
    const mentionsOpen = mentionQuery !== null && filteredMentions.length > 0;
    if (mentionsOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex(i => (i + 1) % filteredMentions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex(i => (i - 1 + filteredMentions.length) % filteredMentions.length);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const chosen = filteredMentions[mentionIndex] ?? filteredMentions[0];
        if (chosen) insertMention(chosen.alias);
        return;
      }
      if (e.key === 'Escape') {
        // Steht ein Panel offen, ist es die auffälligere Sache auf dem
        // Schirm: der globale Handler räumt es weg, das Dropdown bleibt.
        if (aside) return;
        e.preventDefault();
        setMentionQuery(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }
    // Leertaste im Eingabefeld: erst ganz normal tippen lassen (kein
    // preventDefault), aber einen Halte-Timer scharfstellen — läuft er ab,
    // war es Push-to-Talk und das eine getippte Leerzeichen fliegt raus.
    if (e.key === ' ' && supported && !isListening && !isTranscribing) {
      if (e.repeat) {
        // Key-Repeat = die Taste wird gehalten; keine weiteren Leerzeichen.
        e.preventDefault();
        return;
      }
      // keydown feuert VOR dem Einfügen — selectionStart ist die Stelle,
      // an der das Leerzeichen gleich landet.
      const pos = (e.target as HTMLTextAreaElement).selectionStart ?? input.length;
      clearSpaceHold();
      spaceHoldTimerRef.current = window.setTimeout(() => {
        spaceHoldTimerRef.current = null;
        setInput(prev =>
          prev[pos] === ' ' ? prev.slice(0, pos) + prev.slice(pos + 1) : prev
        );
        startListening();
      }, SPACE_HOLD_MS);
    }
  };

  const handleKeyUp = (e: React.KeyboardEvent) => {
    // Leertaste vor Ablauf des Halte-Timers losgelassen → normales
    // Leerzeichen, Diktat abblasen. Das Stoppen einer laufenden Aufnahme
    // übernimmt der globale keyup-Handler in useVoiceInput.
    if (e.key === ' ') clearSpaceHold();
  };

  // Enter sendet auch OHNE fokussiertes Eingabefeld (z. B. direkt nach dem
  // Leertaste-Diktat, wenn der Fokus irgendwo im Chat liegt). Interaktive
  // Elemente behalten ihr natives Enter-Verhalten (Button klicken, Link
  // öffnen) — sonst würde ein fokussierter Knopf gleichzeitig senden.
  const globalEnterSendRef = useRef(() => {});
  globalEnterSendRef.current = () => {
    if (mentionQuery !== null) return;
    void handleSend();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const a = document.activeElement;
      if (a instanceof HTMLElement) {
        const tag = a.tagName;
        if (
          tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
          tag === 'BUTTON' || tag === 'A' || a.isContentEditable ||
          a.getAttribute('role') === 'button' || a.getAttribute('role') === 'link'
        ) return;
      }
      e.preventDefault();
      globalEnterSendRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Escape räumt die Nebenfrage weg — dieselbe Hausregel, mit der Escape
  // schon den Highlights-Drawer und das Fragen-Popover schließt, und wie dort
  // nirgends in der UI erwähnt. Der Listener hängt am FENSTER, nicht an der
  // Textarea: die Nebenfrage überlebt einen Abstecher in die Einstellungen,
  // und danach hat das Eingabefeld keinen Fokus mehr — ein Handler an der
  // Textarea hätte den Tastendruck nie gesehen.
  // Ein Dialog über der App beansprucht Escape für sich (`isOverlayOpen`) —
  // sonst kostet das Schließen der Einstellungen nebenbei die Antwort, die
  // gerade gelesen wurde. Escape schält eine Schicht pro Druck ab.
  useEffect(() => {
    if (!aside) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || isOverlayOpen()) return;
      onDismissAside?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [aside, onDismissAside]);

  // Plus-Button → kleines Popover-Menü öffnen (statt direkt File-Picker).
  const handleTogglePickerMenu = () => {
    setPickerMenuOpen(prev => !prev);
  };

  // Klick auf "Files and media" im Popover → System-File-Picker öffnen.
  const handlePickFiles = () => {
    setPickerMenuOpen(false);
    fileInputRef.current?.click();
  };

  // Klick auf "Upload file" im Popover → PDF-Picker öffnen; die gewählte
  // Datei geht an onUploadPdf (Paper-Upload), nicht in die Message-Anhänge.
  const handlePickPdf = () => {
    setPickerMenuOpen(false);
    pdfInputRef.current?.click();
  };

  const handlePdfSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && onUploadPdf) onUploadPdf(file);
    if (pdfInputRef.current) pdfInputRef.current.value = '';
  };

  // Popover schließt sich, sobald irgendwo außerhalb geklickt wird.
  useEffect(() => {
    if (!pickerMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (pickerMenuRef.current?.contains(target)) return;
      if (plusButtonRef.current?.contains(target)) return;
      setPickerMenuOpen(false);
    };
    // Escape closes it too — the house rule every other popup here follows,
    // and without it the keyboard could walk into the menu but never out
    // (user report 2026-08-11).
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPickerMenuOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerMenuOpen]);

  // Dateien (aus Picker oder Drop) in lokale Anhänge umwandeln, automatisch @-Aliase vergeben.
  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
    setAttachments(prev => {
      const next = [...prev];
      for (const file of files) {
        // Nächste freie Nummer pro Alias-Basis ermitteln
        const base = aliasBaseFor(file.type);
        const existing = next
          .map(a => a.alias)
          .filter(a => a.startsWith(base))
          .map(a => parseInt(a.slice(base.length), 10))
          .filter(n => !isNaN(n));
        const nextN = existing.length > 0 ? Math.max(...existing) + 1 : 1;
        const alias = `${base}${nextN}`;
        const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
        next.push({ alias, file, previewUrl });
      }
      return next;
    });
  };

  const handleFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(e.target.files || []));
    // Input zurücksetzen, damit dieselbe Datei nochmal gewählt werden kann
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Beim Drop gilt dieselbe Typ-Liste wie beim Datei-Picker (accept-Attribut) —
  // der Browser filtert gedroppte Dateien nicht selbst.
  const isAcceptedDropFile = (file: File): boolean => {
    if (file.type.startsWith('image/') || file.type.startsWith('text/')) return true;
    if (file.type === 'application/pdf' || file.type === 'application/json') return true;
    const name = file.name.toLowerCase();
    return ['.pdf', '.md', '.txt', '.csv', '.json'].some(ext => name.endsWith(ext));
  };

  // dragenter/dragleave feuern für jedes Kind-Element erneut — ein Tiefenzähler
  // verhindert, dass das Overlay dabei flackert oder zu früh verschwindet.
  const handleDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    if (!isBusy) setIsDraggingFiles(true);
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = isBusy ? 'none' : 'copy';
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDraggingFiles(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingFiles(false);
    if (isBusy) return;
    addFiles(Array.from(e.dataTransfer.files).filter(isAcceptedDropFile));
  };

  const handleRemoveAttachment = (idx: number) => {
    setAttachments(prev => {
      const att = prev[idx];
      if (att?.previewUrl) URL.revokeObjectURL(att.previewUrl);
      return prev.filter((_, i) => i !== idx);
    });
  };

  // Vision gate (mockup-onboarding-flow §04, V1+V2). The check runs over the
  // ATTACHED files instead of at send time: the user sees the warning while the
  // question is still unwritten, so no typed question is ever lost to it. Only
  // images can trip the gate — PDFs and text files reach the model as text.
  const hasImageAttachment = attachments.some(a => a.file.type.startsWith('image/'));
  const visionBlocked = Boolean(visionGate && !visionGate.activeReadsImages && hasImageAttachment);
  const visionSwitchTarget = visionBlocked ? visionGate?.switchTarget ?? null : null;
  // V2 applies exactly when nothing configured reads images, i.e. no switch
  // target exists — then the card offers the models that could be set up.
  const visionSetupOptions = visionBlocked && !visionSwitchTarget ? visionGate?.setupOptions ?? [] : [];

  // Both exits of the gate drop the images and keep everything else: the typed
  // question survives, only the part the model cannot read goes away.
  const removeImageAttachments = () => {
    setAttachments(prev => {
      for (const att of prev) {
        if (att.file.type.startsWith('image/') && att.previewUrl) URL.revokeObjectURL(att.previewUrl);
      }
      return prev.filter(a => !a.file.type.startsWith('image/'));
    });
  };

  // Bringt einen rohen User-Eingabe-String in eine gültige Alias-Form:
  // - sicheres "@" am Anfang
  // - Whitespace → Underscore (damit der Alias als ein Token im Text steht)
  // - keine zusätzlichen "@" innerhalb des Namens
  const normalizeAlias = (raw: string): string => {
    const trimmed = raw.trim();
    const withoutAt = trimmed.replace(/^@+/, '');
    const collapsed = withoutAt.replace(/\s+/g, '_').replace(/@/g, '');
    return '@' + collapsed;
  };

  const handleRenameAttachment = (idx: number, rawNew: string) => {
    setAttachments(prev => {
      const oldAlias = prev[idx]?.alias;
      if (!oldAlias) return prev;
      const normalized = normalizeAlias(rawNew);
      if (normalized === '@' || normalized === oldAlias) return prev;
      const others = prev.filter((_, i) => i !== idx).map(a => a.alias);
      let finalAlias = normalized;
      if (others.includes(finalAlias)) {
        let n = 2;
        while (others.includes(`${normalized}_${n}`)) n++;
        finalAlias = `${normalized}_${n}`;
      }
      // Eingabefeld synchron halten: alle Vorkommen des alten Alias durch den neuen
      // ersetzen — aber nur als ganzes Token (kein Treffer in "@foto10" für "@foto").
      setInput(input => {
        const escaped = oldAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(escaped + '(?=\\W|$)', 'g');
        return input.replace(re, finalAlias);
      });
      return prev.map((a, i) => (i === idx ? { ...a, alias: finalAlias } : a));
    });
  };

  // @-Autocomplete: prüft, ob der Cursor gerade hinter einem unvollständigen @-Token steht.
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    // Die Nebenfrage verschwindet beim ERSTEN Zeichen, das den Text wirklich
    // ändert — nicht schon beim Fokus (mockup-btw-composer-fold.html §00):
    // wer ins Feld klickt, um beim Lesen die Hände zu sortieren, verliert die
    // Antwort nicht. Kein Hinweistext begleitet das; die Geste muss sich
    // erklären, nicht die UI.
    if (aside && value !== input) onDismissAside?.();
    setInput(value);
    const cursor = e.target.selectionStart ?? value.length;
    const before = value.slice(0, cursor);
    const match = before.match(/@(\w*)$/);
    setMentionQuery(match ? match[1] : null);
  };

  const filteredMentions = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    return attachments.filter(a => a.alias.slice(1).toLowerCase().startsWith(q));
  }, [attachments, mentionQuery]);

  // Bei jeder Änderung der Vorschlagsliste den Highlight-Index zurücksetzen,
  // damit immer der erste Vorschlag aktiv ist und nie ein Out-of-Bounds-Index entsteht.
  useEffect(() => {
    setMentionIndex(0);
  }, [mentionQuery, filteredMentions.length]);

  const insertMention = (alias: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const cursor = ta.selectionStart ?? input.length;
    const before = input.slice(0, cursor);
    const after = input.slice(cursor);
    const replaced = before.replace(/@\w*$/, alias + ' ');
    const newValue = replaced + after;
    setInput(newValue);
    setMentionQuery(null);
    // Cursor hinter den eingefügten Alias setzen
    requestAnimationFrame(() => {
      const pos = replaced.length;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  };

  // Seit der Backend-Warteschlange blockiert ein laufender Stream den
  // Composer NICHT mehr: weitere Fragen sind erwünscht und reihen sich ein
  // (FIFO). Nur der kurze Sende-Moment selbst und das Chat-Laden sperren.
  const isBusy = sending || loading;

  // Sprung aus dem Highlights-Drawer: Nachricht mittig in den Viewport
  // scrollen und die Zeile kurz aufblinken lassen (Grill-Entscheidung 8).
  // Der Flash startet erst, wenn das Smooth-Scrolling zur Ruhe gekommen ist —
  // sonst pulsiert die Zeile, während sie noch außerhalb des Sichtfelds ist,
  // und der Nutzer verpasst das Aufleuchten.
  const [flashMessageId, setFlashMessageId] = useState<string | null>(null);
  // Punktgenauer Flash auf der Markierung selbst (Nutzerkorrektur 2026-07-22):
  // weiches Ein-/Ausblenden statt Blinken (2. Korrektur am selben Tag).
  // ::highlight()-Pseudoelemente sind nicht direkt animierbar — der Fade
  // läuft über die registrierte Custom Property --syflo-flash-alpha
  // (index.css): die Zeile bekommt data-flash-range, deren Keyframes
  // animieren die Property, und die ::highlight-Regeln mischen ihre Farbe
  // per color-mix damit.
  const [flashRange, setFlashRange] = useState<{
    messageId: string;
    startOffset: number;
    endOffset: number;
    color: HighlightColor;
  } | null>(null);
  const flashTimersRef = useRef<number[]>([]);
  const scrollSettleRafRef = useRef<number | null>(null);
  useEffect(() => () => {
    flashTimersRef.current.forEach(t => window.clearTimeout(t));
    if (scrollSettleRafRef.current !== null) cancelAnimationFrame(scrollSettleRafRef.current);
  }, []);

  const startFlash = (
    messageId: string,
    range?: { startOffset: number; endOffset: number; color: HighlightColor },
  ) => {
    flashTimersRef.current.forEach(t => window.clearTimeout(t));
    flashTimersRef.current = [];
    const schedule = (fn: () => void, ms: number) =>
      flashTimersRef.current.push(window.setTimeout(fn, ms));

    if (range) {
      // Nur die MARKIERUNG blinkt, nicht die ganze Blase (Nutzerentscheid
      // 2026-07-22, festgehalten in App.highlights.test.tsx).
      //
      // Warum das Aufglühen im Chat lange schwächer wirkte als im PDF
      // (Nutzer-Report 2026-08-15), und warum der Blasen-Glow NICHT die
      // Antwort war: im PDF liegt um die Markierung ein echter Halo — die
      // Rechtecke sind Elemente, `drop-shadow` läuft um ihre Silhouette. Im
      // Chat ist die Markierung gar kein Element: sie wird über
      // `::highlight()` auf einen Range gemalt, und dieses Pseudo-Element
      // erlaubt weder `box-shadow` noch `outline`. Der Ersatz aus den Mitteln
      // des Pseudos — dichter `text-shadow` plus pulsender Unterstrich —
      // reichte nicht: unter der fast weiß aufgehellten Fläche blieb sichtbar
      // nur der Strich („im Chat glüht einfach nur der Unterstrich auf",
      // 2026-08-16). Seitdem misst `paintFlashChatRange` die Rechtecke des
      // Ranges aus und legt DENSELBEN Halo darüber wie das PDF (flashGlow.ts).
      // Hier ändert sich dadurch nichts: der Flash bleibt an der Markierung,
      // nicht an der Blase.
      setFlashMessageId(null);
      setFlashRange({ messageId, ...range });
      // Der Fade selbst läuft in CSS (syflo-hl-range-flash) — hier nur noch
      // nach Ablauf aufräumen.
      schedule(() => setFlashRange(null), FLASH_MS);
      return;
    }
    setFlashRange(null);
    setFlashMessageId(messageId);
    schedule(() => setFlashMessageId(null), FLASH_MS);
  };

  // Sprung + Flash — genutzt vom Highlights-Drawer (per Ref von außen) und
  // von der Fragen-Navigation (Popover/Stepper/Shortcuts) hier drin. Die
  // Fragen-Navigation springt OHNE Flash (Nutzerkorrektur 2026-07-22):
  // beim bewussten Navigieren zwischen Fragen ist das Aufblinken nur Unruhe;
  // der Flash bleibt den Highlight-Sprüngen aus dem Drawer vorbehalten.
  const jumpToMessage = (
    messageId: string,
    range?: { startOffset: number; endOffset: number; color: HighlightColor },
    opts?: { flash?: boolean },
  ) => {
      const container = scrollContainerRef.current;
      const row = container?.querySelector(`[data-testid="message-row-${messageId}"]`);
      if (!container || !row) return;
      // Punktgenau: bei langen Nachrichten zur MARKIERUNG scrollen, nicht zur
      // Zeilenmitte — sonst liegt die Markierung außerhalb des Sichtfelds
      // (Nutzer-Report 2026-07-22). Ziel ist das Element um den Range-Anfang;
      // ohne Auflösung (z. B. Inhalt noch nicht gerendert) fällt der Sprung
      // auf die Zeile zurück.
      let target: Element = row;
      if (range) {
        const root = row.querySelector('[data-chat-content]');
        const resolved = root
          ? rangeFromOffsets(root, range.startOffset, range.endOffset)
          : null;
        target = resolved?.startContainer.parentElement ?? row;
      }
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (opts?.flash === false) return;
      // Auf Scroll-Ruhe warten: 3 Frames ohne Positionsänderung (deckt auch
      // den Fall "war schon im Sichtfeld" ab), harter Deckel bei 2 s.
      if (scrollSettleRafRef.current !== null) cancelAnimationFrame(scrollSettleRafRef.current);
      const startedAt = performance.now();
      let lastTop = container.scrollTop;
      let stableFrames = 0;
      const tick = () => {
        const top = container.scrollTop;
        if (top === lastTop) {
          stableFrames++;
        } else {
          stableFrames = 0;
          lastTop = top;
        }
        if (stableFrames >= 3 || performance.now() - startedAt > 2000) {
          scrollSettleRafRef.current = null;
          startFlash(messageId, range);
          return;
        }
        scrollSettleRafRef.current = requestAnimationFrame(tick);
      };
      scrollSettleRafRef.current = requestAnimationFrame(tick);
  };

  // ─── Branch trace (mockup-branch-trace.html, Variante A) ───
  // Welche Abzweig-Zeile unter welcher Nachricht hängt. Der Anker wird gegen
  // die WIRKLICH gerenderten Nachrichten geprüft: zeigt er ins Leere, wandert
  // die Zeile nach oben, statt lautlos zu verschwinden.
  const branchTraces = useMemo(
    () => groupBranchTraces(chat?.children, (chat?.messages ?? []).map((m) => m.id)),
    [chat?.children, chat?.messages],
  );

  // Rücksprung aus der Kopfzeile eines Zweigs: die zugehörige Zeile im
  // Elternchat leuchtet kurz auf — derselbe Glow wie beim Sprung aus dem
  // Highlights-Drawer, damit „hier bist du abgebogen" ohne Erklärung ankommt.
  const [flashTraceChatId, setFlashTraceChatId] = useState<string | null>(null);
  const jumpToTrace = (branchChatId: string) => {
    const container = scrollContainerRef.current;
    const row = container?.querySelector(`[data-testid="branch-trace-${branchChatId}"]`);
    // Eingeklappte Stapel haben die Zeile noch nicht im DOM — das Setzen des
    // Flash-Ziels klappt sie auf (BranchTrace), der Sprung folgt im nächsten
    // Frame. Ohne Container/Chat bleibt es beim reinen Aufleuchten.
    setFlashTraceChatId(branchChatId);
    flashTimersRef.current.push(window.setTimeout(() => setFlashTraceChatId(null), FLASH_MS));
    if (!container) return;
    const scroll = () => {
      const el = container.querySelector(`[data-testid="branch-trace-${branchChatId}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    if (row) scroll();
    else requestAnimationFrame(scroll);
  };

  useImperativeHandle(ref, () => ({
    focusComposer: (text?: string) => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      if (text) setInput(prev => prev + text);
    },
    // Enter on a bubble selects the bubble whole and opens the same popup a
    // drag-selection does — the keyboard cannot select part of a bubble, and
    // says so rather than pretending (ADR-0011).
    selectWholeMessage: (messageId: string) => {
      if (!onChatSelection) return;
      const row = document.querySelector(`[data-focus-item="${CSS.escape(messageId)}"]`);
      const content = row?.querySelector<HTMLElement>('[data-chat-content]');
      const message = chat?.messages.find(m => m.id === messageId);
      if (!content || !message) return;
      const range = document.createRange();
      range.selectNodeContents(content);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      const text = content.textContent ?? '';
      const rect = content.getBoundingClientRect();
      onChatSelection(
        {
          messageId,
          chatId: message.chat_id,
          text: text.trim(),
          startOffset: 0,
          endOffset: text.length,
        },
        message.content,
        rect.left + rect.width / 2,
        rect.top,
      );
    },
    scrollToMessage: jumpToMessage,
    scrollToBranchTrace: jumpToTrace,
  }));

  // ─── Fragen-Navigation (Grill 2026-07-22, mockup-question-nav.html 1+3) ───
  // Jede User-Nachricht ist eine Frage; Scroll-Spy leitet die "aktuelle" live
  // aus der Scroll-Position ab — eine Quelle für Stepper-Zähler und aktiven
  // Popover-Eintrag.
  const questions = useMemo(
    () => (chat ? deriveQuestions(chat.messages) : []),
    [chat?.messages],
  );
  const [activeQuestion, setActiveQuestion] = useState(-1);
  const [listOverflows, setListOverflows] = useState(false);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const measure = () => {
      setListOverflows(el.scrollHeight > el.clientHeight);
      if (questions.length === 0) {
        setActiveQuestion(-1);
        return;
      }
      const cTop = el.getBoundingClientRect().top;
      const tops = questions.map((q) => {
        const row = el.querySelector(`[data-testid="message-row-${q.messageId}"]`);
        return row ? row.getBoundingClientRect().top - cTop + el.scrollTop : Number.POSITIVE_INFINITY;
      });
      // Bottom clamp: fully scrolled down → the last question is current,
      // even when a short/failed final answer keeps its top below the midline.
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 2;
      setActiveQuestion(
        currentQuestionIndex(tops, el.scrollTop + el.clientHeight / 2, atBottom),
      );
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      el.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [chat?.id, questions]);

  const jumpToQuestion = (index: number) => {
    const q = questions[Math.max(0, Math.min(questions.length - 1, index))];
    if (q) jumpToMessage(q.messageId, undefined, { flash: false });
  };

  // Alt+↑/↓ — global, aber stumm, solange ein Eingabefeld fokussiert ist
  // (Grill-Entscheidung 5): beim Tippen gewinnt der native Cursor.
  useEffect(() => {
    if (questions.length < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      jumpToQuestion(activeQuestion + (e.key === 'ArrowUp' ? -1 : 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [questions, activeQuestion]);

  // Empty state: shown when no chat is selected.
  if (!chat) {
    return (
      <div className="syflo-chat-pane flex-1 flex items-center justify-center bg-white">
        {/* No max-width + nowrap: title and subtitle each stay on ONE line
            (user request 2026-07-26) — the wide monospace themes wrapped
            them awkwardly mid-sentence. */}
        <div className="text-center px-8">
          {/* Theme-Logo über dem Titel, leicht vergrößert (Nutzerwunsch
              2026-07-22) — jedes Theme zeigt seine eigene Logo-Variante. */}
          <div className="flex justify-center mb-6" data-testid="empty-state-logo">
            <Logo scale={1.6} />
          </div>
          <h2 className="syflo-empty-title whitespace-nowrap text-[32px] font-serif text-gray-800 mb-3 tracking-tight">{S.emptyTitle}</h2>
          <p className="whitespace-nowrap text-gray-500 text-[15px] leading-relaxed">{S.emptySubtitle}</p>
        </div>
      </div>
    );
  }

  // Right padding that keeps the header text clear of the absolutely
  // positioned action buttons (question stepper + Highlights).
  const headerActionsPad =
    onToggleHighlights || questions.length >= 2
      ? onToggleHighlights && questions.length >= 2
        ? 'pr-56 @max-[30rem]:pr-16'
        : 'pr-32 @max-[30rem]:pr-8'
      : '';

  // Clicking the quote jumps to the branch's source.
  const handleBranchedFromActivate = () => {
    if (onBranchedFromClick) onBranchedFromClick();
    else onSelectChat(chat.parent_id!);
  };

  return (
    <div
      // The chat column is a keyboard region only while it is actually
      // visible: the highlights drawer's overlay variant covers it whole, and
      // a ring walking behind it would be unreachable (ADR-0011, found in the
      // running app 2026-08-10).
      data-focus-region={highlightsDrawer ? undefined : 'chat'}
      className="syflo-chat-pane flex-1 flex flex-col bg-white overflow-hidden relative"
    >
      {/* Header: permanent für alle Chats (Grill 2026-07-21, Entscheidung 5) —
          der Highlights-Knopf braucht einen festen Ort. Bei Branch-Chats
          trägt statt des Titels das "Branched from"-Zitat den Kontext. */}
      {/* @container: in schmalen Spalten macht sich der Header kompakt —
          der Titel reserviert Platz für den Highlights-Knopf (statt darunter
          zu laufen), und der Knopf wird unter 30rem zum reinen Icon
          (Nutzerkorrektur 2026-07-22). */}
      {/* z-20: @container setzt contain:layout und KAPSELT damit den z-Index
          des Fragen-Popovers ein — ohne eigenes z-Level übermalen die später
          im DOM folgenden (positionierten) Nachrichten-Container das Popover
          (Nutzer-Screenshot 2026-07-22, Matrix-Theme). */}
      <div className="relative z-20 border-b border-gray-100 bg-white @container">
        <div className="flex justify-center">
          {/* py-4 für BEIDE Header-Arten (Nutzerentscheidung 2026-08-06): der
              Wurzel-Header stand auf py-7 und wuchs mit einem zweizeiligen
              Titel auf 104 px — bei gleichem Innenabstand oben und unten, aber
              zu viel davon. Der Titel trägt sein Gewicht über Schriftschnitt
              und Größe, nicht über Leerraum. */}
          <div
            className={`${chatColumnClass} py-4`}
            style={chatColumnStyle}
            data-testid="chat-header-shell"
          >
            {chat.parent_word && chat.parent_id ? (
              /* Branch chats: the blue "Branched from …" link takes the
                 title's place (mockup-branch-header.html §01) — title and
                 quote were near-duplicates; the full title stays available
                 as tooltip, in the sidebar and in the mind map.
                 The quote is SHOWN as parent_word_display when the model
                 restored its math ("σ 2 B ← 1 m m ∑ …" → a set formula,
                 user report 2026-08-02); parent_word stays the verbatim
                 anchor everything else searches for. */
              <div className={`group relative flex items-start gap-1 text-sm ${headerActionsPad}`}>
                <span className="material-icons mt-0.5 shrink-0 text-[14px] text-gray-400">subdirectory_arrow_left</span>
                <div
                  ref={branchQuoteRef}
                  className={`min-w-0 flex-1 leading-relaxed whitespace-nowrap ${hasMath(branchQuoteText) ? 'syflo-math-fade' : 'truncate'}`}
                  data-testid="branched-from-quote"
                  title={plainMathText(chat.title)}
                >
                  <span className="text-gray-400">{S.branchedFrom}</span>
                  {/* No <button>: buttons are atomic inline blocks that
                      cannot truncate — an inline <span> with link semantics
                      ellipsizes cleanly. Color alone (no border/underline)
                      marks it as a link — a border under the quote marks
                      used to read as stray underscores (user report
                      2026-07-27, recurred 2026-07-31 with math quotes). */}
                  <span
                    role="link"
                    tabIndex={0}
                    onClick={handleBranchedFromActivate}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleBranchedFromActivate();
                      }
                    }}
                    className="cursor-pointer text-blue-600 hover:text-blue-800 font-medium transition-colors"
                  >
                    "<InlineMarkdown text={branchQuoteText} />"
                  </span>
                </div>
                {/* Hover/focus tooltip replaces the old chevron+dropdown
                    (mockup-branch-header.html §03): only mounted when the
                    quote is actually cut, so short quotes get no unneeded
                    affordance. Light card (bg-white/border-gray-100), NOT a
                    dark bg-gray-900 tooltip: the matrix theme inverts the
                    gray scale, so a dark tooltip would render light-on-white
                    there. */}
                {branchQuoteOverflows && (
                  <div
                    role="tooltip"
                    data-testid="branched-from-tooltip"
                    className="pointer-events-none absolute left-5 top-full z-30 mt-2 max-w-sm rounded-lg border border-gray-100 bg-white px-3 py-2 text-[12.5px] leading-relaxed text-gray-700 opacity-0 shadow-2xl transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                  >
                    <span className="absolute -top-1 left-4 h-2 w-2 rotate-45 border-l border-t border-gray-100 bg-white" />
                    "<InlineMarkdown text={branchQuoteText} />"
                  </div>
                )}
              </div>
            ) : videoYoutubeId && !chat.parent_id ? (
              /* Wurzel-Chat eines Video-Baums: der Titel steht hier NICHT
                 (Variante C, Nutzerwahl 2026-08-15,
                 design/mockup-video-header-merge.html). Er ist beim Wurzel-Chat
                 identisch mit dem Video-Titel, den das Banner direkt darunter
                 ohnehin nennt — zweimal derselbe Satz, zusammen 105 px, bevor
                 die erste Antwort beginnt.

                 Dieselbe Entscheidung wie bei Zweig-Chats einen Block weiter
                 oben: von zwei Beinahe-Duplikaten bleibt eines. Dort gewinnt
                 das Zitat, hier das Banner — weil dort auch Kanal, Dauer und
                 die beiden Quellen-Knöpfe stehen, der Titel also bei seinen
                 Angaben bleibt.

                 Ohne Ersatztext (Nutzerkorrektur 2026-08-15): eine
                 Einordnung „Video-Baum" stand kurz hier und war selbst
                 überflüssig — das Banner darunter zeigt Symbol, Titel, Kanal
                 und Dauer, damit ist die Art der Quelle beantwortet. Übrig
                 bleibt eine leere Leiste, die nur noch die Aktionen trägt.

                 Der Platzhalter ist trotzdem nötig: die Aktionen sind
                 absolut positioniert (top-1/2), die Leiste bekäme sonst gar
                 keine Höhe. NICHT die Knopfhöhe (h-8) — das war der erste
                 Griff und ließ die Leiste auf 65 px wachsen, mehr als mit dem
                 Titel davor. Die Knöpfe brauchen keine ebenso hohe Zeile,
                 sondern eine ausreichend hohe LEISTE: h-4 plus py-4 ergibt
                 48 px, also 8 px Luft über und unter den 32-px-Knöpfen —
                 dieselbe Höhe wie die Textzeile, die hier vorher stand.

                 In Zweigen desselben Baums greift dieser Zweig nicht: dort
                 ist chat.parent_id gesetzt, und Kopf und Banner sagen zwei
                 verschiedene Dinge. */
              <div className="h-4" data-testid="video-root-header-spacer" aria-hidden="true" />
            ) : (
              <>
                <h2
                  className={`font-semibold text-gray-900 break-words line-clamp-2 text-base ${headerActionsPad}`}
                  title={plainMathText(chat.title)}
                >
                  <MathText text={chat.title} />
                </h2>
                {/* Topic branch (`/branch`): no quote to put in the title's
                    place, so the title stays and the way back is one quiet
                    line under it (mockup-branch-trace.html §07 —
                    the .bf-line shape of mockup-branch-command.html). It
                    leads to the branch line in the parent transcript, which
                    is the only record of where this topic came up. */}
                {chat.parent_id && chat.branch_origin && (
                  <div className={`mt-1 flex items-center gap-1 text-[11.5px] ${headerActionsPad}`}>
                    <CornerDownRight size={12} className="shrink-0 text-gray-400" />
                    <span className="shrink-0 text-gray-400">{S.traceBackTo}</span>
                    <span
                      role="link"
                      tabIndex={0}
                      data-testid="trace-back-link"
                      onClick={handleBranchedFromActivate}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleBranchedFromActivate();
                        }
                      }}
                      title={parentTitle ? plainMathText(parentTitle) : undefined}
                      className="min-w-0 cursor-pointer truncate font-medium text-blue-600 transition-colors hover:text-blue-800"
                    >
                      {parentTitle ? <MathText text={parentTitle} /> : S.branchedFrom.trim()}
                    </span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
        {(onToggleHighlights || questions.length >= 2) && (
          <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-2">
            <QuestionNavButton
              questions={questions}
              activeIndex={activeQuestion}
              onJump={(id) => jumpToMessage(id, undefined, { flash: false })}
            />
            {/* Kein aria-label an diesem Knopf: seine Beschriftung steht als
                Text darin. Die Kurzinfo erklärt nur die Symbol-Stufe unter
                30rem — ein aria-label würde den sichtbaren Namen überschreiben. */}
            {onToggleHighlights && (
              <button
                type="button"
                aria-pressed={highlightsOpen ?? false}
                data-tip={S.toggleHighlightsTitle} data-tip-narrow-only="" data-tip-below="" data-tip-end=""
                onClick={onToggleHighlights}
                data-focus-item="chat-highlights"
                className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium transition-colors ${
                  highlightsOpen
                    ? 'bg-blue-50 text-blue-700'
                    : 'border border-gray-200 text-gray-500 hover:bg-gray-100 hover:text-gray-700'
                }`}
              >
                <Highlighter size={14} />
                <span className="@max-[30rem]:hidden">{S.highlightsButton}</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Quellen-Banner für Bäume mit YouTube transcript (ADR-0005): sitzt
          fest unter dem Header und bleibt auch bei offenem Drawer sichtbar. */}
      {videoBanner}

      {/* Alles unterhalb des Headers in einem relativen Container, damit der
          Highlights-Drawer sich exakt darüberlegen kann — der Header (und
          damit sein Toggle-Knopf) bleibt frei. */}
      <div className="relative flex-1 min-h-0 flex flex-col">

      {/* Message list */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
        <div className="flex justify-center">
          <div
            className={`${chatColumnClass} flex flex-col py-8`}
            style={chatColumnStyle}
            data-testid="chat-content-shell"
          >
            {/* The "Branched from" link lives in the header row now
                (mockup-branch-header.html §01) — no duplicate row here. */}
            {chat.messages.length === 0 && (
              <div className="w-full pt-16 text-center text-sm text-gray-400">
                <p className="text-base font-medium text-gray-500 mb-1">{S.emptyChatTitle}</p>
                <p className="text-xs">{S.emptyChatHint}</p>
              </div>
            )}

            {/* Branch lines whose anchor did not survive (empty chat at the
                time, or the anchor message was deleted) open the transcript —
                the fork happened, only its place in it is gone. */}
            {branchTraces.leading.length > 0 && (
              <div
                style={
                  chat.messages.length
                    ? { marginBottom: '1.25rem' }
                    // Leerer Chat: der Hinweistext darüber ist zentrierte
                    // Fließschrift, die Zeile ein Bedienelement — ohne
                    // eigenen Luftraum kleben beide aneinander
                    // (Nutzer-Screenshot 2026-08-09, Matrix-Theme).
                    : { marginTop: '3rem' }
                }
              >
                <BranchTrace
                  entries={branchTraces.leading}
                  onOpen={onSelectChat}
                  flashChatId={flashTraceChatId}
                />
              </div>
            )}

            {orderMessages(chat.messages).map((msg, i, ordered) => {
              const isLastAssistant = msg.role === 'assistant' && i === ordered.length - 1;
              const branchWords = chat.children
                .filter(c => c.parent_word)
                .map(c => ({ word: c.parent_word!, chatId: c.id }));
              const traces = branchTraces.byMessageId.get(msg.id);
              return (
                <Fragment key={msg.id}>
                <div
                  data-testid={`message-row-${msg.id}`}
                  // The bubble is one keyboard item (ADR-0011). Enter selects
                  // it whole and opens the usual selection popup.
                  data-focus-item={msg.id}
                  data-flash={flashMessageId === msg.id ? 'true' : undefined}
                  // Testbarer Marker für den punktgenauen Markierungs-Flash —
                  // jsdom hat keine Custom Highlight API, das Malen no-opt dort.
                  data-flash-range={flashRange?.messageId === msg.id ? 'true' : undefined}
                  className={flashMessageId === msg.id ? 'syflo-hl-flash rounded-xl' : undefined}
                  style={{
                    marginTop: i === 0 ? 0 : '2rem',
                    // Glow in der Akzentfarbe (Nutzerkorrektur 2026-07-21:
                    // Glow statt Ring) — die Zeile hat keine eigene
                    // Highlight-Farbe. Über das blue-600-Token statt als
                    // Hex-Wert, damit der Glow dem Theme folgt statt in jedem
                    // Theme blau zu bleiben (Nutzerkorrektur 2026-08-09).
                    ...(flashMessageId === msg.id
                      ? ({ '--flash-color': 'var(--color-blue-600, #2563EB)' } as React.CSSProperties)
                      : null),
                  }}
                >
                  <MessageBubble
                    message={msg}
                    isStreaming={
                      streamingMessageIds
                        ? streamingMessageIds.has(msg.id)
                        : isLastAssistant && (sending || streaming)
                    }
                    // Tips/quotes rotate under EVERY actively streaming
                    // placeholder — a regenerate mid-list is not the last
                    // message, but deserves the same waiting look (user
                    // report 2026-07-25). Fallback: last assistant.
                    showThinkingTips={
                      streamingMessageIds ? streamingMessageIds.has(msg.id) : isLastAssistant
                    }
                    onRetryMessage={onRetryMessage}
                    onContinueMessage={onContinueMessage}
                    modelLabels={modelLabels}
                    onRetryLocalModel={onRetryLocalModel}
                    hasLocalModel={hasLocalModel}
                    billingUrl={billingUrl}
                    billingUrls={billingUrls}
                    onOpenModelPicker={onOpenModelPicker}
                    settingsChangedAt={settingsChangedAt}
                    onOpenSettings={onOpenSettings}
                    providerLabels={providerLabels}
                    localModelName={localModelName}
                    cloudFallback={cloudFallback}
                    onRetryCloudModel={onRetryCloudModel}
                    freeFallback={freeFallback}
                    freeProviderOffer={freeProviderOffer ?? undefined}
                    onAddFreeProvider={onAddFreeProvider}
                    onRetryFreeModel={onRetryFreeModel}
                    onWordRightClick={(word, context, x, y) =>
                      onWordRightClick({ word, context, x, y })
                    }
                    branchWords={branchWords}
                    videoYoutubeId={videoYoutubeId}
                    onTimeMarkClick={onTimeMarkClick}
                    onBranchClick={onSelectChat}
                    // Ahead-link of the queued note (§07): jumps to the chat
                    // whose question the queue is answering right now.
                    onOpenChat={onSelectChat}
                    // Klick auf das Zitat einer "Ask in chat"-Frage: zurück
                    // zur Textstelle (mockup-quote-jump-to-source.html).
                    onQuoteClick={onQuoteClick}
                    highlights={chatHighlights}
                    onChatSelection={onChatSelection}
                    onHighlightContextMenu={onHighlightContextMenu}
                    pendingSelection={pendingSelection}
                    flashRange={
                      flashRange && flashRange.messageId === msg.id ? flashRange : null
                    }
                  />
                </div>
                {/* Branch trace (mockup-branch-trace.html §02): a sibling of
                    the message row, never inside it — the row is what the
                    scroll spy, the flash and the highlight anchoring measure,
                    and a line drawn into it would shift all three. */}
                {traces && traces.length > 0 && (
                  <div style={{ marginTop: '1.25rem' }}>
                    <BranchTrace
                      entries={traces}
                      onOpen={onSelectChat}
                      flashChatId={flashTraceChatId}
                    />
                  </div>
                )}
                </Fragment>
              );
            })}

            {/* Unanswered trailing question (mockup-model-flow §10): one
                quiet row covers every silent loss — reload while queued,
                backend restart with a full queue, background-chat stream
                errors. Hidden while a live stream/queue owns the answer
                (the streaming prop mirrors both sets in App). */}
            {(() => {
              if (!onResendUnanswered || streaming || sending || loading) return null;
              const ordered = orderMessages(chat.messages);
              const last = ordered[ordered.length - 1];
              if (!last || last.role !== 'user') return null;
              return (
                <div
                  data-testid="unanswered-note"
                  className="flex flex-wrap items-center gap-2 text-[12.5px] text-gray-400"
                  style={{ marginTop: '0.75rem' }}
                >
                  <AlertCircle size={13} className="shrink-0" />
                  <span className="italic">{S.unanswered}</span>
                  <button
                    type="button"
                    data-testid="resend-button"
                    onClick={() => onResendUnanswered(last)}
                    className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-0.5 text-[12px] font-medium text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700"
                  >
                    <RotateCcw size={11} className="shrink-0" />
                    {S.resend}
                  </button>
                </div>
              );
            })()}

            <div ref={bottomRef} />
          </div>
        </div>
      </div>

      {/* Input area — full width. Nimmt Drag-and-drop von Dateien entgegen
          (gleiche Typen wie der Datei-Picker); das Overlay zeigt die Drop-Zone. */}
      <div
        /* Bewusst OHNE eigene Hintergrundfarbe (Nutzerreport 2026-08-09):
           die Fläche erbt den Hintergrund der Chat-Spalte, damit er in JEDEM
           Theme ohne Bruch durchläuft — der Matrix-Regen, Hyrules Lichtpfütze,
           das schlichte Weiß der Standard-Themes. Ein eigenes bg-white schnitt
           hier einen sichtbaren Kasten aus dem Hintergrund. Es wird auch nicht
           gebraucht: die Nachrichtenliste ist ein eigener Scroll-Container und
           endet über dieser Fläche, es scrollt also nichts dahinter durch. */
        className="syflo-composer-area pb-6 pt-3 relative"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        data-testid="chat-input-dropzone"
      >
        {/* Die zwei schwebenden Knöpfe — "Zur neuesten Nachricht" (mittig) und
            der Fragen-Stepper (rechts, ab 2 Fragen und nur bei Überlauf,
            Grill-Entscheidung 3). Sie hängen mit bottom-full an der OBERKANTE
            dieses Containers, nicht mit einem festen bottom-32 am Spaltenboden:
            der Composer wächst nach oben (bis 144 px), und in einer schmalen
            Spalte erreicht er diese Höhe schon bei einer normalen Frage — dann
            lagen die Knöpfe IM Eingabefeld (Nutzerreport 2026-08-10,
            design/mockup-composer-narrow.html §05). Der Streifen selbst ist
            klickdurchlässig, nur die Knöpfe fangen Klicks. */}
        {(!isPinnedToBottom || (listOverflows && questions.length >= 2)) && (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-full z-10 mb-2 h-9"
            data-testid="composer-floaters"
          >
            {!isPinnedToBottom && (
              <button
                onClick={scrollToBottom}
                data-tip={S.scrollToLatest}
                aria-label={S.scrollToLatest}
                className="pointer-events-auto absolute bottom-0 left-1/2 -translate-x-1/2 w-9 h-9 flex items-center justify-center rounded-full bg-white border border-gray-200 text-gray-600 shadow-md hover:text-gray-900 hover:bg-gray-50 transition-colors"
              >
                <ChevronDown size={18} strokeWidth={2} />
              </button>
            )}
            {listOverflows && questions.length >= 2 && (
              <div className="pointer-events-auto absolute bottom-0 right-4">
                <QuestionStepper
                  activeIndex={activeQuestion}
                  total={questions.length}
                  onJumpTo={jumpToQuestion}
                />
              </div>
            )}
          </div>
        )}

        {isDraggingFiles && (
          <div
            className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-blue-400 bg-blue-50/90 text-blue-600"
            data-testid="chat-drop-overlay"
          >
            <ImagePlus size={18} strokeWidth={1.9} />
            <span className="text-sm font-medium">{S.dropFiles}</span>
          </div>
        )}
        <div className="flex justify-center">
          <div className={`${chatColumnClass} @container`} style={chatColumnStyle} data-testid="chat-input-shell">
            {/* Guided empty state (ADR-0008), first run variant O2
                (mockup-onboarding-flow §03, chosen 2026-08-15): the setup card
                sits ABOVE the composer instead of replacing it. Replacing it
                sealed the app on the very first start — no text field, no
                attach button, no dictation — so the user had to buy a key
                before ever seeing what it was for. Everything except SENDING
                stays usable now. */}
            {setupNotice}

            {/* The notice strip of O2 — one thin line between the card and the
                composer, and the reason a locked send button never reads as a
                dead end: the way out is already on screen before it is tried.
                The whole row leads on (chevron), as in the mockup. */}
            {firstRun && (
              <button
                type="button"
                onClick={onOpenSetup}
                data-testid="first-run-strip"
                className="mb-2 mx-2 flex w-[calc(100%-1rem)] items-center gap-2 rounded-xl border border-blue-100 bg-blue-50/60 px-3 py-2.5 text-left transition-colors hover:bg-blue-50"
              >
                <KeyRound size={13} className="shrink-0 text-blue-600" />
                <span className="min-w-0 flex-1 truncate text-[13px] text-gray-700">
                  {S.firstRunBanner}
                  {' — '}
                  <span className="font-semibold text-blue-700">{S.firstRunBannerAction}</span>
                </span>
                <ChevronRight size={13} className="shrink-0 text-blue-600" />
              </button>
            )}

            {/* Anhang-Chips über dem Eingabefeld */}
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2 px-2">
                {attachments.map((att, i) => (
                  <AttachmentChip
                    key={`${att.alias}-${i}`}
                    alias={att.alias}
                    filename={att.file.name}
                    mimetype={att.file.type}
                    previewUrl={att.previewUrl}
                    onRemove={() => handleRemoveAttachment(i)}
                    onRename={(newAlias) => handleRenameAttachment(i, newAlias)}
                  />
                ))}
                {/* Warning chip right next to the attachment chips (§04 V1):
                    the gate names the model that cannot read the image. Without
                    a label there is nothing to name, so the chip stays away —
                    the card below still carries the exit. */}
                {visionBlocked && visionGate?.activeLabel && (
                  <span
                    data-testid="vision-warning-chip"
                    className="self-center inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700"
                  >
                    <EyeOff size={12} className="shrink-0" />
                    {S.visionChipWarning(visionGate.activeLabel)}
                  </span>
                )}
              </div>
            )}

            {/* §04 V1 — a configured model reads images: name it. Switching
                keeps the attachment and the typed text; only the model moves. */}
            {visionSwitchTarget && (
              <div
                data-testid="vision-switch-card"
                className="mb-2 mx-2 rounded-xl border border-blue-100 bg-blue-50/60 px-3 py-2.5"
              >
                <p className="text-[13px] font-semibold text-gray-900">{S.visionSwitchTitle}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    // Only the model moves: attachment and typed text stay, so
                    // the question can be finished after the switch.
                    onClick={() => onSwitchVisionModel?.(visionSwitchTarget)}
                    data-testid="vision-switch-button"
                    className="inline-flex items-center gap-1 rounded-md border border-blue-100 bg-blue-50 px-2 py-0.5 text-[12px] font-semibold text-blue-700 transition-colors hover:bg-blue-100"
                  >
                    <Eye size={11} className="shrink-0" />
                    {S.visionSwitchAction(visionSwitchTarget.label)}
                  </button>
                  <button
                    type="button"
                    onClick={removeImageAttachments}
                    data-testid="vision-remove-image"
                    className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-0.5 text-[12px] font-medium text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700"
                  >
                    {S.visionRemoveImage}
                  </button>
                </div>
              </div>
            )}

            {/* §04 V2 — nothing configured reads images. The state the user
                strands in today gets an exit, with price and size attached. */}
            {visionSetupOptions.length > 0 && (
              <div
                data-testid="vision-none-card"
                className="mb-2 mx-2 rounded-xl border border-blue-100 bg-blue-50/60 px-3 py-2.5"
              >
                <p className="flex items-center gap-1.5 text-[13px] font-semibold text-gray-900">
                  <EyeOff size={13} className="shrink-0 text-blue-600" />
                  {S.visionNoneTitle}
                </p>
                <p className="mt-1 text-[11.5px] text-gray-600">{S.visionNoneBody}</p>
                <div className="mt-2 overflow-hidden rounded-lg border border-gray-200 bg-white">
                  {visionSetupOptions.map((opt, i) => (
                    <button
                      key={`${opt.provider}-${opt.model}`}
                      type="button"
                      // Both kinds lead to Settings · Models: that is where the
                      // key is pasted AND where a local model is downloaded.
                      onClick={() => onOpenSettingsForProvider?.(opt.provider)}
                      data-testid={`vision-setup-row-${opt.model}`}
                      className={`flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-gray-50 ${
                        i > 0 ? 'border-t border-gray-200' : ''
                      }`}
                    >
                      {opt.kind === 'cloud'
                        ? <Zap size={13} className="shrink-0 text-blue-600" />
                        : <Cpu size={13} className="shrink-0 text-gray-400" />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-semibold text-gray-900">{opt.label}</span>
                        <span className={`block truncate text-[11.5px] ${opt.kind === 'cloud' ? 'text-blue-700' : 'text-gray-500'}`}>
                          {opt.kind === 'cloud'
                            ? S.visionCloudRow(opt.requestsPerDay ?? 0)
                            : S.visionLocalRow(opt.size ?? '')}
                        </span>
                      </span>
                      <span className={`shrink-0 rounded-full border px-1.5 py-px text-[10px] font-semibold ${
                        opt.kind === 'cloud'
                          ? 'border-blue-100 bg-blue-50 text-blue-700'
                          : 'border-gray-200 bg-gray-50 text-gray-500'
                      }`}>
                        {opt.kind === 'cloud' ? S.visionSetupBadge : S.visionLoadBadge}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={removeImageAttachments}
                    data-testid="vision-ask-anyway"
                    className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-0.5 text-[12px] font-medium text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700"
                  >
                    {S.visionAskAnyway}
                  </button>
                </div>
              </div>
            )}

            {/* @-Autocomplete-Dropdown: erscheint, wenn der User "@" tippt */}
            {mentionQuery !== null && filteredMentions.length > 0 && (
              <div className="absolute bottom-[112px] left-1/2 -translate-x-1/2 z-20 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden w-[28rem] max-w-[calc(100%-3rem)]">
                <div className="px-3 py-2 text-[11px] uppercase tracking-wider text-gray-400 font-medium border-b border-gray-100">
                  {S.attachmentsHeading}
                </div>
                {filteredMentions.map((att, i) => (
                  <button
                    key={att.alias}
                    onClick={() => insertMention(att.alias)}
                    onMouseEnter={() => setMentionIndex(i)}
                    className={`w-full flex items-center gap-3 px-3 py-2 transition-colors text-left ${
                      i === mentionIndex ? 'bg-gray-100' : 'hover:bg-gray-50'
                    }`}
                    data-testid={`mention-item-${att.alias}`}
                  >
                    <AttachmentChip
                      alias={att.alias}
                      filename={att.file.name}
                      mimetype={att.file.type}
                      previewUrl={att.previewUrl}
                      compact
                    />
                  </button>
                ))}
              </div>
            )}

            {/* /btw-Nebenfrage — klappt über dem Eingabefeld aus und ist
                Teil des Composers, nie eine Nachricht
                (design/mockup-btw-composer-fold.html). */}
            {aside && <BtwPanel aside={aside} onDismiss={onDismissAside} onKeep={onKeepAside} onBranch={onBranchAside} modelLabels={modelLabels} providerLabels={providerLabels} />}

            {/* /branch-Chip — nennt das Elternteil, unter dem der Zweig
                entsteht, BEVOR Enter gedrückt wird
                (design/mockup-branch-command.html §01). */}
            {branchMode && (
              <div
                className="mb-2 mx-2 flex items-center gap-2 text-[11px]"
                data-testid="branch-chip"
              >
                <span className="inline-flex items-center rounded-md border border-dashed border-gray-300 bg-gray-100 px-2 py-0.5 font-mono font-semibold text-gray-600">
                  /branch
                </span>
                <div className="relative min-w-0">
                  <button
                    ref={branchTargetButtonRef}
                    type="button"
                    onClick={() => setBranchPickerOpen((open) => !open)}
                    data-tip={S.branchTargetChange}
                    aria-label={S.branchTargetChange}
                    aria-haspopup="menu"
                    aria-expanded={branchPickerOpen}
                    data-testid="branch-target"
                    className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md px-1 py-0.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
                  >
                    <CornerDownRight size={11} className="shrink-0" />
                    <span className="truncate">{S.branchUnder(branchTargetTitle)}</span>
                    <ChevronDown size={11} className="shrink-0" />
                  </button>
                  {branchPickerOpen && (
                    <div
                      ref={branchPickerRef}
                      role="menu"
                      data-testid="branch-target-picker"
                      // max-h: ein tiefer Baum hat leicht zwanzig Chats — die
                      // Liste scrollt, statt aus dem Fenster zu wachsen.
                      className="absolute bottom-full left-0 z-30 mb-1 max-h-72 w-72 max-w-[calc(100vw-3rem)] overflow-y-auto rounded-xl border border-gray-200 bg-white py-1 shadow-lg"
                    >
                      <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-gray-400">
                        {S.branchTargetHeading}
                      </div>
                      {orderedBranchTargets.map((target, i) => (
                        <button
                          key={target.id}
                          role="menuitem"
                          onClick={() => { setBranchTargetId(target.id); setBranchPickerOpen(false); }}
                          data-testid={`branch-target-item-${target.id}`}
                          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors ${
                            target.id === effectiveBranchTargetId
                              ? 'bg-blue-50 font-medium text-blue-700'
                              : 'text-gray-800 hover:bg-gray-50'
                          }`}
                          // Die Einrückung zeigt den Baum; der aktuelle Chat
                          // steht oben und bleibt darum bündig.
                          style={{ paddingLeft: i === 0 ? undefined : `${12 + target.depth * 14}px` }}
                        >
                          {i === 0 && <GitBranch size={12} className="shrink-0 text-current opacity-60" />}
                          <span className="min-w-0 flex-1 truncate"><MathText text={target.title} /></span>
                          {target.id === effectiveBranchTargetId && <Check size={12} className="shrink-0" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* "Ask in chat"-Zitatblock — dockt über dem Eingabefeld an
                (mockup-chat-highlights-ask-in-chat.html, Sektion 02):
                Farbbalken in der Highlight-Farbe (neutral grau ohne Farbe),
                Quellenzeile, ×-Button. Entfernen löscht nie das Highlight. */}
            {composerQuote && (
              <div
                className="mb-2 mx-2 flex items-start gap-2.5 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2"
                data-testid="composer-quote"
              >
                <span
                  aria-hidden="true"
                  className="self-stretch w-[3px] rounded-full shrink-0"
                  style={{ background: composerQuote.color ? HIGHLIGHT_HEX[composerQuote.color] : '#CBD5E1' }}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] leading-relaxed text-gray-700 line-clamp-3">
                    <MathText text={composerQuote.text} />
                  </p>
                  <p className="mt-0.5 flex items-center gap-1 text-[11px] font-medium text-gray-400">
                    <MessageSquareQuote size={11} className="shrink-0" />
                    <span className={hasMath(composerQuote.sourceLabel) ? 'syflo-math-fade' : 'truncate'}><MathText text={S.quoteFrom(composerQuote.sourceLabel)} /></span>
                  </p>
                </div>
                <button
                  onClick={onClearComposerQuote}
                  data-tip={S.removeQuote}
                  aria-label={S.removeQuote}
                  data-testid="composer-quote-remove"
                  className="shrink-0 p-1 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                >
                  <X size={13} />
                </button>
              </div>
            )}

            {/* Sprach-Wellen — eigene Zeile ÜBER dem Eingabefeld, damit das
                Eingabefeld nicht größer wird, sondern in Ruhe bleibt. */}
            {isListening && (
              <div className="mb-2 px-3" data-testid="voice-waveform-row">
                <VoiceWaveform volume={volume} />
              </div>
            )}

            {/* Recording state glows in the theme's accent (blue utilities
                are theme-token mapped) instead of a hard red — user decision
                2026-07-25. */}
            {/* Variante A aus design/mockup-composer-narrow.html §02: unter
                30rem bricht die Zeile um. Der Textblock nimmt mit basis-full
                die ganze Breite, alles Übrige rutscht dadurch auf eine zweite
                Zeile — der getippte Text bekommt also die volle Spaltenbreite
                statt der ~4 Zeichen, die zwischen Mikro, Modell-Chip und
                Senden-Knopf übrig blieben (Nutzerreport 2026-08-10).
                rounded-full passt nur zu einer Zeile; zweizeilig wird daraus
                ein Rechteck mit großem Radius. */}
            <div
              data-testid="composer-box"
              className={`flex items-center gap-2 bg-white border border-gray-300 rounded-full @max-[30rem]:flex-wrap @max-[30rem]:rounded-3xl @max-[30rem]:px-3 pl-2 pr-3 py-2 shadow-sm transition-all ${
                isListening
                  ? 'border-blue-300 ring-2 ring-blue-100'
                  : 'focus-within:border-gray-400'
              }`}
            >
              {/* Hidden File-Input — wird vom Plus-Button getriggert */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={handleFilesSelected}
                className="hidden"
                accept="image/*,text/*,.pdf,.md,.txt,.csv,.json"
                data-testid="media-file-input"
              />
              {/* Verstecktes PDF-Input für "Upload file" (Paper an den Tree binden) */}
              <input
                ref={pdfInputRef}
                type="file"
                onChange={handlePdfSelected}
                className="hidden"
                accept="application/pdf,.pdf"
                data-testid="pdf-file-input"
              />
              <div className="relative shrink-0">
                <button
                  ref={plusButtonRef}
                  onClick={handleTogglePickerMenu}
                  disabled={isBusy}
                  aria-haspopup="menu"
                  aria-expanded={pickerMenuOpen}
                  className={`w-9 h-9 flex items-center justify-center rounded-full transition-colors disabled:opacity-50 ${
                    pickerMenuOpen
                      ? 'text-gray-900 bg-gray-100'
                      : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
                  }`}
                  data-tip={S.attach}
                  aria-label={S.attach}
                  data-focus-item="composer-attach"
                  data-testid="attach-plus-button"
                >
                  <Plus size={20} strokeWidth={1.75} />
                </button>
                {pickerMenuOpen && (
                  <div
                    ref={pickerMenuRef}
                    role="menu"
                    className="absolute bottom-full left-0 mb-2 z-30 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden min-w-[14rem] py-1"
                    data-testid="attach-menu"
                  >
                    <button
                      role="menuitem"
                      onClick={handlePickFiles}
                      className="w-full flex items-center gap-3 px-3 py-2 hover:bg-gray-50 transition-colors text-left text-sm text-gray-800"
                      data-testid="attach-menu-files"
                    >
                      <ImageIcon size={16} className="text-gray-500 shrink-0" />
                      <span>{S.menuMedia}</span>
                    </button>
                    {onUploadPdf && (
                      <button
                        role="menuitem"
                        onClick={handlePickPdf}
                        className="w-full flex items-center gap-3 px-3 py-2 hover:bg-gray-50 transition-colors text-left text-sm text-gray-800"
                        data-testid="attach-menu-upload-pdf"
                      >
                        <FileText size={16} className="text-gray-500 shrink-0" />
                        <span>{S.menuPdf}</span>
                      </button>
                    )}
                    {onOpenPaperSearch && (
                      <button
                        role="menuitem"
                        onClick={() => { setPickerMenuOpen(false); onOpenPaperSearch(); }}
                        className="w-full flex items-center gap-3 px-3 py-2 hover:bg-gray-50 transition-colors text-left text-sm text-gray-800"
                        data-testid="attach-menu-research-paper"
                      >
                        <BookOpen size={16} className="text-gray-500 shrink-0" />
                        <span>{S.menuResearchPaper}</span>
                      </button>
                    )}
                    {onOpenYouTubeSearch && (
                      <button
                        role="menuitem"
                        onClick={() => { setPickerMenuOpen(false); onOpenYouTubeSearch(); }}
                        className="w-full flex items-center gap-3 px-3 py-2 hover:bg-gray-50 transition-colors text-left text-sm text-gray-800"
                        data-testid="attach-menu-youtube-transcript"
                      >
                        <TvMinimalPlay size={16} className="text-gray-500 shrink-0" />
                        <span>{S.menuYouTubeTranscript}</span>
                      </button>
                    )}
                  </div>
                )}
                {/* /feedback-Vorschlag: erscheint, solange am Command-Wort
                    getippt wird — an der oberen linken Ecke des Eingabefelds,
                    über dem Plus-Button (design/mockup-feedback.html §2,
                    Nutzerkorrektur 2026-08-01). */}
                {slashCommands.length > 0 && (
                  <div className="absolute bottom-full left-0 mb-2 z-20 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden w-[22rem] max-w-[calc(100vw-3rem)]">
                    {slashCommands.map((cmd, i) => (
                      <button
                        key={cmd.key}
                        onClick={() => runSlashCommand(cmd)}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 text-left ${
                          i === slashIndex ? 'bg-blue-50' : 'hover:bg-gray-50'
                        }`}
                        data-testid={`slash-item-${cmd.key}`}
                      >
                        {cmd.icon}
                        <span>
                          <span className="block text-sm font-semibold text-blue-600">{cmd.label}</span>
                          <span className="block text-xs text-gray-500">{cmd.desc}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Der native Textarea-Platzhalter kann in schmalen Spalten
                  weder umbrechen (sah abgeschnitten aus) noch mit Ellipse
                  kürzen (Chromium ignoriert text-overflow auf Textarea-
                  Platzhaltern). Darum bleibt das placeholder-Attribut nur
                  für Screenreader/Tests, unsichtbar — sichtbar ist das
                  Overlay-Span, das sauber mit „…" kürzt.

                  Highlight-Overlay für /feedback (Nutzerkorrektur 2026-08-01,
                  zweiter Anlauf): ein doppelt gemalter Text-Zwilling sah
                  verwaschen aus (unterschiedliches Antialiasing zweier
                  übereinanderliegender Layer). Robuster: die echte textarea
                  bekommt komplett transparenten Text + sichtbaren Caret: das
                  einzige, was den Text sichtbar zeigt, ist dieser darunter
                  liegende Layer — identische Schrift/Padding/Zeilenhöhe/
                  Umbruch, Höhe und Scroll-Position werden aus der textarea
                  gespiegelt (autosizeTextarea/syncHighlightScroll oben). */}
              <div
                data-testid="composer-text-block"
                className="relative flex-1 min-w-0 flex @max-[30rem]:order-first @max-[30rem]:basis-full"
              >
                <div
                  ref={highlightRef}
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 w-full overflow-hidden px-2 py-[10px] text-[16px] leading-[1.5] whitespace-pre-wrap break-words text-gray-900"
                  data-testid="chat-textarea-highlight"
                >
                  {renderComposerHighlight(input)}
                </div>
                <textarea
                  // Last keyboard item of the chat region (ADR-0011): ↓ from
                  // the final bubble lands here, and any printable key gives
                  // the composer the focus back.
                  data-focus-item="composer"
                  ref={textareaRef}
                  value={input}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyDown}
                  onKeyUp={handleKeyUp}
                  onScroll={syncHighlightScroll}
                  placeholder={isListening || isTranscribing ? '' : composerQuote ? S.placeholderAskQuote : S.placeholderAsk}
                  rows={1}
                  disabled={isBusy}
                  readOnly={isListening || isTranscribing}
                  className="relative min-h-[44px] w-full min-w-0 bg-transparent px-2 py-[10px] text-[16px] text-transparent caret-gray-900 outline-none resize-none leading-[1.5] disabled:opacity-50 placeholder:text-transparent placeholder:whitespace-nowrap placeholder:overflow-hidden"
                  data-testid="chat-textarea"
                />
                {!input && !isListening && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 max-w-[calc(100%-1rem)] truncate text-[16px] leading-[1.5] text-gray-400"
                    data-testid="chat-textarea-placeholder"
                  >
                    {isTranscribing ? S.transcribing : composerQuote ? S.placeholderAskQuote : S.placeholderAsk}
                  </span>
                )}
              </div>

              {/* Der Mikro-Knopf war unter 24rem ausgeblendet, weil er dem
                  Textfeld Breite wegnahm. Mit dem zweizeiligen Composer
                  (Variante A, §02 des Mockups) steht er in der Steuerzeile und
                  kostet keine Textbreite mehr — er darf also bleiben. */}
              {supported && (
                <button
                  onClick={handleToggleListening}
                  data-tip={isTranscribing ? S.transcribing : isListening ? S.stopRecording : S.startRecording} data-tip-end=""
                  aria-label={isTranscribing ? S.transcribing : isListening ? S.stopRecording : S.startRecording}
                  aria-pressed={isListening}
                  disabled={isTranscribing}
                  className={`shrink-0 w-9 h-9 flex items-center justify-center rounded-full transition-colors ${
                    isListening
                      ? 'text-white bg-blue-500 hover:bg-blue-600'
                      : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
                  }`}
                  data-focus-item="composer-mic"
                  data-testid="mic-button"
                >
                  {isTranscribing
                    ? <Loader2 size={20} strokeWidth={1.9} className="animate-spin" />
                    : isListening
                      ? <MicOff size={20} strokeWidth={1.9} />
                      : <Mic size={20} strokeWidth={1.9} />}
                </button>
              )}

              {/* First run (O2): the pill's slot is where a user goes looking
                  for the model, so it must not go blank — it stands in for the
                  picker and leads to the path choice. Same pill geometry as
                  ModelPicker (including its narrow-column hide) so nothing in
                  the row shifts once a real model exists. */}
              {firstRun ? (
                <button
                  type="button"
                  onClick={onOpenSetup}
                  data-testid="first-run-model-pill"
                  data-focus-item="composer-model"
                  className="@max-[19rem]:hidden shrink-0 h-9 max-w-[11rem] @max-[23rem]:max-w-[8rem] px-3 inline-flex items-center gap-1.5 rounded-full border border-blue-100 bg-blue-50 text-[12.5px] font-semibold text-blue-700 transition-colors hover:bg-blue-100"
                >
                  <KeyRound size={11} className="shrink-0" />
                  <span className="truncate">{S.firstRunPillLabel}</span>
                </button>
              ) : modelPicker}

              {(sending || streaming) && onStopStreaming && !input.trim() && attachments.length === 0 ? (
                // Bewusst dieselben Klassen wie der Senden-Knopf (bg-blue-600
                // rounded-full): nur so greifen die Theme-Overrides in
                // index.css (Question-Block, Sticker-Schatten, Phosphor-Glow)
                // auch für den Stop-Zustand — ein hartes Rot fiele aus jedem
                // Theme heraus (Nutzerkorrektur 2026-07-22).
                <button
                  onClick={onStopStreaming}
                  data-tip={S.stopResponse} data-tip-end=""
                  aria-label={S.stopResponse}
                  data-testid="stop-button"
                  /* ml-auto: in der zweizeiligen Steuerzeile (Variante A) sitzt
                     der Knopf rechts, wie einzeilig am Zeilenende. */
                  className="shrink-0 w-9 h-9 @max-[30rem]:ml-auto flex items-center justify-center rounded-full bg-blue-600 text-white transition-all hover:bg-blue-700"
                >
                  <Square size={13} fill="currentColor" strokeWidth={0} />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  // First run (O2): sending is the ONE thing a missing model
                  // really blocks, so it is the one thing that locks. The
                  // tooltip has to name the way out — a disabled arrow with
                  // nothing to read is the dead end the mockup warns about
                  // (data-tip survives `disabled`, see index.css).
                  disabled={firstRun || isBusy || isListening || isTranscribing || (!input.trim() && attachments.length === 0)}
                  data-tip={firstRun ? S.firstRunSendTip : S.send} data-tip-end=""
                  aria-label={firstRun ? S.firstRunSendTip : S.send}
                  data-focus-item="composer-send"
                  data-testid="send-button"
                  className="shrink-0 w-9 h-9 @max-[30rem]:ml-auto flex items-center justify-center rounded-full bg-blue-600 text-white transition-all hover:bg-blue-700 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <ArrowUp size={20} strokeWidth={2.25} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Highlights-Drawer über Nachrichtenliste + Composer (Slot vom Owner).
          Innerhalb des relativen Containers, damit der Header sichtbar bleibt. */}
      {highlightsDrawer}

      {/* Roh-Transkript-Drawer (ADR-0005) — gleicher Slot-Mechanismus. */}
      {transcriptDrawer}

      </div>
    </div>
  );
}
