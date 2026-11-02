/**
 * HtmlPane.test.tsx
 *
 * The HTML source pane in the middle column (ADR-0013,
 * design/mockup-html-app.html variant B): sandboxed iframe on the source's
 * own origin, header with outline chip and warning badge, and the bridge
 * traffic in both directions.
 */

import { createRef } from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HtmlPane, type HtmlPaneHandle } from '../components/HtmlPane';
import { api } from '../api';
import type { HtmlHighlight, HtmlSource } from '../types';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: { ...actual.api, getHtmlEmbed: vi.fn() } };
});

const ORIGIN = 'http://src-h1.localhost:3001';
const TOKEN = 'tok-1';

const source: HtmlSource = {
  id: 'h1',
  title: 'Underactuated Lernpfad',
  uploaded_at: '2026-09-29T10:00:00Z',
  sections: [
    { level: 1, heading: '1 Einführung' },
    { level: 2, heading: '1.2 Pendel' },
    { level: 1, heading: '2 LQR' },
  ],
  unfrozen: [],
};

const unfrozen = [
  { url: 'https://cdnjs.cloudflare.com/mathjax.js', kind: 'script', reason: 'no-internet' },
  { url: 'https://fonts.googleapis.com/plex', kind: 'font', reason: 'http-404' },
];

const highlight: HtmlHighlight = {
  id: 'k1',
  htmlSourceId: 'h1',
  chatId: null,
  color: 'yellow',
  anchor: { exact: 'Pendel mit Motor', prefix: 'Das ', suffix: ' ist' },
  section: '1.2 Pendel',
  createdAt: '2026-09-29T10:00:00Z',
};

function baseProps(over: Partial<React.ComponentProps<typeof HtmlPane>> = {}): React.ComponentProps<typeof HtmlPane> {
  return {
    source,
    highlights: [],
    onSelection: vi.fn(),
    onHighlightClick: vi.fn(),
    onRetryFreeze: vi.fn(),
    ...over,
  };
}

async function renderPane(props = baseProps()) {
  const ref = createRef<HtmlPaneHandle>();
  const utils = render(<HtmlPane ref={ref} {...props} />);
  const frame = (await screen.findByTestId('html-source-frame')) as HTMLIFrameElement;
  // Let the effects that attach the message listener and the frame's load handling settle.
  await act(async () => {});
  const post = vi.fn();
  // jsdom gives the iframe a window; spy on what the app sends into it.
  Object.defineProperty(frame.contentWindow, 'postMessage', { value: post, configurable: true });
  frame.getBoundingClientRect = () => ({ left: 300, top: 60, right: 900, bottom: 700, width: 600, height: 640, x: 300, y: 60, toJSON() {} });
  return { ...utils, ref, frame, post };
}

function fromPage(frame: HTMLIFrameElement, data: object, over: { origin?: string } = {}) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: over.origin ?? ORIGIN,
        source: frame.contentWindow,
        data: { source: 'syflo-bridge', token: TOKEN, ...data },
      }),
    );
  });
}

beforeEach(() => {
  vi.mocked(api.getHtmlEmbed).mockResolvedValue({ url: `${ORIGIN}/`, origin: ORIGIN, token: TOKEN });
});

