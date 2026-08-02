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
import { AlertCircle, ArrowLeftRight, Brain, ChevronDown, ChevronRight, Clock, Cloud, Cpu, ExternalLink, Key, RotateCcw, SlidersHorizontal, Square, WifiOff, Zap } from 'lucide-react';
import { ThinkingIndicator } from './ThinkingIndicator';
import {
  clearFlashChatRange,
  clearMessageHighlights,
  clearPendingChatSelection,
  highlightAtPoint,
  paintFlashChatRange,
  paintMessageHighlights,
  paintPendingChatSelection,
  textOffsetInRoot,
} from '../../chat/highlightAnchors';
import { splitLeadingQuote } from '../../chat/messageQuote';
import { rangeToCleanText } from '../../chat/selectionText';
import { sanitizeMath } from '../../markdown/sanitizeMath';
import { MathText, plainMathText } from '../MathText';
import { useStrings } from '../../strings';
import { gfmTableComponents } from './markdownTables';
import { CodeBlock } from './CodeBlock';
import { FAILED_MARKER, INTERRUPTED_MARKER } from '../../types';
import type { ChatSelection, HighlightColor, Message, MessageHighlight } from '../../types';

// ReactMarkdown's defaultUrlTransform strips URLs with unknown schemes (anything
// besides http, https, mailto, tel) for safety. Our internal "branch:<chatId>"
// links would be wiped out, so we let those through and defer to the default
// behaviour for everything else.
const urlTransform = (url: string) =>
  url.startsWith('branch:') ? url : defaultUrlTransform(url);

interface BranchWord {
  word: string;
  chatId: string;
}

interface Props {
  message: Message;
  isStreaming?: boolean;
  onWordRightClick: (word: string, context: string, x: number, y: number) => void;
  branchWords?: BranchWord[];
  onBranchClick?: (chatId: string) => void;
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
  // Queue transparency (mockup-model-flow §07): when the queued event names
  // the chat being answered RIGHT NOW and it is a different chat, the
  // waiting text becomes a link that jumps there.
  onOpenChat?: (chatId: string) => void;
}

