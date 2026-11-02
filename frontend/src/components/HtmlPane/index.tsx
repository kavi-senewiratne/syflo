/**
 * components/HtmlPane/index.tsx
 *
 * The HTML source in the middle column — the counterpart of PdfView and
 * VideoPane (ADR-0013, design/mockup-html-app.html, variant B chosen for the
 * outline chip and the warning card; the badge is the compact door to the same
 * list).
 *
 * The page runs live in an <iframe> on ITS OWN origin (`src-<id>.localhost`),
 * so quizzes and canvases stay interactive while the page has no access to
 * Syflo's chats or keys. The `sandbox` therefore grants scripts and
 * same-origin (that origin is the page's, not ours) and forms/popups, but
 * never top navigation: a page cannot navigate Syflo away.
 *
 * Everything the reader does INSIDE the page reaches us through the bridge
 * (html/bridge.ts): selections, clicks on a mark, the current section. What we
 * want done in the page — paint marks, scroll, clear the selection — goes out
 * the same way, but only after `ready`: a message sent earlier would be lost.
 *
 * Rects from the bridge are relative to the iframe's viewport. The popup and
 * menus live in page coordinates, so every rect is translated by the iframe's
 * own offset before it leaves this component.
 *
 * Links in the page never navigate the frame (the snapshot is ONE page and
 * most sites refuse to be framed): the bridge blocks them and reports
 * `open-link`, and the address opens in the system browser — the same door
 * every external link in Syflo takes (Electron routes window.open to the OS).
 *
 * The page keeps its own design in all five themes (ADR-0013 decision 10);
 * only the frame around it is themed, through the standard tokens.
 */

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { Ref } from 'react';
import { ChevronDown, Code, List, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import { api } from '../../api';
import { useStrings } from '../../strings';
import { readBridgeMessage, toPageRect } from '../../html/bridge';
import { resourceLabel } from '../../html/resourceLabel';
import type { HtmlAnchor, HtmlEmbed, HtmlHighlight, HtmlSection, HtmlSource } from '../../types';
import { CARD_ACTION_BTN_DISABLEABLE } from '../ChatArea/cardActionButton';

export interface HtmlPaneHandle {
  /** Scroll the page to a stored mark (the way back from a quote or branch). */
  scrollToHighlight: (id: string) => void;
  scrollToAnchor: (anchor: HtmlAnchor) => void;
  /** Drop the page's native selection (after the popup's action). */
  clearSelection: () => void;
}

export interface HtmlPaneSelection {
  text: string;
  anchor: HtmlAnchor;
  /** Heading the passage sits under, as far as the bridge has reported it. */
  section: string | null;
  /** Page coordinates: horizontal middle of the passage, just below it. */
  x: number;
  y: number;
}

interface Props {
  source: HtmlSource;
  highlights: HtmlHighlight[];
  onSelection: (selection: HtmlPaneSelection) => void;
  onSelectionCleared?: () => void;
  /** A click on a stored mark, at page coordinates. */
  onHighlightClick: (highlight: HtmlHighlight, x: number, y: number) => void;
  onRetryFreeze: () => void;
  retryingFreeze?: boolean;
  /** A link out of the page. Default: a new window, which Electron hands to the OS browser. */
  onOpenLink?: (url: string) => void;
  ref?: Ref<HtmlPaneHandle>;
}

const openOutside = (url: string) => {
  window.open(url, '_blank', 'noopener,noreferrer');
};

// Scripts and same-origin (the page's own origin), forms and popups. NOT
// allow-top-navigation: the page must not be able to navigate Syflo away.
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups';

type Panel = 'outline' | 'warnings' | null;

export function HtmlPane({
  source,
  highlights,
  onSelection,
  onSelectionCleared,
  onHighlightClick,
  onRetryFreeze,
  retryingFreeze = false,
  onOpenLink = openOutside,
  ref,
}: Props) {
  const S = useStrings().htmlPane;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);

  // Fetched every time the pane opens: the token changes with each server
  // start, so a remembered one would silently stop matching.
  const [embed, setEmbed] = useState<HtmlEmbed | null>(null);
  const [embedFailed, setEmbedFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setEmbed(null);
    setEmbedFailed(false);
    void Promise.resolve()
      .then(() => api.getHtmlEmbed(source.id))
      .then((e) => { if (!cancelled) setEmbed(e); })
      .catch(() => { if (!cancelled) setEmbedFailed(true); });
    return () => { cancelled = true; };
  }, [source.id]);

  // The outline of the loaded page. Starts as the uploaded one; the bridge's
  // own list replaces it because its indices are what scroll-to-section means.
  const [bridgeSections, setBridgeSections] = useState<HtmlSection[] | null>(null);
  const sections = bridgeSections ?? source.sections;
  const [current, setCurrent] = useState<{ heading: string; index: number } | null>(null);
  const currentRef = useRef(current);
  useEffect(() => {
    setBridgeSections(null);
    setCurrent(null);
  }, [source.id]);

  const [panel, setPanel] = useState<Panel>(null);

  // ─── app → page ────────────────────────────────────────────────────────
  const readyRef = useRef(false);
  const embedRef = useRef(embed);
  const highlightsRef = useRef(highlights);
  // Mirrors of props/state for the message handlers below; updated in an
  // effect declared BEFORE every effect that reads them.
  useEffect(() => {
    currentRef.current = current;
    embedRef.current = embed;
    highlightsRef.current = highlights;
  });
  // A request that arrives before `ready` waits here; only the latest matters.
  const pendingRef = useRef<Record<string, unknown> | null>(null);

  const post = useCallback((type: string, extra: Record<string, unknown> = {}) => {
    const e = embedRef.current;
    const win = frameRef.current?.contentWindow;
    if (!e || !win) return;
    win.postMessage({ token: e.token, type, ...extra }, e.origin);
  }, []);

  const paintHighlights = useCallback(() => {
    post('set-highlights', {
      highlights: highlightsRef.current.map((h) => ({ id: h.id, color: h.color, anchor: h.anchor })),
    });
  }, [post]);

  useEffect(() => {
    if (readyRef.current) paintHighlights();
  }, [highlights, paintHighlights]);

  const send = useCallback(
    (type: string, extra: Record<string, unknown> = {}) => {
      if (readyRef.current) post(type, extra);
      else if (type === 'scroll-to-anchor' || type === 'scroll-to-section') pendingRef.current = { type, ...extra };
    },
    [post],
  );

  useImperativeHandle(
    ref,
    () => ({
      scrollToHighlight: (id) => {
        const h = highlightsRef.current.find((x) => x.id === id);
        if (h) send('scroll-to-anchor', { anchor: h.anchor });
      },
      scrollToAnchor: (anchor) => send('scroll-to-anchor', { anchor }),
      clearSelection: () => send('clear-selection'),
    }),
    [send],
  );

  // On every (re)load: forget readiness and say hello. The page's first
  // `ready` can arrive before this component listens; `hello` makes it answer
  // again with ready, outline and section (bridge/PROTOCOL.md).
  const handleFrameLoad = useCallback(() => {
    readyRef.current = false;
    post('hello');
  }, [post]);

  // ─── page → app ────────────────────────────────────────────────────────
  const callbacks = useRef({ onSelection, onSelectionCleared, onHighlightClick, onOpenLink });
  useEffect(() => {
    callbacks.current = { onSelection, onSelectionCleared, onHighlightClick, onOpenLink };
  });

  useEffect(() => {
    if (!embed) return;
    readyRef.current = false;
    const onMessage = (event: MessageEvent) => {
      const msg = readBridgeMessage(event, {
        origin: embed.origin,
        source: frameRef.current?.contentWindow ?? null,
        token: embed.token,
      });
      if (!msg) return;
      const frame = frameRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
      switch (msg.type) {
        case 'ready': {
          readyRef.current = true;
          paintHighlights();
          const pending = pendingRef.current;
          pendingRef.current = null;
          if (pending) {
            const { type, ...rest } = pending as { type: string };
            post(type, rest);
          }
          break;
        }
        case 'outline':
          setBridgeSections(msg.sections);
          break;
        case 'section':
          // -1 = above the first heading: no section to name yet.
          setCurrent(msg.index < 0 ? null : { heading: msg.heading, index: msg.index });
          break;
        case 'selection': {
          const r = toPageRect(msg.rect, frame);
          callbacks.current.onSelection({
            text: msg.text,
            anchor: msg.anchor,
            // The bridge names the section the selection sits in; the section in view
            // is only the fallback for an older bridge.
            section: msg.section !== undefined ? (msg.section || null) : (currentRef.current?.heading ?? null),
            x: r.left + r.width / 2,
            y: r.bottom,
          });
          break;
        }
        case 'selection-cleared':
          callbacks.current.onSelectionCleared?.();
          break;
        case 'highlight-click': {
          const h = highlightsRef.current.find((x) => x.id === msg.id);
          if (!h) break;
          const r = toPageRect(msg.rect, frame);
          callbacks.current.onHighlightClick(h, r.left + r.width / 2, r.bottom);
          break;
        }
        case 'open-link':
          callbacks.current.onOpenLink(msg.url);
          break;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [embed, paintHighlights, post]);

  // ─── header popovers ───────────────────────────────────────────────────
  useEffect(() => {
    if (!panel) return;
    const close = () => setPanel(null);
    const onDown = (e: MouseEvent) => {
      if (headerRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    // A click inside the iframe never bubbles to this document, but it does
    // pull focus out of it — that is the signal that the reader moved on.
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
    };
  }, [panel]);

  const unfrozen = source.unfrozen;
  const chipLabel = current?.heading ?? S.outline;
  const subtitle = useMemo(
    () => S.subtitle(sections.length, unfrozen.length === 0),
    [S, sections.length, unfrozen.length],
  );

  return (
    <div
      data-testid="html-pane"
      // The middle column's source — same keyboard region as PDF and video.
      data-focus-region="source"
      className="syflo-html-pane @container flex min-w-0 flex-1 flex-col overflow-hidden bg-gray-100"
    >
      <div ref={headerRef} className="relative flex shrink-0 items-center gap-3 border-b border-gray-200 bg-white px-5 py-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
          <Code size={16} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold leading-snug text-gray-900" title={source.title}>
            {source.title}
          </p>
          <p className="truncate text-[11.5px] text-gray-500">{subtitle}</p>
        </div>

        {unfrozen.length > 0 && (
          <button
            type="button"
            data-testid="html-unfrozen-badge"
            data-focus-item="html-unfrozen"
            aria-haspopup="menu"
            aria-expanded={panel === 'warnings'}
            onClick={() => setPanel((p) => (p === 'warnings' ? null : 'warnings'))}
            className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-amber-200 bg-amber-50 px-1.5 py-px text-[10px] font-semibold text-amber-700"
          >
            <TriangleAlert size={10} aria-hidden="true" />
            {S.unfrozenBadge(unfrozen.length)}
          </button>
        )}

        <button
          type="button"
          data-testid="html-outline-chip"
          data-focus-item="html-outline"
          aria-haspopup="menu"
          aria-expanded={panel === 'outline'}
          onClick={() => setPanel((p) => (p === 'outline' ? null : 'outline'))}
          className="inline-flex min-w-0 max-w-[45%] shrink items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-[3px] text-xs text-gray-600 transition-colors hover:bg-gray-200"
        >
          <List size={14} className="shrink-0" aria-hidden="true" />
          <span className="truncate">{chipLabel}</span>
          <ChevronDown size={14} className="shrink-0" aria-hidden="true" />
        </button>

        {panel === 'outline' && (
          <div
            role="menu"
            aria-label={S.outline}
            className="absolute right-5 top-[52px] z-40 max-h-[60vh] w-max min-w-[14rem] max-w-[24rem] overflow-y-auto rounded-xl border border-gray-100 bg-white py-1 shadow-2xl"
          >
            {sections.length === 0 && (
              <p className="px-3 py-1.5 text-[12.5px] text-gray-400">{S.outlineEmpty}</p>
            )}
            {sections.map((s, i) => (
              <button
                key={`${i}-${s.heading}`}
                type="button"
                role="menuitem"
                data-focus-item={`html-section-${i}`}
                onClick={() => {
                  setPanel(null);
                  setCurrent({ heading: s.heading, index: i });
                  send('scroll-to-section', { index: i });
                }}
                style={{ paddingLeft: `${0.75 + Math.max(0, Math.min(s.level, 3) - 1) * 0.75}rem` }}
                className={`block w-full whitespace-nowrap py-1.5 pr-3 text-left text-[12.5px] transition-colors ${
                  current?.index === i
                    ? 'bg-blue-50 font-semibold text-blue-700'
                    : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                {s.heading}
              </button>
            ))}
          </div>
        )}

        {panel === 'warnings' && (
          <div
            role="menu"
            aria-label={S.unfrozenTitle}
            className="absolute right-5 top-[52px] z-40 w-max min-w-[16rem] max-w-[28rem] rounded-xl border border-gray-100 bg-white p-3 shadow-2xl"
          >
            <p className="mb-1.5 flex items-center gap-1.5 text-[12.5px] italic text-gray-400">
              <TriangleAlert size={13} className="shrink-0" aria-hidden="true" />
              {S.cardTitle(unfrozen.length)}
            </p>
            <ul className="mb-2.5 list-disc space-y-0.5 pl-[18px] text-[12.5px] text-gray-400">
              {unfrozen.map((r) => (
                <li key={`${r.url}-${r.reason}`} className="[overflow-wrap:anywhere]">
                  {S.resourceLine(resourceLabel(r.url), S.reason(r.reason))}
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={onRetryFreeze}
              disabled={retryingFreeze}
              aria-busy={retryingFreeze}
              data-focus-item="html-retry"
              className={CARD_ACTION_BTN_DISABLEABLE}
            >
              {retryingFreeze
                ? <Loader2 size={11} className="animate-spin" aria-hidden="true" />
                : <RefreshCw size={11} aria-hidden="true" />}
              {S.retry}
            </button>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 p-4">
        {embed ? (
          <iframe
            ref={frameRef}
            data-testid="html-source-frame"
            title={S.frameTitle(source.title)}
            src={embed.url}
            sandbox={SANDBOX}
            onLoad={handleFrameLoad}
            // Literal white paper (STYLE.md fixed constants): the page assumes a white canvas
            // and `bg-white` would turn dark in Matrix.
            style={{ backgroundColor: '#fff' }}
            className="h-full w-full rounded-xl border border-gray-200 shadow-sm"
          />
        ) : embedFailed ? (
          <p className="text-[13px] text-gray-500">{S.loadFailed}</p>
        ) : (
          <p className="flex items-center gap-2 text-[13px] text-gray-500" aria-busy="true">
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            {S.loading}
          </p>
        )}
      </div>
    </div>
  );
}
