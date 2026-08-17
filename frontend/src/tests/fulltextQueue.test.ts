/**
 * fulltextQueue.test.ts
 *
 * Prefetching the silent full-text search (design/mockup-citation-card-
 * standard.html § 05). Searching the whole bibliography at import would be
 * ~25 requests per paper for the ~5 references a reader actually opens
 * (measured over the stored corpus 2026-08-10) — and 25 web searches in one
 * burst is what gets the engines behind SearXNG to answer with a captcha.
 *
 * So the queue is deliberately unhurried: whatever page is on screen, one
 * request at a time, and the reference under the mouse jumps the line.
 */

import { describe, it, expect, vi } from 'vitest';
import { createFulltextQueue } from '../hooks/fulltextQueue';

// A run function that never settles until told to, so the test can watch the
// queue between steps.
function deferredRunner() {
  const started: string[] = [];
  const resolvers: Array<() => void> = [];
  const run = (id: string) =>
    new Promise<void>((resolve) => {
      started.push(id);
      resolvers.push(resolve);
    });
  return {
    run,
    started,
    finishOne: async () => {
      resolvers.shift()?.();
      // Let the queue pick the next one up.
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('createFulltextQueue', () => {
  it('asks for one reference at a time, in the order they were seen', async () => {
    const r = deferredRunner();
    const queue = createFulltextQueue(r.run);

    queue.enqueue(['a', 'b', 'c']);

    expect(r.started).toEqual(['a']);
    await r.finishOne();
    expect(r.started).toEqual(['a', 'b']);
    await r.finishOne();
    expect(r.started).toEqual(['a', 'b', 'c']);
  });

  it('lets the reference under the mouse jump the line', async () => {
    // Between pointing and clicking lie a few hundred milliseconds — enough
    // for the card to open with a finished door instead of a spinner.
    const r = deferredRunner();
    const queue = createFulltextQueue(r.run);

    queue.enqueue(['a', 'b', 'c']);
    queue.prioritize('c');
    await r.finishOne();

    expect(r.started).toEqual(['a', 'c']);
  });

  it('starts a prioritized reference that was never queued at all', async () => {
    const r = deferredRunner();
    const queue = createFulltextQueue(r.run);

    queue.prioritize('z');

    expect(r.started).toEqual(['z']);
  });

  it('never asks for the same reference twice', async () => {
    const r = deferredRunner();
    const queue = createFulltextQueue(r.run);

    queue.enqueue(['a', 'b']);
    queue.enqueue(['a', 'b']);
    queue.prioritize('a');
    await r.finishOne();
    await r.finishOne();

    expect(r.started).toEqual(['a', 'b']);
  });

  it('drops what is still waiting when the reader turns the page', async () => {
    // The citations of the page just left are no longer the ones about to be
    // clicked; spending requests on them is exactly the waste this avoids.
    const r = deferredRunner();
    const queue = createFulltextQueue(r.run);

    queue.enqueue(['a', 'b', 'c']);
    queue.clearPending();
    await r.finishOne();

    expect(r.started).toEqual(['a']);
  });

  it('keeps going when one search throws', async () => {
    const run = vi.fn(async (id: string) => {
      if (id === 'a') throw new Error('SearXNG down');
    });
    const queue = createFulltextQueue(run);

    queue.enqueue(['a', 'b']);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  });
});

describe('createFulltextQueue under a rate limit', () => {
  it('leaves a gap between requests when asked to', async () => {
    // Measured in the running app 2026-08-10: twenty back-to-back searches
    // were enough for every engine behind SearXNG to answer with a CAPTCHA.
    // Reading a paper is slow; the prefetch has no reason to be fast.
    vi.useFakeTimers();
    try {
      const run = vi.fn(async () => {});
      const queue = createFulltextQueue(run, { spacingMs: 2000 });

      queue.enqueue(['a', 'b']);
      await vi.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1500);
      expect(run).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(600);
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops prefetching once the search says it has been shut out', async () => {
    // Carrying on would only deepen the block — and every further answer
    // would be an empty list that means nothing.
    const run = vi.fn(async (id: string) => {
      if (id === 'a') throw Object.assign(new Error('suspended'), { suspended: true });
    });
    const queue = createFulltextQueue(run);

    queue.enqueue(['a', 'b', 'c']);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));

    expect(run).toHaveBeenCalledTimes(1);
  });
});
