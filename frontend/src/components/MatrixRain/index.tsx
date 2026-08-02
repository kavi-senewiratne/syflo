/**
 * MatrixRain — the falling 1/0 rain behind the Matrix theme's sidebar,
 * pdf-pane and chat-pane. Mounted once in App.tsx (design/mockup-matrix-
 * home-rain.html, Variante C); the three panes stay transparent for it in
 * this theme (index.css design:matrix.code-rain). Renders nothing outside
 * the matrix theme and respects prefers-reduced-motion.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { ThemeId } from '../../theme';

function subscribeToTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  return () => observer.disconnect();
}

function readTheme(): ThemeId {
  return (document.documentElement.dataset.theme as ThemeId | undefined) ?? 'professional';
}

const FONT_SIZE = 13;
const FRAME_MS = 120;
const HEAD_COLOR = 'rgba(43, 231, 107, 0.16)';
const TRAIL_FADE = 'rgba(6, 12, 7, 0.12)';
const CLEAR_COLOR = '#060c07';

export function MatrixRain() {
  const theme = useSyncExternalStore(subscribeToTheme, readTheme);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (theme !== 'matrix') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    let drops: number[] = [];
    let intervalId: number | undefined;

    function resize() {
      const parent = canvas!.parentElement;
      canvas!.width = parent ? parent.clientWidth : window.innerWidth;
      canvas!.height = parent ? parent.clientHeight : window.innerHeight;
      const cols = Math.floor(canvas!.width / FONT_SIZE);
      const rows = Math.max(1, Math.floor(canvas!.height / FONT_SIZE));
      drops = Array.from({ length: cols }, (_, i) => (i * 11) % rows);
      ctx!.fillStyle = CLEAR_COLOR;
      ctx!.fillRect(0, 0, canvas!.width, canvas!.height);
    }

    function draw() {
      ctx!.fillStyle = TRAIL_FADE;
      ctx!.fillRect(0, 0, canvas!.width, canvas!.height);
      ctx!.font = `${FONT_SIZE}px IBM Plex Mono, monospace`;
      ctx!.fillStyle = HEAD_COLOR;
      for (let i = 0; i < drops.length; i++) {
        const char = Math.random() > 0.5 ? '1' : '0';
        ctx!.fillText(char, i * FONT_SIZE, drops[i] * FONT_SIZE);
        if (drops[i] * FONT_SIZE > canvas!.height && Math.random() > 0.975) drops[i] = 0;
        drops[i]++;
      }
    }

    function start() {
      if (intervalId !== undefined) return;
      resize();
      intervalId = window.setInterval(draw, FRAME_MS);
    }
    function stop() {
      if (intervalId === undefined) return;
      window.clearInterval(intervalId);
      intervalId = undefined;
    }
    function onVisibilityChange() {
      if (document.hidden) stop();
      else start();
    }

    const resizeObserver = new ResizeObserver(resize);
    if (canvas.parentElement) resizeObserver.observe(canvas.parentElement);
    document.addEventListener('visibilitychange', onVisibilityChange);
    if (!document.hidden) start();

    return () => {
      stop();
      resizeObserver.disconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [theme]);

  if (theme !== 'matrix') return null;

  return <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 -z-10 pointer-events-none" />;
}
