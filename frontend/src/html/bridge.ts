/**
 * html/bridge.ts
 *
 * The app side of the bridge (ADR-0013 decision 2). The backend injects a
 * script into the HTML source; it talks to Syflo by `postMessage`. Everything
 * arriving from the iframe is untrusted until three checks pass — origin, the
 * iframe's own window, and the per-source token — so the page's own scripts
 * cannot forge a selection or a highlight click.
 */

import type { HtmlAnchor, HtmlSection } from '../types';

/** A rectangle relative to the iframe's viewport, as the bridge reports it. */
export interface BridgeRect {
  left?: number;
  top?: number;
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export interface PageRect {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

export type BridgeMessage =
  | { type: 'ready' }
  | { type: 'outline'; sections: HtmlSection[] }
  // index = position in the `outline` list; -1 / '' = before the first heading.
  | { type: 'section'; heading: string; index: number }
  // section = the heading the selection sits under ('' above the first heading).
  | { type: 'selection'; text: string; anchor: HtmlAnchor; rect: BridgeRect; section?: string }
  | { type: 'selection-cleared' }
  | { type: 'highlight-click'; id: string; rect: BridgeRect }
  // Painting report after every set-highlights / late-DOM repaint.
  | { type: 'highlights-painted'; resolved: string[]; missing: string[] }
  | { type: 'anchor-not-found'; anchor: HtmlAnchor }
  // A link to another page was clicked; the bridge blocked the navigation
  // (the snapshot is one page) and asks Syflo to open the address outside.
  | { type: 'open-link'; url: string };

export interface BridgeExpectation {
  origin: string;
  source: Window | null;
  token: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const isAnchor = (a: unknown): a is HtmlAnchor =>
  isObject(a) &&
  typeof a.exact === 'string' && a.exact.trim().length > 0 &&
  typeof a.prefix === 'string' &&
  typeof a.suffix === 'string';

const asRect = (r: unknown): BridgeRect =>
  isObject(r)
    ? {
        left: Number(r.left ?? r.x ?? 0),
        top: Number(r.top ?? r.y ?? 0),
        width: Number(r.width ?? 0),
        height: Number(r.height ?? 0),
      }
    : { left: 0, top: 0, width: 0, height: 0 };

/** The validated message, or null when it is not for us / not trustworthy. */
export function readBridgeMessage(event: MessageEvent, expected: BridgeExpectation): BridgeMessage | null {
  if (event.origin !== expected.origin) return null;
  if (!expected.source || event.source !== expected.source) return null;
  const d: unknown = event.data;
  if (!isObject(d) || d.source !== 'syflo-bridge' || d.token !== expected.token) return null;
  switch (d.type) {
    case 'ready':
      return { type: 'ready' };
    case 'outline':
      if (!Array.isArray(d.sections)) return null;
      return {
        type: 'outline',
        sections: d.sections
          .filter((s): s is Record<string, unknown> => isObject(s) && typeof s.heading === 'string')
          .map((s) => ({ level: Number(s.level) || 1, heading: s.heading as string })),
      };
    case 'section':
      if (typeof d.heading !== 'string' || typeof d.index !== 'number') return null;
      return { type: 'section', heading: d.heading, index: d.index };
    case 'selection':
      if (typeof d.text !== 'string' || !isAnchor(d.anchor)) return null;
      return {
        type: 'selection', text: d.text, anchor: d.anchor, rect: asRect(d.rect),
        section: typeof d.section === 'string' ? d.section : undefined,
      };
    case 'selection-cleared':
      return { type: 'selection-cleared' };
    case 'highlight-click':
      if (typeof d.id !== 'string') return null;
      return { type: 'highlight-click', id: d.id, rect: asRect(d.rect) };
    case 'highlights-painted': {
      const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
      return { type: 'highlights-painted', resolved: ids(d.resolved), missing: ids(d.missing) };
    }
    case 'anchor-not-found':
      if (!isAnchor(d.anchor)) return null;
      return { type: 'anchor-not-found', anchor: d.anchor };
    case 'open-link':
      // Only web and mail addresses leave the app; anything else a page could
      // forge (file:, chrome:, the app's own origin) is dropped here.
      if (typeof d.url !== 'string' || !/^(https?:|mailto:)/i.test(d.url)) return null;
      return { type: 'open-link', url: d.url };
    default:
      return null;
  }
}

/** Iframe-viewport rect → page (window) coordinates. */
export function toPageRect(rect: BridgeRect, frame: { left: number; top: number }): PageRect {
  const left = (rect.left ?? rect.x ?? 0) + frame.left;
  const top = (rect.top ?? rect.y ?? 0) + frame.top;
  return { left, top, width: rect.width, height: rect.height, right: left + rect.width, bottom: top + rect.height };
}
