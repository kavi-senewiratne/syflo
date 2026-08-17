import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useKeyboardNavigation } from '../hooks/useKeyboardNavigation';

/**
 * The wire between the rules and the screen (ADR-0011). A component says where
 * its items are with one `data-focus-item` attribute; the hook decides which of
 * them wears the focus ring. Nothing else about a component has to change.
 */

function Harness(props: {
  onActivate?: (region: string, item: string) => void;
  onToggleNode?: (item: string, expanded: boolean) => void;
  onReturnToComposer?: (text: string) => void;
  escapeTaken?: boolean;
  // Renders a mind map whose nodes carry the SAME ids as the sidebar rows,
  // which is what the real app does.
  twin?: boolean;
  // The highlights drawer's overlay makes the chat column stop being a region.
  chatCovered?: boolean;
  // No row marked as the open chat — then the ring falls back to the chat.
  noActive?: boolean;
  // A source region whose single highlight is drawn in three pieces.
  split?: boolean;
  // An open menu — the selection popup and every action menu carry role="menu".
  menu?: boolean;
}) {
  useKeyboardNavigation({
    escapeTaken: props.escapeTaken ?? false,
    modalOpen: false,
    onActivate: pos => props.onActivate?.(pos.region, pos.item),
    onToggleNode: (item, expanded) => props.onToggleNode?.(item, expanded),
    onReturnToComposer: text => props.onReturnToComposer?.(text),
  });

  return (
    <div>
      {props.split && (
        <div data-focus-region="source">
          <span data-focus-item="hl-1">P</span>
          <span data-focus-item="hl-1">(w</span>
          <span data-focus-item="hl-1">t)</span>
        </div>
      )}
      <div data-focus-region="sidebar">
        <div data-focus-item="root">Attention Is All You Need</div>
        <div data-focus-item="attention" data-focus-active={props.noActive ? undefined : 'true'}>Self-attention</div>
      </div>
      {/* The real App renders the map AFTER the sidebar, so a document-wide
          lookup finds the sidebar's namesake first. */}
      {props.twin && (
        <div data-focus-region="map">
          <div data-focus-item="root">Attention Is All You Need</div>
        </div>
      )}
      <div data-focus-region={props.chatCovered ? undefined : 'chat'}>
        <div data-focus-item="m1">Why divide by the square root of d_k?</div>
        <textarea data-focus-item="composer" aria-label="composer" />
      </div>
      {props.menu && (
        <div role="menu">
          <button>Unclear</button>
          <button>Definition</button>
        </div>
      )}
    </div>
  );
}

const ringed = () => document.querySelector('[data-focus-ring]')?.getAttribute('data-focus-item');