describe('HtmlPane', () => {
  it('fetches the embed descriptor on open and loads the page on its own origin', async () => {
    const { frame } = await renderPane();
    expect(api.getHtmlEmbed).toHaveBeenCalledWith('h1');
    expect(frame.getAttribute('src')).toBe(`${ORIGIN}/`);
  });

  it('sandboxes the frame: scripts and same-origin yes, top navigation never', async () => {
    const { frame } = await renderPane();
    const tokens = (frame.getAttribute('sandbox') ?? '').split(/\s+/);
    expect(tokens).toEqual(expect.arrayContaining(['allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-popups']));
    expect(tokens).not.toContain('allow-top-navigation');
  });

  it('paints its own white paper: a page assumes a white canvas, in every theme', async () => {
    const { frame } = await renderPane();
    // Literal white, not a theme token: Matrix remaps `white` to a dark surface and a
    // page without a background of its own would show black text on it.
    expect(frame.style.backgroundColor).toBe('rgb(255, 255, 255)');
  });

  it('shows the title and a subtitle with the section count', async () => {
    await renderPane();
    expect(screen.getByText('Underactuated Lernpfad')).toBeInTheDocument();
    expect(screen.getByText('HTML · 3 sections · fully frozen')).toBeInTheDocument();
  });

  it('says hello when the frame loads, so a ready that came too early is announced again', async () => {
    const { frame, post } = await renderPane();
    fireEvent.load(frame);
    expect(post).toHaveBeenCalledWith({ token: TOKEN, type: 'hello' }, ORIGIN);
  });

  it('treats section index -1 as "above the first heading"', async () => {
    const { frame } = await renderPane();
    fromPage(frame, { type: 'section', heading: '1.2 Pendel', index: 1 });
    fromPage(frame, { type: 'section', heading: '', index: -1 });
    expect(screen.getByTestId('html-outline-chip')).toHaveTextContent('Outline');
  });

  it('sends the stored highlights only after the bridge says ready, with the token', async () => {
    const { frame, post } = await renderPane(baseProps({ highlights: [highlight] }));
    expect(post).not.toHaveBeenCalled();
    fromPage(frame, { type: 'ready' });
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        token: TOKEN,
        type: 'set-highlights',
        highlights: [{ id: 'k1', color: 'yellow', anchor: highlight.anchor }],
      }),
      ORIGIN,
    );
  });

  it('repaints when the highlights change after ready', async () => {
    const props = baseProps({ highlights: [] });
    const { frame, post, rerender } = await renderPane(props);
    fromPage(frame, { type: 'ready' });
    post.mockClear();
    rerender(<HtmlPane {...props} highlights={[highlight]} />);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'set-highlights' }), ORIGIN);
  });

  it('ignores messages with a wrong token, a wrong origin or another window', async () => {
    const onSelection = vi.fn();
    const { frame } = await renderPane(baseProps({ onSelection }));
    const sel = { type: 'selection', text: 'x', anchor: { exact: 'x', prefix: '', suffix: '' }, rect: { left: 0, top: 0, width: 1, height: 1 } };
    fromPage(frame, { ...sel, token: 'forged' });
    fromPage(frame, sel, { origin: 'http://evil.test' });
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { origin: ORIGIN, source: window, data: { source: 'syflo-bridge', token: TOKEN, ...sel } }));
    });
    expect(onSelection).not.toHaveBeenCalled();
  });

  it('reports a selection in PAGE coordinates (iframe offset added) with its section', async () => {
    const onSelection = vi.fn();
    const { frame } = await renderPane(baseProps({ onSelection }));
    fromPage(frame, { type: 'section', heading: '1.2 Pendel', index: 1 });
    fromPage(frame, {
      type: 'selection',
      text: 'Pendel mit Motor',
      anchor: { exact: 'Pendel mit Motor', prefix: 'Das ', suffix: ' ist' },
      rect: { left: 100, top: 200, width: 80, height: 16 },
    });
    expect(onSelection).toHaveBeenCalledTimes(1);
    const sel = onSelection.mock.calls[0][0];
    expect(sel.text).toBe('Pendel mit Motor');
    expect(sel.section).toBe('1.2 Pendel');
    expect(sel.anchor.exact).toBe('Pendel mit Motor');
    // 300 + 100 + 80/2 = 440 (middle of the selection), 60 + 200 + 16 = 276 (below it)
    expect(sel.x).toBe(440);
    expect(sel.y).toBe(276);
  });

  it('opens the highlight actions at the click, translated to page coordinates', async () => {
    const onHighlightClick = vi.fn();
    const { frame } = await renderPane(baseProps({ highlights: [highlight], onHighlightClick }));
    fromPage(frame, { type: 'highlight-click', id: 'k1', rect: { left: 10, top: 20, width: 40, height: 14 } });
    expect(onHighlightClick).toHaveBeenCalledWith(highlight, 330, 94);
  });

  it('opens a link the page reports in a new window (Electron hands it to the OS browser)', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { frame } = await renderPane();
    fromPage(frame, { type: 'open-link', url: 'https://www.youtube.com/watch?v=x' });
    expect(open).toHaveBeenCalledWith('https://www.youtube.com/watch?v=x', '_blank', 'noopener,noreferrer');
    // The frame itself never navigated.
    expect(frame.getAttribute('src')).toBe(`${ORIGIN}/`);
    open.mockRestore();
  });

  it('lets the app take over link opening', async () => {
    const onOpenLink = vi.fn();
    const { frame } = await renderPane(baseProps({ onOpenLink }));
    fromPage(frame, { type: 'open-link', url: 'https://example.org/' });
    expect(onOpenLink).toHaveBeenCalledWith('https://example.org/');
  });

  it('ignores a click on a highlight the app does not know', async () => {
    const onHighlightClick = vi.fn();
    const { frame } = await renderPane(baseProps({ onHighlightClick }));
    fromPage(frame, { type: 'highlight-click', id: 'ghost', rect: { left: 0, top: 0, width: 1, height: 1 } });
    expect(onHighlightClick).not.toHaveBeenCalled();
  });

  it('the outline chip names the current section and jumps on a click', async () => {
    const { frame, post } = await renderPane();
    fromPage(frame, { type: 'ready' });
    fromPage(frame, { type: 'section', heading: '1.2 Pendel', index: 1 });
    const chip = screen.getByTestId('html-outline-chip');
    expect(chip).toHaveTextContent('1.2 Pendel');
    fireEvent.click(chip);
    const menu = screen.getByRole('menu');
    expect(menu).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: '2 LQR' }));
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'scroll-to-section', index: 2, token: TOKEN }), ORIGIN);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('prefers the outline the bridge reports over the uploaded one', async () => {
    const { frame } = await renderPane();
    fromPage(frame, { type: 'outline', sections: [{ level: 1, heading: 'Nur dies' }] });
    fireEvent.click(screen.getByTestId('html-outline-chip'));
    expect(screen.getByRole('menuitem', { name: 'Nur dies' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: '2 LQR' })).not.toBeInTheDocument();
  });

  it('closes the outline on Escape', async () => {
    await renderPane();
    fireEvent.click(screen.getByTestId('html-outline-chip'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes the outline when focus moves into the page (clicks in the iframe never bubble)', async () => {
    await renderPane();
    fireEvent.click(screen.getByTestId('html-outline-chip'));
    fireEvent.blur(window);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('shows no warning badge on a fully frozen source', async () => {
    await renderPane();
    expect(screen.queryByTestId('html-unfrozen-badge')).not.toBeInTheDocument();
  });

  it('shows a badge with the count; its popover lists every resource with its exact reason and retries', async () => {
    const onRetryFreeze = vi.fn();
    await renderPane(baseProps({ source: { ...source, unfrozen }, onRetryFreeze }));
    const badge = screen.getByTestId('html-unfrozen-badge');
    expect(badge).toHaveTextContent('2 open');
    fireEvent.click(badge);
    expect(screen.getByText('mathjax.js (cdnjs.cloudflare.com): no internet')).toBeInTheDocument();
    expect(screen.getByText('plex (fonts.googleapis.com): HTTP 404')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetryFreeze).toHaveBeenCalledTimes(1);
  });

  it('marks the retry button busy while a retry runs', async () => {
    await renderPane(baseProps({ source: { ...source, unfrozen }, retryingFreeze: true }));
    fireEvent.click(screen.getByTestId('html-unfrozen-badge'));
    expect(screen.getByRole('button', { name: 'Try again' })).toHaveAttribute('aria-busy', 'true');
  });

  it('scrolls to a highlight and clears the selection on the handle', async () => {
    const { ref, frame, post } = await renderPane(baseProps({ highlights: [highlight] }));
    fromPage(frame, { type: 'ready' });
    post.mockClear();
    act(() => ref.current!.scrollToHighlight('k1'));
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'scroll-to-anchor', anchor: highlight.anchor }), ORIGIN);
    act(() => ref.current!.clearSelection());
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'clear-selection' }), ORIGIN);
  });

  it('holds a scroll requested before ready until the bridge is up', async () => {
    const { ref, frame, post } = await renderPane(baseProps({ highlights: [highlight] }));
    act(() => ref.current!.scrollToHighlight('k1'));
    expect(post).not.toHaveBeenCalled();
    fromPage(frame, { type: 'ready' });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'scroll-to-anchor' }), ORIGIN);
  });

  it('says so when the embed descriptor cannot be fetched', async () => {
    vi.mocked(api.getHtmlEmbed).mockRejectedValueOnce(new Error('down'));
    render(<HtmlPane {...baseProps()} />);
    await waitFor(() => expect(screen.getByText('The page could not be opened')).toBeInTheDocument());
  });
});
