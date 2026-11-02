/**
 * htmlBridge.test.ts
 *
 * The app side of the bridge (ADR-0013 decision 2): every message that comes
 * out of the source's iframe is checked against origin, window and token
 * before anything reads it.
 */

import { describe, it, expect } from 'vitest';
import { readBridgeMessage, toPageRect } from '../html/bridge';

const frameWindow = {} as Window;
const expected = { origin: 'http://src-h1.localhost:3001', source: frameWindow, token: 'tok' };

function msg(data: unknown, over: Partial<{ origin: string; source: unknown }> = {}) {
  return {
    origin: over.origin ?? expected.origin,
    source: 'source' in over ? over.source : frameWindow,
    data,
  } as unknown as MessageEvent;
}

const ready = { source: 'syflo-bridge', token: 'tok', type: 'ready' };

describe('readBridgeMessage', () => {
  it('accepts a well-formed message from the expected frame', () => {
    expect(readBridgeMessage(msg(ready), expected)).toEqual({ type: 'ready' });
  });

  it('rejects a foreign origin', () => {
    expect(readBridgeMessage(msg(ready, { origin: 'http://evil.test' }), expected)).toBeNull();
  });

  it('rejects a message that did not come from the iframe window', () => {
    expect(readBridgeMessage(msg(ready, { source: {} }), expected)).toBeNull();
  });

  it('rejects a wrong or missing token', () => {
    expect(readBridgeMessage(msg({ ...ready, token: 'nope' }), expected)).toBeNull();
    expect(readBridgeMessage(msg({ source: 'syflo-bridge', type: 'ready' }), expected)).toBeNull();
  });

  it('rejects data that is not a bridge message', () => {
    expect(readBridgeMessage(msg('hello'), expected)).toBeNull();
    expect(readBridgeMessage(msg({ ...ready, source: 'other' }), expected)).toBeNull();
    expect(readBridgeMessage(msg({ ...ready, type: 'launch-missiles' }), expected)).toBeNull();
  });

  it('reads the outline, the current section and selection events', () => {
    const anchor = { exact: 'a', prefix: 'p', suffix: 's' };
    const rect = { left: 10, top: 20, width: 30, height: 12 };
    expect(readBridgeMessage(msg({ ...ready, type: 'outline', sections: [{ level: 1, heading: 'A' }] }), expected))
      .toEqual({ type: 'outline', sections: [{ level: 1, heading: 'A' }] });
    expect(readBridgeMessage(msg({ ...ready, type: 'section', heading: 'A', index: 0 }), expected))
      .toEqual({ type: 'section', heading: 'A', index: 0 });
    expect(readBridgeMessage(msg({ ...ready, type: 'selection', text: 'a', anchor, rect }), expected))
      .toEqual({ type: 'selection', text: 'a', anchor, rect });
    expect(readBridgeMessage(msg({ ...ready, type: 'selection-cleared' }), expected)).toEqual({ type: 'selection-cleared' });
    expect(readBridgeMessage(msg({ ...ready, type: 'highlight-click', id: 'k1', rect }), expected))
      .toEqual({ type: 'highlight-click', id: 'k1', rect });
  });

  it('reads the painting report and a failed scroll', () => {
    expect(readBridgeMessage(msg({ ...ready, type: 'highlights-painted', resolved: ['a'], missing: ['b', 3] }), expected))
      .toEqual({ type: 'highlights-painted', resolved: ['a'], missing: ['b'] });
    const anchor = { exact: 'a', prefix: '', suffix: '' };
    expect(readBridgeMessage(msg({ ...ready, type: 'anchor-not-found', anchor }), expected))
      .toEqual({ type: 'anchor-not-found', anchor });
  });

  it('keeps section index -1 (before the first heading)', () => {
    expect(readBridgeMessage(msg({ ...ready, type: 'section', heading: '', index: -1 }), expected))
      .toEqual({ type: 'section', heading: '', index: -1 });
  });

  it('passes the section a selection sits in through', () => {
    const anchor = { exact: 'a', prefix: '', suffix: '' };
    const rect = { top: 1, left: 2, width: 3, height: 4 };
    const parsed = readBridgeMessage(msg({ ...ready, type: 'selection', text: 'a', anchor, rect, section: 'Layers' }), expected);
    expect(parsed).toMatchObject({ type: 'selection', section: 'Layers' });
  });

  it('drops a selection without a usable anchor', () => {
    expect(readBridgeMessage(msg({ ...ready, type: 'selection', text: 'a', anchor: { exact: '' }, rect: {} }), expected)).toBeNull();
  });

  it('accepts open-link for web and mail addresses only', () => {
    expect(readBridgeMessage(msg({ ...ready, type: 'open-link', url: 'https://www.youtube.com/watch?v=x' }), expected))
      .toEqual({ type: 'open-link', url: 'https://www.youtube.com/watch?v=x' });
    expect(readBridgeMessage(msg({ ...ready, type: 'open-link', url: 'mailto:russ@mit.edu' }), expected))
      .toEqual({ type: 'open-link', url: 'mailto:russ@mit.edu' });
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 42, undefined]) {
      expect(readBridgeMessage(msg({ ...ready, type: 'open-link', url }), expected)).toBeNull();
    }
  });
});

describe('toPageRect', () => {
  it('moves an iframe-relative rect by the iframe offset', () => {
    expect(toPageRect({ left: 10, top: 20, width: 30, height: 12 }, { left: 300, top: 60 }))
      .toEqual({ left: 310, top: 80, width: 30, height: 12, right: 340, bottom: 92 });
  });

  it('accepts x/y style rects too', () => {
    expect(toPageRect({ x: 5, y: 6, width: 2, height: 2 }, { left: 1, top: 1 }))
      .toMatchObject({ left: 6, top: 7 });
  });
});
