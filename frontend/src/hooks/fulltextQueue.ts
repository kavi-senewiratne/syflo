/**
 * hooks/fulltextQueue.ts
 *
 * When the silent full-text search runs (design/mockup-citation-card-
 * standard.html § 05).
 *
 * Searching the whole bibliography right after import is the obvious move and
 * the wrong one: measured over the stored corpus (2026-08-10), 96 of 149
 * references carry no PDF link while a reader opens about five per paper —
 * so an import-time pass would fire ~25 web searches to serve ~5, all in one
 * burst. The engines behind SearXNG answer bursts with captchas, and that
 * takes the YouTube source down with it.
 *
 * Prefetching by PROXIMITY costs a fraction and hides almost all of the wait:
 * the citations of the page on screen (about four per page in
 * "Attention Is All You Need") and, ahead of everything else, whatever the
 * mouse is pointing at.
 *
 * The queue is deliberately dull: one request at a time, each reference asked
 * for at most once, and everything still waiting dropped when the reader
 * turns the page.
 */

export interface FulltextQueue {
  /** Add references to the back of the line; already-seen ids are ignored. */
  enqueue: (ids: string[]) => void;
  /** Move a reference to the front — or start it, if it was never queued. */
  prioritize: (id: string) => void;
  /** Forget what is still waiting. The one in flight is left to finish. */
  clearPending: () => void;
}

export interface FulltextQueueOptions {
  /**
   * Milliseconds to wait between requests.
   *
   * Measured in the running app 2026-08-10: twenty back-to-back searches were
   * enough for every engine behind SearXNG to shut us out — brave and google
   * cse "Suspended: too many requests", duckduckgo and startpage with a
   * CAPTCHA. Reading a paper takes minutes; the prefetch has no reason to be
   * quick, and being quick is what breaks it.
   */
  spacingMs?: number;
}

export function createFulltextQueue(
  run: (id: string) => Promise<unknown>,
  { spacingMs = 0 }: FulltextQueueOptions = {},
): FulltextQueue {
  const pending: string[] = [];
  const seen = new Set<string>();
  let running = false;
  // Set once the search reports it has been blocked. Carrying on would only
  // deepen the block, and every further answer would be an empty list that
  // means nothing — so prefetching stops for this paper. A card the reader
  // actually opens still asks (that path does not go through the queue).
  let shutOut = false;

  const pump = () => {
    if (running || shutOut) return;
    const next = pending.shift();
    if (next === undefined) return;
    running = true;
    // Started here and now, not a microtask later: the mouse is already on
    // its way to the click, and a tick of politeness is a tick of spinner.
    let inFlight: Promise<unknown>;
    try {
      inFlight = Promise.resolve(run(next));
    } catch {
      inFlight = Promise.resolve();
    }
    // A failed search must not stall the line: SearXNG being down is exactly
    // when the next reference would still like its turn. Being SHUT OUT is
    // the one failure that stops everything.
    void inFlight
      .catch((err: unknown) => {
        if (err && typeof err === 'object' && 'suspended' in err && err.suspended) shutOut = true;
      })
      .then(() => {
        running = false;
        if (shutOut) return;
        if (spacingMs > 0) setTimeout(pump, spacingMs);
        else pump();
      });
  };

  const add = (id: string, toFront: boolean) => {
    if (seen.has(id)) return;
    seen.add(id);
    if (toFront) pending.unshift(id);
    else pending.push(id);
  };

  return {
    enqueue(ids) {
      for (const id of ids) add(id, false);
      pump();
    },
    prioritize(id) {
      // Already asked for? Then it is either done or in flight — either way
      // the card will have its answer, and re-asking would waste a request.
      const waiting = pending.indexOf(id);
      if (waiting > -1) {
        pending.splice(waiting, 1);
        pending.unshift(id);
      } else {
        add(id, true);
      }
      pump();
    },
    clearPending() {
      // `seen` is NOT cleared: a reference already asked about keeps its
      // answer, and coming back to the page must not ask again.
      pending.length = 0;
    },
  };
}
