/**
 * components/CitationCard/index.tsx
 *
 * The card a clicked citation opens — in the running text and on a row of the
 * reference list alike, because those are the same thing
 * (design/mockup-paper-reference-links.html § 03–05).
 *
 * Four lines and two doors, nothing else: title, one meta line, two lines of
 * abstract-ish context, then the doors. No badge repeating the number just
 * clicked, no footnote explaining the buttons. THE STATE LIVES IN THE DOOR —
 * a paywalled work reads "No free PDF", one already imported reads "Go to
 * tree", one still downloading shows a spinner in the button that stays put.
 *
 * The shell is FloatingPopup's, deliberately: rounded-2xl, shadow-2xl, an
 * uppercase overline above the title, and a gray-50 footer whose buttons are
 * stacked, full-width and all blue-50 — "gleiche Fläche, gleiche Farbe, die
 * Reihenfolge allein kommuniziert die Priorität" (user decision 2026-07-20).
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  X, Globe, Download, ArrowRight, Search, Loader2, AlertTriangle, Clock,
  Calendar, BookOpen, Quote, BookMarked, ChevronDown,
} from 'lucide-react';
import type { PaperReference } from '../../types';
import { useStrings } from '../../strings';
import { MathText } from '../MathText';

export interface CitationCardTarget {
  reference: PaperReference;
  // Viewport point the card should sit next to (the clicked citation).
  x: number;
  y: number;
}

interface Props {
  target: CitationCardTarget | null;
  // Set when a tree already holds this work — the Syflo door becomes
  // "Go to tree" and can never create a duplicate.
  existingChatId?: string | null;
  // True while this reference's PDF is being fetched.
  loading?: boolean;
  // Set when the last attempt failed; the card says so and drops the door.
  failed?: boolean;
  // The silent full-text search (design/mockup-citation-card-standard.html
  // § 04). `searching` while the web is being asked, `searchDone` once it has
  // answered with nothing, `searchFailed` when the search backend itself was
  // unreachable — three different sentences, because only one of them is a
  // statement about the paper.
  searching?: boolean;
  searchDone?: boolean;
  searchFailed?: boolean;
  // When the search may be tried again, ISO — set when the engines shut us
  // out for asking too often. The card counts it down and retries itself.
  searchRetryAt?: string | null;
  onRetrySearch?: () => void;
  onClose: () => void;
  onOpenInSyflo: (reference: PaperReference) => void;
  onOpenInBrowser: (reference: PaperReference) => void;
  onGoToTree: (chatId: string) => void;
}

const MARGIN = 12;

/**
 * One width for every reference (design/mockup-citation-card-standard.html
 * § 02, user decision 2026-08-10). The card used to be `w-fit` between 280 and
 * 440px, so two clicks in a row opened two differently sized windows and the
 * doors landed somewhere else each time.
 *
 * 384 is measured, not chosen: the longest title in the stored corpus
 * ("Google's Neural Machine Translation System: …") fills exactly the three
 * lines the title is allowed. The known price is empty space beside a
 * two-word title — a fixed shell was rejected for that once (2026-08-09) and
 * is accepted now, because a window that keeps its size beats one that fits.
 */
const CARD_WIDTH = 384;

/**
 * Where a reference points on the open web, in order of directness. Never
 * null: even a row nothing could resolve carries its printed text, and
 * searching for that is exactly what the reader would do by hand — a dead
 * "Search the web" button was the one thing they could not click (user
 * report 2026-08-09).
 */
