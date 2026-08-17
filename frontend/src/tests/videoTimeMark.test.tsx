/**
 * tests/videoTimeMark.test.tsx
 *
 * With the video embedded in the middle column, the jump target of a time mark
 * lies inside the window (design/mockup-youtube-embed-layout.html § 03): a
 * plain click seeks the player instead of leaving for YouTube. The element
 * stays a real <a href> pointing at youtube.com, so middle-click and
 * "open in new tab" keep working — and a tree without a player (no seek
 * handler) behaves exactly as it did before 2026-08-15.
 */

import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MessageBubble } from '../components/ChatArea/MessageBubble';
import type { Message } from '../types';

const message: Message = {
  id: 'm1',
  chat_id: 'c1',
  role: 'assistant',
  content: '## Where the parameters come from [8:58 - 14:14]\n\nEin lossy zip.',
  created_at: new Date().toISOString(),
};

const renderBubble = (onTimeMarkClick?: (seconds: number) => void) =>
  render(
    <MessageBubble
      message={message}
      onWordRightClick={vi.fn()}
      videoYoutubeId="zjkBMFhNj_g"
      onTimeMarkClick={onTimeMarkClick}
    />,
  );

describe('time mark of a video overview', () => {
  it('springt im Player und verlässt Syflo nicht', () => {
    const onTimeMarkClick = vi.fn();
    renderBubble(onTimeMarkClick);

    const link = screen.getByTestId('video-time-link') as HTMLAnchorElement;
    // Der Link bleibt ein echter Link auf die Sekunde — Mittelklick und
    // „in neuem Tab öffnen" bleiben geschenkt.
    expect(link.href).toBe('https://www.youtube.com/watch?v=zjkBMFhNj_g&t=538s');

    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);

    expect(onTimeMarkClick).toHaveBeenCalledWith(538);
    // Verhindert: der Browser würde sonst zusätzlich YouTube öffnen.
    expect(click.defaultPrevented).toBe(true);
  });

  it('bleibt ein normaler Link, wenn kein Player im Fenster steht', () => {
    renderBubble(undefined);

    const link = screen.getByTestId('video-time-link');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(false);
  });

  it('lässt den Mittelklick durch, damit YouTube in einem neuen Tab aufgeht', () => {
    const onTimeMarkClick = vi.fn();
    renderBubble(onTimeMarkClick);

    const link = screen.getByTestId('video-time-link');
    const middle = new MouseEvent('click', { bubbles: true, cancelable: true, button: 1 });
    link.dispatchEvent(middle);

    expect(onTimeMarkClick).not.toHaveBeenCalled();
    expect(middle.defaultPrevented).toBe(false);
  });
});
