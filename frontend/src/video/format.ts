/**
 * video/format.ts
 *
 * Formatting helpers for the YouTube source (ADR-0005). `formatDuration`
 * used to live in the VideoBanner component; the banner was replaced by
 * VideoPane on 2026-08-15 (Variante C, design/mockup-video-header-merge.html)
 * but three call sites still needed the helper, so it now sits on its own
 * next to the other video-side modules (markdown/chapters.ts, timeLinks.ts).
 */

// 3587 s → "59:47"; from an hour on "1:05:47".
export function formatDuration(seconds: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
