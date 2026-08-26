/**
 * CitationCard.test.tsx
 *
 * The card a clicked citation opens. What matters here is the rule the whole
 * design rests on: THE STATE LIVES IN THE DOOR. There is no badge and no
 * footnote explaining anything — a paywalled work reads "No free PDF", one
 * already imported reads "Go to tree", one downloading shows a spinner in the
 * button that stays exactly where it was.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CitationCard, browserUrlFor } from '../components/CitationCard';
import type { PaperReference } from '../types';

const RESOLVED: PaperReference = {
  id: 'r1',
  anchor: 'cite.luong2015',
  label: '[24]',
  rawText: '[24] M.-T. Luong, H. Pham, C. Manning. Effective approaches… arXiv:1508.04025, 2015.',
  openalexId: 'W2',
  title: 'Effective Approaches to Attention-based Neural Machine Translation',
  authors: ['Minh-Thang Luong', 'Hieu Pham', 'Christopher D. Manning'],
  year: 2015,
  citations: 11204,
  doi: null,
  arxivId: '1508.04025',
  pdfUrl: 'https://arxiv.org/pdf/1508.04025',
  parsedTitle: 'Effective approaches to attention-based neural machine translation',
  parsedAuthors: ['M.-T. Luong', 'H. Pham', 'C. Manning'],
  parsedVenue: null,
  parsedYear: 2015,
};

// No downloadable PDF: the publisher only offers a landing page.
const PAYWALLED: PaperReference = {
  ...RESOLVED,
  id: 'r2',
  anchor: 'cite.lstm',
  label: '[13]',
  title: 'Long Short-Term Memory',
  authors: ['Sepp Hochreiter', 'Jürgen Schmidhuber'],
  year: 1997,
  citations: 92640,
  doi: '10.1162/neco.1997.9.8.1735',
  arxivId: null,
  pdfUrl: null,
  parsedTitle: 'Long short-term memory',
  parsedAuthors: ['Sepp Hochreiter', 'Jürgen Schmidhuber'],
  parsedVenue: 'Neural Computation',
  parsedYear: 1997,
};

// OpenAlex knows nothing about it; the printed row is all we have.
const UNRESOLVED: PaperReference = {
  id: 'r3',
  anchor: 'cite.sennrich',
  label: '[31]',
  rawText: '[31] R. Sennrich, B. Haddow, A. Birch. Improving NMT models with monolingual data. 2015.',
  openalexId: null,
  title: null,
  authors: [],
  year: null,
  citations: null,
  doi: null,
  arxivId: null,
  pdfUrl: null,
  parsedTitle: 'Improving NMT models with monolingual data',
  parsedAuthors: ['R. Sennrich', 'B. Haddow', 'A. Birch'],
  parsedVenue: null,
  parsedYear: 2015,
};

function setup(reference: PaperReference, props: Partial<Parameters<typeof CitationCard>[0]> = {}) {
  const handlers = {
    onClose: vi.fn(),
    onOpenInSyflo: vi.fn(),
    onOpenInBrowser: vi.fn(),
    onGoToTree: vi.fn(),
  };
  render(
    <CitationCard target={{ reference, x: 100, y: 100 }} {...handlers} {...props} />,
  );
  return handlers;
}

describe('CitationCard', () => {
  it('offers both doors for a work with a free PDF', async () => {
    const h = setup(RESOLVED);

    expect(screen.getByText(RESOLVED.title as string)).toBeInTheDocument();
    // Each fact on its own row behind its own icon, not one "·"-joined line.
    expect(screen.getByText('Minh-Thang Luong, Hieu Pham, Christopher D. Manning')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('citation-open-in-syflo'));
    expect(h.onOpenInSyflo).toHaveBeenCalledWith(RESOLVED);

    await userEvent.click(screen.getByTestId('citation-open-in-browser'));
    expect(h.onOpenInBrowser).toHaveBeenCalledWith(RESOLVED);
  });

  it('shows title and authors, and folds the rest into one line', async () => {
    // Variant 6 (design/mockup-citation-card-v2.html, user decision
    // 2026-08-09): a reader clicking a citation asks "do I want to read
    // this?" — the title and the authors answer it. Year, venue and citation
    // count are reference material and collapse until asked for.
    setup(RESOLVED);

    expect(screen.getByText(RESOLVED.title as string)).toBeInTheDocument();
    expect(screen.getByText('Minh-Thang Luong, Hieu Pham, Christopher D. Manning')).toBeInTheDocument();

    // Folded: one summary line, no separate rows yet. The count says what it
    // counts — there is no icon beside it to explain a bare number.
    const more = screen.getByTestId('citation-more');
    expect(more).toHaveTextContent('2015');
    expect(more).toHaveTextContent('11,204 citations');
    expect(screen.queryByText('Year:')).not.toBeInTheDocument();

    await userEvent.click(more);

    // Unfolded: each fact on its own labelled row.
    expect(screen.getByText('Year:')).toBeInTheDocument();
    expect(screen.getByText('Citations:')).toBeInTheDocument();
  });

  it('prefers the resolved venue over the one read off the printed row', async () => {
    // The printed row abbreviates ("In Proc. EMNLP"); the resolved record
    // spells it out. Both are shown in the same slot, so the better one wins
    // (2026-08-12).
    setup({
      ...RESOLVED,
      venue: 'Empirical Methods in Natural Language Processing',
      parsedVenue: 'In Proc. EMNLP',
    });

    await userEvent.click(screen.getByTestId('citation-more'));

    expect(
      screen.getByText('Empirical Methods in Natural Language Processing'),
    ).toBeInTheDocument();
    expect(screen.queryByText('In Proc. EMNLP')).not.toBeInTheDocument();
  });

  it('leaves out the fold when there is nothing behind it', async () => {
    setup({ ...UNRESOLVED, parsedYear: null, parsedVenue: null });

    expect(screen.queryByTestId('citation-more')).not.toBeInTheDocument();
    expect(screen.getByText('R. Sennrich, B. Haddow, A. Birch')).toBeInTheDocument();
  });

  it('gives every fact its own row, labelled for screen readers', async () => {
    // One long "·"-separated string wrapped mid-separator and read as rubble
    // (user report 2026-08-09). Icons replace the separators; the label each
    // icon carries is what a screen reader announces.
    setup({ ...UNRESOLVED, parsedVenue: 'Advances in Neural Information Processing Systems' });
    await userEvent.click(screen.getByTestId('citation-more'));

    expect(screen.getByText('R. Sennrich, B. Haddow, A. Birch')).toBeInTheDocument();
    expect(screen.getByText('2015')).toBeInTheDocument();
    expect(
      screen.getByText('Advances in Neural Information Processing Systems'),
    ).toBeInTheDocument();
    // The icons are decorative; the meaning lives in the labels beside them.
    // The authors need none — they are the sentence, not a data field.
    expect(screen.getByText('Published in:')).toBeInTheDocument();
    expect(screen.getByText('Year:')).toBeInTheDocument();
  });

  it('marks a shortened author list rather than cutting silently', async () => {
    setup({
      ...UNRESOLVED,
      parsedAuthors: ['A. One', 'B. Two', 'C. Three', 'D. Four', 'E. Five'],
    });

    expect(screen.getByText(/A\. One, B\. Two, C\. Three et al\./)).toBeInTheDocument();
  });

  it('drops the Syflo door and says why, rather than showing a dead button', async () => {
    // A disabled button carrying an explanation is not a control — it reads
    // as broken (user report 2026-08-09). The reason moves into the body and
    // only the working door remains. Since the silent search exists, the
    // verdict is only spoken once the search HAS looked (searchDone).
    setup(PAYWALLED, { searchDone: true });

    expect(screen.queryByTestId('citation-open-in-syflo')).not.toBeInTheDocument();
    expect(screen.getByTestId('citation-no-pdf-note')).toHaveTextContent(/No freely available full text/i);
    expect(screen.getByTestId('citation-open-in-browser')).toBeEnabled();
  });

  it('reads a row OpenAlex never listed off the page, in the same layout', async () => {
    // Same title weight, same meta line — the overline is the only place that
    // admits where the metadata came from.
    setup(UNRESOLVED);

    expect(screen.getByText('Improving NMT models with monolingual data')).toBeInTheDocument();
    expect(screen.getByText('R. Sennrich, B. Haddow, A. Birch')).toBeInTheDocument();
    expect(screen.getByText(/from the page/i)).toBeInTheDocument();
  });

  it('keeps the button in place while the paper downloads', async () => {
    // Same surface, same size — only icon and label change, exactly as
    // FloatingPopup behaves while creating a branch.
    setup(RESOLVED, { loading: true });

    const syflo = screen.getByTestId('citation-open-in-syflo');
    expect(syflo).toHaveTextContent('Loading paper…');
    expect(syflo).toBeDisabled();
    expect(syflo).toHaveAttribute('aria-busy', 'true');
  });

  it('swaps the verb once the work is already a tree', async () => {
    const h = setup(RESOLVED, { existingChatId: 'chat-9' });

    expect(screen.queryByTestId('citation-open-in-syflo')).not.toBeInTheDocument();
    const goTo = screen.getByTestId('citation-go-to-tree');
    expect(goTo).toHaveTextContent('Go to tree');

    await userEvent.click(goTo);
    // Never a duplicate tree — it navigates to the one that exists.
    expect(h.onGoToTree).toHaveBeenCalledWith('chat-9');
    expect(h.onOpenInSyflo).not.toHaveBeenCalled();
  });

  it('reports a failed download in the card, since Syflo has no toasts', async () => {
    setup(RESOLVED, { failed: true });

    expect(screen.getByText(/download was blocked/i)).toBeInTheDocument();
    // The door that cannot work is gone; the browser stays.
    expect(screen.queryByTestId('citation-open-in-syflo')).not.toBeInTheDocument();
    expect(screen.getByTestId('citation-open-in-browser')).toBeEnabled();
  });

  it('falls back to the printed line only when nothing could be read out of it', async () => {
    const fragment = { ...UNRESOLVED, parsedTitle: null, parsedAuthors: [], parsedYear: null };
    setup(fragment);

    expect(screen.getByText(/R\. Sennrich, B\. Haddow/)).toBeInTheDocument();
    // And nothing else: a line saying "this is the printed text" would sit
    // right under the printed text and add nothing (user report 2026-08-09).
    expect(screen.queryByText(/printed/i)).not.toBeInTheDocument();
  });

  it('always lets the reader search — even with no identifier at all', async () => {
    // The dead "Search the web" button was the one thing the reader could not
    // click (user report 2026-08-09). The printed row IS the query.
    const h = setup({ ...UNRESOLVED, parsedTitle: null });

    const browser = screen.getByTestId('citation-open-in-browser');
    expect(browser).toBeEnabled();
    expect(browser).toHaveTextContent('Search the web');

    await userEvent.click(browser);
    expect(h.onOpenInBrowser).toHaveBeenCalled();
  });

  it('opens the same window whatever the title is', async () => {
    // Two clicks in a row used to produce two differently sized cards: the
    // shell was w-fit between 280 and 440px, so the window jumped with every
    // reference (user report 2026-08-10, design/mockup-citation-card-standard
    // .html § 02). One measure for all — the price is empty space beside a
    // short title, and it is paid deliberately.
    const short = { ...RESOLVED, title: 'Deep Residual Learning' };
    const long = {
      ...RESOLVED,
      id: 'r-long',
      title:
        "Google's Neural Machine Translation System: Bridging the Gap between Human and Machine Translation",
    };

    const first = render(
      <CitationCard
        target={{ reference: short, x: 100, y: 100 }}
        onClose={vi.fn()}
        onOpenInSyflo={vi.fn()}
        onOpenInBrowser={vi.fn()}
        onGoToTree={vi.fn()}
      />,
    );
    const narrow = screen.getByTestId('citation-card').style.width;
    first.unmount();

    render(
      <CitationCard
        target={{ reference: long, x: 100, y: 100 }}
        onClose={vi.fn()}
        onOpenInSyflo={vi.fn()}
        onOpenInBrowser={vi.fn()}
        onGoToTree={vi.fn()}
      />,
    );

    expect(narrow).not.toBe('');
    expect(screen.getByTestId('citation-card').style.width).toBe(narrow);
    // Clamped to three lines — so the full title has to stay reachable.
    expect(screen.getByTestId('citation-title')).toHaveAttribute('title', long.title);
  });

  describe('the silent full-text search', () => {
    // design/mockup-citation-card-standard.html § 04, user decision
    // 2026-08-10: the search is an ingredient, not a screen. There is no
    // "Search the web" button and no hit list — whatever the search finds
    // simply becomes the door, and the card looks like any other.

    it('never denies the door before anyone has looked for it', async () => {
      // Seen in the running app 2026-08-11: the card opened with "No
      // downloadable PDF available" and only THEN turned into "Looking for
      // the full text…". A reference without a linked PDF is always searched,
      // so "not looked yet" must read as looking — not as a verdict.
      setup(PAYWALLED);

      expect(screen.getByTestId('citation-open-in-syflo')).toHaveTextContent(
        'Looking for the full text…',
      );
      expect(screen.queryByTestId('citation-no-pdf-note')).not.toBeInTheDocument();
    });

    it('says the door is on its way instead of denying it exists', async () => {
      setup(PAYWALLED, { searching: true });

      const syflo = screen.getByTestId('citation-open-in-syflo');
      expect(syflo).toHaveTextContent('Looking for the full text…');
      expect(syflo).toBeDisabled();
      // The old "No downloadable PDF available" would be a lie while looking.
      expect(screen.queryByTestId('citation-no-pdf-note')).not.toBeInTheDocument();
    });

    it('leaves no trace of itself once it has found something', async () => {
      // The card said "Full text found on arxiv.org" for a while. It is
      // backstage information: the reader's job is to read the paper, not to
      // learn how Syflo got hold of it (user decision 2026-08-11). A found
      // reference is simply a reference with a door.
      const h = setup({
        ...PAYWALLED,
        pdfUrl: 'https://arxiv.org/pdf/1508.07909',
        fulltextHost: 'arxiv.org',
      });

      expect(screen.queryByTestId('citation-fulltext-host')).not.toBeInTheDocument();
      expect(screen.queryByText(/arxiv\.org/i)).not.toBeInTheDocument();
      await userEvent.click(screen.getByTestId('citation-open-in-syflo'));
      expect(h.onOpenInSyflo).toHaveBeenCalled();
    });

    it('admits the search came up empty, and keeps the browser door', async () => {
      setup(PAYWALLED, { searchDone: true });

      expect(screen.queryByTestId('citation-open-in-syflo')).not.toBeInTheDocument();
      expect(screen.getByTestId('citation-no-pdf-note')).toHaveTextContent(/No freely available full text/i);
      expect(screen.getByTestId('citation-open-in-browser')).toBeEnabled();
    });

    it('counts the wait down and tries again by itself', async () => {
      // Being shut out is temporary: the engines behind the search suspend a
      // caller that asked too often and let them back in minutes later. The
      // card says so in three words and takes care of the retry — a dead end
      // that fixes itself while you look at it is not a dead end (user
      // decision 2026-08-11).
      vi.useFakeTimers();
      try {
        const onRetrySearch = vi.fn();
        render(
          <CitationCard
            target={{ reference: PAYWALLED, x: 100, y: 100 }}
            searchRetryAt={new Date(Date.now() + 30_000).toISOString()}
            onRetrySearch={onRetrySearch}
            onClose={vi.fn()}
            onOpenInSyflo={vi.fn()}
            onOpenInBrowser={vi.fn()}
            onGoToTree={vi.fn()}
          />,
        );

        // The countdown is a NOTE, not a button: a button implies a choice,
        // and the reader has none — nor could they tell what pressing it
        // would retry (user report 2026-08-11). The door keeps saying what
        // Syflo is doing; the grey line above says when the next attempt is.
        const note = screen.getByTestId('citation-search-retry');
        expect(note.tagName).not.toBe('BUTTON');
        expect(note).toHaveTextContent('Search paused — resuming in 30 s');
        // The door stays, greyed out, and names what the reader will be able
        // to do when the clock runs out — not what the machine is doing
        // meanwhile (user decision 2026-08-11). No spinner: nothing is being
        // searched during the wait.
        const door = screen.getByTestId('citation-open-in-syflo');
        expect(door).toBeDisabled();
        expect(door).toHaveTextContent('Open in Syflo');
        expect(door.querySelector('.animate-spin')).toBeNull();
        expect(screen.getByTestId('citation-open-in-browser')).toBeEnabled();

        await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
        expect(screen.getByTestId('citation-search-retry')).toHaveTextContent('20 s');

        await act(async () => { await vi.advanceTimersByTimeAsync(21_000); });
        expect(onRetrySearch).toHaveBeenCalledTimes(1);
        // At zero the search starts again, and the door says so: the wait is
        // over, so neither the clock line nor the grey destination may stay
        // (user decision 2026-08-11).
        expect(screen.queryByTestId('citation-search-retry')).not.toBeInTheDocument();
        const resumed = screen.getByTestId('citation-open-in-syflo');
        expect(resumed).toHaveTextContent('Looking for the full text…');
        expect(resumed.querySelector('.animate-spin')).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('when no web search is set up', () => {
    // W1 (design/mockup-onboarding-flow.html §06): the card asks for the key
    // at the point of need, because this is the spot where a search WOULD have
    // run. Not in the settings, on the off chance the reader goes looking.
    it('asks for a key instead of counting down a wait that cannot end', () => {
      setup(PAYWALLED, { searchUnavailable: true });

      // No countdown, no greyed-out door promising a retry: waiting fixes an
      // engine that shut us out, never a search that was never set up.
      expect(screen.queryByTestId('citation-search-retry')).not.toBeInTheDocument();
      expect(screen.getByTestId('citation-search-setup')).toBeInTheDocument();
      expect(screen.getByTestId('citation-search-setup')).toHaveTextContent(
        'No freely available full text found',
      );
      // The free allowance is the fact that makes the ask answerable — and it
      // is a number, not a recommendation.
      expect(screen.getByTestId('citation-search-setup')).toHaveTextContent(
        '1000 searches a month, free',
      );
      // Three short lines, and NOT the paper's title again: the card already
      // carries it as its own heading (user report 2026-08-24, "it looks like
      // a lot of text now").
      expect(screen.getByTestId('citation-search-setup')).not.toHaveTextContent(
        PAYWALLED.title as string,
      );
    });

    it('saves the key and searches again in one gesture', async () => {
      const onSaveSearchKey = vi.fn().mockResolvedValue(undefined);
      setup(PAYWALLED, { searchUnavailable: true, onSaveSearchKey });

      await userEvent.click(screen.getByTestId('citation-search-key-open'));
      await userEvent.type(screen.getByTestId('citation-search-key-input'), 'tvly-abc123');
      await userEvent.click(screen.getByTestId('citation-search-key-save'));

      // One call, with the key alone: the card knows which reference it is on,
      // so re-running the search is the caller's business, not the reader's.
      expect(onSaveSearchKey).toHaveBeenCalledWith('tvly-abc123');
    });

    it('never saves an empty key', async () => {
      const onSaveSearchKey = vi.fn();
      setup(PAYWALLED, { searchUnavailable: true, onSaveSearchKey });

      await userEvent.click(screen.getByTestId('citation-search-key-open'));
      await userEvent.click(screen.getByTestId('citation-search-key-save'));

      expect(onSaveSearchKey).not.toHaveBeenCalled();
    });

    it('offers Scholar as the way out for a reader who will not add a key', async () => {
      // The mockup's second button. Whoever declines the key still came here to
      // read the paper, and Scholar is where they would have gone by hand.
      const h = setup(PAYWALLED, { searchUnavailable: true });

      await userEvent.click(screen.getByTestId('citation-search-scholar'));

      expect(h.onOpenInBrowser).toHaveBeenCalledWith(PAYWALLED);
    });

  });

  it('closes on Escape', async () => {
    const h = setup(RESOLVED);

    await userEvent.keyboard('{Escape}');

    expect(h.onClose).toHaveBeenCalled();
  });
});

describe('browserUrlFor', () => {
  it('prefers the arXiv abstract, then the DOI, then a title search', () => {
    expect(browserUrlFor(RESOLVED)).toBe('https://arxiv.org/abs/1508.04025');
    expect(browserUrlFor(PAYWALLED)).toBe('https://doi.org/10.1162/neco.1997.9.8.1735');
    // Never null: a row with nothing but printed text still searches for it.
    expect(browserUrlFor({ ...UNRESOLVED, parsedTitle: null })).toContain('google.com/search');
  });
});
