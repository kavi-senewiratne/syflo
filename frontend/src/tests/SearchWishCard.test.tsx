/**
 * SearchWishCard.test.tsx
 *
 * W2 (§06): the model called `web_search` and there was no key, so nobody
 * looked. The card under the answer says so — and names the query the model
 * formulated, because that is the fact that makes "is a key worth getting?"
 * answerable.
 *
 * Shape and copy: design/mockup-search-wish-card.html, variant C. Two facts the
 * earlier copy left to inference and these tests now pin: a Tavily key is the
 * only way Syflo searches at all (ADR-0012 dropped SearXNG), and the free tier
 * is not a trial — ~33 searches a day, stated per day because that is the unit
 * a reader can judge.
 *
 * The state it prevents: a confidently stale answer with nothing to indicate
 * that a search would have helped.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { MessageBubble } from '../components/ChatArea/MessageBubble';
import type { Message } from '../types';

const answered: Message = {
  id: 'a1',
  chat_id: 'c1',
  role: 'assistant',
  content: 'As of my knowledge cutoff, I cannot give you today’s weather.',
  created_at: new Date().toISOString(),
  searchWish: { query: 'weather in Austin today', error: 'no-search-provider' },
};

describe('the search wish card', () => {
  it('names the query the model would have searched for', () => {
    render(<MessageBubble message={answered} onWordRightClick={vi.fn()} />);

    const card = screen.getByTestId('search-wish');
    expect(card).toHaveTextContent('wanted to look up');
    expect(card).toHaveTextContent('weather in Austin today');
  });

  it('says what the answer is worth without a search', () => {
    render(<MessageBubble message={answered} onWordRightClick={vi.fn()} />);

    expect(screen.getByTestId('search-wish')).toHaveTextContent(
      'Answered without a web search',
    );
  });

  it('says that a key is what makes searching possible at all', () => {
    // Without this line the card only reports a failure; the reader has no way
    // to know Syflo has no other search path.
    render(<MessageBubble message={answered} onWordRightClick={vi.fn()} />);

    expect(screen.getByTestId('search-wish')).toHaveTextContent(
      'A free Tavily key switches web search on',
    );
  });

  it('states the free allowance per day, the unit a reader can judge', () => {
    render(<MessageBubble message={answered} onWordRightClick={vi.fn()} />);

    expect(screen.getByTestId('search-wish')).toHaveTextContent('~33 a day');
  });

  it('drops the offer once the allowance is gone, where no key helps', () => {
    render(
      <MessageBubble
        message={{ ...answered, searchWish: { query: 'q', error: 'tavily-quota-exhausted' } }}
        onWordRightClick={vi.fn()}
      />,
    );

    const card = screen.getByTestId('search-wish');
    expect(card).toHaveTextContent('allowance used up');
    expect(card).not.toHaveTextContent('switches web search on');
    // Nothing to press until the 1st — offering a key would be a dead end.
    expect(screen.queryByTestId('search-wish-key-open')).not.toBeInTheDocument();
  });

  it('sits under the answer and never replaces it', () => {
    render(<MessageBubble message={answered} onWordRightClick={vi.fn()} />);

    // The answer is real content — the reader keeps it whatever the card says.
    expect(screen.getByText(/knowledge cutoff/)).toBeInTheDocument();
  });

  it('stays away when the search actually ran', () => {
    render(
      <MessageBubble
        message={{ ...answered, searchWish: undefined }}
        onWordRightClick={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('search-wish')).not.toBeInTheDocument();
  });

  it('takes a key and asks for the answer again in one gesture', async () => {
    const onSaveSearchKey = vi.fn().mockResolvedValue(undefined);
    render(
      <MessageBubble
        message={answered}
        onWordRightClick={vi.fn()}
        onSaveSearchKey={onSaveSearchKey}
      />,
    );

    await userEvent.click(screen.getByTestId('search-wish-key-open'));
    await userEvent.type(screen.getByTestId('search-wish-key-input'), 'tvly-abc123');
    await userEvent.click(screen.getByTestId('search-wish-key-save'));

    // The caller re-runs the answer, so it needs to know WHICH answer: the
    // bubble binds its own message to the call.
    expect(onSaveSearchKey).toHaveBeenCalledWith(
      'tvly-abc123',
      expect.objectContaining({ id: 'a1' }),
    );
  });

  it('never saves an empty key', async () => {
    const onSaveSearchKey = vi.fn();
    render(
      <MessageBubble
        message={answered}
        onWordRightClick={vi.fn()}
        onSaveSearchKey={onSaveSearchKey}
      />,
    );

    await userEvent.click(screen.getByTestId('search-wish-key-open'));
    await userEvent.click(screen.getByTestId('search-wish-key-save'));

    expect(onSaveSearchKey).not.toHaveBeenCalled();
  });

  it('can be dismissed, because the reader has already been told', async () => {
    // The mockup's "answer anyway": the answer is already there, so dismissing
    // costs nothing — unlike the citation card, where the card IS the way out.
    render(<MessageBubble message={answered} onWordRightClick={vi.fn()} />);

    await userEvent.click(screen.getByTestId('search-wish-dismiss'));

    expect(screen.queryByTestId('search-wish')).not.toBeInTheDocument();
  });

  // Reported 2026-08-25: the note used to vanish on the next chat switch,
  // because it lived only in the stream. Now it is a stored column — which
  // means it can outlive the situation it describes.
  it('keeps the note but drops the offer once a key is stored', () => {
    render(
      <MessageBubble message={answered} onWordRightClick={vi.fn()} searchKeyStored />,
    );

    const card = screen.getByTestId('search-wish');
    // Still true: this answer WAS written without a search.
    expect(card).toHaveTextContent('Answered without a web search');
    expect(card).toHaveTextContent('weather in Austin today');
    // No longer true: there is nothing left to add.
    expect(card).not.toHaveTextContent('switches web search on');
    expect(screen.queryByTestId('search-wish-key-open')).not.toBeInTheDocument();
  });

  it('says the key was rejected rather than asking as if none existed', () => {
    render(
      <MessageBubble
        message={{ ...answered, searchWish: { query: 'q', error: 'tavily-invalid-key' } }}
        onWordRightClick={vi.fn()}
      />,
    );

    const card = screen.getByTestId('search-wish');
    expect(card).toHaveTextContent('rejected');
    // The ask changes with the state: replacing, not adding.
    expect(card).toHaveTextContent('Replace the key');
  });
});
