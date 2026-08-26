/**
 * hooks/useCitations.ts
 *
 * Reference links for the paper currently open: load them, keep asking while
 * the background pass runs, and carry the two doors
 * (design/mockup-paper-reference-links.html).
 *
 * The pass takes seconds — reading the PDF's annotations, then one OpenAlex
 * round trip — so the view polls while `status` is 'pending' and stops for
 * good on 'ready' or 'none'. 'none' is a finished state, not a failure: it is
 * the honest answer for a Word export or a scan.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { PaperCitation, PaperCitations, PaperReference } from '../types';

const POLL_MS = 2500;
// The pass is bounded work; if it hasn't finished by now something is wrong
// upstream and polling forever would only burn requests.
const MAX_POLLS = 24;

const EMPTY: PaperCitations = { status: 'pending', references: [], citations: [] };

export function useCitations(paperId: string | null) {
  const [data, setData] = useState<PaperCitations>(EMPTY);
  const pollsRef = useRef(0);

  useEffect(() => {
    if (!paperId) {
      setData(EMPTY);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    pollsRef.current = 0;

    const load = async () => {
      try {
        const next = await api.getPaperCitations(paperId);
        if (cancelled) return;
        setData(next);
        if (next.status === 'pending' && pollsRef.current++ < MAX_POLLS) {
          timer = setTimeout(load, POLL_MS);
        }
      } catch {
        // A failed fetch leaves the previous state alone: citations are an
        // enrichment, and losing them must never disturb reading the paper.
      }
    };
    void load();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [paperId]);

  const referenceById = useCallback(
    (id: string | null): PaperReference | null =>
      (id && data.references.find((r) => r.id === id)) || null,
    [data.references],
  );

  const referenceFor = useCallback(
    (citation: PaperCitation): PaperReference | null => referenceById(citation.referenceId),
    [referenceById],
  );

  // Look one reference up on demand, when its card opens. Nothing is searched
  // during import — that cost 40–93 requests per paper and had OpenAlex
  // rate-limit us for minutes (measured 2026-08-09). The answer replaces the
  // row in place, so the open card fills in without a reload.
  //
  // A title is no longer reason enough to skip it: an identified reference can
  // still have an empty fold, and 118 of 171 stored references did (measured
  // 2026-08-12). The backend then looks the missing facts up in the
  // background — one request per reference, hit or miss.
  const resolve = useCallback(
    async (reference: PaperReference): Promise<PaperReference> => {
      const foldIsEmpty =
        reference.citations === null ||
        reference.citations === undefined ||
        !(reference.venue || reference.parsedVenue) ||
        (reference.year ?? reference.parsedYear) === null;
      if (!paperId || (reference.title && !foldIsEmpty)) return reference;
      const filled = await api.resolveReference(paperId, reference.id);
      if (!filled) return reference;
      setData((prev) => ({
        ...prev,
        references: prev.references.map((r) => (r.id === filled.id ? filled : r)),
      }));
      return filled;
    },
    [paperId],
  );

  // Ask the web for a full text this paper never linked — the silent search
  // (design/mockup-citation-card-standard.html § 04). Nothing about the call
  // is visible: the answer replaces the row in place, and the card that is
  // waiting on it simply grows its door.
  //
  // Costs at most one request per reference for the whole session — the
  // backend remembers a miss as well as a hit, and `searchedRef` keeps a
  // second click from asking again before the first answer is back.
  // 'searching' while the request is out, 'done' once it has answered — the
  // two states the card needs to tell "still looking" from "looked and found
  // nothing". Kept in state, not a ref, because the card renders from it.
  const [fulltextState, setFulltextState] = useState<Record<string, 'searching' | 'done'>>({});
  const askedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    askedRef.current = new Set();
    setFulltextState({});
  }, [paperId]);

  const ensureFulltext = useCallback(
    async (referenceId: string): Promise<void> => {
      if (!paperId || askedRef.current.has(referenceId)) return;
      askedRef.current.add(referenceId);
      setFulltextState((prev) => ({ ...prev, [referenceId]: 'searching' }));
      const filled = await api.ensureFulltext(paperId, referenceId);
      // Two ways for nobody to have looked: the engines shut us out, or no
      // search is set up at all (W1, §06). Different cures, same conclusion
      // here — neither is an answer about the paper.
      const nobodyLooked = Boolean(filled?.fulltextSearchFailed || filled?.fulltextSearchUnavailable);
      // 'done' means "the web was asked and answered". A search that could
      // not run must NOT land here: the card would then say "no full text
      // found" about a paper nobody looked for (seen in the running app
      // 2026-08-10, with every engine behind SearXNG serving CAPTCHAs).
      if (!nobodyLooked) {
        setFulltextState((prev) => ({ ...prev, [referenceId]: 'done' }));
      } else {
        setFulltextState((prev) => {
          const next = { ...prev };
          delete next[referenceId];
          return next;
        });
      }
      if (!filled) return;
      setData((prev) => ({
        ...prev,
        references: prev.references.map((r) => (r.id === filled.id ? { ...r, ...filled } : r)),
      }));
      // A failed search is not an answer: let the next click try again — and
      // tell the caller, because the prefetch queue has to stop. SearXNG
      // answers a blocked search with an empty list (measured 2026-08-10), so
      // carrying on would record every remaining reference as hopeless.
      if (nobodyLooked) {
        askedRef.current.delete(referenceId);
        throw Object.assign(new Error('Full-text search unavailable'), { suspended: true });
      }
    },
    [paperId],
  );

  return { ...data, referenceById, referenceFor, resolve, ensureFulltext, fulltextState };
}
