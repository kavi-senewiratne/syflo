/**
 * tests/passageTitle.test.ts
 *
 * A branch must appear with its finished title, not with the raw passage
 * (user requirement 2026-08-02). The lookup starts while the selection popup
 * is open; at click time it is awaited only briefly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api', () => ({ api: { passageTitle: vi.fn() } }));

import { api } from '../api';
import { tidyPassage, startPassageTitle, awaitTitle } from '../chat/passageTitle';

const mocked = () => vi.mocked(api.passageTitle);

const PDF_FORMULA = 'x ( k ) = x ( k ) − E [ x ( k ) ] √ Var [ x ( k ) ]';

describe('tidyPassage — the model-free fallback', () => {
  it('glues the spaces the PDF text layer sprinkles around brackets', () => {
    expect(tidyPassage(PDF_FORMULA)).toBe('x(k) = x(k) − E[x(k)] √Var[x(k)]');
  });

  it('repairs hyphenation from a line break', () => {
    expect(tidyPassage('makes it no- toriously hard')).toBe('makes it notoriously hard');
  });

  it('collapses newlines and runs of spaces', () => {
    expect(tidyPassage('  the loss\n  over a   mini-batch ')).toBe('the loss over a mini-batch');
  });

  it('leaves ordinary prose alone', () => {
    expect(tidyPassage('Batch normalization reduces covariate shift')).toBe(
      'Batch normalization reduces covariate shift',
    );
  });
});

describe('awaitTitle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocked().mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('uses the model title once it arrived', async () => {
    mocked().mockResolvedValue('$x^{(k)}$');
    const pending = startPassageTitle(PDF_FORMULA);

    await expect(awaitTitle(pending, PDF_FORMULA)).resolves.toBe('$x^{(k)}$');
  });

  it('falls back to the tidied passage when the model returns nothing', async () => {
    mocked().mockResolvedValue(null);
    const pending = startPassageTitle(PDF_FORMULA);

    await expect(awaitTitle(pending, PDF_FORMULA)).resolves.toBe('x(k) = x(k) − E[x(k)] √Var[x(k)]');
  });

  it('never lets a slow model hold the branch hostage', async () => {
    mocked().mockReturnValue(new Promise(() => {})); // never settles
    const pending = startPassageTitle(PDF_FORMULA);

    const result = awaitTitle(pending, PDF_FORMULA, 2500);
    await vi.advanceTimersByTimeAsync(2500);

    await expect(result).resolves.toBe('x(k) = x(k) − E[x(k)] √Var[x(k)]');
  });

  it('swallows a failing lookup instead of rejecting', async () => {
    mocked().mockRejectedValue(new Error('offline'));
    const pending = startPassageTitle(PDF_FORMULA);

    await expect(awaitTitle(pending, PDF_FORMULA)).resolves.toBe('x(k) = x(k) − E[x(k)] √Var[x(k)]');
  });

  it('ignores a lookup that belongs to an older selection', async () => {
    mocked().mockResolvedValue('$\\mu_B$');
    const stale = startPassageTitle('eine andere Passage');

    await expect(awaitTitle(stale, PDF_FORMULA)).resolves.toBe(
      'x(k) = x(k) − E[x(k)] √Var[x(k)]',
    );
  });

  it('works without any pending lookup at all', async () => {
    await expect(awaitTitle(null, 'nur Text')).resolves.toBe('nur Text');
  });
});
