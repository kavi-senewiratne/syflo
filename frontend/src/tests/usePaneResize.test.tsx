/**
 * tests/usePaneResize.test.tsx
 *
 * The two pane dividers (chat column width, mind-map pane height) shared one
 * hand-copied drag algorithm in App.tsx and had no behaviour test at all —
 * App.test.tsx only asserted that the divider element exists. This covers what
 * the extraction to hooks/usePaneResize.ts must keep true:
 *
 *   - a stored size is restored, but only when it is inside [min, max]
 *   - every move is clamped
 *   - localStorage is written on pointerup, NOT on every pointermove
 *   - pointercancel persists like pointerup (the pointer can be stolen mid-drag)
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { usePaneResize } from '../hooks/usePaneResize';

const KEY = 'test.paneWidth';

// jsdom has no Pointer Capture API — the hook calls it on pointerdown.
beforeEach(() => {
  localStorage.clear();
  Element.prototype.setPointerCapture = vi.fn();
});

/** A divider dragged along X, the chat column's geometry. */
function Harness() {
  const [width, handlers] = usePaneResize({
    storageKey: KEY,
    fallback: 340,
    min: 300,
    max: 800,
    startDrag: (e, current) => ({ startX: e.clientX, startWidth: current }),
    nextValue: (e, start) => start.startWidth + (start.startX - e.clientX),
  });
  return (
    <div>
      <span data-testid="width">{width}</span>
      <div data-testid="divider" {...handlers} />
    </div>
  );
}

const width = () => Number(screen.getByTestId('width').textContent);
const divider = () => screen.getByTestId('divider');

function drag(...xs: number[]) {
  fireEvent.pointerDown(divider(), { clientX: xs[0], pointerId: 1 });
  for (const x of xs.slice(1)) fireEvent.pointerMove(divider(), { clientX: x, pointerId: 1 });
}

describe('usePaneResize', () => {
  it('starts on the fallback when nothing is stored', () => {
    render(<Harness />);
    expect(width()).toBe(340);
  });

  it('restores a stored size', () => {
    localStorage.setItem(KEY, '520');
    render(<Harness />);
    expect(width()).toBe(520);
  });

  it('discards a stored size outside [min, max]', () => {
    localStorage.setItem(KEY, '9000');
    render(<Harness />);
    expect(width()).toBe(340);
  });

  it('follows the pointer — dragging left widens the column', () => {
    render(<Harness />);
    drag(500, 460); // 40 px to the left
    expect(width()).toBe(380);
  });

  it('clamps the size at both bounds', () => {
    render(<Harness />);
    drag(500, -2000);
    expect(width()).toBe(800);

    fireEvent.pointerUp(divider());
    drag(500, 2000);
    expect(width()).toBe(300);
  });

  it('writes to storage on release only, not on every move', () => {
    render(<Harness />);
    drag(500, 480, 460);
    expect(localStorage.getItem(KEY)).toBeNull();

    fireEvent.pointerUp(divider());
    expect(localStorage.getItem(KEY)).toBe('380');
  });

  it('still saves the size when the pointer is taken away mid-drag', () => {
    render(<Harness />);
    drag(500, 450);
    fireEvent.pointerCancel(divider());
    expect(localStorage.getItem(KEY)).toBe('390');
  });

  it('ignores moves that had no pointerdown', () => {
    render(<Harness />);
    fireEvent.pointerMove(divider(), { clientX: 100 });
    expect(width()).toBe(340);
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
