/**
 * Der gemeinsame Sprung-Halo (flashGlow.ts).
 *
 * Ein Signal für alle Flächen: PDF, Chat, Transcript und Kapitel legen
 * dieselbe Gruppe über die markierte Stelle, damit überall die GANZE Stelle
 * aufglüht statt nur ihres Unterstrichs (Nutzerwunsch 2026-08-16).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLASH_GLOW_HEX, FLASH_GLOW_MS, showFlashGlow } from '../flashGlow';

const box = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height }) as DOMRect;

const rects = (...list: DOMRect[]) => ({
  getClientRects: () => list as unknown as DOMRectList,
});

const layer = () => document.querySelector('[data-syflo-flash-glow]') as HTMLElement | null;

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('flash glow', () => {
  it('legt eine Halo-Gruppe in der Farbe der Markierung an', () => {
    const stop = showFlashGlow({ targets: () => [rects(box(10, 20, 50, 16))], color: 'green' });

    const group = layer()!.firstElementChild as HTMLElement;
    expect(group.className).toBe('syflo-hl-flash-group');
    expect(group.style.getPropertyValue('--flash-color')).toBe(FLASH_GLOW_HEX.green);
    stop();
  });

  it('setzt die Rechtecke relativ zum Clip-Rahmen', () => {
    const clip = document.createElement('div');
    clip.getBoundingClientRect = () => box(100, 50, 400, 300);
    document.body.appendChild(clip);

    const stop = showFlashGlow({
      targets: () => [rects(box(120, 80, 60, 18))],
      color: 'pink',
      clip,
    });

    // Der Rahmen sitzt auf dem Scroller, das Rechteck 20/30 px darin.
    expect(layer()!.style.left).toBe('100px');
    expect(layer()!.style.top).toBe('50px');
    const rect = layer()!.firstElementChild!.children[0] as HTMLElement;
    expect(rect.style.left).toBe('20px');
    expect(rect.style.top).toBe('30px');
    expect(rect.style.width).toBe('60px');
    stop();
  });

  it('lässt zusammengefallene Rechtecke aus', () => {
    // Ein leeres Zeilenstück oder ein Range-Ende ohne Breite ergäbe sonst
    // einen Punkt Halo an einer Stelle ohne Text.
    const stop = showFlashGlow({
      targets: () => [rects(box(0, 0, 40, 16), box(40, 0, 0, 16))],
      color: 'blue',
    });

    expect(layer()!.firstElementChild!.childElementCount).toBe(1);
    stop();
  });

  it('räumt sich nach dem letzten Puls selbst auf', () => {
    vi.useFakeTimers();
    showFlashGlow({ targets: () => [rects(box(0, 0, 40, 16))], color: 'yellow' });

    expect(layer()).not.toBeNull();
    vi.advanceTimersByTime(FLASH_GLOW_MS + 50);
    expect(layer()).toBeNull();
  });
});
