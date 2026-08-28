/**
 * components/VideoPane/index.tsx
 *
 * The video pane in the middle column — the video counterpart of PdfView
 * (design/mockup-youtube-embed-layout.html, variant C, user decision
 * 2026-08-15). The video plays embedded; underneath stand the chapters of the
 * Video overview, and the toolbar switches that space to the raw transcript.
 * Default view is Chapters (user decision).
 *
 * Why a bare iframe with `enablejsapi=1` instead of YouTube's IFrame Player
 * API: the API means loading a script from youtube.com into the renderer,
 * which Electron's CSP would have to allow. The postMessage protocol behind
 * that script is all this pane needs — one `seekTo` command out, and the
 * player's own `infoDelivery` events back in for the running time.
 *
 * The protocol has one detail that cost a user report (measured in the running
 * app 2026-08-15): the registration must name the widget channel,
 * `{event:'listening', id:1, channel:'widget'}`. Without `channel` the player
 * answers `alreadyInitialized` and then stays silent — no `infoDelivery`, no
 * running time, so the chapter mark froze on whatever was clicked last while
 * the video played on into later chapters. With the channel, currentTime
 * arrives about four times a second.
 */

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ArrowRight, ExternalLink, FileText, List, MonitorOff, TvMinimalPlay } from 'lucide-react';
import { useStrings } from '../../strings';
import type { HighlightColor, TranscriptHighlight, Video } from '../../types';
import { formatDuration } from '../../video/format';
import { activeChapterIndex, parseChapters } from '../../markdown/chapters';
import { lastTimeMark } from '../../markdown/timeLinks';
import { activeBlockIndex, parseTranscriptBlocks } from '../../markdown/transcriptBlocks';
import { showFlashGlow } from '../../flashGlow';

const PLAYER_ORIGIN = 'https://www.youtube.com';
// Kanal und Kennung, unter denen ein enablejsapi-Player Befehle annimmt UND
// seine Spielzeit meldet. Ohne `channel` antwortet er `alreadyInitialized` und
// bleibt dann für immer still (im Browser gemessen 2026-08-15).
const PLAYER_CHANNEL = 'widget';
const PLAYER_ID = 1;
const HANDSHAKE_INTERVAL_MS = 400;
// So viele verspätete Zeitmeldungen werden nach einem Sprung verworfen. Der
// Player meldet etwa viermal pro Sekunde, das sind also rund drei Sekunden
// Geduld — danach glaubt die Pane wieder dem Player.
const STALE_REPORTS_MAX = 12;
// Length of the glow on the way back — the same 1.35 s the chat's range flash
// runs (FLASH_MS in ChatArea/index.tsx; change both together).
const FLASH_MS = 1350;
// How the pane decides that a smooth scroll has come to rest: poll the
// position, and treat two unchanged readings as "standing still". Cheaper and
// more portable than `scrollend`, which does not fire at all when the target
// was already in view.
const SCROLL_SETTLE_TICK_MS = 100;
// Ceiling for that wait — a mark 5637 px down needed 1.5 s (measured
// 2026-08-16), so this is generous without ever losing the glow.
const SCROLL_SETTLE_MAX_MS = 2500;
// So oft wird ein offenbar verschluckter Sprung wiederholt.
const SEEK_RETRIES_MAX = 3;
// Vorlauf eines Sprungs: die Marken sind grobe 30-Sekunden-Absätze, also landet
// ein Sprung zwei Sekunden früher — sonst mitten im Satz.
const SEEK_RUN_UP = 2;

export interface VideoPaneHandle {
  /** Play from `seconds` — what a time mark in the chat calls. */
  seekTo: (seconds: number) => void;
  /**
   * The way back from a quote or a branch: open the view the mark lives in,
   * scroll it into sight, let it GLOW like a highlighted passage in the chat
   * (user request 2026-08-16), and put the player on its second.
   */
  showHighlight: (highlightId: string) => void;
}

interface Props {
  video: Video;
  /** Raw markdown of the Video overview; its headings become the chapters. */
  overview?: string | null;
  /**
   * Asked for once when the transcript view opens on a video whose transcript
   * is not in memory yet — the state right after an import, where only the
   * import response (without the text) has arrived. Keeps the fetch lazy: a
   * reader who stays on the chapters never pays for it.
   */
  onRequestTranscript?: () => void;
  /**
   * The overview is being written right now. Without it the pane cannot tell
   * "no answer yet" from "the answer is arriving", and the empty state told
   * the user to ask a question that structurePrompt() already sent for them
   * (design/mockup-truncated-answer.html §02).
   */
  overviewStreaming?: boolean;
  /** The overview ended mid-thought — the chapters stop early for a reason. */
  overviewTruncated?: boolean;
  /**
   * A continuation round is running right now. While it is, the pane says
   * "writing" and the card stays quiet: between two automatic rounds the card
   * used to flash up and invite a click for something already under way (user
   * report 2026-08-18).
   */
  overviewContinuing?: boolean;
  /**
   * The overview reads as finished and still stops well before the video ends
   * (Flash Lite covered 16:16 of 1:06:31 and reported `finish=stop`,
   * 2026-08-18). Same card, honest wording: nothing broke off here.
   */
  overviewStoppedEarly?: boolean;
  /** Continue the cut-off overview; same exit as the card in the chat. */
  onContinueOverview?: () => void;
  /**
   * A passage was selected in the transcript. Carries the second of the block
   * it starts in — read from the block, never picked by the reader (user
   * decision 2026-08-16), so the way back can land on the text AND the moment.
   */
  onTranscriptSelection?: (sel: {
    text: string;
    seconds: number | null;
    /** Character offsets into the RAW transcript — the anchor of a mark. */
    startOffset: number;
    endOffset: number;
    x: number;
    y: number;
  }) => void;
  /** Saved colored marks of this video — transcript AND chapter passages. */
  transcriptHighlights?: TranscriptHighlight[];
  /** Click on a mark that opened a branch: go to that chat. */
  onOpenHighlightChat?: (chatId: string) => void;
  /**
   * A passage was selected in a CHAPTER (user request 2026-08-16). Chapters
   * are the model's own writing, so a branch from here quotes the overview,
   * not the source — but the second still comes along, because a chapter
   * knows exactly where in the video it belongs.
   */
  onChapterSelection?: (sel: {
    text: string;
    seconds: number | null;
    x: number;
    y: number;
  }) => void;
  ref?: React.Ref<VideoPaneHandle>;
}