describe('useKeyboardNavigation', () => {
  it('shows no ring at all until the user asks for it', () => {
    render(<Harness />);

    expect(ringed()).toBeUndefined();
  });

  it('falls back to the chat when nothing is marked as the open one', () => {
    render(<Harness noActive />);
    screen.getByLabelText('composer').focus();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(ringed()).toBe('m1');
  });

  it('carries the ring into the sidebar with the left arrow', () => {
    render(<Harness noActive />);
    screen.getByLabelText('composer').focus();
    fireEvent.keyDown(window, { key: 'Escape' });

    fireEvent.keyDown(window, { key: 'ArrowLeft' });

    expect(ringed()).toBe('root');
  });

  it('activates the ringed item on Enter', () => {
    const onActivate = vi.fn();
    render(<Harness noActive onActivate={onActivate} />);
    screen.getByLabelText('composer').focus();
    fireEvent.keyDown(window, { key: 'Escape' });

    fireEvent.keyDown(window, { key: 'Enter' });

    expect(onActivate).toHaveBeenCalledWith('chat', 'm1');
  });

  it('carries the ring into a menu the keyboard opened', () => {
    const { rerender } = render(<Harness noActive />);
    screen.getByLabelText('composer').focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(ringed()).toBe('m1');

    // Enter on the bubble opens the selection popup — a key was the last input.
    fireEvent.keyDown(window, { key: 'Enter' });
    rerender(<Harness noActive menu />);

    expect(document.querySelector('[role="menu"] [data-focus-ring]')).not.toBeNull();
  });

  it('leaves the ring alone when a mouse gesture opens the menu', () => {
    // The selection popup carries role="menu" as well, and dragging across the
    // PDF opens it: the ring jumped out of the structure into that popup all by
    // itself (user report 2026-08-12). A pointerdown precedes every such menu.
    const { rerender } = render(<Harness noActive />);
    screen.getByLabelText('composer').focus();
    fireEvent.keyDown(window, { key: 'Escape' });

    fireEvent.pointerDown(document.body);
    rerender(<Harness noActive menu />);

    expect(ringed()).toBe('m1');
    expect(document.querySelector('[role="menu"] [data-focus-ring]')).toBeNull();
  });

  it('drops the ring and hands the character to the composer on any printable key', () => {
    const onReturnToComposer = vi.fn();
    render(<Harness noActive onReturnToComposer={onReturnToComposer} />);
    screen.getByLabelText('composer').focus();
    fireEvent.keyDown(window, { key: 'Escape' });

    fireEvent.keyDown(window, { key: 'h' });

    expect(onReturnToComposer).toHaveBeenCalledWith('h');
    expect(ringed()).toBeUndefined();
  });

  it('rings the item of the region it is in, not a namesake in another region', () => {
    // The mind map and the sidebar both key their items by chat id, so a
    // document-wide lookup would always paint the sidebar row and the ring
    // would appear stuck (found in the running app, 2026-08-10).
    render(<Harness noActive twin />);
    screen.getByLabelText('composer').focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'ArrowUp' });

    const ring = document.querySelector('[data-focus-ring]');
    expect(ring?.closest('[data-focus-region]')?.getAttribute('data-focus-region')).toBe('map');
  });

  it('hands the keys back to a text field the user clicked into', () => {
    // The whole design rests on the browser knowing which target has focus —
    // so it must be asked, not second-guessed from React state.
    render(<Harness noActive />);
    screen.getByLabelText('composer').focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(ringed()).toBe('m1');

    screen.getByLabelText('composer').focus();
    fireEvent.keyDown(window, { key: 'ArrowLeft' });

    expect(ringed()).toBeUndefined();
  });

  it('drops a ring whose region has disappeared under it', () => {
    // Opening the highlights drawer covers the chat column, and the ring must
    // not stay stranded on an element nobody can see (found in the running
    // app, 2026-08-10).
    const { rerender } = render(<Harness noActive />);
    screen.getByLabelText('composer').focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(ringed()).toBe('m1');

    rerender(<Harness noActive chatCovered />);

    expect(ringed()).toBeUndefined();
  });

  it('starts where the app already says the user is', () => {
    // The sidebar already marks the open chat with a blue pill. The first
    // Escape must agree with it, or the ring appears somewhere the user was
    // not looking (user report 2026-08-11).
    render(<Harness />);
    screen.getByLabelText('composer').focus();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(ringed()).toBe('attention');
  });

  it('returns to wherever the ring was last, once it has been somewhere', () => {
    render(<Harness />);
    screen.getByLabelText('composer').focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(ringed()).toBe('attention');
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(ringed()).toBe('root');

    fireEvent.keyDown(window, { key: 'h' });
    screen.getByLabelText('composer').focus();
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(ringed()).toBe('root');
  });

  it('takes Tab out of the app so there is only one focus indicator', () => {
    // Two systems — the browser's focus outline and the ring — read as two
    // places the keyboard is (user report 2026-08-11).
    render(<Harness />);
    screen.getByLabelText('composer').focus();
    fireEvent.keyDown(window, { key: 'Escape' });

    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves Tab alone inside a text field, where forms need it', () => {
    render(<Harness />);
    screen.getByLabelText('composer').focus();

    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('puts the ring away when Escape is pressed a second time', () => {
    render(<Harness />);
    screen.getByLabelText('composer').focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(ringed()).toBe('attention');

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(ringed()).toBeUndefined();
  });

  it('rings every piece an item is drawn in', () => {
    // A highlight wrapping over lines — or a formula split into baseline
    // bands — is one item painted several times (user report 2026-08-11).
    render(<Harness split />);
    screen.getByLabelText('composer').focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'ArrowRight' });

    expect(document.querySelectorAll('[data-focus-ring]').length).toBe(3);
  });

  it('keeps its hands off Escape while an overlay is open', () => {
    render(<Harness escapeTaken />);
    screen.getByLabelText('composer').focus();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(ringed()).toBeUndefined();
  });
});
