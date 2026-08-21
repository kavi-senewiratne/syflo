/**
 * tests/TextSmoother.test.ts
 *
 * Smooth reveal of streamed answer text (src/streaming/TextSmoother.ts):
 * a big burst is revealed linearly instead of popping in at once, the rate
 * accelerates so the display never trails the model by more than the
 * catch-up horizon, and flush() reveals everything immediately. Asserts
 * against the exported product constants (user-tuned 2026-07-25) instead
 * of duplicating magic numbers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TextSmoother,
  BASE_CHARS_PER_SECOND,
  MAX_LAG_SECONDS,
  TICK_MS,
} from '../streaming/TextSmoother';

describe('TextSmoother', () => {
  let visible: string;
  let reveals: number;
  let smoother: TextSmoother;

  beforeEach(() => {
    vi.useFakeTimers();
    visible = '';
    reveals = 0;
    smoother = new TextSmoother({
      onReveal: (text) => {
        visible = text;
        reveals += 1;
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reveals a 3000-char burst gradually — only a part after 100 ms', () => {
    smoother.push('A'.repeat(3000));
    expect(visible).toBe(''); // nothing before the first tick

    vi.advanceTimersByTime(100);
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThan(3000);
  });

  it('accelerates on a big backlog and catches up within the lag horizon', () => {
    smoother.push('A'.repeat(3000));
    // The sticky rate rises to backlog / horizon — far above the base pace.
    const expectedRate = Math.max(BASE_CHARS_PER_SECOND, 3000 / MAX_LAG_SECONDS);

    // After ~1 s the reveal runs at the accelerated (not the base) pace…
    vi.advanceTimersByTime(1000);
    expect(visible.length).toBeGreaterThan(expectedRate * 0.9);
    expect(visible.length).toBeGreaterThan(BASE_CHARS_PER_SECOND * 2);
    expect(visible.length).toBeLessThan(3000);

    // …and the catch-up guarantee holds: everything visible within the
    // horizon (plus two ticks of slack for rounding).
    vi.advanceTimersByTime(MAX_LAG_SECONDS * 1000 - 1000 + 2 * TICK_MS);
    expect(visible.length).toBe(3000);
  });

  it('reveals at the comfortable base pace for small deltas', () => {
    smoother.push('B'.repeat(90));

    vi.advanceTimersByTime(100); // ~a tenth of a second of base pace
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThan(Math.ceil(BASE_CHARS_PER_SECOND * 0.2));

    // 90 chars need 90/base seconds at the reading pace.
    vi.advanceTimersByTime(Math.ceil((90 / BASE_CHARS_PER_SECOND) * 1000) + 2 * TICK_MS);
    expect(visible.length).toBe(90);
  });

  it('keeps revealing across multiple pushes without losing text', () => {
    smoother.push('X'.repeat(600));
    vi.advanceTimersByTime(300);
    smoother.push('Y'.repeat(600));
    vi.advanceTimersByTime(MAX_LAG_SECONDS * 1000 + 2 * TICK_MS);

    expect(visible).toBe('X'.repeat(600) + 'Y'.repeat(600));
  });

  // Für /btw: stirbt ein Modell mitten in der Antwort, nimmt das Backend
  // seine Zeichen zurück (reset). Der Smoother darf das Zurückgenommene dann
  // nicht weiter aufdecken — sonst schriebe das nächste Modell unter eine
  // Ruine (Nutzer-Report 2026-08-19).
  it('reset() drops the buffered text without revealing it', () => {
    smoother.push('A'.repeat(600));
    vi.advanceTimersByTime(90);
    const seenBefore = visible;
    expect(seenBefore.length).toBeGreaterThan(0);

    smoother.reset();
    vi.advanceTimersByTime(500);
    // Kein weiteres Aufdecken nach dem Zurücknehmen.
    expect(visible).toBe(seenBefore);

    // Und die nächste Antwort beginnt bei null, nicht hinter der alten.
    smoother.push('B'.repeat(60));
    vi.advanceTimersByTime(1000);
    expect(visible).toBe('B'.repeat(60));
  });

  it('flush() reveals everything immediately and stops the timer', () => {
    smoother.push('C'.repeat(3000));
    vi.advanceTimersByTime(2 * TICK_MS);
    expect(visible.length).toBeLessThan(3000);

    smoother.flush();
    expect(visible.length).toBe(3000);

    // Timer is stopped — no further callbacks fire.
    const after = reveals;
    vi.advanceTimersByTime(1000);
    expect(reveals).toBe(after);
  });

  it('flush() on an already caught-up smoother does not fire onReveal again', () => {
    smoother.push('D'.repeat(30));
    vi.advanceTimersByTime(Math.ceil((30 / BASE_CHARS_PER_SECOND) * 1000) + 2 * TICK_MS);
    expect(visible.length).toBe(30);
    const after = reveals;

    smoother.flush();
    expect(reveals).toBe(after);
  });

  // finish() (live report 2026-07-26): a done-flush bypassed the smoothing
  // exactly for the fastest models — the drain must keep the paced rate.

  it('finish() drains the rest at the paced rate instead of dumping it', async () => {
    smoother.push('E'.repeat(3000));
    vi.advanceTimersByTime(2 * TICK_MS);
    const beforeFinish = visible.length;
    expect(beforeFinish).toBeLessThan(3000);

    let drained = false;
    void smoother.finish().then(() => { drained = true; });

    // Right after finish(): still NOT everything visible — no dump.
    expect(visible.length).toBe(beforeFinish);
    expect(drained).toBe(false);

    // Within the lag horizon the drain completes and the promise resolves.
    await vi.advanceTimersByTimeAsync(MAX_LAG_SECONDS * 1000 + 2 * TICK_MS);
    expect(visible.length).toBe(3000);
    expect(drained).toBe(true);
  });

  it('finish() resolves immediately when already caught up', async () => {
    smoother.push('F'.repeat(30));
    vi.advanceTimersByTime(Math.ceil((30 / BASE_CHARS_PER_SECOND) * 1000) + 2 * TICK_MS);
    expect(visible.length).toBe(30);

    let drained = false;
    void smoother.finish().then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(true);
  });
});
