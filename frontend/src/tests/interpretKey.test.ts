import { describe, it, expect } from 'vitest';
import { interpretKey, type KeyContext } from '../keyboard/focusMap';

/**
 * What a keystroke means, given only where the focus is and whether anything
 * is open (ADR-0011). This is the half that makes a mode unnecessary: the same
 * key reads differently in a text field and on an item, and the caller never
 * has to remember which — it just says where the focus is.
 */

const press = (key: string, ctx: Partial<KeyContext> = {}, mods: Partial<KeyboardEvent> = {}) =>
  interpretKey(
    { key, ctrlKey: false, metaKey: false, altKey: false, ...mods } as KeyboardEvent,
    { inComposer: true, escapeTaken: false, modalOpen: false, ...ctx },
  );

describe('interpretKey', () => {
  it('lets an open overlay keep Escape — the ring is the last step of the chain', () => {
    expect(press('Escape', { escapeTaken: true })).toEqual({ kind: 'ignore' });
  });

  it('keeps navigating while a drawer owns Escape — a drawer is a region, not a modal', () => {
    // The highlights drawer took Escape AND froze every arrow key with it, so
    // the ring could not be moved at all while it was open (user report
    // 2026-08-11).
    expect(press('ArrowLeft', { inComposer: false, escapeTaken: true }))
      .toEqual({ kind: 'nav', key: 'ArrowLeft' });
  });

  it('freezes navigation while a real modal is up', () => {
    expect(press('ArrowLeft', { inComposer: false, modalOpen: true })).toEqual({ kind: 'ignore' });
  });

  it('leaves the composer on Escape once nothing is left to close', () => {
    expect(press('Escape')).toEqual({ kind: 'enterStructure' });
  });

  it('puts the ring away when Escape is pressed again', () => {
    // Escape got the user in; the same key gets them out (user request
    // 2026-08-11). Anything still open closes first, as always.
    expect(press('Escape', { inComposer: false })).toEqual({ kind: 'leaveStructure' });
  });

  it('lets an open thing close before the ring is put away', () => {
    expect(press('Escape', { inComposer: false, escapeTaken: true })).toEqual({ kind: 'ignore' });
  });

  it('leaves the arrows to the caret while the composer has focus', () => {
    expect(press('ArrowLeft')).toEqual({ kind: 'ignore' });
  });

  it('reads the arrows as navigation once the focus sits on an item', () => {
    expect(press('ArrowLeft', { inComposer: false })).toEqual({ kind: 'nav', key: 'ArrowLeft' });
  });

  it('activates the focused item on Enter', () => {
    expect(press('Enter', { inComposer: false })).toEqual({ kind: 'activate' });
  });

  it('leaves Enter to the composer, which sends', () => {
    expect(press('Enter')).toEqual({ kind: 'ignore' });
  });

  it('returns to the composer on any printable key, carrying the character', () => {
    expect(press('h', { inComposer: false })).toEqual({ kind: 'returnToComposer', text: 'h' });
  });

  it('keeps shortcuts out of it — a modified key is never typing', () => {
    expect(press('k', { inComposer: false }, { metaKey: true })).toEqual({ kind: 'ignore' });
  });
});
