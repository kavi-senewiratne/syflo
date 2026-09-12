/**
 * components/ChatArea/MessageBubble.tsx
 *
 * Renders a single message in the conversation.
 *
 * User messages: right-aligned subtle bubble.
 * Assistant messages: left-aligned plain text on the white chat background.
 *
 * Branch words: words used to create child chats are rendered as blue
 * underlined hyperlinks inside assistant messages. Clicking navigates
 * to that child chat.
 */

import { Children, isValidElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { AlertCircle, ArrowLeftRight, ArrowRight, Brain, Check, ChevronDown, ChevronRight, Clock, Cloud, CornerUpLeft, Cpu, ExternalLink, Info, Key, KeyRound, Loader2, RotateCcw, Search, SlidersHorizontal, Square, WifiOff, X, Zap } from 'lucide-react';
import { ThinkingIndicator } from './ThinkingIndicator';
import { CARD_ACTION_BTN, CARD_ACTION_BTN_DISABLEABLE, CARD_ACTION_LINK } from './cardActionButton';
import {
  clearFlashChatRange,
  clearMessageHighlights,
  clearPendingChatSelection,
  highlightAtPoint,
  paintFlashChatRange,
  paintMessageHighlights,
  paintPendingChatSelection,
  rangeFromOffsets,
  textOffsetInRoot,
} from '../../chat/highlightAnchors';
import { markedOccurrenceIndex } from '../../chat/markedOccurrence';
import { splitLeadingQuote } from '../../chat/messageQuote';
import { rangeToCleanText } from '../../chat/selectionText';
import { snapLiveSelectionToWords } from '../../selection/wordSnap';
import { sanitizeMath } from '../../markdown/sanitizeMath';
import { protectTablePipes } from '../../markdown/protectTablePipes';
import { insertBranchLinks, type BranchWord } from '../../markdown/branchLinks';
import { insertTimeLinks, lastTimeMark, youtubeTimeUrl } from '../../markdown/timeLinks';
import { markWideFormulas } from '../../markdown/wideMath';
import { MathText, plainMathText } from '../MathText';
import { useStrings } from '../../strings';
import { gfmTableComponents } from './markdownTables';
import { CodeBlock } from './CodeBlock';
import { FAILED_MARKER, INTERRUPTED_MARKER } from '../../types';
import type { ChatSelection, FreeProviderOffer, HighlightColor, LLMProvider, Message, MessageHighlight } from '../../types';

// ReactMarkdown's defaultUrlTransform strips URLs with unknown schemes (anything
// besides http, https, mailto, tel) for safety. Our internal schemes would be
// wiped out, so we let those through and defer to the default behaviour for
// everything else.
//
// Both are internal and never reach the network as-is: `branch:<chatId>` is
// handled by a click handler, `t:<seconds>` is rebuilt into a real
// https://youtube.com URL by the `a()` renderer. Anything added here has to
// keep that property — this function is the only thing standing between model
// output and an href.
//
// The `t:` case cost an hour on 2026-08-15: regex, prop and renderer were all
// correct, but the scheme was silently dropped HERE, so `a()` never saw an
// `href` to act on. When an internal link "does nothing", look at this line
// first.
const INTERNAL_SCHEMES = ['branch:', 't:'];
const urlTransform = (url: string) =>
  INTERNAL_SCHEMES.some((s) => url.startsWith(s)) ? url : defaultUrlTransform(url);

interface Props {
  message: Message;
  isStreaming?: boolean;
  onWordRightClick: (word: string, context: string, x: number, y: number) => void;
  branchWords?: BranchWord[];
  onBranchClick?: (chatId: string) => void;
  // YouTube-Kennung des Baum-Videos. Gesetzt heißt: Zeitmarken in dieser
  // Nachricht werden zu Links auf genau diese Sekunde (markdown/timeLinks.ts).
  // Ohne Video bleibt „[3:15]" gewöhnlicher Text.
  videoYoutubeId?: string;
  // Mit eingebettetem Player in der Mittelspalte liegt das Ziel einer
  // Zeitmarke IM Fenster: ein normaler Klick springt dort hin, statt YouTube
  // zu öffnen (mockup-youtube-embed-layout.html §03). Ohne Handler — Video
  // nicht einbettbar oder Player zu — bleibt die Marke der Link von vorher.
  onTimeMarkClick?: (seconds: number) => void;
  // Persistent chat-text highlights of the whole chat; this bubble paints the
  // ones anchored to its own message (mockup-chat-highlights-ask-in-chat.html).
  highlights?: MessageHighlight[];
  // Right-click with a live text selection inside this bubble. The selection
  // carries character offsets into the bubble's rendered plain text.
  onChatSelection?: (sel: ChatSelection, context: string, x: number, y: number) => void;
  // Right-click on an existing highlight (without a live selection) — opens
  // the recolor/delete menu, same gesture as clicking a PDF highlight.
  // Left-clicking a highlight opens the same menu (parity with the PDF).
  onHighlightContextMenu?: (highlight: MessageHighlight, x: number, y: number) => void;
  // Die beim Rechtsklick erfasste Auswahl, solange das Popup offen ist —
  // wird als Pending-Overlay weitergemalt, weil die native Selektion beim
  // Klick ins Popup kollabiert. Nur die besitzende Nachricht malt.
  pendingSelection?: ChatSelection | null;
  // Beim Warten auf das erste Token rotiert unter den Lade-Punkten die
  // Tipp-/Zitat-Zeile — unabhängig vom Thinking-Modus, denn auch die
  // Prompt-Verarbeitung großer Paper dauert spürbar (Nutzerentscheid
  // 2026-07-21; mockup-model-picker.html, Sektion 04).
  showThinkingTips?: boolean;
  // Sprung-Flash aus dem Highlights-Drawer: blinkt die Markierung selbst an
  // (nicht die Bubble), in ihrer Highlight-Farbe (wie beim PDF). ChatArea
  // taktet das Blinken, hier wird nur gemalt.
  flashRange?: { startOffset: number; endOffset: number; color: HighlightColor } | null;
  // Retry-Button der '*Failed*'-Fehlerzeile: erzeugt die Antwort neu, ohne
  // dass der Nutzer die Frage erneut tippen/diktieren muss. Ohne Handler
  // wird nur die Fehlerzeile ohne Button gezeigt (z. B. ParentContextPane).
  onRetryMessage?: (message: Message) => void;
  // Continue a cut-off answer in place (mockup-truncated-answer §01) —
  // distinct from onRetryMessage, which throws the text away and starts over.
  onContinueMessage?: (message: Message) => void;
  // Registry display labels per model name (name → label) for the failover
  // note. Optional; unknown or missing names render raw.
  modelLabels?: Record<string, string>;
  // Emergency path when ALL cloud quotas are exhausted (ADR-0008): retry
  // THIS answer via the local model. Only offered when a local model is
  // installed and the marker carries the transient quotaExhausted flag.
  onRetryLocalModel?: (message: Message) => void;
  hasLocalModel?: boolean;
  // Quota card v3 (mockup-quota-states): billing page of the ACTIVE
  // provider — the "Limit erhöhen" button links here (daily/too_large).
  billingUrl?: string | null;
  // Billing pages per provider (§08): after a cross-provider failover the
  // limit may belong to a different provider than the active one — the
  // "Raise limit" link follows the message's failProvider when known.
  billingUrls?: Record<string, string | null | undefined>;
  // Opens the composer's model picker — the too_large card offers it
  // because a bigger-budget model often fits the same question. The card
  // hands over ITS message: a pick that actually changes the model retries
  // that answer immediately (auto-retry, user decision 2026-07-29).
  onOpenModelPicker?: (message: Message) => void;
  // Last settings change (ISO): model switch, provider switch or key save
  // (settingsChangedAt generalizes modelSwitchedAt, mockup-model-flow §05).
  // Quota AND failReason cards older than this re-offer an ENABLED retry —
  // the new configuration may succeed where the old one failed.
  settingsChangedAt?: string | null;
  // Opens Settings · Models — the exit of the no_key/bad_key/local_missing
  // cards (mockup-model-flow §05/§11).
  onOpenSettings?: () => void;
  // Registry display labels per provider id (id → label) for the failReason
  // cards. Unknown or missing ids render raw.
  providerLabels?: Record<string, string>;
  // Name of the configured local model — the no_vision card's tooltip names
  // it ("qwen3.5:9b versteht Bilder.").
  localModelName?: string;
  // Privacy guard (§11): the local_missing card offers ONE explicit, named
  // cloud exit — only when a keyed cloud provider exists. The handler
  // switches to that provider+model and retries this answer.
  cloudFallback?: { providerLabel: string; modelLabel: string } | null;
  onRetryCloudModel?: (message: Message) => void;
  // W4 billing card (cost tiers 2026-07-30): the primary exit answers with
  // the first FREE model — switching + auto-retry in one click.
  freeFallback?: { providerLabel: string; modelLabel: string } | null;
  onRetryFreeModel?: (message: Message) => void;
  // G2 (mockup-onboarding-flow §07, chosen 2026-08-15): the OTHER free
  // provider, offered on the daily-limit card because that is where its
  // allowance stops being advertising and becomes a way out. Absent means the
  // card looks exactly as it did before — every free provider already has a
  // key, or the failure was not a daily limit.
  freeProviderOffer?: FreeProviderOffer;
  onAddFreeProvider?: (provider: LLMProvider) => void;
  // Queue transparency (mockup-model-flow §07): when the queued event names
  // the chat being answered RIGHT NOW and it is a different chat, the
  // waiting text becomes a link that jumps there.
  onOpenChat?: (chatId: string) => void;
  // Click on the quote of an "Ask in chat" question
  // (mockup-quote-jump-to-source.html, variant A): jump back to the passage
  // it was taken from. Only offered when the message carries an anchor.
  onQuoteClick?: (message: Message) => void;
  // W2 (§06): the reader hands over a Tavily key from the card under an answer
  // the model could not look up. The bubble binds its own message, so the
  // caller knows WHICH answer to ask again — it owns the chat, the card owns
  // only the key.
  onSaveSearchKey?: (key: string, message: Message) => Promise<void> | void;
  searchKeyStored?: boolean;
  // The active chat has a running or queued stream. The save-&-retry receipt
  // of the search-wish card reads it as "the re-asked answer is still being
  // written" — spinner on step 2 while true, settled line once false.
  chatStreaming?: boolean;
}

// "Thought for 1m 42s" / "Thought for 34s".
function formatThoughtDuration(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Modelle schreiben LaTeX teils als \(...\)/\[...\] — remark-math versteht
// nur die Dollar-Syntax. Vor dem Rendern beide Varianten normalisieren.
// Außerdem: Inline-Formeln mit Display-Absicht (\displaystyle, Umgebungen wie
// matrix/aligned) auf eine eigene Display-Zeile befördern — inline gequetscht
// kollidieren die hohen Konstrukte mit den Nachbarzeilen (Report 2026-07-22).
const DISPLAY_INTENT = /\\displaystyle|\\begin\{/;
// Code-Span-Heuristiken fürs Formel-Auspacken (Reports 2026-07-24):
// `$PATH$` (Env-Var-Stil, reine GROSSBUCHSTABEN) bleibt Code, ebenso
// Regex-Escapes wie `\d+`. Echte Formeln erkennt man an Dollar-/\(...\)-
// Trennern oder an einem bekannten LaTeX-Kommando im Span.
const ENV_VAR_STYLE = /^[A-Z_][A-Z0-9_]*$/;
const LATEX_COMMAND = new RegExp(
  '\\\\(?:' +
    [
      'approx', 'hat', 'frac', 'sqrt', 'sum', 'prod', 'int', 'cdot', 'times', 'pm', 'infty',
      'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta',
      'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'rho', 'sigma', 'tau', 'phi', 'varphi',
      'chi', 'psi', 'omega', 'Delta', 'Gamma', 'Theta', 'Lambda', 'Sigma', 'Phi', 'Psi', 'Omega',
      'leq', 'geq', 'neq', 'sim', 'propto', 'nabla', 'partial', 'mid', 'to',
      'mathcal', 'mathbb', 'mathbf', 'mathrm', 'operatorname', 'text',
      'vec', 'bar', 'dot', 'ddot', 'tilde', 'displaystyle', 'begin', 'left', 'right',
      'rightarrow', 'leftarrow', 'Rightarrow', 'binom', 'log', 'ln', 'exp',
      'sin', 'cos', 'tan', 'min', 'max', 'arg',
    ].join('|') +
    // kein \b: dahinter dürfen _{(^ etc. folgen (\sum_{i=1} — "_" ist ein
    // Wortzeichen, \b würde scheitern); nur weitere Buchstaben schließen aus,
    // damit \tanh nicht fälschlich als \tan zählt.
    ')(?![a-zA-Z])',
);
export function normalizeMathDelimiters(content: string): string {
  return (
    content
      // Kleine Modelle verpacken Formeln zusätzlich in Backticks
      // (`$\hat{P}(...)$`, `$n-1$`) — in Code-Spans rendert KaTeX bewusst
      // nicht. Auspacken, außer der Inhalt ist eine Env-Var wie `$PATH$`.
      // Bewusst OHNE \s* zwischen Backtick und $: sonst könnte die Regel
      // über "…`code` $x$ `mehr`…" hinweg zwei fremde Spans verschmelzen.
      .replace(/`(\$\$?)([^`$][^`]*?)\1`/g, (m, dollars, expr) =>
        ENV_VAR_STYLE.test(expr.trim()) ? m : `${dollars}${expr}${dollars}`,
      )
      // Unbalancierte Reste (Report 2026-07-24, Runde 3): `$\hat{P}(...)``
      // oder ``$O(n^2)$`` — schiefe Backtick-Zahl und/oder fehlendes
      // Schluss-$. Math-Signale: bekanntes Kommando, Hoch-/Tiefstellung,
      // oder ein sauberes Schluss-$. `$PATH``/`${var}` bleiben Code.
      .replace(/`{1,2}\$([^`$][^`]*?)(\$?)`{1,2}/g, (m, expr, closing) => {
        const t = expr.trim();
        if (ENV_VAR_STYLE.test(t) || t.startsWith('{')) return m;
        if (LATEX_COMMAND.test(t) || /[\^_]/.test(t) || closing === '$') return `$${t}$`;
        return m;
      })
      // `\(...\)` / `\[...\]` in Backticks: die Trenner sind eindeutig LaTeX.
      // [^`] statt [\s\S], damit die Regel nie über Span-Grenzen hinweg
      // zwei verschiedene Code-Spans zu einer Formel verschmilzt.
      .replace(/`(\\\([^`]+?\\\)|\\\[[^`]+?\\\])`/g, '$1')
      // Nacktes LaTeX in Backticks (`\hat{P}(...)`, `\approx`) → $...$ —
      // aber nur bei bekanntem Kommando; `\d+` & Co. bleiben Code.
      .replace(/`([^`\n$]+)`/g, (m, expr) =>
        LATEX_COMMAND.test(expr) ? `$${expr.trim()}$` : m,
      )
      // Verwaiste einzelne Backticks direkt an sonst intakter $-Mathe
      // (`$w_t$… bzw. …$w_t$`). Lookaround verhindert, dass ein kompletter
      // Code-Span `$PATH$` angefasst wird (dort steht auf beiden Seiten
      // ein Backtick).
      .replace(/`(\$\$?)([^`$\n]+)\1(?!`)/g, '$1$2$1')
      .replace(/(?<!`)(\$\$?)([^`$\n]+)\1`/g, '$1$2$1')
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, expr) => `\n$$\n${expr}\n$$\n`)
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, expr) => `$${expr}$`)
      // Lookarounds keep this from matching INSIDE `$$…$$`: on
      // `$$x = \begin{pmatrix}…$$` the inner `$x = …$` would otherwise be
      // rewritten, leaving two stray `$` that swallow the following prose
      // into a katex-error span (screenshot case 2026-07-25, Bengio answer).
      .replace(/(?<!\$)\$([^$\n]+)\$(?!\$)/g, (m, expr) =>
        DISPLAY_INTENT.test(expr) ? `\n$$\n${expr}\n$$\n` : m,
      )
  );
}

export function MessageBubble({
  message,
  isStreaming,
  onWordRightClick,
  branchWords,
  videoYoutubeId,
  onTimeMarkClick,
  onBranchClick,
  highlights,
  onChatSelection,
  onHighlightContextMenu,
  pendingSelection,
  showThinkingTips,
  flashRange,
  onRetryMessage,
  onContinueMessage,
  modelLabels,
  onRetryLocalModel,
  hasLocalModel,
  billingUrl,
  billingUrls,
  onOpenModelPicker,
  settingsChangedAt,
  onOpenSettings,
  providerLabels,
  localModelName,
  cloudFallback,
  onRetryCloudModel,
  freeFallback,
  onRetryFreeModel,
  onOpenChat,
  onQuoteClick,
  freeProviderOffer,
  onAddFreeProvider,
  onSaveSearchKey,
  searchKeyStored,
  chatStreaming,
}: Props) {
  // UI-Texte in der App language — re-rendert beim Sprachwechsel mit.
  const STR = useStrings();
  const S = STR.messageBubble;
  // Provider labels for the failover note; unknown providers keep raw names.
  const providerLabel = (id: string): string =>
    (STR.settings.model.providerLabels as Record<string, string>)[id] ?? id;
  // Registry display label of a model (label ?? raw name).
  const modelLabel = (name: string): string => modelLabels?.[name] ?? name;
  const isUser = message.role === 'user';
  const isInterrupted =
    message.role === 'assistant' && message.content.trim() === INTERRUPTED_MARKER;
  const isFailed =
    message.role === 'assistant' && message.content.trim() === FAILED_MARKER;
  // Der Job dieser Antwort wartet noch in der Backend-Warteschlange
  // (Ollama hat einen Slot; Fragen laufen FIFO über alle Chats).
  const isQueued = message.queuedAhead !== undefined && !message.content;

  // Root around the rendered message text — the coordinate system for
  // highlight offsets. Excludes streaming indicator and sources list.
  const contentRef = useRef<HTMLDivElement>(null);

  // ─── Keyboard anchors for this message's highlights ──────────────────────
  // Chat highlights are painted through the CSS Custom Highlight API and have
  // no DOM element of their own — nothing readScreen could list, so ↓ walked
  // straight past them (user report 2026-09-12; the PDF's highlights ARE
  // items, ADR-0011 decision 7). Each highlight gets one invisible, absolutely
  // positioned anchor over its bounding box: the ring machinery reads it like
  // any other item, and Enter's synthetic click falls through to the text
  // underneath (pointer-events: none keeps it out of real mouse work).
  // data-focus-axis="sequence" sits on the anchor itself so two marks on one
  // text line never form a ← → row — they are places in a text, not controls
  // (the same call the PDF made, 2026-08-11).
  const [hlAnchors, setHlAnchors] = useState<
    Array<{ id: string; top: number; left: number; width: number; height: number }>
  >([]);
  const hlAnchorsKey = useRef('');
  const measureHlAnchors = () => {
    const root = contentRef.current;
    if (!root) return;
    const mine = (highlights ?? []).filter((h) => h.messageId === message.id);
    const rootRect = root.getBoundingClientRect();
    const next: typeof hlAnchors = [];
    for (const h of mine) {
      const range = rangeFromOffsets(root, h.startOffset, h.endOffset);
      // jsdom's Range has no getBoundingClientRect at all — no geometry, no
      // anchors there (the tests that care stub it, like the row tests do).
      if (!range || typeof range.getBoundingClientRect !== 'function') continue;
      const r = range.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      next.push({
        id: h.id,
        top: r.top - rootRect.top,
        left: r.left - rootRect.left,
        width: r.width,
        height: r.height,
      });
    }
    const key = next
      .map((a) => `${a.id}:${Math.round(a.top)},${Math.round(a.left)},${Math.round(a.width)},${Math.round(a.height)}`)
      .join('|');
    if (key !== hlAnchorsKey.current) {
      hlAnchorsKey.current = key;
      setHlAnchors(next);
    }
  };
  // The ResizeObserver below mounts once ([] deps) — hand it the CURRENT
  // measure closure, not the first render's (whose `highlights` was empty).
  const measureHlAnchorsRef = useRef(measureHlAnchors);
  measureHlAnchorsRef.current = measureHlAnchors;
  const hlAnchorEls = hlAnchors.map((a) => (
    <span
      key={a.id}
      data-focus-item={a.id}
      data-focus-click=""
      data-focus-axis="sequence"
      aria-hidden="true"
      style={{
        position: 'absolute',
        top: a.top,
        left: a.left,
        width: a.width,
        height: a.height,
        pointerEvents: 'none',
      }}
    />
  ));

  // Thinking-Panel: null = Automatik (offen, solange die Gedankenkette
  // streamt und noch keine Antwort da ist; zu, sobald die Antwort beginnt).
  // Ein Klick des Nutzers überstimmt die Automatik dauerhaft.
  const [thinkingOpenChoice, setThinkingOpenChoice] = useState<boolean | null>(null);
  const reasoningStreaming = Boolean(isStreaming && message.reasoning && !message.content);
  const thinkingOpen = thinkingOpenChoice ?? reasoningStreaming;

  // Quota card (mockup-quota-states §04/§05): the retry button is only ever
  // active when clicking it can work. retryAt (transient, from the SSE
  // error) is the earliest cooldown expiry; while it runs, this ticks once
  // per second so the disabled button counts down and re-enables itself.
  const retryAtMs = message.quotaExhausted && message.retryAt ? new Date(message.retryAt).getTime() : null;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (retryAtMs === null || retryAtMs <= Date.now()) return;
    const t = setInterval(() => {
      setNowMs(Date.now());
      if (Date.now() >= retryAtMs) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [retryAtMs]);
  const retryInSeconds = retryAtMs === null ? 0 : Math.max(0, Math.ceil((retryAtMs - nowMs) / 1000));
  // Beyond ~5 minutes (the daily-limit case) a countdown button is absurd —
  // the card drops retry entirely and shows the reset-time line instead.
  const LONG_COOLDOWN_SECONDS = 5 * 60;
  const isLongCooldown = retryInSeconds > LONG_COOLDOWN_SECONDS;
  const retryAtTimeLabel = retryAtMs === null
    ? ''
    : new Date(retryAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // The user changed settings AFTER this card appeared (model/provider
  // switch or key save): the new configuration may succeed where the old
  // one failed — re-offer an enabled retry (ISO strings compare
  // lexicographically in time order). Applies to quota AND failReason cards.
  const changedSinceFail = Boolean(
    settingsChangedAt && settingsChangedAt > message.created_at,
  );
  const switchedSinceFail = Boolean(message.quotaExhausted && changedSinceFail);

  // (Re)paint this message's highlights after EVERY commit — deliberately no
  // dependency array. Re-renders can rebuild the markdown DOM without
  // message.content changing (e.g. branchWords arriving after the tree loads
  // → insertBranchLinks rewrites the rendered tree); the previously painted
  // ranges then hang on detached text nodes and silently collapse. Painting
  // is idempotent and cheap (one TreeWalker over this bubble). Skipped while
  // streaming — the text nodes churn on every delta; the final paint happens
  // once the stream settles.
  useLayoutEffect(() => {
    if (isStreaming) return;
    const root = contentRef.current;
    if (!root) return;
    // VOR dem Malen: eine zu breite Inline-Formel wird hier zum Block (§03).
    // Das verschiebt ihre Grundlinie, und genau die messen die Markierungs-
    // Unterstriche unten aus — in dieser Reihenfolge messen sie das Endergebnis.
    markWideFormulas(root);
    if (highlights) paintMessageHighlights(message.id, root, highlights);
    // Pending-Selektion des offenen Popups: der Besitzer malt sie bei jedem
    // Commit neu, alle anderen räumen nur ihre frühere Besitzerschaft auf.
    paintPendingChatSelection(
      message.id,
      root,
      pendingSelection?.messageId === message.id ? pendingSelection : null,
    );
    // Nach den Farb-Stilen malen, damit der Flash sie sicher überdeckt.
    paintFlashChatRange(message.id, root, flashRange ?? null);
    // Ordinal der markierten Stelle nachmessen (§04, Variante A). Läuft im
    // selben Effekt, weil es dieselbe Bedingung braucht: fertig gestreamter
    // Text und ein DOM, der zum Inhalt passt.
    if (branchWords && branchWords.length > 0 && highlights) {
      let next: Record<string, number | 'none'> | null = null;
      for (const w of branchWords) {
        const mark = highlights.find(
          (h) => h.childChatId === w.chatId && h.messageId === message.id,
        );
        if (!mark) continue;
        const found = markedOccurrenceIndex(root, w.word, mark.startOffset);
        const value: number | 'none' = found ?? 'none';
        if (markOrdinals[w.chatId] === value) continue;
        (next ??= { ...markOrdinals })[w.chatId] = value;
      }
      if (next) setMarkOrdinals(next);
    }
    // After the paints: the keyboard anchors mirror the same offsets against
    // the same, current DOM. Guarded by a geometry key, so this settles after
    // one extra commit instead of looping.
    measureHlAnchors();
  });
  useEffect(() => () => {
    clearMessageHighlights(message.id);
    clearPendingChatSelection(message.id);
    clearFlashChatRange(message.id);
  }, [message.id]);

  // Spaltenbreite geändert (Trennlinie gezogen, Fenster verkleinert, Drawer
  // auf) → Formeln neu messen. Ohne das bliebe die Entscheidung aus §03 auf der
  // Breite von damals stehen: eine Formel, die in der breiten Spalte passte,
  // liefe in der schmalen wieder heraus. Kein Commit begleitet einen Ziehvorgang,
  // also kann der Effekt oben das nicht mitbekommen.
  useLayoutEffect(() => {
    const root = contentRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    let lastWidth = -1;
    const observer = new ResizeObserver(() => {
      // Nur die Breite zählt. Das Umschalten selbst ändert die HÖHE der Blase,
      // was den Observer erneut auslösen würde — die Wächter-Zeile beendet die
      // Kette nach einem Durchlauf.
      const width = root.clientWidth;
      if (width === lastWidth) return;
      lastWidth = width;
      markWideFormulas(root);
      // A narrower column reflows the text, and every highlight sits somewhere
      // new — the keyboard anchors have to move with them.
      measureHlAnchorsRef.current();
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // ─── Zweig aus einer markierten Stelle: nur DIESE Stelle verlinken ────────
  // (Nutzerentscheid 2026-08-13, design/mockup-simply-blue-fixes.html §04,
  // Variante A). Vorher wurde jedes Vorkommen der Elternwörter zum Link — eine
  // Antwort, die „Leaky Abstraction" dreimal schreibt, zeigte eine
  // gelb-und-blaue Stelle und zwei blaue, ohne dass etwas den Unterschied
  // erklärte (Nutzer-Report 2026-08-13).
  //
  // Markierung und Link leben in verschiedenen Koordinaten (gerenderter Text
  // vs. rohes Markdown), also treffen sie sich auf einem Ordinal: „der n-te
  // Treffer". Gemessen wird im DOM (chat/markedOccurrence.ts), gesetzt wird im
  // Markdown (branchLinks). Der gerenderte TEXT ändert sich dabei nicht — ein
  // Link trägt genau seinen Wortlaut —, also ist die Messung stabil und die
  // Schleife läuft nach einem zusätzlichen Rendern aus.
  //   undefined = noch nicht gemessen → nichts verlinken (ein Frame lang)
  //   'none'    = gemessen, kein Treffer (z. B. Formel-Passage) → wie bisher
  //               ALLE Vorkommen verlinken, statt den Sprung zu verlieren
  const [markOrdinals, setMarkOrdinals] = useState<Record<string, number | 'none'>>({});

  const effectiveBranchWords = useMemo(() => {
    if (!branchWords || branchWords.length === 0 || !highlights) return branchWords;
    return branchWords.map((w) => {
      const mark = highlights.find((h) => h.childChatId === w.chatId);
      // Kein Markierungs-Zweig (/branch, /btw, Rechtsklick auf ein Wort):
      // unveränderte Alle-Vorkommen-Regel.
      if (!mark) return w;
      // Die Markierung sitzt in einer ANDEREN Nachricht — dort gehört der
      // Sprung hin, hier bleibt der Text schlicht.
      if (mark.messageId !== message.id) return { ...w, occurrence: -1 };
      const ordinal = markOrdinals[w.chatId];
      if (ordinal === 'none') return w;
      return { ...w, occurrence: ordinal ?? -1 };
    });
  }, [branchWords, highlights, markOrdinals, message.id]);

  // Pre-process content: branch word links einbetten, LaTeX-Trenner
  // normalisieren. Muss VOR dem isUser-Early-Return stehen (Hook-Regeln).
  const branchLinked = effectiveBranchWords && effectiveBranchWords.length > 0 && message.content
    ? insertBranchLinks(message.content, effectiveBranchWords)
    : message.content;
  // Zeitmarken der Video overview anklickbar machen — nur in Bäumen mit
  // Video, sonst wäre ein „[3:15]" in einem PDF-Chat ein toter Link.
  // NACH insertBranchLinks: dessen Links sind dann schon geschrieben, und
  // die Zeit-Regex überspringt alles, was bereits `](` trägt.
  const linkedContent = videoYoutubeId && branchLinked
    ? insertTimeLinks(branchLinked)
    : branchLinked;
  // sanitizeMath läuft NACH normalizeMathDelimiters: erst Backtick-Mathe
  // auspacken und \(…\)-Paare wandeln, dann Reste (verwaiste Trenner,
  // Absatz-Verschlucker) reparieren. Während des Streamens auf dem
  // sichtbaren Präfix — offene End-Trenner bleiben dann unmaskiert.
  // protectTablePipes zuletzt: es braucht fertige $-Trenner, um die Pipes
  // INNERHALB einer Formel von den Zelltrennern der Tabelle zu unterscheiden.
  const processedContent = linkedContent
    ? protectTablePipes(sanitizeMath(normalizeMathDelimiters(linkedContent), { streaming: isStreaming }))
    : linkedContent;

  // onBranchClick über eine Ref in den memoizten Baum reichen — der Baum
  // wird nur bei Inhaltsänderung neu erzeugt, der Handler bleibt aktuell.
  const onBranchClickRef = useRef(onBranchClick);
  onBranchClickRef.current = onBranchClick;
  // Dieselbe Ref-Brücke für den Sprung in den eingebetteten Player: der
  // memoizte Baum sieht sonst den Handler vom ersten Rendern.
  const onTimeMarkClickRef = useRef(onTimeMarkClick);
  onTimeMarkClickRef.current = onTimeMarkClick;

  // Den gerenderten Markdown-Baum pro Inhalt memoizen (Nutzer-Report
  // 2026-07-22, 3. Runde): Ohne Memo re-parst ReactMarkdown bei JEDEM
  // Commit — auch fremden (Popup auf/zu, Drawer-Toggle, Hintergrund-Stream)
  // — und ersetzt dabei die Textknoten der Bubble. Jede live Textauswahl
  // des Nutzers starb dadurch beim nächsten Commit. Mit stabiler
  // Element-Referenz überspringt React den Teilbaum komplett: der DOM (und
  // damit die Selektion) bleibt stehen, bis sich der INHALT ändert.
  const markdownTree = useMemo(() => {
    if (isUser || !processedContent) return null;
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { errorColor: 'var(--color-gray-500, #6b7280)', strict: 'ignore' }]]}
        urlTransform={urlTransform}
        components={{
          ...gfmTableComponents,
          // Branch links: a blue clickable span, never a real <a> tag — and,
          // since 2026-08-12, never a real <button> either. A <button> is an
          // atomic inline-BLOCK with the UA's own `text-align: center`: a
          // branch word long enough to wrap came out centred inside its own
          // box, with the border-b drawn across the full box width — a blue
          // block sitting in the middle of the paragraph (user screenshot
          // 2026-08-12, "Textkorpora getestet: dem Brown-Korpus …", measured
          // in the DOM). role="button" on a span keeps the semantics and the
          // keyboard path while the text stays ordinary inline prose that
          // wraps, aligns and can be selected like its neighbours — the same
          // conclusion the clickable quote reached (see the quote block below).
          // KEIN eigener Unterstrich mehr (Nutzer-Report 2026-08-15, zweiter
          // zum selben Strich nach dem 2026-08-06).
          //
          // Am 06.08. war die Linie voll deckend und lief als harter zweiter
          // Strich unter dem Unterstrich der Markierung — im Mushroom-Theme in
          // der roten Akzentfarbe, wo sie wie ein Fehler aussah statt wie ein
          // Link. Der Versuch, sie auf 55 % zu dämpfen, hat das Problem nur
          // leiser gemacht, nicht gelöst: es waren immer noch ZWEI Striche für
          // EINE Aussage.
          //
          // Der zweite ist der überflüssige. Ein Zweig-Link im Fließtext sitzt
          // per Konstruktion in genau der Markierung, aus der der Zweig
          // entstanden ist, und `::highlight(syflo-chat-hl-linked)` zeichnet
          // dort bereits einen Unterstrich — in der Tinte der Markierung, also
          // in jedem Theme unauffällig. Übrig bleibt hier die Farbe, die den
          // Link als Link ausweist.
          a({ href, children }) {
            // Zeitmarke der Video overview → YouTube an genau dieser Sekunde
            // (Nutzerentscheid 2026-08-15, Variante A). Ein echtes <a>, kein
            // role="button"-Span wie beim Zweig-Link: das Ziel IST eine
            // externe Seite, und nur so gibt es Mittelklick, „in neuem Tab
            // öffnen" und die Vorschau in der Statuszeile geschenkt. Die
            // Inline-Block-Falle vom 2026-08-12 greift hier nicht — eine
            // Zeitmarke ist ein paar Zeichen lang und bricht nie um.
            //
            // Aussehen wie die Zeit-Chips im Transkript-Drawer, damit „das ist
            // eine Stelle im Video" an beiden Orten gleich aussieht. Farben
            // über blue-*, also pro Theme umgefärbt.
            if (href?.startsWith('t:') && videoYoutubeId) {
              const seconds = Number(href.slice(2));
              if (Number.isFinite(seconds)) {
                return (
                  <a
                    href={youtubeTimeUrl(videoYoutubeId, seconds)}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="video-time-link"
                    // Keyboard item (ADR-0011): ↓ walks the overview's time
                    // marks like any other element, Enter presses them (user
                    // request 2026-09-12). The id repeats when the same second
                    // is marked twice in one message — readScreen dedups, the
                    // ring unions the pieces, Enter seeks the same second
                    // either way.
                    data-focus-item={`time-${message.id}-${Math.floor(seconds)}`}
                    // Steht der Player in der Mittelspalte, gehört der
                    // einfache Klick ihm (mockup-youtube-embed-layout.html
                    // §03). Mittelklick, Cmd/Ctrl- und Shift-Klick bleiben
                    // dem Browser: das sind die Gesten für „woanders öffnen",
                    // und dafür ist das href noch da.
                    onClick={(e) => {
                      const jump = onTimeMarkClickRef.current;
                      if (!jump) return;
                      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                      e.preventDefault();
                      jump(seconds);
                    }}
                    title={S.openAtTime}
                    className="mx-px rounded-md bg-blue-50 px-1.5 py-px font-mono text-[0.85em] font-medium text-blue-700 no-underline transition-colors hover:bg-blue-100"
                  >
                    {children}
                  </a>
                );
              }
            }
            if (href?.startsWith('branch:')) {
              const chatId = href.replace('branch:', '');
              return (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={() => onBranchClickRef.current?.(chatId)}
                  onKeyDown={e => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    onBranchClickRef.current?.(chatId);
                  }}
                  className="text-blue-600 hover:text-blue-800 font-medium cursor-pointer"
                >
                  {children}
                </span>
              );
            }
            // Keep children as-is: String() turned element children
            // (e.g. rendered KaTeX inside a link) into "[object Object]".
            return <a href={href}>{children}</a>;
          },
          // Code-Blöcke laufen über den pre-Renderer (auch Fences OHNE
          // Sprache — die landeten früher fälschlich im Inline-Stil):
          // Sprache + Text aus dem inneren <code> ziehen und an den
          // gehighlighteten, theme-fähigen CodeBlock geben.
          pre({ children }) {
            const child = Children.toArray(children).find(isValidElement) as
              | ReactElement<{ className?: string; children?: unknown }>
              | undefined;
            const fenceLang = /language-([\w+-]+)/.exec(child?.props.className ?? '')?.[1];
            const code = String(child?.props.children ?? '').replace(/\n$/, '');
            return <CodeBlock code={code} fenceLang={fenceLang} />;
          },
          // Nur noch Inline-Code — Block-Code fängt pre() oben ab.
          code({ children, ...props }) {
            return (
              <code className="bg-gray-100 text-gray-800 px-1.5 py-0.5 rounded text-xs font-mono" {...props}>
                {children}
              </code>
            );
          },
          p({ children }) {
            return <p className="mb-3 last:mb-0">{children}</p>;
          },
          ul({ children }) {
            return (
              <ul className="list-disc list-outside pl-6 mb-3 space-y-1 marker:text-gray-400 [&_ul]:list-[circle] [&_ul_ul]:list-[square]">
                {children}
              </ul>
            );
          },
          ol({ children }) {
            return (
              <ol className="list-decimal list-outside pl-6 mb-3 space-y-1 marker:text-gray-400 [&_ol]:list-[lower-alpha] [&_ol_ol]:list-[lower-roman]">
                {children}
              </ol>
            );
          },
          li({ children }) {
            return (
              <li className="pl-1 leading-relaxed [&>ul]:mt-1 [&>ul]:mb-0 [&>ol]:mt-1 [&>ol]:mb-0">
                {children}
              </li>
            );
          },
          h1({ children }) { return <h1 className="text-lg font-bold mb-2 mt-4">{children}</h1>; },
          h2({ children }) { return <h2 className="text-base font-bold mb-2 mt-3">{children}</h2>; },
          h3({ children }) { return <h3 className="text-sm font-bold mb-1 mt-2">{children}</h3>; },
          blockquote({ children }) {
            return <blockquote className="border-l-4 border-gray-200 pl-4 text-gray-500 my-2">{children}</blockquote>;
          },
        }}
      >
        {processedContent}
      </ReactMarkdown>
    );
  }, [isUser, processedContent]);

  // Finishing a drag-selection opens the popup directly — no right-click
  // needed (user request 2026-07-31). Mirrors the old context-menu branch 1
  // below, just fired on mouseup instead of contextmenu.
  const handleMouseUp = (e: React.MouseEvent) => {
    if (!onChatSelection) return;
    const root = contentRef.current;
    if (!root) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const live = selection.getRangeAt(0);
    if (!root.contains(live.startContainer) || !root.contains(live.endContainer)) return;
    // Chrome hands back a range that starts/ends wherever the press point
    // rounded to — half a glyph in, and the first or last letter is gone
    // (repro 2026-08-06). Grow it to whole words first, and write it back so
    // the blue selection shows what the popup and the branch will carry.
    const range = snapLiveSelectionToWords() ?? live;
    const raw = range.toString();
    // Clean quote text: KaTeX formulas as their $…$ source instead of the
    // tripled DOM text (chat/selectionText.ts). The highlight anchor offsets
    // below stay based on the raw DOM text.
    const text = rangeToCleanText(range) || raw.trim();
    if (!text) return;
    // Shift the offsets past any selected leading/trailing whitespace so
    // they frame exactly the trimmed quote.
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    const start = textOffsetInRoot(root, range.startContainer, range.startOffset);
    const end = textOffsetInRoot(root, range.endContainer, range.endOffset);
    onChatSelection(
      {
        messageId: message.id,
        chatId: message.chat_id,
        text,
        startOffset: start + leading,
        endOffset: end - trailing,
      },
      message.content,
      e.clientX,
      e.clientY,
    );
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    const root = contentRef.current;
    if (root) {
      // No selection, but the click landed on an existing highlight →
      // recolor/delete menu.
      if (onHighlightContextMenu && highlights && highlights.length > 0) {
        const mine = highlights.filter((h) => h.messageId === message.id);
        const hit = highlightAtPoint(root, mine, e.clientX, e.clientY);
        if (hit) {
          e.preventDefault();
          onHighlightContextMenu(hit, e.clientX, e.clientY);
          return;
        }
      }
    }
    // Fallback: definition lookup for a single word at the click point —
    // assistant messages only (unchanged behavior; the mouseup handler above
    // covers drag-selections in bubbles wired for chat highlighting).
    if (isUser) return;
    e.preventDefault();
    // Same word snap as the mouseup path: a right-click over a selection whose
    // start rounded into a glyph must not define half a word.
    snapLiveSelectionToWords();
    const selection = window.getSelection()?.toString().trim();
    const word = selection || getWordAtPoint(e);
    if (word) {
      onWordRightClick(word, message.content, e.clientX, e.clientY);
    }
  };

  // Left-click on an existing highlight opens the recolor/delete menu — the
  // same gesture as clicking a colored highlight in the PDF. Clicks that are
  // part of a text selection or land on links/buttons pass through untouched.
  const handleClick = (e: React.MouseEvent) => {
    if (!onHighlightContextMenu || !highlights || highlights.length === 0) return;
    const root = contentRef.current;
    if (!root) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    // [role="button"] belongs in the list: branch links and clickable quotes
    // are spans with button semantics, not <button> elements.
    if ((e.target as HTMLElement).closest('a, button, [role="button"]')) return;
    const mine = highlights.filter((h) => h.messageId === message.id);
    // Enter's synthetic click targets the highlight's keyboard anchor — a real
    // mouse click never does (pointer-events: none). The anchor names its
    // highlight, so no point-to-offset guessing: a multi-line mark's bounding
    // box centre can sit between the marked lines, where highlightAtPoint
    // would come up empty.
    const anchorId = (e.target as HTMLElement).dataset?.focusItem;
    const direct = anchorId ? mine.find((h) => h.id === anchorId) : undefined;
    if (direct) {
      onHighlightContextMenu(direct, e.clientX, e.clientY);
      return;
    }
    const hit = highlightAtPoint(root, mine, e.clientX, e.clientY);
    if (hit) onHighlightContextMenu(hit, e.clientX, e.clientY);
  };

  // Ein Zitat ist nur dann ein Sprung, wenn die Nachricht einen Anker trägt
  // (mockup-quote-jump-to-source.html): Fragen ohne Zitat, Nachrichten von
  // vor dem Feature und PDF-Zitate ohne Farbwahl bleiben toter Text.
  const quoteIsClickable = Boolean(onQuoteClick && message.quote_highlight_id);

  const handleQuoteClick = (e: React.MouseEvent) => {
    // Ein Klick, der eine Textmarkierung beendet, ist keine Navigation — der
    // Nutzer wollte gerade zitieren, nicht springen.
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    // Der Klick gehört dem Zitat: die Bubble darunter würde sonst noch ihr
    // Highlight-Kontextmenü öffnen.
    e.stopPropagation();
    onQuoteClick?.(message);
  };

  const handleQuoteKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    onQuoteClick?.(message);
  };

  // User messages: gray bubble, right-aligned.
  if (isUser) {
    const attachments = message.attachments || [];
    const images = attachments.filter(a => a.mimetype.startsWith('image/'));
    const others = attachments.filter(a => !a.mimetype.startsWith('image/'));
    return (
      <div className="flex justify-end">
        {/* min(42rem, 100%): die feste Obergrenze war breiter als die Spalte,
            sobald der Chat neben PDF und Eltern-Kontext steht — die
            rechtsbündige Bubble wuchs dann nach LINKS aus dem Bild heraus
            (Nutzer-Screenshot 2026-08-09). min-w-0 lässt den Umbruch im
            Flex-Kind überhaupt erst greifen. */}
        <div
          className="flex min-w-0 flex-col items-end gap-2"
          style={{ maxWidth: 'min(42rem, 100%)' }}
        >
          {/* Bild-Vorschauen oberhalb der Bubble */}
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2 justify-end">
              {images.map(img => (
                <img
                  key={img.id}
                  src={img.url}
                  alt={img.filename}
                  className="rounded-2xl object-cover border border-gray-200"
                  style={{ maxHeight: '14rem', maxWidth: '20rem' }}
                  title={`${img.alias} — ${img.filename}`}
                />
              ))}
            </div>
          )}
          {/* Andere Datei-Anhänge als kleine Chips */}
          {others.length > 0 && (
            <div className="flex flex-wrap gap-1.5 justify-end">
              {others.map(att => (
                <a
                  key={att.id}
                  href={att.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 bg-gray-100 hover:bg-gray-200 transition-colors rounded-full px-3 py-1 text-xs text-gray-700"
                >
                  <span className="font-medium text-blue-600">{att.alias}</span>
                  <span className="text-gray-500 truncate max-w-[12rem]">{att.filename}</span>
                </a>
              ))}
            </div>
          )}
          {message.content && (() => {
            const { quote, rest } = splitLeadingQuote(message.content);
            return (
              <div
                onContextMenu={handleContextMenu}
                onMouseUp={handleMouseUp}
                onClick={handleClick}
                // max-w-full: ohne eine Breitengrenze AN DER BUBBLE selbst ist
                // sie shrink-to-fit auf max-content — dann gibt es keine Kante,
                // an der break-words greifen könnte, und ein einziges langes
                // Wort schiebt die rechtsbündige Bubble aus der Spalte heraus
                // (Nutzer-Screenshot 2026-08-09, schmale Chat-Spalte).
                className="max-w-full bg-gray-100 text-gray-900 select-text"
                style={{
                  borderRadius: '2rem',
                  padding: '0.75rem 1.125rem',
                  lineHeight: 1.65,
                  fontSize: '15px',
                }}
              >
                <div ref={contentRef} data-chat-content className="relative">
                  {hlAnchorEls}
                  {quote !== null && (
                    // currentColor + Opazität statt fester Grautöne: die
                    // Themes färben die User-Bubble beliebig um (Matrix dunkel,
                    // Mushroom rot, …) — absolute Grays wurden dort unlesbar
                    // (Nutzer-Report 2026-07-22). So bleibt das Zitat immer
                    // eine gedimmte Variante der Bubble-Textfarbe: lesbar auf
                    // jedem Grund, aber klar von der Frage unterscheidbar.
                    //
                    // Mit Anker wird derselbe Block zum Sprung zurück zur
                    // Quelle (mockup-quote-jump-to-source.html, Variante A):
                    // role="button" statt <button>, damit der Zitattext
                    // markierbar bleibt — "Ask in chat" auf einem Zitat muss
                    // weiter funktionieren.
                    <div
                      className={`mb-2 border-l-2 border-current pl-3 text-sm whitespace-pre-wrap break-words opacity-75${
                        quoteIsClickable ? ' syflo-quote-link' : ''
                      }`}
                      data-testid="user-message-quote"
                      {...(quoteIsClickable
                        ? {
                            role: 'button',
                            tabIndex: 0,
                            title: S.quoteJumpTitle,
                            onClick: handleQuoteClick,
                            onKeyDown: handleQuoteKeyDown,
                          }
                        : {})}
                    >
                      {/* MathText, not the markdown pipeline: user text is
                          plain by design, but "Ask in chat" quotes carry $…$
                          from KaTeX selections (audit 2026-07-28). */}
                      <MathText text={quote} />
                      {quoteIsClickable && (
                        <CornerUpLeft
                          className="syflo-quote-link-icon inline-block ml-1.5 align-[-2px]"
                          size={13}
                          aria-hidden
                        />
                      )}
                    </div>
                  )}
                  {/* break-words: eine getippte Zeichenkette ohne Leerzeichen
                      ("hellooooosdfsf…") ist sonst ein einziges Wort und
                      sprengt die Bubble. */}
                  <p className="whitespace-pre-wrap break-words"><MathText text={quote !== null ? rest : message.content} /></p>
                </div>
              </div>
            );
          })()}
        </div>
      </div>
    );
  }

  // Assistant messages: left-aligned on the white chat background.
  return (
    <div className="flex flex-col items-start">
      {/* Einklappbares Thinking-Panel: die live gestreamte Gedankenkette.
          Automatik: offen während der Denk-Phase, klappt beim ersten
          Antwort-Token zu — die Wartezeit fühlt sich so deutlich kürzer an. */}
      {message.reasoning && (
        <div className="mb-1 w-full" style={{ maxWidth: '46rem' }}>
          <button
            type="button"
            data-testid="thinking-toggle"
            aria-expanded={thinkingOpen}
            onClick={() => setThinkingOpenChoice(!thinkingOpen)}
            className="flex items-center gap-1.5 text-[12px] font-medium text-gray-400 hover:text-gray-600 transition-colors"
          >
            <Brain size={12} className="shrink-0" />
            {reasoningStreaming
              ? S.thinking
              : message.thoughtForSeconds !== undefined
                ? S.thoughtFor(formatThoughtDuration(message.thoughtForSeconds))
                : S.thoughts}
            {thinkingOpen
              ? <ChevronDown size={12} className="shrink-0" />
              : <ChevronRight size={12} className="shrink-0" />}
          </button>
          {thinkingOpen && (
            <div
              data-testid="thinking-panel"
              className="mt-1.5 border-l-2 border-gray-200 pl-3 text-[12.5px] leading-relaxed text-gray-500 whitespace-pre-wrap"
            >
              {/* Reasoning stays plain text (not markdown), but models write
                  $…$ math while thinking — render it (audit 2026-07-28). */}
              <MathText text={message.reasoning} />
            </div>
          )}
        </div>
      )}

      {/* "Thought for Xs" — eingeklappte Zeile über der Antwort, wenn das
          Modell nachgedacht hat, die Gedankenkette aber nicht (mehr) vorliegt
          (z. B. nach einem Reload der Nachricht). */}
      {message.thoughtForSeconds !== undefined && !isStreaming && !message.reasoning && (
        <div
          data-testid="thought-for-line"
          className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-gray-400"
        >
          <Clock size={12} className="shrink-0" />
          {S.thoughtFor(formatThoughtDuration(message.thoughtForSeconds))}
        </div>
      )}
      {/* Failover note (ADR-0008): another model stepped in for THIS answer
          because the active one hit a limit. from === to (sibling model of
          the same provider) is the common case and names the models; the
          cross-provider variant names the providers. Unlike the rate-limit
          countdown the note stays with the answer — it explains who it is
          from. */}
      {message.failover && (() => {
        // Reason-true copy (§11): no_vision and model_unavailable name their
        // real cause; the quota family (daily/rate_limit/too_large/cooldown)
        // keeps the established "Quota reached" wording. Naming rules are
        // shared: same provider → model labels, cross → provider labels + model.
        const f = message.failover;
        const sameProvider = f.from === f.to;
        const [samePair, crossPair] =
          f.reason === 'no_vision'
            ? [STR.chatArea.failoverNoVisionSameProvider, STR.chatArea.failoverNoVision]
            : f.reason === 'model_unavailable'
              ? [STR.chatArea.failoverUnavailableSameProvider, STR.chatArea.failoverUnavailable]
              : f.reason === 'stalled'
                ? [STR.chatArea.failoverStalledSameProvider, STR.chatArea.failoverStalled]
                : [STR.chatArea.failoverSameProvider, STR.chatArea.failover];
        return (
          <div
            data-testid="failover-note"
            className="mb-1 flex items-center gap-1.5 text-[12.5px] italic text-gray-400"
          >
            <ArrowLeftRight size={12} className="shrink-0" />
            {sameProvider
              ? samePair(modelLabel(f.fromModel), modelLabel(f.model))
              : crossPair(providerLabel(f.from), providerLabel(f.to), modelLabel(f.model))}
          </div>
        );
      })()}
      {/* Cloud provider rate limit (ADR-0008; mockup-quota-states §10,
          variant C, 2026-07-26): a quiet NON-italic meta row ABOVE the
          bubble — same position and voice as the failover note — naming
          which minute limit bit and on which model. The tips card below
          stays untouched; the row disappears with the next token. */}
      {/* Provider overloaded (503, mockup-truncated-answer §03): the same
          quiet meta row as the rate-limit line — the user is waiting either
          way, only the cause differs. Named separately because "rate limit"
          would blame the user's quota for the provider's busy servers. */}
      {message.overloaded && !isQueued && !isFailed && !message.content && (
        <div
          data-testid="overloaded-note"
          className="mb-1 flex items-center gap-1.5 text-[12.5px] text-gray-400"
        >
          <Clock size={12} className="shrink-0" />
          <OverloadCountdown
            seconds={message.overloaded.retryInSeconds}
            attempt={message.overloaded.attempt}
            maxAttempts={message.overloaded.maxAttempts}
            providerName={
              message.overloaded.provider
                ? providerLabels?.[message.overloaded.provider] ?? message.overloaded.provider
                : ''
            }
          />
        </div>
      )}
      {message.rateLimit && !isQueued && !isFailed && !message.content && (
        <div
          data-testid="rate-limit-note"
          className="mb-1 flex items-center gap-1.5 text-[12.5px] text-gray-400"
        >
          <Clock size={12} className="shrink-0" />
          <RateLimitCountdown
            seconds={message.rateLimit.retryInSeconds}
            scope={message.rateLimit.scope}
            modelName={message.rateLimit.model ? modelLabel(message.rateLimit.model) : undefined}
          />
        </div>
      )}
      <div
        onContextMenu={handleContextMenu}
        onMouseUp={handleMouseUp}
        onClick={handleClick}
        className="max-w-none py-1 text-sm leading-relaxed select-text cursor-text prose prose-sm"
        /* min(46rem, 100%) statt 46rem: 46rem ist das Lesemaß für breite
           Spalten, aber als ABSOLUTE Grenze ließ es die Blase über die Spalte
           hinauswachsen. Der Elternteil ist ein Column-Flex mit items-start,
           das Kind bemisst sich also an seinem Inhalt — eine Markdown-Tabelle
           wurde so 519 px breit in einer 253 px schmalen Spalte und schob die
           GANZE Nachrichtenliste seitwärts (horizontale Scrollleiste,
           Nutzerreport 2026-08-10). Tabellen, Code-Blöcke und Display-Formeln
           haben je einen eigenen overflow-x-auto-Container; der greift aber
           erst, wenn ein Vorfahre die Breite überhaupt begrenzt. */
        style={{ maxWidth: 'min(46rem, 100%)' }}
      >
        {isInterrupted ? (
          // Stop-Button: die angefangene Antwort wird verworfen; an ihrer
          // Stelle steht nur diese Markierung (Nutzerentscheid 2026-07-22).
          // Mit Retry (mockup-model-flow §09): derselbe verankerte Regenerate
          // wie bei der Fehlerzeile — das Backend akzeptiert *Interrupted*.
          <div
            data-testid="interrupted-note"
            className="flex flex-wrap items-center gap-2 text-[12.5px] text-gray-400"
          >
            <Square size={9} fill="currentColor" strokeWidth={0} className="shrink-0" />
            <span className="italic">{S.interrupted}</span>
            {onRetryMessage && (
              <button
                type="button"
                data-testid="interrupted-retry-button"
                onClick={() => onRetryMessage(message)}
                className={CARD_ACTION_BTN}
              >
                <RotateCcw size={11} className="shrink-0" />
                {S.retry}
              </button>
            )}
          </div>
        ) : isFailed ? (
          // Fehlgeschlagene Generierung ('*Failed*'-Marker, persistiert oder
          // lokal): dezente Fehlerzeile im Stil der Interrupted-Markierung —
          // Standard-Grautöne, damit alle Themes sie umfärben können — plus
          // Retry-Button, der die Antwort ohne Neu-Tippen neu erzeugt.
          message.quotaExhausted ? (
            // quotaExhausted (transient): the failover ran out of ALL
            // candidate models. Card per mockup-quota-states v3 — one line
            // per purpose, explanations in tooltips, actions per cause:
            // daily → upgrade link, no retry (cannot work today; unless no
            // local model exists — then retry stays as the only escape);
            // rate_limit → countdown retry + burst explainer;
            // too_large → switch model + upgrade link, never retry (the
            // identical oversized request fails deterministically).
            // No quotaReason (e.g. backend restart) → generic fallback.
            <div
              data-testid="failed-note"
              className="flex flex-col items-start gap-2 text-[12.5px] text-gray-400"
            >
              <div className="flex items-center gap-2">
                <AlertCircle size={13} className="shrink-0" />
                <span className="italic">
                  {message.quotaReason === 'daily'
                    ? STR.chatArea.quotaDaily
                    : message.quotaReason === 'rate_limit'
                      ? STR.chatArea.quotaMinute
                      : message.quotaReason === 'too_large'
                        ? STR.chatArea.quotaTooLarge
                        : message.quotaReason === 'billing'
                          ? STR.chatArea.quotaBilling(message.failModel ? modelLabel(message.failModel) : '')
                          : STR.chatArea.quotaExhausted}
                </span>
              </div>
              {isLongCooldown && message.quotaReason !== 'too_large' && (
                <div data-testid="quota-retry-at" className="flex items-center gap-1.5 text-[11px] text-gray-400">
                  <Clock size={11} className="shrink-0" />
                  {STR.chatArea.quotaRetryAtTime(retryAtTimeLabel)}
                </div>
              )}
              {message.quotaReason === 'rate_limit' && (
                <p data-testid="quota-minute-note" className="text-[11px] text-gray-400">
                  {STR.chatArea.quotaMinuteNote}
                </p>
              )}
              {/* G2 (§07): the second free provider, named with its allowance
                  AND its limits — numbers only, never "recommended". */}
              {message.quotaReason === 'daily' && freeProviderOffer && (
                <p data-testid="free-provider-offer" className="text-[11.5px] text-gray-500">
                  {STR.chatArea.freeProviderOffer(freeProviderOffer.label, freeProviderOffer.quota)}
                  {freeProviderOffer.readsImages === false && (
                    <>{' '}{STR.chatArea.freeProviderNoImagesNote(freeProviderOffer.label)}</>
                  )}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {message.quotaReason === 'daily' && freeProviderOffer && onAddFreeProvider && (
                  // G2 (§07) exits: setting up the provider takes the user out
                  // of the wall today; waiting is the equally valid other
                  // answer, so it gets a plain button — not a dismissed link.
                  <>
                    <button
                      type="button"
                      data-testid="add-free-provider-button"
                      onClick={() => onAddFreeProvider(freeProviderOffer.provider)}
                      className={CARD_ACTION_BTN}
                    >
                      <Key size={11} className="shrink-0" />
                      {STR.chatArea.freeProviderAddAction(freeProviderOffer.label)}
                    </button>
                    <button
                      type="button"
                      data-testid="free-provider-wait-button"
                      className={CARD_ACTION_BTN}
                    >
                      {STR.chatArea.freeProviderWait}
                    </button>
                  </>
                )}
                {message.quotaReason === 'billing' && freeFallback && onRetryFreeModel && (
                  // W4 primary exit: answer with the first FREE model —
                  // switch + auto-retry in one click; the deliberate paid
                  // pick stays untouched for the day billing exists.
                  <button
                    type="button"
                    data-testid="retry-free-button"
                    onClick={() => onRetryFreeModel(message)}
                    className={CARD_ACTION_BTN}
                  >
                    <Zap size={11} className="shrink-0" />
                    {STR.chatArea.retryWithModel(freeFallback.modelLabel)}
                  </button>
                )}
                {onRetryMessage &&
                  // After a model switch the card re-offers an ENABLED retry
                  // (the new model may have budget) — otherwise: never for
                  // too_large or billing (both fail deterministically), only
                  // as last escape for daily/long cooldown.
                  (switchedSinceFail ||
                    (message.quotaReason !== 'too_large' &&
                      message.quotaReason !== 'billing' &&
                      (message.quotaReason === 'daily' || isLongCooldown
                        ? !(hasLocalModel && onRetryLocalModel)
                        : true))) && (
                  <button
                    type="button"
                    data-testid="retry-button"
                    disabled={retryInSeconds > 0 && !isLongCooldown && !switchedSinceFail}
                    onClick={() => onRetryMessage(message)}
                    className={CARD_ACTION_BTN_DISABLEABLE}
                  >
                    <RotateCcw size={11} className="shrink-0" />
                    {retryInSeconds > 0 && !isLongCooldown && !switchedSinceFail ? STR.chatArea.retryCountdown(retryInSeconds) : S.retry}
                  </button>
                )}
                {hasLocalModel && onRetryLocalModel && message.quotaReason !== 'billing' && (
                  <button
                    type="button"
                    data-testid="retry-local-button"
                    title={`${STR.chatArea.retryLocal} — ${STR.chatArea.retryLocalNote}`}
                    onClick={() => onRetryLocalModel(message)}
                    className={CARD_ACTION_BTN}
                  >
                    <Cpu size={11} className="shrink-0" />
                    {STR.chatArea.retryLocal}
                  </button>
                )}
                {message.quotaReason === 'too_large' && onOpenModelPicker && (
                  <button
                    type="button"
                    data-testid="switch-model-button"
                    title={STR.chatArea.switchModelTip}
                    onClick={() => onOpenModelPicker(message)}
                    className={CARD_ACTION_BTN}
                  >
                    <ArrowLeftRight size={11} className="shrink-0" />
                    {STR.chatArea.switchModelAction}
                  </button>
                )}
                {(message.quotaReason === 'daily' || message.quotaReason === 'too_large') && ((message.failProvider && billingUrls?.[message.failProvider]) || billingUrl) && (
                  <a
                    href={(message.failProvider && billingUrls?.[message.failProvider]) || billingUrl || undefined}
                    target="_blank"
                    rel="noreferrer"
                    data-testid="raise-limit-link"
                    title={STR.chatArea.raiseLimitTip}
                    className={CARD_ACTION_LINK}
                  >
                    <ExternalLink size={11} className="shrink-0" />
                    {STR.chatArea.raiseLimit}
                  </a>
                )}
                {message.quotaReason === 'billing' && ((message.failProvider && billingUrls?.[message.failProvider]) || billingUrl) && (
                  <a
                    href={(message.failProvider && billingUrls?.[message.failProvider]) || billingUrl || undefined}
                    target="_blank"
                    rel="noreferrer"
                    data-testid="setup-billing-link"
                    title={STR.chatArea.setUpBillingTip}
                    className={CARD_ACTION_LINK}
                  >
                    <ExternalLink size={11} className="shrink-0" />
                    {STR.chatArea.setUpBilling}
                  </a>
                )}
              </div>
              {message.quotaReason === 'billing' && (
                <p data-testid="quota-billing-note" className="text-[11px] text-gray-400">
                  {STR.chatArea.quotaBillingNote}
                </p>
              )}
              {hasLocalModel && onRetryLocalModel && message.quotaReason !== 'billing' && (
                <p data-testid="retry-local-note" className="text-[11px] text-gray-400">
                  {STR.chatArea.retryLocalNote}
                </p>
              )}
            </div>
          ) : message.failReason ? (
            // Honest card per failReason (mockup-model-flow §05/§11): one
            // message line naming the culprit, a button row whose exits
            // actually lead out, at most one footnote. A plain retry appears
            // only where repeating can work (network, local_unreachable) —
            // or once the settings changed after the card appeared (§05).
            (() => {
              const reason = message.failReason;
              const failProviderLabel = message.failProvider
                ? providerLabels?.[message.failProvider] ?? message.failProvider
                : '';
              const failModelLabel = message.failModel ? modelLabel(message.failModel) : '';
              const line =
                reason === 'no_key'
                  ? STR.chatArea.failNoKey(failProviderLabel)
                  : reason === 'bad_key'
                    ? STR.chatArea.failBadKey(failProviderLabel)
                    : reason === 'no_vision'
                      ? STR.chatArea.failNoVision(failModelLabel)
                      : reason === 'network'
                        ? STR.chatArea.failNetwork
                        : reason === 'overloaded'
                          ? STR.chatArea.failOverloaded(failProviderLabel)
                          : reason === 'local_missing'
                            ? STR.chatArea.failLocalMissing(message.failModel ?? '')
                            : STR.chatArea.failLocalUnreachable;
              const showRetry =
                onRetryMessage &&
                (reason === 'network' || reason === 'local_unreachable' ||
                  // Overload passes on its own — unlike a quota, the same
                  // request can succeed on the very next try.
                  reason === 'overloaded' || changedSinceFail);
              const showLocal =
                hasLocalModel &&
                onRetryLocalModel &&
                (reason === 'no_key' || reason === 'bad_key' || reason === 'no_vision' ||
                  // A busy cloud is exactly when the private model earns its keep.
                  reason === 'overloaded');
              const settingsLabel =
                reason === 'no_key'
                  ? STR.chatArea.addApiKey
                  : reason === 'bad_key'
                    ? STR.chatArea.checkApiKey
                    : STR.chatArea.checkInSettings;
              const showSettings =
                onOpenSettings &&
                (reason === 'no_key' || reason === 'bad_key' || reason === 'local_missing' || reason === 'local_unreachable');
              return (
                <div
                  data-testid="failed-note"
                  className="flex flex-col items-start gap-2 text-[12.5px] text-gray-400"
                >
                  <div className="flex items-center gap-2">
                    {reason === 'network' ? (
                      <WifiOff size={13} className="shrink-0" />
                    ) : (
                      <AlertCircle size={13} className="shrink-0" />
                    )}
                    <span className="italic">{line}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {showSettings && (
                      <button
                        type="button"
                        data-testid="open-settings-button"
                        title={reason === 'no_key' || reason === 'bad_key' ? STR.chatArea.addApiKeyTip : undefined}
                        onClick={onOpenSettings}
                        className={CARD_ACTION_BTN}
                      >
                        {reason === 'no_key' || reason === 'bad_key' ? (
                          <Key size={11} className="shrink-0" />
                        ) : (
                          <SlidersHorizontal size={11} className="shrink-0" />
                        )}
                        {settingsLabel}
                      </button>
                    )}
                    {showLocal && (
                      <button
                        type="button"
                        data-testid="retry-local-button"
                        title={
                          reason === 'no_vision' && localModelName
                            ? STR.chatArea.localVisionTip(localModelName)
                            : `${STR.chatArea.retryLocal} — ${STR.chatArea.retryLocalNote}`
                        }
                        onClick={() => onRetryLocalModel(message)}
                        className={CARD_ACTION_BTN}
                      >
                        <Cpu size={11} className="shrink-0" />
                        {STR.chatArea.retryLocal}
                      </button>
                    )}
                    {reason === 'no_vision' && onOpenModelPicker && (
                      <button
                        type="button"
                        data-testid="switch-model-button"
                        title={STR.chatArea.switchModelVisionTip}
                        onClick={() => onOpenModelPicker(message)}
                        className={CARD_ACTION_BTN}
                      >
                        <ArrowLeftRight size={11} className="shrink-0" />
                        {STR.chatArea.switchModelAction}
                      </button>
                    )}
                    {reason === 'local_missing' && cloudFallback && onRetryCloudModel && (
                      <button
                        type="button"
                        data-testid="retry-cloud-button"
                        title={STR.chatArea.retryCloudTip(cloudFallback.providerLabel)}
                        onClick={() => onRetryCloudModel(message)}
                        className={CARD_ACTION_BTN}
                      >
                        <Cloud size={11} className="shrink-0" />
                        {STR.chatArea.retryCloud(cloudFallback.modelLabel)}
                      </button>
                    )}
                    {showRetry && (
                      <button
                        type="button"
                        data-testid="retry-button"
                        onClick={() => onRetryMessage(message)}
                        className={CARD_ACTION_BTN}
                      >
                        <RotateCcw size={11} className="shrink-0" />
                        {S.retry}
                      </button>
                    )}
                  </div>
                  {reason === 'no_vision' && (
                    <p className="text-[11px] text-gray-400">{STR.chatArea.removeImageFootnote}</p>
                  )}
                  {reason === 'network' && (
                    <p className="text-[11px] text-gray-400">{STR.chatArea.networkFootnote}</p>
                  )}
                  {reason === 'local_missing' && message.failModel && (
                    <p className="text-[11px] text-gray-400">
                      {STR.chatArea.installPrefix}
                      <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[10px] text-gray-600">
                        {`ollama pull ${message.failModel}`}
                      </code>
                      {STR.chatArea.installSuffix}
                    </p>
                  )}
                </div>
              );
            })()
          ) : (
          <div
            data-testid="failed-note"
            className="flex flex-wrap items-center gap-2 text-[12.5px] text-gray-400"
          >
            <AlertCircle size={13} className="shrink-0" />
            <span className="italic">{S.failed}</span>
            {onRetryMessage && (
              <button
                type="button"
                data-testid="retry-button"
                onClick={() => onRetryMessage(message)}
                className={CARD_ACTION_BTN}
              >
                <RotateCcw size={11} className="shrink-0" />
                {S.retry}
              </button>
            )}
          </div>
          )
        ) : markdownTree ? (
          // relative: positioning context for the invisible highlight anchors
          // — it changes nothing else (no offsets are set on the div itself).
          <div ref={contentRef} data-chat-content className="relative">
            {markdownTree}
            {hlAnchorEls}
          </div>
        ) : null}

        {/* Wartet der Job noch in der Backend-Warteschlange, zeigt die Blase
            den Platz in der Schlange statt der Denk-Punkte — ehrlicher als
            minutenlanges "Denkt nach…". */}
        {isQueued && (() => {
          const queuedText =
            message.queuedAhead === 0 ? S.queuedNext : S.queued(message.queuedAhead!);
          // Ahead-link (§07): only when the queue is answering ANOTHER chat
          // right now — jumping into the own chat would be a no-op.
          const current = message.queuedCurrent;
          const jumpTarget =
            onOpenChat && current && current.chatId !== message.chat_id ? current : null;
          return (
            <div
              data-testid="queued-note"
              className="flex items-center gap-1.5 text-[12.5px] italic text-gray-400"
            >
              <Clock size={12} className="shrink-0" />
              {jumpTarget ? (
                <button
                  type="button"
                  data-testid="queued-ahead-link"
                  title={S.nowAnswering(plainMathText(jumpTarget.question))}
                  onClick={() => onOpenChat!(jumpTarget.chatId)}
                  className="italic text-gray-400 hover:underline underline-offset-2 cursor-pointer"
                >
                  {queuedText}
                </button>
              ) : (
                queuedText
              )}
              {/* Model chip (§07): the local model that will answer this
                  waiting question — neutral pill, updates live on a switch. */}
              {message.queuedModel && (
                <span
                  data-testid="queued-model-chip"
                  className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10.5px] font-medium not-italic text-gray-500"
                >
                  <Cpu size={10} className="shrink-0" />
                  {message.queuedModel}
                </span>
              )}
            </div>
          );
        })()}

        {/* Läuft die Gedankenkette sichtbar im Panel, wären die Tipps darunter
            doppelt — dann nur die Punkte. */}
        {isStreaming && !processedContent && !isQueued && !isFailed && (
          <ThinkingIndicator withTips={Boolean(showThinkingTips) && !message.reasoning} />
        )}

        {isStreaming && processedContent && (
          <span
            data-testid="streaming-cursor"
            className="inline-block w-2 h-4 bg-gray-400 animate-pulse rounded-sm ml-0.5"
          />
        )}

        {message.sources && message.sources.length > 0 && (
          <SourcesList sources={message.sources} />
        )}

        {/* W2 (§06): the model called the search and nobody looked. UNDER the
            answer, never instead of it — the answer is real, it is just older
            than the question. */}
        {message.searchWish && (
          <SearchWishCard
            wish={message.searchWish}
            searchKeyStored={searchKeyStored}
            retryStreaming={chatStreaming}
            onSaveSearchKey={onSaveSearchKey && ((key) => onSaveSearchKey(key, message))}
          />
        )}

        {/* The provider ended this answer mid-thought
            (design/mockup-truncated-answer.html §01). The card sits UNDER the
            text and never replaces it — unlike '*Failed*', there is real
            content here, and for a Video overview it is also the chapters
            already parsed. Hidden while a continuation streams: the answer is
            growing, the card would contradict it. */}
        {/* Boolean(), not the raw column: `truncated` is a SQLite 0/1, and
            JSX renders a leading 0 as text — a lone "0" sat under every
            finished answer (user report with screenshot 2026-08-16). */}
        {Boolean(message.truncated) && !isStreaming && !isFailed && !isInterrupted && (
          <div
            data-testid="truncated-note"
            className="mt-2 flex flex-col items-start gap-2 text-[12.5px] text-gray-400"
          >
            <div className="flex items-center gap-2">
              <AlertCircle size={13} className="shrink-0" />
              <span className="italic">
                {(() => {
                  const mark = lastTimeMark(message.content);
                  return mark ? STR.chatArea.truncatedAtMark(mark) : STR.chatArea.truncated;
                })()}
              </span>
            </div>
            {onContinueMessage && (
              <button
                type="button"
                data-testid="continue-button"
                onClick={() => onContinueMessage(message)}
                className={CARD_ACTION_BTN}
              >
                <ArrowRight size={11} className="shrink-0" />
                {STR.chatArea.continueWriting}
              </button>
            )}
          </div>
        )}

        {/* The seam of a continued answer could not be verified
            (mockup-truncated-answer §04): the model twice skipped the
            repeat-your-last-words instruction, so the join may hide a gap in
            the middle of the text. The card mirrors the truncated one — same
            place, same tone — but its exit is REGENERATE: continuing cannot
            repair text that is already welded together wrong. Hidden while
            truncated is still set: the automat is not done growing the answer,
            and two cards under one bubble would fight for the same click. */}
        {Boolean(message.seam_suspect) && !message.truncated && !isStreaming && !isFailed && !isInterrupted && (
          <div
            data-testid="seam-suspect-note"
            className="mt-2 flex flex-col items-start gap-2 text-[12.5px] text-gray-400"
          >
            <div className="flex items-center gap-2">
              <AlertCircle size={13} className="shrink-0" />
              <span className="italic">{STR.chatArea.seamSuspect}</span>
            </div>
            {onRetryMessage && (
              <button
                type="button"
                data-testid="seam-regenerate-button"
                onClick={() => onRetryMessage(message)}
                className={CARD_ACTION_BTN}
              >
                <RotateCcw size={11} className="shrink-0" />
                {STR.chatArea.seamRegenerate}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Live countdown of the rate-limit line: ticks down locally from
// retryInSeconds to 0; every further rateLimit event (next attempt) resets it.
// With scope + model (variant C) the copy names the exact limit; without
// them (older events) it falls back to the generic wording.
function RateLimitCountdown({ seconds, scope, modelName }: { seconds: number; scope?: 'requests' | 'tokens'; modelName?: string }) {
  const S = useStrings().chatArea;
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    setLeft(seconds);
    const t = window.setInterval(() => setLeft(v => Math.max(0, v - 1)), 1000);
    return () => window.clearInterval(t);
  }, [seconds]);
  const scoped = scope && modelName;
  // At 0 the retry round-trip is in flight — an honest "Retrying…" beats a
  // line frozen at "0 s".
  if (left > 0) {
    return (
      <>
        {scoped
          ? S.rateLimitedScoped(
              scope === 'tokens' ? S.rateLimitScopeTokens : S.rateLimitScopeRequests,
              modelName,
              left,
            )
          : S.rateLimited(left)}
      </>
    );
  }
  return <>{scoped ? S.retryingOn(modelName) : S.retrying}</>;
}

// Live countdown of the overload line. Same shape as RateLimitCountdown, and
// deliberately a second small component rather than a flag on the first: the
// two waits share a look, not a sentence, and merging them would put an
// if-cause branch inside every render of both.
function OverloadCountdown({
  seconds, attempt, maxAttempts, providerName,
}: { seconds: number; attempt: number; maxAttempts: number; providerName: string }) {
  const S = useStrings().chatArea;
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    setLeft(seconds);
    const t = window.setInterval(() => setLeft(v => Math.max(0, v - 1)), 1000);
    return () => window.clearInterval(t);
  }, [seconds]);
  // At 0 the retry is in flight — say so instead of freezing at "0 s".
  return (
    <>
      {left > 0
        ? S.overloadedWaiting(providerName, left, attempt, maxAttempts)
        : S.overloadedRetrying(providerName, attempt, maxAttempts)}
    </>
  );
}

// Compact citation strip rendered under an assistant answer that used
// web_search. Each source is a small chip with the site's hostname; clicking
// opens the full URL in a new tab. The full title shows as tooltip on hover.
function SourcesList({ sources }: { sources: NonNullable<Message['sources']> }) {
  const S = useStrings().messageBubble;
  // De-duplicate by URL — the same article can come from multiple engines.
  const seen = new Set<string>();
  const unique = sources.filter(s => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
  if (unique.length === 0) return null;

  return (
    <div className="mt-4 pt-3 border-t border-gray-100">
      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
        {S.sources}
      </p>
      <ol className="flex flex-wrap gap-1.5">
        {unique.slice(0, 8).map((s, i) => {
          let host = '';
          try { host = new URL(s.url).hostname.replace(/^www\./, ''); } catch (_) { host = s.url; }
          return (
            <li key={s.url}>
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                title={s.title}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-gray-100 hover:bg-gray-200 text-xs text-gray-700 transition-colors"
              >
                <span className="text-gray-400">{i + 1}.</span>
                <span className="truncate max-w-[14rem]">{host}</span>
              </a>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * W2 (§06): what the model wanted to look up, and why the answer above may be
 * out of date. Shape and copy: design/mockup-search-wish-card.html, variant C.
 *
 * Dismissable, unlike the citation card's ask — there the card IS the way to
 * the paper, here the answer already arrived and the card is only a caveat.
 *
 * The previous card was blue-on-blue: a blue-50/60 surface with a full-width
 * blue-50 button on it, a 4 % lightness gap that read as a hole rather than as
 * something to press. This one sits on `white` like every other card, spends
 * its accent on a 2 px strip and a badge, and sizes the button to its label.
 * Filled on blue-700, not blue-600: measured against each theme's own `white`,
 * blue-600 gives 2.89:1 in Hyrule and 4.31:1 in Mushroom Kingdom, while
 * blue-700 gives 6.70 / 6.70 / 5.65 / 3.92 / 13.83. Hyrule's turquoise ramp has
 * no pair that clears AA at 12 px — 3.92 is the best the token family allows.
 */
function SearchWishCard({
  wish,
  searchKeyStored,
  retryStreaming,
  onSaveSearchKey,
}: {
  wish: NonNullable<Message['searchWish']>;
  searchKeyStored?: boolean;
  retryStreaming?: boolean;
  onSaveSearchKey?: (key: string) => Promise<void> | void;
}) {
  const S = useStrings().messageBubble.searchWish;
  const [dismissed, setDismissed] = useState(false);
  const [keyFieldOpen, setKeyFieldOpen] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  // The key was saved from THIS card, this session. Transient by design: on
  // reload the card falls back to the stored-key caveat (mockup §05).
  const [savedHere, setSavedHere] = useState(false);

  if (dismissed) return null;

  // Save-&-retry receipt (mockup-search-key-saved.html, fifth pass): two
  // steps only WHILE something runs — step 1 checks the moment the card
  // morphs (the save is a done fact), step 2 carries the spinner, because
  // what runs is the answer generation below, not the search. Settled it is
  // one line with ONE check; "web search stays on" is an aside, not a step,
  // so it moves to its own faint line behind an Info mark — the app's
  // existing hint vocabulary (model picker local-hint row, settings hints).
  if (savedHere) {
    return (
      <div data-testid="search-wish-saved" className="mt-3 rounded-lg bg-blue-100/40 px-3 py-2.5">
        {retryStreaming ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-start gap-2">
              <Check size={13} className="mt-0.5 shrink-0 text-blue-700" />
              <p className="text-xs font-semibold text-gray-900 leading-snug">{S.savedTitle}</p>
            </div>
            <div className="flex items-start gap-2">
              <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin text-blue-700" />
              <p data-testid="search-wish-saved-asking" className="text-xs text-gray-500 leading-snug">{S.savedAsking}</p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-start gap-2">
              <Check size={13} className="mt-0.5 shrink-0 text-blue-700" />
              <p data-testid="search-wish-saved-done" className="flex-1 min-w-0 text-xs text-gray-900 leading-snug">
                <span className="font-semibold">{S.savedTitle}</span> — {S.savedDone}
              </p>
              <button
                onClick={() => setDismissed(true)}
                aria-label={S.dismiss}
                data-testid="search-wish-dismiss"
                className="shrink-0 p-0.5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
              >
                <X size={13} />
              </button>
            </div>
            <div className="flex items-start gap-2">
              <Info size={13} className="mt-0.5 shrink-0 text-gray-400" />
              <p className="flex-1 min-w-0 text-[11px] text-gray-400 leading-relaxed">{S.savedAside}</p>
            </div>
          </div>
        )}
      </div>
    );
  }

  // One sentence per named state, and a different ask in each. "Add a search
  // key" is wrong when one is already stored — the reader would type the same
  // wrong key again — and wrong when the allowance is gone, where no key helps
  // until the 1st. Only the wish state names the offer and the allowance.
  const state =
    wish.error === 'tavily-invalid-key'
      ? {
          title: S.rejectedTitle,
          body: S.rejectedBody,
          offer: null,
          action: S.replaceKey,
          allowance: null,
        }
      : wish.error === 'tavily-quota-exhausted'
        ? {
            title: S.quotaTitle,
            body: S.quotaBody,
            offer: null,
            action: null,
            allowance: null,
          }
        : searchKeyStored
          // Stored since this answer was written — the note is still true
          // (this answer was written without a search), but offering to add a
          // key would be a dead end, so only the fact remains.
          ? {
              title: S.title,
              body: S.body(wish.query),
              offer: null,
              action: null,
              allowance: null,
            }
          : {
              title: S.title,
              body: S.body(wish.query),
              offer: S.offer,
              action: S.addKey,
              allowance: S.allowance,
            };

  const save = async () => {
    const key = keyInput.trim();
    // An empty field is not a decision — saving '' would clear a stored key.
    if (!key || saving) return;
    setSaving(true);
    try {
      await onSaveSearchKey?.(key);
      // Morph to the receipt — leaving the key field standing made the click
      // look swallowed (user report with screenshot, 2026-09-12).
      setSavedHere(true);
    } finally {
      setSaving(false);
    }
  };

  // One head for both faces of the card. `aside` shares the title line in
  // parentheses; `body` and `second` each get a line of their own.
  const head = keyFieldOpen
    ? { title: S.keyTitle, aside: S.keyBody, body: null, second: S.keyEffect }
    : { title: state.title, aside: null, body: state.body, second: state.offer };

  return (
    <div
      data-testid="search-wish"
      className="mt-3 rounded-lg bg-blue-100/40 px-3 py-2.5"
    >
      {/* Placement D (design/mockup-search-wish-placement.html): a footer of
          the answer bubble, NOT a card of its own. The card sits inside
          `.prose.select-text`, and in four of five themes that bubble already
          has a frame plus a hard 4px offset shadow (Mushroom Kingdom 2px
          #26264f, Ink Blue 1.5px #1c2b4a, Hyrule 1px, Matrix a 2px left edge).
          Mushroom Kingdom also repaints every border-gray-* as that same ink,
          so a nested card cannot be quieter than its container — both frames
          come out identical and it reads as a window inside a window (user
          report 2026-08-25). index.css:749 records the same bug from the /btw
          fold-out. Fixed the same way: by dropping the second frame, not by
          restyling it.

          What marks the footer instead is a wash of the theme's own accent, no
          border and no shadow — it has to read as its own area while still
          belonging to the bubble (user request 2026-08-25). blue-100/40 is the
          only token wash that separates in all five themes; measured as rgb
          distance from each bubble colour: 16.1 / 9.0 / 17.8 / 14.5 / 13.6.
          Full blue-50 collapses to 4.6 in Ink Blue, whose bubble IS near
          blue-50, and gray-50 to 0.0 in Matrix, whose bubble IS gray-50. */}
      <div>
        <div className="flex items-start gap-2">
          <span className="shrink-0 w-[22px] h-[22px] rounded-lg bg-blue-50 text-blue-700 flex items-center justify-center">
            {keyFieldOpen ? <KeyRound size={12} /> : <Search size={12} />}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-gray-900 leading-snug">
              {head.title}
              {head.aside && (
                <span className="ml-1 font-normal text-[11px] text-gray-500">
                  ({head.aside})
                </span>
              )}
            </p>
            {head.body && (
              <p className="mt-0.5 text-[11px] leading-relaxed text-gray-500">
                {head.body}
              </p>
            )}
            {/* Never two sentences in one paragraph here: the second one is
                always a different kind of claim from the first — what could be
                rather than what happened, what the key does rather than where
                it lives — so it gets its own line and the darker grey. */}
            {head.second && (
              <p className="mt-1 text-[11px] leading-relaxed text-gray-700">
                {head.second}
              </p>
            )}
          </div>
          <button
            onClick={() => setDismissed(true)}
            aria-label={S.dismiss}
            data-testid="search-wish-dismiss"
            className="shrink-0 p-0.5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <X size={13} />
          </button>
        </div>

        {keyFieldOpen ? (
          <>
            <div className="mt-2 flex items-center gap-2">
              <input
                data-testid="search-wish-key-input"
                type="password"
                autoFocus
                value={keyInput}
                onChange={e => setKeyInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void save(); }}
                placeholder={S.keyPlaceholder}
                aria-label={S.keyLabel}
                className="flex-1 min-w-0 h-7 px-2.5 rounded-lg border border-gray-200 bg-white font-mono text-[11px] text-gray-700 placeholder:text-gray-400 focus:outline-none focus:border-blue-500"
              />
              <button
                onClick={() => void save()}
                disabled={saving || keyInput.trim().length === 0}
                aria-busy={saving || undefined}
                data-testid="search-wish-key-save"
                className="shrink-0 inline-flex items-center gap-1.5 h-7 px-3 rounded-lg bg-blue-700 text-white text-xs font-semibold hover:bg-blue-800 transition-colors disabled:opacity-50 disabled:hover:bg-blue-700 disabled:cursor-default"
              >
                {saving && <Loader2 size={12} className="animate-spin" />}
                {saving ? S.saving : S.save}
              </button>
            </div>
            <div className="mt-2.5">
              <a
                href="https://app.tavily.com/home"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-700 underline decoration-blue-700/35 underline-offset-2 hover:decoration-blue-700"
              >
                {S.getKey}
                <ExternalLink size={11} />
              </a>
            </div>
          </>
        ) : (
          state.action && (
            <div className="mt-3 flex items-center gap-3 flex-wrap">
              <button
                onClick={() => setKeyFieldOpen(true)}
                data-testid="search-wish-key-open"
                className="inline-flex items-center gap-1.5 h-7 px-3 rounded-lg bg-blue-700 text-white text-xs font-semibold hover:bg-blue-800 transition-colors"
              >
                <KeyRound size={12} />
                {state.action}
              </button>
              {/* Per-day, not per-month: the reader can judge whether ~33 covers
                  a working day; 1000 a month tells them nothing they can use. */}
              {state.allowance && (
                <span className="text-[11px] text-gray-400">{state.allowance}</span>
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
}

function getWordAtPoint(e: React.MouseEvent): string {
  const range = document.caretRangeFromPoint?.(e.clientX, e.clientY);
  if (!range) return '';
  const el = range.startContainer;
  const text = el.textContent || '';
  const offset = range.startOffset;
  const words = text.split(/\s+/);
  let pos = 0;
  for (const word of words) {
    pos += word.length + 1;
    if (pos > offset) return word.replace(/[^a-zA-Z0-9äöüÄÖÜß-]/g, '');
  }
  return '';
}
