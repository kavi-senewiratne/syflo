/**
 * useCitations.fulltext.test.tsx
 *
 * The silent full-text search as the card sees it
 * (design/mockup-citation-card-standard.html § 04).
 *
 * Both cases below were found in the RUNNING app on 2026-08-10, with every
 * search engine serving CAPTCHAs after twenty searches — and both
 * made the card state something untrue about the paper.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCitations } from '../hooks/useCitations';
import { api } from '../api';
import type { PaperReference } from '../types';

const REFERENCE: PaperReference = {
  id: 'r1',
  anchor: 'cite.dropout',
  label: '[30]',
  rawText: '[30] N. Srivastava et al. Dropout. JMLR, 2014.',
  openalexId: 'W1',
  title: 'Dropout: a simple way to prevent neural networks from overfitting',
  authors: ['Nitish Srivastava'],
  year: 2014,
  citations: 40000,
  doi: null,
  arxivId: null,
  pdfUrl: null,
  parsedTitle: null,
  parsedAuthors: [],
  parsedVenue: null,
  parsedYear: 2014,
};

beforeEach(() => {
  // The same spy object is reused across tests otherwise, and its call count
  // leaks from one test into the next.
  vi.restoreAllMocks();
  vi.spyOn(api, 'getPaperCitations').mockResolvedValue({
    status: 'ready',
    references: [REFERENCE],
    citations: [],
  });
});

describe('useCitations — the facts behind a reference', () => {
  it('asks for a reference whose fold is still empty, title or no title', async () => {
    // resolve() used to stop at "it has a title", so an identified reference
    // with no citation count and no venue never asked anyone — 118 of 171
    // stored references sat like that (measured 2026-08-12), and the card
    // showed a year and nothing else.
    const titled: PaperReference = { ...REFERENCE, citations: null, parsedVenue: null };
    vi.spyOn(api, 'getPaperCitations').mockResolvedValue({
      status: 'ready',
      references: [titled],
      citations: [],
    });
    const resolveSpy = vi.spyOn(api, 'resolveReference').mockResolvedValue({
      ...titled,
      citations: 1183,
      venue: 'Empirical Methods in Natural Language Processing',
    });
    const { result } = renderHook(() => useCitations('p1'));
    await waitFor(() => expect(result.current.references).toHaveLength(1));

    await act(async () => {
      await result.current.resolve(titled);
    });

    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(result.current.referenceById('r1')).toMatchObject({
      citations: 1183,
      venue: 'Empirical Methods in Natural Language Processing',
    });
  });

  it('leaves a complete reference alone', async () => {
    const complete: PaperReference = {
      ...REFERENCE,
      citations: 42,
      venue: 'NeurIPS',
      year: 2014,
    };
    vi.spyOn(api, 'getPaperCitations').mockResolvedValue({
      status: 'ready',
      references: [complete],
      citations: [],
    });
    const resolveSpy = vi.spyOn(api, 'resolveReference').mockResolvedValue(complete);
    const { result } = renderHook(() => useCitations('p1'));
    await waitFor(() => expect(result.current.references).toHaveLength(1));

    await act(async () => {
      await result.current.resolve(complete);
    });

    expect(resolveSpy).not.toHaveBeenCalled();
  });
});

describe('useCitations — the silent search', () => {
  it('counts a reference as searched once the web has answered', async () => {
    vi.spyOn(api, 'ensureFulltext').mockResolvedValue({
      ...REFERENCE,
      pdfUrl: 'https://arxiv.org/pdf/1207.0580',
      fulltextHost: 'arxiv.org',
    });
    const { result } = renderHook(() => useCitations('p1'));
    await waitFor(() => expect(result.current.references).toHaveLength(1));

    await act(async () => {
      await result.current.ensureFulltext('r1');
    });

    expect(result.current.fulltextState.r1).toBe('done');
    expect(result.current.referenceById('r1')?.pdfUrl).toBe('https://arxiv.org/pdf/1207.0580');
  });

  it('does not count a search that could not run', async () => {
    // Otherwise the card reads "No freely available full text found" about a
    // paper nobody ever looked for — which is exactly what happened in the
    // running app once the search engines had shut us out.
    vi.spyOn(api, 'ensureFulltext').mockResolvedValue({
      ...REFERENCE,
      fulltextSearchFailed: true,
    });
    const { result } = renderHook(() => useCitations('p1'));
    await waitFor(() => expect(result.current.references).toHaveLength(1));

    await act(async () => {
      await result.current.ensureFulltext('r1').catch(() => {});
    });

    expect(result.current.fulltextState.r1).toBeUndefined();
    expect(result.current.referenceById('r1')?.fulltextSearchFailed).toBe(true);
  });

  it('does not count a search that was never set up', async () => {
    // W1 (§06): with no key nobody looked either, so the same rule applies —
    // and the prefetch queue must stop, or it walks the whole bibliography
    // recording every row as hopeless.
    vi.spyOn(api, 'ensureFulltext').mockResolvedValue({
      ...REFERENCE,
      fulltextSearchUnavailable: true,
    });
    const { result } = renderHook(() => useCitations('p1'));
    await waitFor(() => expect(result.current.references).toHaveLength(1));

    let thrown: unknown = null;
    await act(async () => {
      await result.current.ensureFulltext('r1').catch((e) => { thrown = e; });
    });

    expect((thrown as { suspended?: boolean })?.suspended).toBe(true);
    expect(result.current.fulltextState.r1).toBeUndefined();
    expect(result.current.referenceById('r1')?.fulltextSearchUnavailable).toBe(true);
  });

  it('searches for real on the next click once a key exists', async () => {
    // The card's "save and search" leans on this: the miss was never recorded,
    // so asking again actually asks.
    const search = vi.spyOn(api, 'ensureFulltext').mockResolvedValue({
      ...REFERENCE,
      fulltextSearchUnavailable: true,
    });
    const { result } = renderHook(() => useCitations('p1'));
    await waitFor(() => expect(result.current.references).toHaveLength(1));

    await act(async () => {
      await result.current.ensureFulltext('r1').catch(() => {});
    });
    search.mockResolvedValue({ ...REFERENCE, pdfUrl: 'https://arxiv.org/pdf/1207.0580' });
    await act(async () => {
      await result.current.ensureFulltext('r1');
    });

    expect(search).toHaveBeenCalledTimes(2);
    expect(result.current.referenceById('r1')?.pdfUrl).toBe('https://arxiv.org/pdf/1207.0580');
  });

  it('lets a failed search be tried again, but never repeats a real answer', async () => {
    const failing = vi.spyOn(api, 'ensureFulltext').mockResolvedValue({
      ...REFERENCE,
      fulltextSearchFailed: true,
    });
    const { result } = renderHook(() => useCitations('p1'));
    await waitFor(() => expect(result.current.references).toHaveLength(1));

    await act(async () => {
      await result.current.ensureFulltext('r1').catch(() => {});
      await result.current.ensureFulltext('r1').catch(() => {});
    });
    expect(failing).toHaveBeenCalledTimes(2);

    failing.mockResolvedValue({ ...REFERENCE, pdfUrl: null });
    await act(async () => {
      await result.current.ensureFulltext('r1');
      await result.current.ensureFulltext('r1');
    });
    expect(failing).toHaveBeenCalledTimes(3);
  });
});
