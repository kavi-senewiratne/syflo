/**
 * tests/Popover.test.tsx
 *
 * The portal popover helper (design/mockup-model-picker-truth.html §01,
 * variant A). The bug it exists for: a drop-up rendered as an `absolute`
 * child of the composer is clipped by the chat column's `overflow-hidden`,
 * so in a 240 px column the 288 px model menu lost its left half.
 *
 * jsdom has no layout — every getBoundingClientRect is 0x0 — so the two
 * measurements the helper takes (anchor rect, panel size) are faked on
 * Element.prototype; that also covers the panel, which only exists after
 * the portal has rendered.
 */

import { useRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Popover } from '../components/Popover';

// w-72 — the width of the model menu, the panel the helper was built for.
const PANEL_WIDTH = 288;
const PANEL_HEIGHT = 320;

const rect = (r: Partial<DOMRect>): DOMRect =>
  ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}), ...r }) as DOMRect;

// The anchor as the app sees it: the composer's model pill at the bottom
// right of a wide chat column.
const WIDE_ANCHOR = rect({ left: 800, right: 900, top: 700, bottom: 736, width: 100, height: 36 });

let anchorRect = WIDE_ANCHOR;

function stubLayout(anchor: DOMRect) {
  anchorRect = anchor;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element): DOMRect {
    const id = this.getAttribute?.('data-testid');
    if (id === 'anchor') return anchorRect;
    if (id === 'panel') return rect({ width: PANEL_WIDTH, height: PANEL_HEIGHT });
    return rect({});
  });
}

function setViewport(width: number, height: number) {
  window.innerWidth = width;
  window.innerHeight = height;
}

function Harness({ open = true, onClose, align }: { open?: boolean; onClose?: () => void; align?: 'start' | 'end' }) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <div data-testid="parent">
      <button data-testid="anchor" ref={anchorRef} type="button">
        anchor
      </button>
      <Popover open={open} anchorRef={anchorRef} onClose={onClose ?? (() => {})} align={align} className="w-72" testId="panel">
        <span data-testid="content">menu content</span>
      </Popover>
    </div>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Popover', () => {
  it('renders its children in document.body, not inside the parent container', () => {
    stubLayout(WIDE_ANCHOR);
    setViewport(1280, 800);
    render(<Harness />);
    const panel = screen.getByTestId('panel');
    expect(panel.parentElement).toBe(document.body);
    expect(screen.getByTestId('parent')).not.toContainElement(screen.getByTestId('content'));
  });

  it('sits right-aligned above the anchor, measured against the viewport', () => {
    stubLayout(WIDE_ANCHOR);
    setViewport(1280, 800);
    render(<Harness />);
    const panel = screen.getByTestId('panel');
    expect(panel.style.position).toBe('fixed');
    // left = anchor.right - width = 900 - 288
    expect(panel.style.left).toBe('612px');
    // bottom = viewportHeight - anchor.top + gap = 800 - 700 + 8
    expect(panel.style.bottom).toBe('108px');
  });

  // The reported bug: a 288 px panel right-aligned in a 240 px column
  // reaches past the left window edge. It gets pushed in instead of cut off.
  it('pushes itself in at the left window edge instead of hanging outside', () => {
    stubLayout(rect({ left: 140, right: 240, top: 700, bottom: 736, width: 100, height: 36 }));
    setViewport(260, 800);
    render(<Harness />);
    // 240 - 288 = -48 would be off-screen; the margin wins.
    expect(screen.getByTestId('panel').style.left).toBe('8px');
  });

  // The mirror case: an anchor that already reaches past the right window
  // edge (a window being resized narrower) must not drag the panel out.
  it('keeps itself inside the right window edge', () => {
    stubLayout(rect({ left: 910, right: 1010, top: 700, bottom: 736, width: 100, height: 36 }));
    setViewport(1000, 800);
    render(<Harness />);
    // min(1010 - 288, 1000 - 288 - 8) = 704
    expect(screen.getByTestId('panel').style.left).toBe('704px');
  });

  it('closes on an outside click, but never on a click on the anchor or inside the panel', () => {
    stubLayout(WIDE_ANCHOR);
    setViewport(1280, 800);
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    // The anchor toggles itself — closing here would re-open it right after.
    fireEvent.mouseDown(screen.getByTestId('anchor'));
    expect(onClose).not.toHaveBeenCalled();
    // Picking a row inside the panel is the caller's business.
    fireEvent.mouseDown(screen.getByTestId('content'));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('re-measures when the window resizes and when a container scrolls', () => {
    stubLayout(WIDE_ANCHOR);
    setViewport(1280, 800);
    render(<Harness />);
    const panel = screen.getByTestId('panel');
    expect(panel.style.left).toBe('612px');

    // The window gets narrow enough that the right clamp takes over.
    setViewport(700, 800);
    fireEvent(window, new Event('resize'));
    // min(900 - 288, 700 - 288 - 8) = 404
    expect(panel.style.left).toBe('404px');

    // Scrolling a CONTAINER (the chat pane, not the window) moves the anchor
    // too — scroll events do not bubble, so the listener must capture.
    anchorRect = rect({ left: 800, right: 900, top: 500, bottom: 536, width: 100, height: 36 });
    fireEvent.scroll(screen.getByTestId('parent'));
    expect(panel.style.bottom).toBe('308px');
  });

  // The composer's other three drop-ups (attachment menu, branch picker,
  // @-autocomplete) are all left-aligned — same mechanism, other edge.
  it('aligns to the anchor’s left edge on request, clamped the same way', () => {
    stubLayout(WIDE_ANCHOR);
    setViewport(1280, 800);
    render(<Harness align="start" />);
    expect(screen.getByTestId('panel').style.left).toBe('800px');
  });

  it('closes on Escape', () => {
    stubLayout(WIDE_ANCHOR);
    setViewport(1280, 800);
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