/**
 * Respektiert die System-Einstellung „Bewegung reduzieren": dort wird das
 * Mitscrollen der Liste ein harter Sprung statt einer Fahrt.
 */
function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

// Saturated pastels, identical to the PDF and chat marks — a color means the
// same thing on every surface (HIGHLIGHT_BG_CLASS in PdfView).
const HIGHLIGHT_BG_CLASS: Record<HighlightColor, string> = {
  yellow: 'bg-[#FEF08A]',
  green: 'bg-[#BBF7D0]',
  blue: 'bg-[#BFDBFE]',
  pink: 'bg-[#FBCFE8]',
  orange: 'bg-[#FED7AA]',
};

/**
 * One block's text, cut into plain and colored pieces.
 *
 * Deliberately plain React nodes rather than the CSS Custom Highlight API the
 * chat uses: a transcript block is unformatted text, so slicing it needs no
 * DOM walking — and ::highlight() paints only the inline box, which the chat
 * had to work around (project note 2026-08-14). Marks may overlap; the piece
 * boundaries are simply every start and end that falls inside the block.
 */
function paintBlock(
  text: string,
  blockOffset: number,
  highlights: TranscriptHighlight[] | undefined,
  opts: {
    /** Which marks belong to this text — transcript blocks or chapter text. */
    source: 'transcript' | 'chapter';
    testId: string;
    onOpenChat?: (chatId: string) => void;
    /** The mark that should glow right now, if it is in this text. */
    flashId?: string | null;
  },
): React.ReactNode {
  if (!highlights || highlights.length === 0) return text;
  const blockEnd = blockOffset + text.length;
  const inside = highlights.filter(
    h => (h.source ?? 'transcript') === opts.source &&
      h.endOffset > blockOffset && h.startOffset < blockEnd,
  );
  if (inside.length === 0) return text;

  const cuts = new Set<number>([0, text.length]);
  for (const h of inside) {
    cuts.add(Math.max(0, h.startOffset - blockOffset));
    cuts.add(Math.min(text.length, h.endOffset - blockOffset));
  }
  const bounds = [...cuts].sort((a, b) => a - b);

  const pieces: React.ReactNode[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const from = bounds[i];
    const to = bounds[i + 1];
    if (from === to) continue;
    const at = blockOffset + from;
    // The LAST mark covering this piece wins its color — the same rule as
    // recoloring: the newest decision is the visible one.
    const covering = inside.filter(h => h.startOffset <= at && h.endOffset >= blockOffset + to);
    const chunk = text.slice(from, to);
    if (covering.length === 0) {
      pieces.push(chunk);
      continue;
    }
    const top = covering[covering.length - 1];
    // A mark that opened a branch is a way IN, exactly like a linked
    // highlight in the chat or on the page (user request 2026-08-16): click
    // it and you are in that chat. role="button" rather than <button> for the
    // same reason the row is one — the text has to stay selectable.
    const linked = Boolean(top.childChatId && opts.onOpenChat);
    pieces.push(
      <span
        key={`${from}-${to}`}
        data-testid={opts.testId}
        data-highlight-id={top.id}
        data-color={top.color}
        data-flash={top.id === opts.flashId ? 'true' : undefined}
        {...(linked
          ? {
              role: 'button',
              tabIndex: 0,
              onClick: (e: React.MouseEvent) => {
                // The row underneath would otherwise seek the video as well —
                // one click, one destination.
                e.stopPropagation();
                if (window.getSelection()?.toString().trim()) return;
                opts.onOpenChat!(top.childChatId!);
              },
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                e.stopPropagation();
                opts.onOpenChat!(top.childChatId!);
              },
            }
          : null)}
        className={`rounded-[2px] ${HIGHLIGHT_BG_CLASS[top.color]} ${
          linked ? 'cursor-pointer syflo-mark-linked' : ''
        }`}
      >
        {chunk}
      </span>,
    );
  }
  return pieces;
}

/** "465" → "7:45"; the chips read like the transcript's minute marks. */
function markOf(seconds: number): string {
  return formatDuration(seconds) ?? '0:00';
}

