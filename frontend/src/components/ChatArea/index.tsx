/**
 * components/ChatArea/index.tsx
 *
 * The main conversation panel. Renders the message history, the auto-expanding
 * input field, the send button, and the microphone button for voice dictation.
 */

import { useState, useRef, useEffect, useImperativeHandle, useMemo } from 'react';
import { Loader2, Mic, MicOff, Plus, ArrowUp, ChevronDown, ChevronUp, Highlighter, Image as ImageIcon, ImagePlus, FileText, BookOpen, MessageSquareQuote, Square, TvMinimalPlay, X } from 'lucide-react';
import { MessageBubble } from './MessageBubble';
import { InheritedContextBanner } from './InheritedContextBanner';
import { AttachmentChip } from './AttachmentChip';
import { Logo } from '../Logo';
import { VoiceWaveform } from './VoiceWaveform';
import { useVoiceInput } from '../../hooks/useVoiceInput';
import { useStrings } from '../../strings';
import { HIGHLIGHT_HEX } from '../../types';
import type { ChatAncestor, ChatDetail, ChatSelection, ComposerQuote, HighlightColor, LocalAttachment, Message, MessageHighlight, WordPopup } from '../../types';
import { rangeFromOffsets } from '../../chat/highlightAnchors';
import { deriveQuestions, currentQuestionIndex } from '../../chat/questionNav';
import { orderMessages } from '../../chat/messageOrder';
import { QuestionNavButton, QuestionStepper } from './QuestionNav';

interface Props {
  chat: ChatDetail | null;
  loading: boolean;
  streaming: boolean;
  onSendMessage: (content: string, attachments: LocalAttachment[]) => Promise<void>;
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
  // Header (wie das Kontext-Banner), kommt fertig komponiert vom Owner (App).
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
  // "Ask in chat"-Zitat, das vorbefüllt über der Textarea hängt. Beim Senden
  // wird es als Markdown-Blockquote über die Frage gestellt.
  composerQuote?: ComposerQuote | null;
  onClearComposerQuote?: () => void;
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
  // Vorfahren-Pfad des aktiven Chats fürs Kontext-Banner unter dem Header
  // (design/mockup-context-banner-variants.html §01, Variante 3a) — der
  // geerbte Kontext wird im Chat angezeigt, der ihn empfängt.
  ancestors?: ChatAncestor[];
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
}

// Dauer des Aufblinkens nach einem Drawer-Sprung.
const FLASH_MS = 1500;

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

// How close to the bottom (in px) counts as "at the bottom" — used to re-pin
// auto-scroll once the user manually scrolls back down.
const AT_BOTTOM_THRESHOLD = 8;

