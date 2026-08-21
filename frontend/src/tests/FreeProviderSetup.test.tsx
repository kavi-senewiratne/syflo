/**
 * tests/FreeProviderSetup.test.tsx
 *
 * G2 (design/mockup-onboarding-flow.html §07, chosen 2026-08-15): the second
 * free provider is offered exactly where its value is visible — on the card
 * that says the daily limit is reached. The offer states the allowance and
 * the limits (Groq reads no images) and never calls one provider better than
 * another. Both exits are real: add the provider, or wait for the reset.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MessageBubble } from '../components/ChatArea/MessageBubble';
import { FAILED_MARKER } from '../types';
import type { FreeProviderOffer, Message } from '../types';

const noop = () => {};

// A persisted *Failed* marker whose failover ended on the daily limit.
const dailyLimit: Message = {
  id: 'a1',
  chat_id: 'c1',
  role: 'assistant',
  content: FAILED_MARKER,
  created_at: '2026-08-15T10:00:00.000Z',
  quotaExhausted: true,
  quotaReason: 'daily',
  failProvider: 'gemini',
};

// Numbers as registry.json states them: Groq's free tier counts tokens.
const groqOffer: FreeProviderOffer = {
  provider: 'groq',
  label: 'Groq',
  quota: '200,000 tokens a day',
  readsImages: false,
};

describe('daily-limit card · free provider offer', () => {
  it('states the other free provider’s allowance and that it reads no images', () => {
    render(
      <MessageBubble
        message={dailyLimit}
        onWordRightClick={noop}
        freeProviderOffer={groqOffer}
        onAddFreeProvider={vi.fn()}
      />,
    );
    const offer = screen.getByTestId('free-provider-offer');
    expect(offer).toHaveTextContent(
      'With a Groq key you could keep working right away — 200,000 tokens a day, free of charge.',
    );
    expect(offer).toHaveTextContent('Groq does not read images, though.');
  });

  it('offers adding the provider as the acting exit', () => {
    const onAddFreeProvider = vi.fn();
    render(
      <MessageBubble
        message={dailyLimit}
        onWordRightClick={noop}
        freeProviderOffer={groqOffer}
        onAddFreeProvider={onAddFreeProvider}
      />,
    );
    const button = screen.getByTestId('add-free-provider-button');
    expect(button).toHaveTextContent('Add Groq');
    fireEvent.click(button);
    expect(onAddFreeProvider).toHaveBeenCalledWith('groq');
  });

  it('waiting is an equal exit that changes nothing on the card', () => {
    const onAddFreeProvider = vi.fn();
    render(
      <MessageBubble
        message={dailyLimit}
        onWordRightClick={noop}
        freeProviderOffer={groqOffer}
        onAddFreeProvider={onAddFreeProvider}
      />,
    );
    const wait = screen.getByTestId('free-provider-wait-button');
    expect(wait).toHaveTextContent('Wait until tomorrow');
    const before = screen.getByTestId('failed-note').textContent;
    fireEvent.click(wait);
    expect(onAddFreeProvider).not.toHaveBeenCalled();
    expect(screen.getByTestId('failed-note').textContent).toBe(before);
  });

  it('without an offer the daily card is exactly the card it was before', () => {
    const withOffer = render(
      <MessageBubble
        message={dailyLimit}
        onWordRightClick={noop}
        onRetryMessage={vi.fn()}
        freeProviderOffer={groqOffer}
        onAddFreeProvider={vi.fn()}
      />,
    );
    const enriched = screen.getByTestId('failed-note').textContent!;
    withOffer.unmount();

    render(<MessageBubble message={dailyLimit} onWordRightClick={noop} onRetryMessage={vi.fn()} />);
    const plain = screen.getByTestId('failed-note');
    expect(screen.queryByTestId('free-provider-offer')).not.toBeInTheDocument();
    expect(screen.queryByTestId('add-free-provider-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('free-provider-wait-button')).not.toBeInTheDocument();
    // The daily card's own exits are untouched by G2.
    expect(screen.getByTestId('retry-button')).toBeInTheDocument();
    expect(plain.textContent).toBe('The daily quota of the cloud models is used up.Try again');
    // The offer only ever ADDS to the card — the old wording stays put.
    expect(enriched).toContain('The daily quota of the cloud models is used up.');
    expect(enriched).toContain('Try again');
  });

  it('offers nothing on a limit that is not the daily one', () => {
    const minuteLimit: Message = { ...dailyLimit, quotaReason: 'rate_limit' };
    render(
      <MessageBubble
        message={minuteLimit}
        onWordRightClick={noop}
        freeProviderOffer={groqOffer}
        onAddFreeProvider={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('free-provider-offer')).not.toBeInTheDocument();
    expect(screen.queryByTestId('add-free-provider-button')).not.toBeInTheDocument();
  });
});