export function VideoPane({
  video, overview, onRequestTranscript, overviewStreaming, overviewTruncated, overviewStoppedEarly, overviewContinuing, onContinueOverview,
  onTranscriptSelection, transcriptHighlights, onChapterSelection, onOpenHighlightChat, ref,
}: Props) {
  const S = useStrings().videoPane;
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Ziel eines laufenden Sprungs plus Zähler der verworfenen Altmeldungen.
  const pendingSeekRef = useRef<{
    /** Die Sekunde, die wir dem Player geschickt haben (mit Vorlauf). */
    command: number;
    /** Die GEMEINTE Sekunde — Kapitel- bzw. Absatzanfang. */
    intent: number;
    /** Hat der Player das Sprungziel erreicht? Dann kein Nachfassen mehr. */
    arrived: boolean;
    ignored: number;
    retries: number;
  } | null>(null);
  const [view, setView] = useState<'chapters' | 'transcript'>('chapters');
  const [currentSeconds, setCurrentSeconds] = useState(0);
  const [embedBlocked, setEmbedBlocked] = useState(false);

  const chapters = useMemo(() => parseChapters(overview ?? ''), [overview]);
  // How far the cut-off overview got — the reader's first question when the
  // list stops early is "up to where?".
  const lastMark = useMemo(() => lastTimeMark(overview ?? ''), [overview]);
  // Being written — the first draft or a continuation round. The reader cannot
  // tell those apart and should not have to: both mean "not yet, wait".
  const writing = Boolean(overviewStreaming || overviewContinuing);
  const blocks = useMemo(() => parseTranscriptBlocks(video.transcript ?? ''), [video.transcript]);
  const duration = formatDuration(video.duration_seconds);

  /** Is the user holding a real text selection right now? */
  const hasTextSelection = useCallback(() => {
    const sel = window.getSelection();
    return Boolean(sel && !sel.isCollapsed && sel.toString().trim().length > 0);
  }, []);

  /**
   * Hand a finished selection upstairs, with the position the popup should
   * open at. Chrome snaps the caret so a drag can end on a collapsed
   * selection — those are ignored rather than reported as empty passages.
   */
  const reportSelection = useCallback((block: { seconds: number | null; offset: number }) => {
    if (!onTranscriptSelection) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const raw = sel.toString();
    const text = raw.trim();
    if (!text) return;
    const range = sel.getRangeAt(0);
    // The anchor: where this passage sits in the RAW transcript. The range's
    // own offset is relative to the block's text node, so the block's offset
    // carries it the rest of the way. Leading whitespace the user dragged
    // over is trimmed off both ends, or the mark would paint a gap.
    const lead = raw.length - raw.trimStart().length;
    const startOffset = block.offset + range.startOffset + lead;
    const rect = range.getBoundingClientRect?.();
    onTranscriptSelection({
      text,
      seconds: block.seconds,
      startOffset,
      endOffset: startOffset + text.length,
      x: rect ? rect.left + rect.width / 2 : 0,
      y: rect ? rect.bottom : 0,
    });
  }, [onTranscriptSelection]);

  /** Same as reportSelection, but for chapter text — no offsets, no anchor. */
  const reportChapterSelection = useCallback((seconds: number | null) => {
    if (!onChapterSelection) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const text = sel.toString().trim();
    if (!text) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect?.();
    onChapterSelection({
      text,
      seconds,
      x: rect ? rect.left + rect.width / 2 : 0,
      y: rect ? rect.bottom : 0,
    });
  }, [onChapterSelection]);

  // One command down the postMessage channel the `enablejsapi` player listens
  // on. Marks are coarse 30-second paragraphs (buildTranscriptText), so a jump
  // lands near the sentence, not on it — two seconds of run-up hide that.
  const postSeek = useCallback((target: number) => {
    const frame = frameRef.current?.contentWindow;
    if (!frame) return;
    frame.postMessage(
      JSON.stringify({ event: 'command', func: 'seekTo', args: [target, true] }),
      '*',
    );
    // A jump must not wake a PAUSED player (user request 2026-08-16) — but it
    // must also not freeze an unstarted one. Pausing a player that never
    // played leaves a black frame: it has left the poster behind and has no
    // picture to show yet (user report with the black video, same day). So
    // the extra pause goes out for state 2 (paused) and 0 (ended) only;
    // unstarted and cued keep the old behaviour of playing from the mark.
    // Twice, a beat apart: playback resumes slightly AFTER the seek is
    // processed, so a pause in the same tick would arrive too early.
    const st = playerStateRef.current;
    if (st !== 2 && st !== 0) return;
    const pause = () =>
      frameRef.current?.contentWindow?.postMessage(
        JSON.stringify({ event: 'command', func: 'pauseVideo', args: [] }),
        '*',
      );
    pause();
    window.setTimeout(pause, 250);
  }, []);

  // The mark that is glowing right now (way back from a quote or branch).
  const [flashId, setFlashId] = useState<string | null>(null);
  // The list's scroller — shared by the follow-along scrolling further down
  // and by showHighlight, which brings a mark into sight.
  const listRef = useRef<HTMLDivElement>(null);
  // The scroller of the list — shared by the follow-along scrolling below and
  // by showHighlight, which has to bring a mark into sight.

  // Set while ONE jump is in flight on a player that never played: the pause
  // that follows it waits for the first frame.
  const brakeOnFirstFrameRef = useRef(false);

  // The player's own state, as it reports it: -1 unstarted, 0 ended,
  // 1 playing, 2 paused, 3 buffering, 5 cued. A ref, not React state — it is
  // read inside the seek path, where a re-render would restart the list.
  const playerStateRef = useRef<number>(-1);

  const seekTo = useCallback((seconds: number) => {
    const target = Math.max(0, Math.floor(seconds) - SEEK_RUN_UP);
    // A player the reader never started must not keep playing (user request
    // 2026-08-16) — and it must still show the moment it jumped to, not the
    // channel's poster (same day, third round: `&start=` in the URL shows the
    // poster). There is only one way to have both: jump, let the player reach
    // the frame, and brake the instant it reports that it is playing. Pausing
    // any earlier leaves a black rectangle — it has dropped the poster but
    // has no picture yet.
    if (playerStateRef.current === -1 || playerStateRef.current === 5) {
      brakeOnFirstFrameRef.current = true;
    }
    postSeek(target);
    // Ein Sprung ist unterwegs: der Player meldet danach noch einige Male die
    // ALTE Stelle (Nutzer-Report mit Bild 2026-08-15 — die Marke zuckte erst
    // zum früheren Kapitel und dann zum angeklickten). Diese Meldungen werden
    // verworfen, bis die neue Stelle gemeldet ist.
    // Geprüft wird gegen die GEMEINTE Sekunde, nicht gegen das Sprungziel: der
    // Vorlauf von zwei Sekunden würde die Marke sonst nach jedem Sprung erst auf
    // das vorige Kapitel setzen (genau das Rückzucken aus dem Report).
    pendingSeekRef.current = { command: target, intent: seconds, arrived: false, ignored: 0, retries: 0 };
    setCurrentSeconds(seconds);
  }, [postSeek]);

  const showHighlight = useCallback((highlightId: string) => {
    const mark = (transcriptHighlights ?? []).find(h => h.id === highlightId);
    if (!mark) return;
    // The mark decides the view: a chapter passage is not in the transcript.
    setView((mark.source ?? 'transcript') === 'chapter' ? 'chapters' : 'transcript');
    if (mark.startSeconds !== null) seekTo(mark.startSeconds);

    // Scroll FIRST, glow AFTER (user request 2026-08-16). A mark twenty rows
    // down would otherwise burn its 1.35 s while the list is still travelling,
    // and the reader arrives at a mark that has already stopped signalling.
    const glow = () => {
      setFlashId(highlightId);
      // Three soft pulses (3 × 0.45 s, the shared rule in index.css). The mark
      // is cleared when the ANIMATION ends, not on a timer of the same length:
      // a timer starts here, the animation only after React has painted the
      // attribute, so the two are off by a frame or two — measured 2026-08-16,
      // the animation was cut at 1283 ms of 1350 and the third pulse ended
      // abruptly instead of fading out ("es glüht nicht 3 mal auf").
      const clear = () => setFlashId(current => (current === highlightId ? null : current));
      window.setTimeout(() => {
        const el = listRef.current?.querySelector(`[data-highlight-id="${highlightId}"]`);
        el?.addEventListener('animationend', clear, { once: true });
        // Fallback for a browser that never fires it, and for a mark whose
        // animation was interrupted by a re-render.
        window.setTimeout(clear, FLASH_MS + 400);
      }, 0);
    };

    // One tick for the view switch to render the row it lives in.
    window.setTimeout(() => {
      const scroller = listRef.current;
      const el = scroller?.querySelector(`[data-highlight-id="${highlightId}"]`);
      if (!el) return void glow(); // nothing to scroll to — still say where it is
      const reduced = prefersReducedMotion();
      el.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
      if (reduced || !scroller) return void glow();
      // Wait for the list to actually COME TO REST before glowing. A fixed
      // delay is not enough: measured 2026-08-16, a mark 5637 px down took
      // 1.5 s to reach, while a 600 ms fallback started the glow mid-flight —
      // exactly the "scroll first, then glow" the user asked for, missed by
      // a second. So the position is polled until it stops changing, which
      // also covers a mark that was already in view (no movement at all).
      let last = scroller.scrollTop;
      let still = 0;
      let waited = 0;
      const tick = window.setInterval(() => {
        waited += SCROLL_SETTLE_TICK_MS;
        const now = scroller.scrollTop;
        still = now === last ? still + 1 : 0;
        last = now;
        // Two quiet ticks = standing still; the ceiling keeps a scroll that
        // never settles (a list still loading) from swallowing the glow.
        if (still >= 2 || waited >= SCROLL_SETTLE_MAX_MS) {
          window.clearInterval(tick);
          glow();
        }
      }, SCROLL_SETTLE_TICK_MS);
    }, 0);
  }, [transcriptHighlights, seekTo]);

  useImperativeHandle(ref, () => ({ seekTo, showHighlight }), [seekTo, showHighlight]);

  // Der Halo um die aufglühende Marke — dieselbe Gruppe wie im PDF und im Chat
  // (flashGlow.ts, Nutzerwunsch 2026-08-16: überall soll die ganze markierte
  // Stelle aufglühen). Die Fläche hellt CSS auf, den farbigen Schein legt das
  // Overlay darüber. Die Marken kommen aus einem Ref, damit eine neue
  // Prop-Identität den laufenden Puls nicht neu startet.
  const marksRef = useRef<TranscriptHighlight[] | undefined>(transcriptHighlights);
  marksRef.current = transcriptHighlights;
  useEffect(() => {
    if (!flashId) return;
    const scroller = listRef.current;
    const color = (marksRef.current ?? []).find(h => h.id === flashId)?.color;
    if (!scroller || !color) return;
    // Bei jedem Frame neu gesucht: eine Marke kann über mehrere Spans laufen
    // (Kapitel-Titel + Kernaussage), und die Liste rendert währenddessen weiter.
    const targets = () => Array.from(scroller.querySelectorAll(`[data-highlight-id="${flashId}"]`));
    if (targets().length === 0) return;
    return showFlashGlow({ targets, color, clip: scroller });
  }, [flashId]);

  // Solange false, klopft die Anmeldung weiter (siehe Dateikopf).
  const [playerListening, setPlayerListening] = useState(false);

  // The player talks back once it is asked to: `listening` starts the stream of
  // infoDelivery events that carry currentTime, and onError 101/150 is the
  // channel saying the uploader forbade embedding.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== PLAYER_ORIGIN) return;
      let data: unknown;
      try {
        data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      if (!data || typeof data !== 'object') return;
      const msg = data as {
        event?: string;
        info?: { currentTime?: number; playerState?: number } | number;
      };
      if (msg.event === 'onError') {
        const code = typeof msg.info === 'number' ? msg.info : undefined;
        if (code === 101 || code === 150) setEmbedBlocked(true);
        return;
      }
      if (typeof msg.info === 'object' && typeof msg.info?.playerState === 'number') {
        playerStateRef.current = msg.info.playerState;
        // The one braked jump: the player has just started, so it now has a
        // picture at the mark — hold it there. Cleared right away, so every
        // later play (the reader's own) runs untouched.
        if (msg.info.playerState === 1 && brakeOnFirstFrameRef.current) {
          brakeOnFirstFrameRef.current = false;
          frameRef.current?.contentWindow?.postMessage(
            JSON.stringify({ event: 'command', func: 'pauseVideo', args: [] }),
            '*',
          );
        }
      }
      if (typeof msg.info === 'object' && typeof msg.info?.currentTime === 'number') {
        setPlayerListening(true);
        const reported = msg.info.currentTime;
        const pending = pendingSeekRef.current;
        if (pending) {
          if (reported + 0.5 >= pending.command) {
            // Sprung ist angekommen: nicht mehr nachfassen. Die Anzeige bleibt
            // aber bei der GEMEINTEN Sekunde, bis der Player sie erreicht hat —
            // die zwei Sekunden Vorlauf liegen im Abschnitt DAVOR, und genau die
            // sah der Nutzer als „springt zuerst zum früheren" (Report
            // 2026-08-16).
            pending.arrived = true;
            if (reported + 0.5 < pending.intent) return;
            pendingSeekRef.current = null;
          } else if (pending.ignored < STALE_REPORTS_MAX) {
            // Verspätete Meldung von vor dem Sprung — verwerfen.
            pending.ignored++;
            // Rührt sich der Player gar nicht, war der Befehl verschluckt: ein
            // Klick direkt nach dem Laden trifft einen Player, der noch nicht
            // bereit ist (live beobachtet 2026-08-16 — die Marke fiel danach auf
            // Kapitel 1 zurück). Also nachfassen, ein paar Mal.
            if (!pending.arrived && pending.ignored % 4 === 0 && pending.retries < SEEK_RETRIES_MAX) {
              pending.retries++;
              postSeek(pending.command);
            }
            return;
          } else {
            // Der Sprung ist offenbar nicht angekommen. Dann gilt wieder, was
            // der Player sagt: lieber eine unerwartete Marke als eine falsche.
            pendingSeekRef.current = null;
          }
        }
        setCurrentSeconds(reported);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [postSeek]);

  // Anmeldung beim Player: wiederholt, bis die erste Zeit gemeldet wurde. Ein
  // an `load` gebundener Handschlag käme zu spät — das Ereignis ist meist
  // vorbei, bevor dieser Effekt hängt (gemessen 2026-08-15).
  useEffect(() => {
    if (playerListening || embedBlocked) return;
    const knock = () =>
      frameRef.current?.contentWindow?.postMessage(
        JSON.stringify({ event: 'listening', id: PLAYER_ID, channel: PLAYER_CHANNEL }),
        '*',
      );
    knock();
    const timer = window.setInterval(knock, HANDSHAKE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [playerListening, embedBlocked, video.youtube_id]);

  // Die angeklickte Zeile behält ihre Marke, solange das Video in ihrem
  // Abschnitt läuft. Nötig, weil ein Unterpunkt oft dieselbe Startsekunde trägt
  // wie sein Hauptabschnitt (gemessen: 07:48 zweimal) — ohne das leuchtet nach
  // einem Klick auf den Hauptabschnitt die Zeile darunter.
  const [clickedIndex, setClickedIndex] = useState<number | null>(null);

  const jumpToChapter = (index: number) => {
    setClickedIndex(index);
    seekTo(chapters[index].startSeconds);
  };

  const clickedStillRunning = (): boolean => {
    if (clickedIndex === null || !chapters[clickedIndex]) return false;
    const c = chapters[clickedIndex];
    const next = chapters
      .slice(clickedIndex + 1)
      .find((later) => later.startSeconds > c.startSeconds)?.startSeconds;
    // Bis zur nächsten ANDEREN Startmarke, nicht bis zum Ende des eigenen
    // Bereichs: sonst klebt die Marke nach einem Klick auf einen
    // Hauptabschnitt minutenlang oben, während seine Unterpunkte längst laufen
    // — genau die Beschwerde „das Kapitelfenster zeigt den früheren Teil".
    const until = next ?? c.endSeconds ?? Infinity;
    // Der Vorlauf gehört noch zur angeklickten Zeile: sonst leuchtet in diesen
    // zwei Sekunden das Kapitel davor.
    return currentSeconds + SEEK_RUN_UP + 0.5 >= c.startSeconds && currentSeconds < until;
  };

  const activeChapter = clickedStillRunning()
    ? (clickedIndex as number)
    : activeChapterIndex(chapters, currentSeconds);
  const activeBlock = activeBlockIndex(blocks, currentSeconds);

  // Die Liste folgt dem Video (Nutzerwunsch 2026-08-16): wechselt die laufende
  // Zeile, wird sie in den sichtbaren Bereich geholt. Nur beim WECHSEL, nicht
  // bei jeder Zeitmeldung — sonst ruckelt die Spalte viermal pro Sekunde.

  const followed = view === 'chapters' ? activeChapter : activeBlock;
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('[aria-current="true"]');
    if (row && typeof row.scrollIntoView === 'function') {
      // 'center' statt 'nearest': nearest klebt die laufende Zeile an den
      // unteren Rand, dann sieht man nicht, was als Nächstes kommt (im Browser
      // gemessen 2026-08-16: Abstand nach unten 0 px).
      // Gleitend statt springend (Nutzerwunsch 2026-08-16) — außer das System
      // bittet um weniger Bewegung, dann bleibt der Sprung.
      row.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }
  }, [followed, view]);

  return (
    <div
      data-testid="video-pane"
      // The middle column's source, so the same keyboard region the PDF pane
      // is (ADR-0011). Without it the ring walked from the sidebar straight
      // into the chat and the whole video column was unreachable by keyboard
      // (user report 2026-08-17).
      data-focus-region="source"
      // @container: die Werkzeugleiste richtet sich nach der BREITE DER SPALTE,
      // nicht des Fensters. In einem 914-px-Fenster bleiben der Mittelspalte
      // gemessene 314 px (2026-08-15) — dort ist für den Titel kein Platz, und
      // ohne diese Regel schrumpfte er auf „An…".
      className="syflo-video-pane @container flex min-w-0 flex-1 flex-col overflow-hidden bg-gray-100"
    >
      {/* Kopfzeile = das frühere Quellen-Banner (Nutzerwunsch 2026-08-15: „ich
          mag, wie es früher aussah"): Badge, fetter Titel, gedämpfte Zeile mit
          Kanal und Dauer — dieselbe Form wie VideoBanner, damit sich die Spalte
          in den Rest der App einfügt. Der Ansichts-Umschalter sitzt jetzt unten
          an der Liste, die er umschaltet, nicht hier oben. */}
      <div className="flex shrink-0 items-center gap-3 border-b border-gray-200 bg-white px-5 py-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
          <TvMinimalPlay size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-gray-900" title={video.title}>
            {video.title}
          </p>
          <p className="truncate text-[11.5px] text-gray-500">
            {video.channel}
            {duration ? `${video.channel ? ' · ' : ''}${duration}` : ''}
          </p>
        </div>
      </div>

      {/* The player. Kept mounted when embedding is blocked would be pointless,
          so that case swaps in a card instead — and stays out of red, because
          the source itself is fine (mockup § 06). */}
      {embedBlocked ? (
        <div
          data-testid="video-embed-blocked"
          className="m-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
        >
          <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-lg bg-gray-100 text-gray-500">
            <MonitorOff size={16} />
          </div>
          <h3 className="mb-1 text-[13.5px] font-semibold text-gray-900">{S.embedBlockedTitle}</h3>
          <p className="text-[12.5px] leading-relaxed text-gray-500">{S.embedBlockedBody}</p>
          <a
            href={video.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100"
          >
            <ExternalLink size={12} />
            {S.watchOnYouTube}
          </a>
        </div>
      ) : (
        <div className="shrink-0 px-3 pt-4 pb-3">
          <div className="mx-auto aspect-video w-full max-w-[52rem] overflow-hidden rounded-xl bg-gray-900 shadow-lg">
            <iframe
              ref={frameRef}
              data-testid="video-player-frame"
              title={video.title}
              src={`${PLAYER_ORIGIN}/embed/${video.youtube_id}?enablejsapi=1&rel=0`}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              className="h-full w-full border-0"
            />
          </div>
        </div>
      )}

      {/* Chapters (default) or the raw transcript — one space, two readings.
          Der Umschalter gehört zu diesem Fenster und steht deshalb HIER, in
          seiner Kopfzeile (Nutzerwunsch 2026-08-15), nicht oben in der Leiste
          der Quelle. */}
      {/* EINE rechte Kante für Player, Umschalter und Rollbalken (Nutzerwunsch
          2026-08-16). Die Karten enden dafür etwas früher — der Rollbalken
          braucht seine 6 px, und der harte Schatten der markierten Karte
          weitere 4 px. */}
      <div className="flex min-h-0 flex-1 flex-col px-3 pb-4">
        {/* Nur der Umschalter — die Beschriftung („KAPITEL · AUS DER ÜBERSICHT")
            ist raus (Nutzerwunsch 2026-08-16): die beiden Tasten sagen schon,
            was man sieht. */}
        <div className="flex shrink-0 items-center justify-end py-2">
          <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-gray-200 bg-white px-1 py-0.5">
            <button
              type="button"
              data-testid="video-view-chapters"
              data-focus-item="video-view-chapters"
              aria-pressed={view === 'chapters'}
              onClick={() => setView('chapters')}
              className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors ${
                view === 'chapters'
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'
              }`}
            >
              <List size={13} />
              {S.chapters}
            </button>
            <button
              type="button"
              data-testid="video-view-transcript"
              data-focus-item="video-view-transcript"
              aria-pressed={view === 'transcript'}
              onClick={() => {
                setView('transcript');
                if (!video.transcript) onRequestTranscript?.();
              }}
              className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors ${
                view === 'transcript'
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'
              }`}
            >
              <FileText size={13} />
              {S.transcript}
            </button>
          </div>
        </div>

        {/* px-1 py-1 ist kein Zierrand: `overflow-y-auto` schneidet auch
            waagerecht ab, und ohne diese Luft lag der Ring der markierten Karte
            außerhalb des Fensters (Nutzer-Report mit Bild 2026-08-16 — dieselbe
            Falle wie beim Fokusring der Tastatur-Navigation). */}
        {/* Rechts mehr Innenluft als links: der Rollbalken sitzt am rechten Rand
            des Scrollers, und der harte Schatten der markierten Karte ragt 4 px
            heraus — bei 3,7 px Abstand berührten sich beide (gemessen
            2026-08-16). Der Scroller reicht dafür näher an den Spaltenrand. */}
        {/* Chapters and transcript blocks are a READING SEQUENCE, not a row of
            side-by-side controls (ADR-0011, same mark as the PDF's marks): two
            rows whose tops happen to fall within the row tolerance must still
            answer to ↑ ↓, and ← must mean "leave the column". The switch above
            stays outside this scroller and keeps its ← →. */}
        <div
          ref={listRef}
          data-focus-axis="sequence"
          className="min-h-0 flex-1 overflow-y-auto py-2 pr-2 pl-0.5"
        >
        {view === 'chapters' ? (
          chapters.length > 0 || writing ? (
            <div data-testid="video-chapters" className="flex flex-col gap-1">
              {chapters.map((c, i) => (
                <div
                  role="button"
                  tabIndex={0}
                  key={`${c.startSeconds}-${i}`}
                  data-testid="video-chapter"
                  // One keyboard item per chapter; ↵ jumps the player there,
                  // the same thing a click does.
                  data-focus-item={`chapter-${i}`}
                  // Unterabschnitte tragen ihre Ebene sichtbar (Einzug) und
                  // maschinenlesbar: eine "###"-Zeile ist kein zweiter
                  // Hauptabschnitt, auch wenn sie dieselbe Marke trägt.
                  data-level={c.level}
                  aria-current={i === activeChapter ? 'true' : undefined}
                  title={S.jumpTo(markOf(c.startSeconds))}
                  onMouseUp={() => reportChapterSelection(c.startSeconds)}
                  onClick={() => {
                    // A click that ends a selection must not seek — same rule
                    // as in the transcript (variant A).
                    if (hasTextSelection()) return;
                    jumpToChapter(i);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    jumpToChapter(i);
                  }}
                  style={c.level > 2 ? { marginLeft: `${(c.level - 2) * 0.9}rem` } : undefined}
                  // Markierte Zeile wie im Transkript (Nutzerwunsch 2026-08-16):
                  // ein Ring statt Rahmen PLUS Ring — die Doppellinie war es, die
                  // am Rand des Fensters abgeschnitten aussah — und die Zeitmarke
                  // gefüllt statt blass.
                  // syflo-chapter-in: die Karte blendet beim Ankommen ein und
                  // steigt 7 px auf (§03, Variante A). Sie hängt am Einhängen
                  // des Knotens — beim Rollen passiert nichts, beim Wachsen der
                  // Übersicht jede neue Zeile für sich.
                  className={`syflo-chapter-in flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors select-text ${
                    i === activeChapter
                      ? 'border-transparent bg-white shadow-sm ring-1 ring-blue-600'
                      : 'border-transparent bg-transparent hover:bg-white'
                  }`}
                >
                  {/* The time chip stays OUT of every selection (user decision
                      2026-08-16): it is a jump target, not a quote — dragging
                      across the row must never carry "07:30" into a question. */}
                  <span
                    data-chapter-mark=""
                    className={`shrink-0 rounded-md px-1.5 py-px font-mono text-[10.5px] font-medium select-none ${
                      i === activeChapter ? 'bg-blue-600 text-white' : 'bg-blue-50 text-blue-700'
                    }`}
                  >
                    {markOf(c.startSeconds)}
                  </span>
                  <span className="min-w-0 flex-1" data-chapter-text="">
                    <span className="block text-[12.5px] leading-snug font-semibold break-words text-gray-900">
                      {paintBlock(c.title, c.titleOffset, transcriptHighlights, {
                        source: 'chapter', testId: 'chapter-highlight', onOpenChat: onOpenHighlightChat, flashId,
                      })}
                    </span>
                    {c.keyPoint && (
                      <span className="mt-0.5 block text-[11.5px] leading-relaxed break-words text-gray-500">
                        {c.keyPointOffset !== null
                          ? paintBlock(c.keyPoint, c.keyPointOffset, transcriptHighlights, {
                              source: 'chapter', testId: 'chapter-highlight', onOpenChat: onOpenHighlightChat, flashId,
                            })
                          : c.keyPoint}
                      </span>
                    )}
                  </span>
                </div>
              ))}
              {/* The overview is still arriving: chapters appear one heading
                  at a time, so the row goes UNDER what already landed —
                  the list grows downwards, exactly as the answer does. */}
              {writing && (
                <div
                  data-testid="video-chapters-writing"
                  className="flex items-center gap-2 px-3 py-2.5 text-[11.5px] text-gray-500"
                >
                  <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-gray-200 border-t-gray-500" />
                  {S.chaptersWriting}
                </div>
              )}
              {/* It stopped early. This is where the reader NOTICES the gap,
                  so this is where the way out belongs — no scrolling back
                  into the chat to find the same button. */}
              {(overviewTruncated || overviewStoppedEarly) && !writing && (
                <div
                  data-testid="video-chapters-truncated"
                  className="mt-2 rounded-xl border border-dashed border-gray-300 bg-white px-4 py-3.5"
                >
                  <h3 className="mb-1 text-[12.5px] font-semibold text-gray-900">
                    {lastMark
                      ? overviewTruncated
                        ? S.chaptersCutAtMark(lastMark)
                        : S.chaptersShortAtMark(lastMark)
                      : S.chaptersCut}
                  </h3>
                  <p className="text-[11.5px] leading-relaxed text-gray-500">
                    {S.chaptersCutBody(duration ?? '')}
                  </p>
                  {onContinueOverview && (
                    <button
                      type="button"
                      data-testid="video-continue-button"
                      data-focus-item="video-continue"
                      onClick={onContinueOverview}
                      className="mt-2.5 inline-flex items-center gap-1 rounded-md border border-blue-100 bg-blue-50 px-2 py-1 text-[11.5px] font-semibold text-blue-700 transition-colors hover:bg-blue-100"
                    >
                      <ArrowRight size={11} className="shrink-0" />
                      {S.continueOverview}
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : overviewTruncated && !writing ? (
            <div
              data-testid="video-chapters-truncated"
              className="mt-2 rounded-xl border border-dashed border-gray-300 bg-white px-4 py-3.5"
            >
              <h3 className="mb-1 text-[12.5px] font-semibold text-gray-900">{S.chaptersCut}</h3>
              <p className="text-[11.5px] leading-relaxed text-gray-500">{S.chaptersCutBody(duration ?? '')}</p>
              {onContinueOverview && (
                <button
                  type="button"
                  data-testid="video-continue-button"
                  data-focus-item="video-continue"
                  onClick={onContinueOverview}
                  className="mt-2.5 inline-flex items-center gap-1 rounded-md border border-blue-100 bg-blue-50 px-2 py-1 text-[11.5px] font-semibold text-blue-700 transition-colors hover:bg-blue-100"
                >
                  <ArrowRight size={11} className="shrink-0" />
                  {S.continueOverview}
                </button>
              )}
            </div>
          ) : (
            <div
              data-testid="video-chapters-empty"
              className="mt-2 rounded-xl border border-dashed border-gray-300 bg-white px-4 py-4"
            >
              <h3 className="mb-1 text-[13px] font-semibold text-gray-900">{S.noChaptersTitle}</h3>
              <p className="text-[12.5px] leading-relaxed text-gray-500">{S.noChaptersBody}</p>
            </div>
          )
        ) : (
          <div data-testid="video-transcript" className="flex flex-col gap-1.5">
            {blocks.map((b, i) => (
              // A div with role="button", not a real <button>: text inside a
              // button cannot be dragged over in Chrome, and this row has to
              // do both (variant A of mockup-transcript-selection.html — drag
              // selects, a plain click still seeks). Same repair as the PDF
              // reference links, where anchors were eating the drag.
              <div
                role="button"
                tabIndex={0}
                key={i}
                data-testid="video-transcript-block"
                data-focus-item={`transcript-${i}`}
                aria-current={i === activeBlock ? 'true' : undefined}
                onMouseUp={() => reportSelection(b)}
                onClick={() => {
                  // A click that ENDS a selection must not seek — otherwise
                  // every highlight would jump the video away from the passage
                  // the reader just marked.
                  if (hasTextSelection()) return;
                  if (b.seconds !== null) seekTo(b.seconds);
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  if (b.seconds !== null) seekTo(b.seconds);
                }}
                className={`flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors select-text ${
                  i === activeBlock
                    ? 'bg-white shadow-sm ring-1 ring-blue-600'
                    : 'hover:bg-white'
                }`}
              >
                {b.time && (
                  <span
                    className={`shrink-0 rounded-md px-1.5 py-px font-mono text-[10.5px] font-medium ${
                      i === activeBlock ? 'bg-blue-600 text-white' : 'bg-blue-50 text-blue-700'
                    }`}
                  >
                    {b.time}
                  </span>
                )}
                <span
                  className={`text-[12.5px] leading-relaxed break-words ${
                    i === activeBlock ? 'text-gray-900' : 'text-gray-700'
                  }`}
                  data-transcript-text=""
                >
                  {paintBlock(b.text, b.offset, transcriptHighlights, { source: 'transcript', testId: 'transcript-highlight', onOpenChat: onOpenHighlightChat, flashId })}
                </span>
              </div>
            ))}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
