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
  Calendar, BookOpen, Quote, BookMarked, ChevronDown, KeyRound,
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
  // No web search is set up at all (W1, design/mockup-onboarding-flow.html
  // §06). A FOURTH state, deliberately not folded into `searchFailed`: that
  // one is temporary and its cure is time, this one's cure is a key. The card
  // asks for it here, where the search would have run.
  searchUnavailable?: boolean;
  // WHICH named state it is: no provider, a rejected key, a spent allowance.
  // All three need a person, none needs a wait — but they need different
  // sentences, and "add a search key" is wrong when one is already stored.
  searchReason?: string | null;
  // Resolves once the key is stored; the caller re-runs the search for THIS
  // reference, since it is the one that knows which reference is open.
  onSaveSearchKey?: (key: string) => Promise<void> | void;
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
  searchUnavailable = false,
  searchReason = null,
  onSaveSearchKey,
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
  // The W1 ask, and its one input. Collapsed to a button first: the card is
  // 384px wide and a text field opened by default would push the doors down on
  // every reference, including the ones the reader only glanced at.
  const [keyFieldOpen, setKeyFieldOpen] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  // A new reference means a new decision: nothing typed carries over.
  useEffect(() => {
    setKeyFieldOpen(false);
    setKeyInput('');
    setSavingKey(false);
  }, [target?.reference.id]);
  const askForSearchKey = searchUnavailable;

  const saveSearchKey = async () => {
    const key = keyInput.trim();
    // An empty field is not a decision — saving "" would clear a key that a
    // second window might just have stored.
    if (!key || savingKey) return;
    setSavingKey(true);
    try {
      await onSaveSearchKey?.(key);
    } finally {
      setSavingKey(false);
    }
  };

  // A named state outranks any retry time that may still be in flight from the
  // previous attempt: it is the reader's to fix, and a clock beside the ask
  // made the card contradict itself (seen in the running app 2026-08-24).
  const retryAtMs = searchRetryAt && !searchUnavailable ? new Date(searchRetryAt).getTime() : null;
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

  // Which of the three sentences the ask carries. The free allowance is only
  // news to someone who has no key yet; quoting it at a reader whose key was
  // rejected, or whose 1000 searches are gone, reads as a taunt — and "add a
  // search key" invites them to type the same wrong key again.
  const searchAsk =
    searchReason === 'tavily-invalid-key'
      ? { askTitle: S.searchKeyRejectedTitle, body: S.searchKeyRejectedBody, showFree: false }
      : searchReason === 'tavily-quota-exhausted'
        ? { askTitle: S.searchQuotaTitle, body: S.searchQuotaBody, showFree: false }
        : { askTitle: S.searchSetupTitle, body: S.searchSetupBody, showFree: true };

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

          {/* A single fact is shown outright: a chevron that "expands" one
              line into the same one line is a control with nothing behind it
              (user report 2026-09-12). The fold exists to keep three facts
              from crowding the card, so it starts at two. */}
          {foldedFacts.length > 0 &&
            (unfolded || foldedFacts.length === 1 ? (
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
        {!canOpenInSyflo && !existingChatId && !failed && !countingDown && !resuming && !searching && (searchDone || searchFailed || (searchUnavailable && !askForSearchKey)) && (
          <p
            className="px-1 pb-0.5 text-[11px] text-gray-400 leading-relaxed"
            data-testid="citation-no-pdf-note"
          >
            {searchFailed ? S.searchUnreachable : S.noFulltextFound}
          </p>
        )}
        {/* W1 (§06): the ask, at the point where a search would have run. It
            replaces the door rather than sitting beside it — there is nothing
            to open, and a greyed-out "Open in Syflo" next to it would promise
            an arrival that no amount of waiting brings. */}
        {askForSearchKey && !canOpenInSyflo && !existingChatId && !failed && (
          <div
            data-testid="citation-search-setup"
            className="rounded-lg border border-blue-100 bg-blue-50/60 px-3 py-2.5 space-y-2"
          >
            <p className="flex items-center gap-1.5 text-xs font-medium text-gray-700">
              <Search size={12} className="shrink-0 text-blue-600" />
              {searchAsk.askTitle}
            </p>
            <p className="text-[11px] text-gray-500 leading-relaxed">
              {searchAsk.body}
              {searchAsk.showFree && (
                <>
                  <br />
                  <span className="text-gray-400">{S.searchSetupFree}</span>
                </>
              )}
            </p>
            {keyFieldOpen ? (
              <div className="space-y-2">
                <label className="sr-only" htmlFor="citation-search-key-input">
                  {S.searchSetupKeyLabel}
                </label>
                <input
                  id="citation-search-key-input"
                  data-testid="citation-search-key-input"
                  type="password"
                  autoFocus
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  // Enter saves: the field holds one value and there is one
                  // thing to do with it.
                  onKeyDown={(e) => { if (e.key === 'Enter') void saveSearchKey(); }}
                  placeholder={S.searchSetupKeyPlaceholder}
                  className="w-full px-2.5 py-1.5 rounded-md border border-gray-200 bg-white text-xs text-gray-700 placeholder:text-gray-300 focus:outline-none focus:border-blue-400"
                />
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void saveSearchKey()}
                    disabled={savingKey || keyInput.trim().length === 0}
                    aria-busy={savingKey || undefined}
                    data-testid="citation-search-key-save"
                    // The card's own idiom: one surface, one colour, the order
                    // alone carries the priority (user decision 2026-07-20).
                    // A filled blue-600 button was tried first and looked like
                    // a different app's control sitting inside the card.
                    className="flex items-center justify-center gap-1.5 flex-1 px-3 py-1.5 rounded-lg text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 transition-colors disabled:opacity-50 disabled:hover:bg-blue-50 disabled:cursor-default"
                  >
                    {savingKey && <Loader2 size={12} className="animate-spin" />}
                    {savingKey ? S.searchSetupSaving : S.searchSetupSave}
                  </button>
                  <a
                    href="https://app.tavily.com/home"
                    target="_blank"
                    rel="noreferrer"
                    data-testid="citation-search-get-key"
                    className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-blue-700 hover:bg-blue-100 transition-colors"
                  >
                    {S.searchSetupGetKey}
                  </a>
                </div>
              </div>
            ) : (
              // Stacked, full width, same surface — the card's footer idiom.
              // Side by side (tried first) wrapped "Such-Schlüssel hinzufügen"
              // onto three lines inside the 384px shell (seen in the running
              // app 2026-08-24).
              <div className="space-y-1.5">
                <button
                  onClick={() => setKeyFieldOpen(true)}
                  data-testid="citation-search-key-open"
                  className="flex items-center justify-center gap-1.5 w-full px-3 py-1.5 rounded-lg text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 transition-colors"
                >
                  <KeyRound size={12} />
                  {S.searchSetupAddKey}
                </button>
                {/* The way out for a reader who will not add a key. They still
                    came here to read the paper. */}
                <button
                  onClick={() => onOpenInBrowser(ref)}
                  data-testid="citation-search-scholar"
                  className="flex items-center justify-center w-full px-3 py-1.5 rounded-lg text-xs font-medium text-blue-700 hover:bg-blue-100 transition-colors"
                >
                  {S.searchSetupScholar}
                </button>
              </div>
            )}
          </div>
        )}
        {/* The door the search is working on — shown from the moment the card
            opens, because a reference without a linked PDF is ALWAYS searched.
            It carries the same shape and place as the real one, so nothing
            moves when the answer arrives. */}
        {!canOpenInSyflo && !existingChatId && !failed && !searchUnavailable &&
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
