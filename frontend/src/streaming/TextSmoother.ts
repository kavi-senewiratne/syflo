/**
 * streaming/TextSmoother.ts
 *
 * Smoothly reveals streamed answer text. Fast cloud models (>1000 tok/s)
 * make whole paragraphs "pop" into the chat at once — impossible to read
 * along. The smoother buffers incoming deltas and reveals characters on a
 * ~30 ms timer instead.
 *
 * Adaptive rate: the base is a comfortable reading pace (~110 chars/s,
 * user-tuned 2026-07-25). Whenever a push leaves more backlog than the
 * current rate could clear in `maxLagSeconds`, the rate rises to
 * `backlog / maxLagSeconds` and stays there (sticky) until the display has
 * caught up — so the reveal is linear and the display never trails the
 * model by more than ~2.5 s (user-tuned 2026-07-25). Once caught up, the
 * rate relaxes back to the base.
 *
 * `finish()` resolves once the remaining buffer has been revealed AT THE
 * PACED RATE — used at stream done. (Flushing at done instead silently
 * bypassed the smoothing for very fast models: Groq delivers the whole
 * answer before the first ticks, so everything popped in via the done
 * flush — live report 2026-07-26.)
 *
 * `flush()` reveals everything immediately and stops the timer — used on
 * error/abort so markers are never raced by a still-ticking reveal.
 *
 * Pure TypeScript, no React — the owner (App's per-stream state) wires
 * `onReveal` into its own UI updates.
 */

export interface TextSmootherOptions {
  // Called with the currently visible prefix after every reveal step.
  onReveal: (visibleText: string) => void;
  // Comfortable reading pace, in characters per second.
  baseCharsPerSecond?: number;
  // The display never trails the model by more than roughly this many seconds.
  maxLagSeconds?: number;
  // Reveal timer granularity.
  tickMs?: number;
}

// Defaults are exported so tests assert against the real product tuning
// instead of duplicating magic numbers. Both user-tuned 2026-07-25 in two
// rounds (180 chars/s / 1.5 s → 110 / 2.5 → 85 / 4: still too fast to
// read along — the lag horizon dominates how fast cloud bursts reveal).
export const BASE_CHARS_PER_SECOND = 85;
export const MAX_LAG_SECONDS = 4;
export const TICK_MS = 30;

export class TextSmoother {
  private readonly onReveal: (visibleText: string) => void;
  private readonly base: number;
  private readonly maxLag: number;
  private readonly tickMs: number;

  // Full text received so far; `revealed` chars of it are visible.
  private buffer = '';
  private revealed = 0;
  // Fractional characters carried between ticks (rate * tick is rarely whole).
  private carry = 0;
  // Current reveal rate in chars/s — sticky while draining a backlog.
  private rate: number;
  private timer: number | null = null;
  // Resolver of a pending finish() — called when the drain catches up.
  private onDrained: (() => void) | null = null;

  constructor(opts: TextSmootherOptions) {
    this.onReveal = opts.onReveal;
    this.base = opts.baseCharsPerSecond ?? BASE_CHARS_PER_SECOND;
    this.maxLag = opts.maxLagSeconds ?? MAX_LAG_SECONDS;
    this.tickMs = opts.tickMs ?? TICK_MS;
    this.rate = this.base;
  }

  /** Append a streamed delta to the buffer and (re)start the reveal timer. */
  push(delta: string): void {
    if (!delta) return;
    this.buffer += delta;
    // Adaptive catch-up: raise the sticky rate so the whole backlog clears
    // within maxLag seconds. Never lower it mid-drain — a linear reveal
    // reads calmer than one that keeps re-slowing.
    const backlog = this.buffer.length - this.revealed;
    this.rate = Math.max(this.rate, backlog / this.maxLag);
    if (this.timer === null) {
      this.timer = window.setInterval(() => this.tick(), this.tickMs);
    }
  }

  /**
   * Stream done: resolves once the rest of the buffer has been revealed at
   * the paced rate (the adaptive rate bounds the drain to ~maxLag seconds).
   * Never reveals instantly — that would bypass the smoothing exactly for
   * the fastest models.
   */
  finish(): Promise<void> {
    if (this.revealed >= this.buffer.length) {
      this.stopTimer();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.onDrained = resolve;
    });
  }

  /** Reveal everything immediately and stop the timer (error/abort). */
  flush(): void {
    this.stopTimer();
    this.carry = 0;
    this.rate = this.base;
    if (this.revealed < this.buffer.length) {
      this.revealed = this.buffer.length;
      this.onReveal(this.buffer);
    }
    this.onDrained?.();
    this.onDrained = null;
  }

  private tick(): void {
    this.carry += (this.rate * this.tickMs) / 1000;
    const step = Math.floor(this.carry);
    if (step > 0) {
      this.carry -= step;
      this.revealed = Math.min(this.buffer.length, this.revealed + step);
      this.onReveal(this.buffer.slice(0, this.revealed));
    }
    if (this.revealed >= this.buffer.length) {
      // Caught up — stop ticking and relax back to the reading pace.
      this.stopTimer();
      this.carry = 0;
      this.rate = this.base;
      this.onDrained?.();
      this.onDrained = null;
    }
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }
}
