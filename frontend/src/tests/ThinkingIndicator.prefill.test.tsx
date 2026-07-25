/**
 * PrefillEtaLine im ThinkingIndicator (design/mockup-prefill-progress.html §01):
 * Countdown-Zeile, solange das Backend Prefill vorhersagt; nach Ablauf der
 * Schätzung ehrliche "dauert länger"-Zeile statt eines hängenden Balkens.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { ThinkingIndicator } from '../components/ChatArea/ThinkingIndicator';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ThinkingIndicator — prefill ETA', () => {
  it('shows nothing without a prefillEta', () => {
    render(<ThinkingIndicator />);
    expect(screen.queryByTestId('prefill-eta')).toBeNull();
  });

  it('renders the countdown and ticks down once per second', () => {
    vi.useFakeTimers();
    render(<ThinkingIndicator prefillEta={35} />);

    expect(screen.getByTestId('prefill-eta').textContent).toContain('~35');

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId('prefill-eta').textContent).toContain('~33');
  });

  it('switches to the "taking longer" line when the estimate overruns', () => {
    vi.useFakeTimers();
    render(<ThinkingIndicator prefillEta={2} />);

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    const line = screen.getByTestId('prefill-eta').textContent || '';
    expect(line).not.toContain('~');
    expect(line.toLowerCase()).toContain('longer');
  });
});