export function ChatArea({ chat, loading, streaming, onSendMessage, onWordRightClick, onSelectChat, onUploadPdf, onOpenPaperSearch, onOpenYouTubeSearch, videoBanner, transcriptDrawer, chatHighlights, onChatSelection, onHighlightContextMenu, pendingSelection, onBranchedFromClick, composerQuote, onClearComposerQuote, onToggleHighlights, highlightsOpen, highlightsDrawer, modelPicker, onStopStreaming, streamingMessageIds, onRetryMessage, ancestors, voiceRecorderFactory, ref }: Props) {
  // UI-Texte in der App language — re-rendert beim Sprachwechsel mit.
  const S = useStrings().chatArea;
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  // @-Autocomplete: enthält den aktuell getippten Filter-String, oder null wenn kein @-Modus.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  // Markiert den aktuell hervorgehobenen Vorschlag im Autocomplete-Dropdown.
  const [mentionIndex, setMentionIndex] = useState(0);
  // Steuert das kleine Plus-Popover-Menü ("Files and media", …) — wie bei Claude.
  const [pickerMenuOpen, setPickerMenuOpen] = useState(false);
  // True, solange Dateien über dem Eingabebereich schweben — zeigt das Drop-Overlay.
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const dragDepthRef = useRef(0);
  const pickerMenuRef = useRef<HTMLDivElement>(null);
  const plusButtonRef = useRef<HTMLButtonElement>(null);
  // Mirror state for rendering the "scroll to latest" button.
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);
  // Authoritative pin state read by the auto-scroll effect. A ref avoids
  // race conditions where a stale state value could pull the user back down
  // a moment after they started scrolling up.
  const isPinnedRef = useRef(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Enter fiel mit laufender Transkription zusammen → Senden vormerken,
  // sobald das Transkript im Eingabefeld gelandet ist (Effekt unten).
  const pendingSendRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const chatColumnClass = 'shrink-0 px-6 sm:px-8';
  // maxWidth 100% (statt calc(100% - 3rem)): in der schmalen Drei-Spalten-
  // Chat-Spalte sind die px-Innenabstände Gutter genug — die zusätzlichen
  // 3rem Außenrand quetschten den Composer, bis der Senden-Knopf aus dem
  // Eingabefeld ragte (Nutzerkorrektur 2026-07-22).
  const chatColumnStyle = { width: '46rem', maxWidth: '100%' };

  // "Branched from"-Zitat: standardmäßig auf 2 Zeilen geklemmt; der Chevron
  // klappt den vollen Text auf. Der Chevron erscheint nur, wenn das Zitat
  // wirklich abgeschnitten ist — gemessen per ResizeObserver, damit das auch
  // beim Verbreitern der Chat-Spalte (Drag-Resize) stimmt.
  const [branchQuoteExpanded, setBranchQuoteExpanded] = useState(false);
  const [branchQuoteOverflows, setBranchQuoteOverflows] = useState(false);
  const branchQuoteRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setBranchQuoteExpanded(false);
  }, [chat?.id]);
  useEffect(() => {
    const el = branchQuoteRef.current;
    if (!el) return;
    const measure = () => {
      // Im aufgeklappten Zustand nicht messen — sonst verschwände der
      // Chevron und man könnte nie wieder zuklappen.
      if (!branchQuoteExpanded) {
        setBranchQuoteOverflows(el.scrollHeight > el.clientHeight + 1);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [chat?.id, chat?.parent_word, branchQuoteExpanded]);

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
    isPinnedRef.current = pinned;
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

  // Auto-scroll on new content only when the user hasn't scrolled away.
  useEffect(() => {
    if (isPinnedRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [chat?.messages, streaming]);

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
    ta.style.height = `${Math.min(Math.max(ta.scrollHeight, 44), 144)}px`;
  };
  useEffect(autosizeTextarea, [input]);

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
    if ((!text && attachments.length === 0) || sending || !chat) return;
    // Zitat als Markdown-Blockquote über die Frage stellen — so landet es im
    // LLM-Kontext und MessageBubble rendert es als Zitatblock in der Bubble.
    const content = composerQuote && text
      ? composerQuote.text.split('\n').map((l) => `> ${l}`).join('\n') + '\n\n' + text
      : text;
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
      await onSendMessage(content, sentAttachments);
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
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
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

  useImperativeHandle(ref, () => ({ scrollToMessage: jumpToMessage }));

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
      setActiveQuestion(currentQuestionIndex(tops, el.scrollTop + el.clientHeight / 2));
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
        <div className="text-center max-w-lg px-8">
          {/* Theme-Logo über dem Titel, leicht vergrößert (Nutzerwunsch
              2026-07-22) — jedes Theme zeigt seine eigene Logo-Variante. */}
          <div className="flex justify-center mb-6" data-testid="empty-state-logo">
            <Logo scale={1.6} />
          </div>
          <h2 className="syflo-empty-title text-[32px] font-serif text-gray-800 mb-3 tracking-tight">{S.emptyTitle}</h2>
          <p className="text-gray-500 text-[15px] leading-relaxed">{S.emptySubtitle}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="syflo-chat-pane flex-1 flex flex-col bg-white overflow-hidden relative">
      {/* Header: permanent für alle Chats (Grill 2026-07-21, Entscheidung 5) —
          der Highlights-Knopf braucht einen festen Ort. Bei Branch-Chats
          schmaler, weil das "Branched from"-Zitat den Kontext trägt. */}
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
          <div
            className={`${chatColumnClass} ${chat.parent_word && chat.parent_id ? 'py-3' : 'py-7'}`}
            style={chatColumnStyle}
            data-testid="chat-header-shell"
          >
            <h2
              className={`font-semibold text-gray-900 break-words line-clamp-2 ${chat.parent_word && chat.parent_id ? 'text-sm' : 'text-base'} ${onToggleHighlights || questions.length >= 2 ? (onToggleHighlights && questions.length >= 2 ? 'pr-56 @max-[30rem]:pr-16' : 'pr-32 @max-[30rem]:pr-8') : ''}`}
              title={chat.title}
            >
              {chat.title}
            </h2>
          </div>
        </div>
        {(onToggleHighlights || questions.length >= 2) && (
          <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-2">
            <QuestionNavButton
              questions={questions}
              activeIndex={activeQuestion}
              onJump={(id) => jumpToMessage(id, undefined, { flash: false })}
            />
            {onToggleHighlights && (
              <button
                type="button"
                aria-pressed={highlightsOpen ?? false}
                title={S.toggleHighlightsTitle}
                onClick={onToggleHighlights}
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

      {/* Geerbter Kontext als Banner + Inline-Akkordeon (Variante 3a):
          sitzt fest unter dem Header, die Nachrichten scrollen darunter. */}
      {ancestors && ancestors.length > 0 && <InheritedContextBanner ancestors={ancestors} />}

      {/* Quellen-Banner für Bäume mit YouTube transcript (ADR-0005): sitzt
          wie das Kontext-Banner fest unter dem Header und bleibt auch bei
          offenem Drawer sichtbar. */}
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
            {/* Blue hyperlink back to parent chat — shown at the top of
                branched chats. The quote is the user's original PDF/chat
                selection and can be a whole sentence: clamped to two lines,
                expandable via the chevron (only shown when actually cut). */}
            {chat.parent_word && chat.parent_id && (
              <div className="flex w-full min-w-0 items-start gap-1.5 border-b border-gray-100 pb-3 mb-6 text-sm">
                <span className="material-icons mt-0.5 shrink-0 text-[14px] text-gray-400">subdirectory_arrow_left</span>
                <div
                  ref={branchQuoteRef}
                  className={`min-w-0 flex-1 break-words leading-relaxed ${branchQuoteExpanded ? '' : 'line-clamp-2'}`}
                  data-testid="branched-from-quote"
                >
                  <span className="text-gray-400">{S.branchedFrom}</span>
                  {/* Kein <button>: Buttons sind atomare Inline-Blöcke, die
                      weder über Zeilen umbrechen noch sich clampen lassen —
                      das Zitat wäre wieder einzeilig abgeschnitten. Ein
                      inline-<span> mit Link-Semantik bricht sauber um. */}
                  <span
                    role="link"
                    tabIndex={0}
                    onClick={() =>
                      onBranchedFromClick ? onBranchedFromClick() : onSelectChat(chat.parent_id!)
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        if (onBranchedFromClick) onBranchedFromClick();
                        else onSelectChat(chat.parent_id!);
                      }
                    }}
                    className="cursor-pointer text-blue-600 underline underline-offset-2 hover:text-blue-800 font-medium transition-colors"
                  >
                    "{chat.parent_word}"
                  </span>
                </div>
                {(branchQuoteOverflows || branchQuoteExpanded) && (
                  <button
                    onClick={() => setBranchQuoteExpanded(v => !v)}
                    title={branchQuoteExpanded ? S.showLess : S.showFullText}
                    aria-expanded={branchQuoteExpanded}
                    data-testid="branched-from-toggle"
                    className="mt-0.5 shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                  >
                    {branchQuoteExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                )}
              </div>
            )}

            {chat.messages.length === 0 && (
              <div className="w-full pt-16 text-center text-sm text-gray-400">
                <p className="text-base font-medium text-gray-500 mb-1">{S.emptyChatTitle}</p>
                <p className="text-xs">{S.emptyChatHint}</p>
              </div>
            )}

            {orderMessages(chat.messages).map((msg, i, ordered) => {
              const isLastAssistant = msg.role === 'assistant' && i === ordered.length - 1;
              const branchWords = chat.children
                .filter(c => c.parent_word)
                .map(c => ({ word: c.parent_word!, chatId: c.id }));
              return (
                <div
                  key={msg.id}
                  data-testid={`message-row-${msg.id}`}
                  data-flash={flashMessageId === msg.id ? 'true' : undefined}
                  // Testbarer Marker für den punktgenauen Markierungs-Flash —
                  // jsdom hat keine Custom Highlight API, das Malen no-opt dort.
                  data-flash-range={flashRange?.messageId === msg.id ? 'true' : undefined}
                  className={flashMessageId === msg.id ? 'syflo-hl-flash rounded-xl' : undefined}
                  style={{
                    marginTop: i === 0 ? 0 : '2rem',
                    // Glow in Blau (Nutzerkorrektur 2026-07-21: Glow statt
                    // Ring) — die Zeile hat keine eigene Highlight-Farbe.
                    ...(flashMessageId === msg.id
                      ? ({ '--flash-color': '#2563EB' } as React.CSSProperties)
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
                    showThinkingTips={isLastAssistant}
                    onRetryMessage={onRetryMessage}
                    onWordRightClick={(word, context, x, y) =>
                      onWordRightClick({ word, context, x, y })
                    }
                    branchWords={branchWords}
                    onBranchClick={onSelectChat}
                    highlights={chatHighlights}
                    onChatSelection={onChatSelection}
                    onHighlightContextMenu={onHighlightContextMenu}
                    pendingSelection={pendingSelection}
                    flashRange={
                      flashRange && flashRange.messageId === msg.id ? flashRange : null
                    }
                  />
                </div>
              );
            })}

            <div ref={bottomRef} />
          </div>
        </div>
      </div>

      {/* "Scroll to bottom" button — only shown when the user has scrolled up
          away from the latest message. Lets them jump back in one click. */}
      {!isPinnedToBottom && (
        <button
          onClick={scrollToBottom}
          title={S.scrollToLatest}
          className="absolute left-1/2 -translate-x-1/2 bottom-32 z-10 w-9 h-9 flex items-center justify-center rounded-full bg-white border border-gray-200 text-gray-600 shadow-md hover:text-gray-900 hover:bg-gray-50 transition-colors"
        >
          <ChevronDown size={18} strokeWidth={2} />
        </button>
      )}

      {/* Fragen-Stepper — schwebt rechts über dem Composer, sobald die Liste
          überläuft (Grill-Entscheidung 3); unter 2 Fragen gäbe es nichts zu
          steppen. Gleiche Höhe wie der "Scroll to latest"-Knopf. */}
      {listOverflows && questions.length >= 2 && (
        <div className="absolute right-4 bottom-32 z-10">
          <QuestionStepper
            activeIndex={activeQuestion}
            total={questions.length}
            onJumpTo={jumpToQuestion}
          />
        </div>
      )}

      {/* Input area — full width. Nimmt Drag-and-drop von Dateien entgegen
          (gleiche Typen wie der Datei-Picker); das Overlay zeigt die Drop-Zone. */}
      <div
        className="bg-white pb-6 pt-3 relative"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        data-testid="chat-input-dropzone"
      >
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
                    {composerQuote.text}
                  </p>
                  <p className="mt-0.5 flex items-center gap-1 text-[11px] font-medium text-gray-400">
                    <MessageSquareQuote size={11} className="shrink-0" />
                    <span className="truncate">{S.quoteFrom(composerQuote.sourceLabel)}</span>
                  </p>
                </div>
                <button
                  onClick={onClearComposerQuote}
                  title={S.removeQuote}
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

            <div className={`flex items-center gap-2 bg-white border border-gray-300 rounded-full pl-2 pr-3 py-2 shadow-sm transition-all ${
              isListening
                ? 'border-red-300 ring-2 ring-red-100'
                : 'focus-within:border-gray-400'
            }`}>
              {/* Hidden File-Input — wird vom Plus-Button getriggert */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={handleFilesSelected}
                className="hidden"
                accept="image/*,text/*,.pdf,.md,.txt,.csv,.json"
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
                  title={S.attach}
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
              </div>

              {/* Der native Textarea-Platzhalter kann in schmalen Spalten
                  weder umbrechen (sah abgeschnitten aus) noch mit Ellipse
                  kürzen (Chromium ignoriert text-overflow auf Textarea-
                  Platzhaltern). Darum bleibt das placeholder-Attribut nur
                  für Screenreader/Tests, unsichtbar — sichtbar ist das
                  Overlay-Span, das sauber mit „…" kürzt. */}
              <div className="relative flex-1 min-w-0 flex">
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyDown}
                  onKeyUp={handleKeyUp}
                  placeholder={isListening || isTranscribing ? '' : composerQuote ? S.placeholderAskQuote : S.placeholderAsk}
                  rows={1}
                  disabled={isBusy}
                  readOnly={isListening || isTranscribing}
                  className="min-h-[44px] w-full min-w-0 bg-transparent px-2 py-[10px] text-[16px] text-gray-900 outline-none resize-none leading-[1.5] disabled:opacity-50 placeholder:text-transparent placeholder:whitespace-nowrap placeholder:overflow-hidden"
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

              {/* In sehr schmalen Spalten (Branch-Chat neben dem PDF) hat das
                  Mockup keinen Mikro-Knopf — ausblenden, damit der Platzhalter
                  und die Eingabe genug Breite behalten. */}
              {supported && (
                <button
                  onClick={handleToggleListening}
                  title={isTranscribing ? S.transcribing : isListening ? S.stopRecording : S.startRecording}
                  aria-pressed={isListening}
                  disabled={isTranscribing}
                  className={`shrink-0 w-9 h-9 @max-[24rem]:hidden flex items-center justify-center rounded-full transition-colors ${
                    isListening
                      ? 'text-white bg-blue-500 hover:bg-blue-600'
                      : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
                  }`}
                  data-testid="mic-button"
                >
                  {isTranscribing
                    ? <Loader2 size={20} strokeWidth={1.9} className="animate-spin" />
                    : isListening
                      ? <MicOff size={20} strokeWidth={1.9} />
                      : <Mic size={20} strokeWidth={1.9} />}
                </button>
              )}

              {modelPicker}

              {(sending || streaming) && onStopStreaming && !input.trim() && attachments.length === 0 ? (
                // Bewusst dieselben Klassen wie der Senden-Knopf (bg-blue-600
                // rounded-full): nur so greifen die Theme-Overrides in
                // index.css (Question-Block, Sticker-Schatten, Phosphor-Glow)
                // auch für den Stop-Zustand — ein hartes Rot fiele aus jedem
                // Theme heraus (Nutzerkorrektur 2026-07-22).
                <button
                  onClick={onStopStreaming}
                  title={S.stopResponse}
                  aria-label={S.stopResponse}
                  data-testid="stop-button"
                  className="shrink-0 w-9 h-9 flex items-center justify-center rounded-full bg-blue-600 text-white transition-all hover:bg-blue-700"
                >
                  <Square size={13} fill="currentColor" strokeWidth={0} />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={isBusy || isListening || isTranscribing || (!input.trim() && attachments.length === 0)}
                  title={S.send}
                  className="shrink-0 w-9 h-9 flex items-center justify-center rounded-full bg-blue-600 text-white transition-all hover:bg-blue-700 disabled:opacity-30 disabled:cursor-not-allowed"
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