export function browserUrlFor(reference: PaperReference): string {
  if (reference.arxivId) return `https://arxiv.org/abs/${reference.arxivId}`;
  if (reference.doi) return `https://doi.org/${reference.doi}`;
  const query = reference.title || reference.parsedTitle || reference.rawText;
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

/**
 * One fact with its symbol. The icon replaces a "·" separator and carries an
 * aria-label, so a screen reader hears "Authors: …" where the eye sees a
 * pictogram.
 */
function MetaRow({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <p className="flex items-start gap-2 text-xs text-gray-500 leading-relaxed">
      <span className="shrink-0 mt-0.5 text-gray-400" aria-hidden="true">
        {icon}
      </span>
      <span className="sr-only">{label}: </span>
      {/* text-pretty, NOT text-balance: balance makes every line the same
          length, which on a three-line title deliberately shortens them all
          and leaves a wide gap on the right — the very thing being fixed
          (user report 2026-08-09). pretty only avoids a stranded last word. */}
      <span className="min-w-0 text-pretty">{children}</span>
    </p>
  );
}

export function CitationCard({
  target,
  existingChatId,
  loading = false,
  failed = false,
  searching = false,
  searchDone = false,
  searchFailed = false,
  searchRetryAt = null,
  onRetrySearch,
  onClose,
  onOpenInSyflo,
  onOpenInBrowser,
  onGoToTree,
}: Props) {
  const S = useStrings().citationCard;
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  // Variant 6 (user decision 2026-08-09): title and authors answer "do I want
  // to read this?"; year, venue and citation count are reference material and
  // stay folded until asked for. Collapses again for the next citation.
  const [unfolded, setUnfolded] = useState(false);
  useEffect(() => { setUnfolded(false); }, [target?.reference.id]);

  // Shut out for asking too often? Then the wait IS the fix, so the card does
  // the waiting: it ticks the seconds down in the door and fires the retry
  // itself when they run out (user decision 2026-08-11). Same shape as the
  // quota cards in MessageBubble — a disabled button that re-enables itself,
  // never one that can be clicked before it can work.
  const retryAtMs = searchRetryAt ? new Date(searchRetryAt).getTime() : null;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (retryAtMs === null) return;
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [retryAtMs]);
  const retryInSeconds = retryAtMs === null ? 0 : Math.max(0, Math.ceil((retryAtMs - nowMs) / 1000));
  // The wait, and its end. `resuming` is the instant the clock hits zero: the
  // retry has fired but its answer is not back yet, and the card must already
  // read as working — otherwise it falls back to the previous verdict for a
  // moment and reads as if nothing happened.
  const countingDown = retryAtMs !== null && retryInSeconds > 0 && !searching;
  const resuming = retryAtMs !== null && retryInSeconds <= 0;
  // Fires once, when the clock runs out — the reader never has to come back
  // and press anything.
  const firedRetryRef = useRef<number | null>(null);
  useEffect(() => {
    if (retryAtMs === null || retryInSeconds > 0) return;
    if (firedRetryRef.current === retryAtMs) return;
    firedRetryRef.current = retryAtMs;
    onRetrySearch?.();
  }, [retryAtMs, retryInSeconds, onRetrySearch]);

  // Sit just below-right of the click, clamped to the viewport against the
  // MEASURED height — the same approach FloatingPopup uses, for the same
  // reason: a card cut off at the bottom edge loses its doors.
  useLayoutEffect(() => {
    if (!target || !cardRef.current) return;
    const { width, height } = cardRef.current.getBoundingClientRect();
    const left = Math.min(target.x + 8, window.innerWidth - width - MARGIN);
    const top = Math.min(target.y + 14, window.innerHeight - height - MARGIN);
    setPos({ left: Math.max(MARGIN, left), top: Math.max(MARGIN, top) });
  }, [target]);

  // Escape closes, like every other transient surface in the app.
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [target, onClose]);

  if (!target) return null;
  const ref = target.reference;

  // A title from OpenAlex and one read off the page fill the SAME layout —
  // only the overline says which. What the reader cares about is whether
  // there is a title at all, not who supplied it.
  const title = ref.title || ref.parsedTitle;
  const fromPage = !ref.title && Boolean(ref.parsedTitle);
  const authors = ref.authors.length ? ref.authors : ref.parsedAuthors;
  const year = ref.year ?? ref.parsedYear;
  const canOpenInSyflo = Boolean(ref.pdfUrl);

  // The overline names the state worth naming — and "already a tree" outranks
  // where the metadata came from: a paper the reader has open in Syflo is not
  // "unidentified", whatever OpenAlex thinks (user report 2026-08-09).
  const overline = [
    ref.label ? S.reference(ref.label) : S.referenceGeneric,
    existingChatId ? S.alreadyATree : fromPage ? S.notIdentified : null,
  ]
    .filter(Boolean)
    .join(' · ');

  // Each fact gets its own line and its own icon. One long "·"-separated
  // string wrapped mid-separator and read as rubble (user report 2026-08-09);
  // with icons the separator IS the symbol, and the eye can jump straight to
  // "who" or "when" without reading the whole line.
  //
  // Nothing could be read out of the row? Then no meta at all — the printed
  // text is already shown above, and saying so adds a line and no information.
  const authorLine = title && authors.length
    ? authors.slice(0, 3).join(', ') + (authors.length > 3 ? ` ${S.etAl}` : '')
    : null;
  // The resolved venue beats the printed one: the row abbreviates ("In Proc.
  // EMNLP"), the record spells it out (2026-08-12).
  const venue = title ? ref.venue || ref.parsedVenue : null;
  // What the summary line offers, in the order it reads: when, where, weight.
  const foldedFacts = [
    year ? String(year) : null,
    venue,
    // Spelled out here: the folded line has no icon to explain a bare number.
    existingChatId ? S.openedAgo : ref.citations != null ? S.citationCountLong(ref.citations) : null,
  ].filter(Boolean) as string[];

  return (
    <div
      ref={cardRef}
      data-testid="citation-card"
      // CARD_WIDTH, always — see the constant for why the fit-to-content shell
      // had to go. The width is an inline style rather than a class so the
      // rule is one value, readable from the DOM and from a test.
      className="fixed z-50 flex flex-col bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden"
      style={{ left: pos.left, top: pos.top, width: CARD_WIDTH }}
    >
      <div className="shrink-0 flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-gray-100">
        {/* min-w-0 lets the title shrink inside the flex row instead of
            pushing the close button out of the fixed shell. */}
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-medium uppercase tracking-wider text-gray-400 mb-0.5">
            {overline}
          </p>
          {/* A parsed title is a title: same weight, same size. Only a row
              nothing could be read out of falls back to the printed line,
              shown as typeset because that text IS the answer.

              Three lines at most, then it is cut — with the whole title in
              `title`, so nothing a clamp hides becomes unreachable. */}
          <p
            data-testid="citation-title"
            title={title || ref.rawText}
            className={`line-clamp-3 ${
              title
                ? 'font-semibold text-sm text-gray-900 leading-snug'
                : 'font-serif text-[13px] text-gray-700 leading-snug'
            }`}
          >
            <MathText text={title || ref.rawText} />
          </p>
        </div>
        <button
          onClick={onClose}
          aria-label={S.close}
          className="shrink-0 p-1 -mr-1 -mt-0.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
        >
          <X size={15} />
        </button>
      </div>

      {(authorLine || foldedFacts.length > 0 || failed) && (
        /* Two lines' worth of floor: without it the doors sit at a different
           height on a card that has authors and one that hasn't (§ 02). */
        <div className="px-5 py-4 flex flex-col gap-1.5 min-h-[66px]">
          {/* The one line a reader actually reads: plain text at body weight,
              no icon — it is the sentence, not a data field. */}
          {authorLine && <p className="text-xs text-gray-500 leading-relaxed">{authorLine}</p>}

          {foldedFacts.length > 0 &&
            (unfolded ? (
              <div className="flex flex-col gap-1.5 pt-0.5">
                {year && (
                  <MetaRow icon={<Calendar size={12} />} label={S.yearLabel}>
                    {year}
                  </MetaRow>
                )}
                {existingChatId ? (
                  <MetaRow icon={<BookMarked size={12} />} label={S.openedAgo}>
                    {S.openedAgo}
                  </MetaRow>
                ) : (
                  ref.citations != null && (
                    <MetaRow icon={<Quote size={12} />} label={S.citationsLabel}>
                      {S.citationCount(ref.citations)}
                    </MetaRow>
                  )
                )}
                {venue && (
                  <MetaRow icon={<BookOpen size={12} />} label={S.venueLabel}>
                    {venue}
                  </MetaRow>
                )}
              </div>
            ) : (
              <button
                onClick={() => setUnfolded(true)}
                data-testid="citation-more"
                aria-expanded={false}
                className="flex items-center gap-1.5 min-w-0 max-w-full text-left text-[11px] text-blue-700 hover:text-blue-800 transition-colors"
              >
                <ChevronDown size={12} className="shrink-0" />
                {/* Truncated, and never a reason to widen the card: a long
                    venue name in the summary pushed every card to the 440px
                    cap (measured in the running app 2026-08-09). The title
                    decides the width; this line follows it. */}
                <span className="truncate">{foldedFacts.join('  |  ')}</span>
              </button>
            ))}

          {failed && (
            <div className="mt-1 flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
              <AlertTriangle size={13} className="shrink-0 mt-0.5 text-gray-400" />
              <p className="text-xs text-gray-700 leading-relaxed">{S.downloadBlocked}</p>
            </div>
          )}
        </div>
      )}

      {/* The doors. Stacked, full-width, same colour — order alone ranks them.
          Only ACTIONS live here: a disabled button carrying an explanation is
          not a control, it is a sentence pretending to be one (user report
          2026-08-09), so a work with no downloadable PDF simply has one door
          and says why above it. */}
      <div className="shrink-0 px-3 py-3 border-t border-gray-100 bg-gray-50 flex flex-col gap-1.5">
        {/* Explains the door that ISN'T there, so it sits with the doors — in
            the body it read as one more metadata field (user report
            2026-08-09).

            Spoken only once the search HAS looked. The card used to open with
            "No downloadable PDF available" and turn into "Looking for the
            full text…" a moment later (user report 2026-08-11) — a verdict
            first and the search afterwards, which is the wrong way round. */}
        {/* The wait, as a NOTE above the doors — never as a button: a button
            offers a choice, and here there is none, since the retry happens by
            itself (user report 2026-08-11). The door below stays, greyed out,
            and keeps naming the DESTINATION — what the reader will be able to
            do once the clock runs out — because "what can I do here?" is the
            question a door answers. It does not spin: nothing is being
            searched during the wait, and a surface that animates while idle
            is lying. */}
        {!canOpenInSyflo && !existingChatId && !failed && countingDown && (
          <p
            className="flex items-center gap-1.5 px-1 pb-0.5 text-[11px] text-gray-400 leading-relaxed"
            data-testid="citation-search-retry"
          >
            <Clock size={11} className="shrink-0" />
            {S.searchRetryIn(retryInSeconds)}
          </p>
        )}
        {!canOpenInSyflo && !existingChatId && !failed && !countingDown && !resuming && !searching && (searchDone || searchFailed) && (
          <p
            className="px-1 pb-0.5 text-[11px] text-gray-400 leading-relaxed"
            data-testid="citation-no-pdf-note"
          >
            {searchFailed ? S.searchUnreachable : S.noFulltextFound}
          </p>
        )}
        {/* The door the search is working on — shown from the moment the card
            opens, because a reference without a linked PDF is ALWAYS searched.
            It carries the same shape and place as the real one, so nothing
            moves when the answer arrives. */}
        {!canOpenInSyflo && !existingChatId && !failed &&
          (countingDown || resuming || searching || (!searchDone && !searchFailed)) && (
            <button
              disabled
              aria-busy={!countingDown || undefined}
              data-testid="citation-open-in-syflo"
              className="flex items-center justify-center gap-2 w-full px-3 py-2 rounded-lg text-sm font-medium text-blue-700 bg-blue-50 opacity-50 cursor-default"
            >
              {countingDown ? <Download size={14} /> : <Loader2 size={14} className="animate-spin" />}
              {countingDown ? S.openInSyflo : S.searchingFulltext}
            </button>
          )}
        {existingChatId ? (
          <button
            onClick={() => onGoToTree(existingChatId)}
            data-testid="citation-go-to-tree"
            className="flex items-center justify-center gap-2 w-full px-3 py-2 rounded-lg text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 transition-colors"
          >
            <ArrowRight size={14} />
            {S.goToTree}
          </button>
        ) : (
          canOpenInSyflo &&
          !failed && (
            <button
              onClick={() => onOpenInSyflo(ref)}
              disabled={loading}
              aria-busy={loading || undefined}
              data-testid="citation-open-in-syflo"
              className="flex items-center justify-center gap-2 w-full px-3 py-2 rounded-lg text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 transition-colors disabled:opacity-50 disabled:hover:bg-blue-50 disabled:cursor-default"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              {/* The button keeps its place and size; only icon and label
                  change (FloatingPopup does the same while branching). */}
              {loading ? S.loadingPaper : S.openInSyflo}
            </button>
          )
        )}
        {/* Always clickable: with no identifier at all, the printed row is the
            search query — which is exactly what the reader would type. */}
        <button
          onClick={() => onOpenInBrowser(ref)}
          data-testid="citation-open-in-browser"
          className="flex items-center justify-center gap-2 w-full px-3 py-2 rounded-lg text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 transition-colors"
        >
          {ref.arxivId || ref.doi ? <Globe size={14} /> : <Search size={14} />}
          {ref.arxivId || ref.doi ? S.openInBrowser : S.searchTheWeb}
        </button>
      </div>
    </div>
  );
}