// "Thought for 1m 42s" / "Thought for 34s".
function formatThoughtDuration(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Escape special regex characters in a string.
function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Pre-process markdown content: replace branch words with markdown link syntax
// so ReactMarkdown can render them as clickable links.
// e.g. "quantum mechanics" becomes "[quantum](branch:chat-id)"
function insertBranchLinks(content: string, branchWords: BranchWord[]): string {
  let result = content;
  for (const { word, chatId } of branchWords) {
    const regex = new RegExp(`\\b(${escapeRegex(word)})\\b`, 'gi');
    result = result.replace(regex, `[$1](branch:${chatId})`);
  }
  return result;
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
  onBranchClick,
  highlights,
  onChatSelection,
  onHighlightContextMenu,
  pendingSelection,
  showThinkingTips,
  flashRange,
  onRetryMessage,
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
  });
  useEffect(() => () => {
    clearMessageHighlights(message.id);
    clearPendingChatSelection(message.id);
    clearFlashChatRange(message.id);
  }, [message.id]);

  // Pre-process content: branch word links einbetten, LaTeX-Trenner
  // normalisieren. Muss VOR dem isUser-Early-Return stehen (Hook-Regeln).
  const linkedContent = branchWords && branchWords.length > 0 && message.content
    ? insertBranchLinks(message.content, branchWords)
    : message.content;
  // sanitizeMath läuft NACH normalizeMathDelimiters: erst Backtick-Mathe
  // auspacken und \(…\)-Paare wandeln, dann Reste (verwaiste Trenner,
  // Absatz-Verschlucker) reparieren. Während des Streamens auf dem
  // sichtbaren Präfix — offene End-Trenner bleiben dann unmaskiert.
  const processedContent = linkedContent
    ? sanitizeMath(normalizeMathDelimiters(linkedContent), { streaming: isStreaming })
    : linkedContent;

  // onBranchClick über eine Ref in den memoizten Baum reichen — der Baum
  // wird nur bei Inhaltsänderung neu erzeugt, der Handler bleibt aktuell.
  const onBranchClickRef = useRef(onBranchClick);
  onBranchClickRef.current = onBranchClick;

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
          // Branch links: rendered as blue buttons (not real <a> tags).
          // border-b, not underline: text-decoration skips inline-block
          // children (KaTeX), leaving broken underline fragments.
          a({ href, children }) {
            if (href?.startsWith('branch:')) {
              const chatId = href.replace('branch:', '');
              return (
                <button
                  onClick={() => onBranchClickRef.current?.(chatId)}
                  className="text-blue-600 border-b border-current hover:text-blue-800 font-medium cursor-pointer"
                >
                  {children}
                </button>
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
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
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
    if ((e.target as HTMLElement).closest('a, button')) return;
    const mine = highlights.filter((h) => h.messageId === message.id);
    const hit = highlightAtPoint(root, mine, e.clientX, e.clientY);
    if (hit) onHighlightContextMenu(hit, e.clientX, e.clientY);
  };

  // User messages: gray bubble, right-aligned.
  if (isUser) {
    const attachments = message.attachments || [];
    const images = attachments.filter(a => a.mimetype.startsWith('image/'));
    const others = attachments.filter(a => !a.mimetype.startsWith('image/'));
    return (
      <div className="flex justify-end">
        <div className="flex flex-col items-end gap-2" style={{ maxWidth: '42rem' }}>
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
                className="bg-gray-100 text-gray-900 select-text"
                style={{
                  borderRadius: '2rem',
                  padding: '0.75rem 1.125rem',
                  lineHeight: 1.65,
                  fontSize: '15px',
                }}
              >
                <div ref={contentRef} data-chat-content>
                  {quote !== null && (
                    // currentColor + Opazität statt fester Grautöne: die
                    // Themes färben die User-Bubble beliebig um (Matrix dunkel,
                    // Mushroom rot, …) — absolute Grays wurden dort unlesbar
                    // (Nutzer-Report 2026-07-22). So bleibt das Zitat immer
                    // eine gedimmte Variante der Bubble-Textfarbe: lesbar auf
                    // jedem Grund, aber klar von der Frage unterscheidbar.
                    <div
                      className="mb-2 border-l-2 border-current pl-3 text-sm whitespace-pre-wrap opacity-75"
                      data-testid="user-message-quote"
                    >
                      {/* MathText, not the markdown pipeline: user text is
                          plain by design, but "Ask in chat" quotes carry $…$
                          from KaTeX selections (audit 2026-07-28). */}
                      <MathText text={quote} />
                    </div>
                  )}
                  <p className="whitespace-pre-wrap"><MathText text={quote !== null ? rest : message.content} /></p>
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
        style={{ maxWidth: '46rem' }}
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
                className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-0.5 text-[12px] font-medium text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700"
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
              <div className="flex flex-wrap items-center gap-2">
                {message.quotaReason === 'billing' && freeFallback && onRetryFreeModel && (
                  // W4 primary exit: answer with the first FREE model —
                  // switch + auto-retry in one click; the deliberate paid
                  // pick stays untouched for the day billing exists.
                  <button
                    type="button"
                    data-testid="retry-free-button"
                    onClick={() => onRetryFreeModel(message)}
                    className="inline-flex items-center gap-1 rounded-md border border-blue-100 bg-blue-50 px-2 py-0.5 text-[12px] font-semibold text-blue-700 transition-colors hover:bg-blue-100"
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
                    className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-0.5 text-[12px] font-medium text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700 disabled:opacity-55 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-gray-500"
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
                    className="inline-flex items-center gap-1 rounded-md border border-blue-100 bg-blue-50 px-2 py-0.5 text-[12px] font-semibold text-blue-700 transition-colors hover:bg-blue-100"
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
                    className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-0.5 text-[12px] font-medium text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700"
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
                    className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-0.5 text-[12px] font-medium text-gray-500 no-underline transition-colors hover:bg-gray-50 hover:text-gray-700"
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
                    className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-0.5 text-[12px] font-medium text-gray-500 no-underline transition-colors hover:bg-gray-50 hover:text-gray-700"
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
                        : reason === 'local_missing'
                          ? STR.chatArea.failLocalMissing(message.failModel ?? '')
                          : STR.chatArea.failLocalUnreachable;
              const plainBtn =
                'inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-0.5 text-[12px] font-medium text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700';
              const primaryishBtn =
                'inline-flex items-center gap-1 rounded-md border border-blue-100 bg-blue-50 px-2 py-0.5 text-[12px] font-semibold text-blue-700 transition-colors hover:bg-blue-100';
              const showRetry =
                onRetryMessage &&
                (reason === 'network' || reason === 'local_unreachable' || changedSinceFail);
              const showLocal =
                hasLocalModel &&
                onRetryLocalModel &&
                (reason === 'no_key' || reason === 'bad_key' || reason === 'no_vision');
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
                        className={primaryishBtn}
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
                        className={reason === 'no_vision' ? primaryishBtn : plainBtn}
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
                        className={plainBtn}
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
                        className={plainBtn}
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
                        className={plainBtn}
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
                className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-0.5 text-[12px] font-medium text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700"
              >
                <RotateCcw size={11} className="shrink-0" />
                {S.retry}
              </button>
            )}
          </div>
          )
        ) : markdownTree ? (
          <div ref={contentRef} data-chat-content>
            {markdownTree}
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
          <span className="inline-block w-2 h-4 bg-gray-400 animate-pulse rounded-sm ml-0.5" />
        )}

        {message.sources && message.sources.length > 0 && (
          <SourcesList sources={message.sources} />
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
