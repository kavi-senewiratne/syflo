/**
 * components/Popover.tsx
 *
 * The one portal layer for the app's drop-ups (design/mockup-model-picker-
 * truth.html §01, variant A). Everything it does is POSITION — the caller
 * keeps the optics and passes its own class recipe.
 *
 * Why a portal: the composer's menus used to be `absolute` children of the
 * composer, and `.syflo-chat-pane` carries `overflow-hidden`. Below the
 * panel's own width (288 px for the model menu) the column simply cut the
 * panel off — the user's screenshot showed "OSTENLOS" and half a meter bar.
 * A panel hung on `document.body` has no clipping ancestor at all, which is
 * exactly what a popover is for: it may cover the PDF column.
 *
 * Why `fixed` instead of `absolute`: with no positioned ancestor left, the
 * panel is placed against the viewport from the anchor's measured rect —
 * and the viewport is also what it has to stay inside of.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode, RefObject } from 'react';

// The panel floats this far above the anchor (the drop-ups' former `mb-2`).
const GAP = 8;
// How close to the window edge the panel may come before it is pushed in.
const MARGIN = 8;
// Layering is part of the position, so the helper owns it: above every
// in-pane layer (z-10 … z-30), below the dialogs at z-50. Painting order
// alone would not do it — a `fixed` app layer with a z-index outranks a
// portal child with z-index:auto, however late it sits in the body.
const Z_INDEX = 40;

interface Position {
  left: number;
  bottom: number;
}

export interface PopoverProps {
  open: boolean;
  // The element the panel is measured against — usually the wrapper of the
  // button that toggles it, not the button itself (a button hidden by a
  // container query measures 0x0 and would send the panel off-screen).
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  // Which edge the panel is aligned to: 'end' (default) puts its right edge
  // on the anchor's right — the model menu — 'start' its left edge on the
  // anchor's left, which is what the composer's other drop-ups do.
  align?: 'start' | 'end';
  // Optics stay with the caller; the helper adds no border, no shadow, no
  // padding of its own.
  className?: string;
  role?: string;
  testId?: string;
  children: ReactNode;
}

export function Popover({ open, anchorRef, onClose, align = 'end', className, role, testId, children }: PopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Position | null>(null);

  // Drop-up: the panel's aligned edge meets the anchor's, its bottom edge
  // sits GAP above the anchor's top. Both are viewport coordinates because
  // the panel is `fixed`.
  const measure = useCallback(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const a = anchor.getBoundingClientRect();
    const width = panel.getBoundingClientRect().width;
    // Clamp both ways, right edge first: a panel wider than the column
    // reaches past the LEFT window edge — the bug from the screenshot — and
    // the left clamp must win when the panel is wider than the window
    // itself, so it is applied last.
    const wanted = align === 'start' ? a.left : a.right - width;
    const left = Math.max(MARGIN, Math.min(wanted, window.innerWidth - width - MARGIN));
    setPos({ left, bottom: window.innerHeight - a.top + GAP });
  }, [anchorRef, align]);

  // Layout effect: measured and placed before the browser paints, so the
  // panel never shows up in a wrong spot for a frame.
  useLayoutEffect(() => {
    if (open) measure();
  }, [open, measure]);

  // A `fixed` panel does not travel with its anchor: the anchor moves when
  // the window is resized AND when any scroll container between it and the
  // page scrolls. Scroll events do not bubble, so the listener captures —
  // otherwise scrolling the chat column would leave the panel behind.
  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, measure]);

  // Dismissal lives here, not in the caller: the panel is no longer a child
  // of the anchor's subtree, so "outside" can only be decided by asking both
  // elements. A click on the anchor is NOT outside — the anchor toggles
  // itself, and closing here would fight that click.
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    // Escape is the keyboard's way out of the same trap: the panel has no
    // focus relationship with the anchor any more, so it cannot rely on
    // blur.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose, anchorRef]);

  if (!open) return null;
  return createPortal(
    <div
      ref={panelRef}
      role={role}
      data-testid={testId}
      className={className}
      style={{ position: 'fixed', left: pos?.left ?? 0, bottom: pos?.bottom ?? 0, zIndex: Z_INDEX }}
    >
      {children}
    </div>,
    document.body,
  );
}
