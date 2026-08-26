/**
 * Logo.tsx
 *
 * Theme-aware Syflo logo for the sidebar header. Every theme shares the same
 * core idea — the "branch mark", one stream forking into two nodes, Syflo's
 * branching chat trees as a sign — but renders it in its own material:
 * sticker ink (Ink Blue), pixels (Mushroom Kingdom), engraving (Hyrule),
 * phosphor terminal (Matrix), flat (Basic, theme id "professional").
 *
 * Design source of truth: design/mockup-logo-themes.html (the sidebar-header
 * cells). Colors and fonts here are the fixed brand constants of each theme's
 * logo — intentionally hardcoded, not the semantic UI tokens.
 */
import { useId, useSyncExternalStore } from 'react';
import type { ThemeId } from '../theme';

// The theme lives as a `data-theme` attribute on <html> (see theme.ts), so a
// MutationObserver is the change signal — no prop drilling from SettingsModal.
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

// Matrix glitch mark — the same branch mark as the app/dock icon
// (design/mockup-logo-icons-round6.html, Matrix section): dark and light
// ghost copies offset sideways, the phosphor-green mark on top split into
// three horizontal bands with the middle band shifted (the "glitch"), plus
// a soft green glow. Replaces the old ">_" terminal prefix in the wordmark
// (user decision 2026-07-26) — the SYFLO text stays.
function MatrixMark({ size = 20 }: { size?: number }) {
  // <use>/<clipPath> need document-unique ids; the logo renders twice
  // (sidebar + empty state). React 19's useId emits non-alphanumeric
  // characters that are shaky inside url(#…), so strip them.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const markId = `mx-mark-${uid}`;
  const topId = `mx-top-${uid}`;
  const bandId = `mx-band-${uid}`;
  const bottomId = `mx-bottom-${uid}`;
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <defs>
        <g id={markId}>
          <path d="M8 24 H 22 C 28 24, 29 15, 36 13" strokeWidth="4.5" strokeLinecap="round" fill="none" />
          <path d="M22 24 C 28 24, 29 33, 36 35" strokeWidth="4.5" strokeLinecap="round" fill="none" />
          <circle cx="7" cy="24" r="3.6" />
          <circle cx="39" cy="12.5" r="5.5" />
          <circle cx="39" cy="35.5" r="5.5" />
        </g>
        <clipPath id={topId}><rect x="-6" y="-4" width="60" height="23" /></clipPath>
        <clipPath id={bandId}><rect x="-6" y="19" width="60" height="7.5" /></clipPath>
        <clipPath id={bottomId}><rect x="-6" y="26.5" width="60" height="26" /></clipPath>
      </defs>
      <use href={`#${markId}`} stroke="#0F7A3C" fill="#0F7A3C" transform="translate(-2.6, 0)" opacity="0.75" />
      <use href={`#${markId}`} stroke="#8CF5B0" fill="#8CF5B0" transform="translate(2.6, 0.6)" opacity="0.35" />
      <g style={{ filter: 'drop-shadow(0 0 4px rgba(43,231,107,0.5))' }}>
        <use href={`#${markId}`} stroke="#2BE76B" fill="#2BE76B" clipPath={`url(#${topId})`} />
        <use href={`#${markId}`} stroke="#2BE76B" fill="#2BE76B" clipPath={`url(#${bandId})`} transform="translate(4.2, 0)" />
        <use href={`#${markId}`} stroke="#2BE76B" fill="#2BE76B" clipPath={`url(#${bottomId})`} transform="translate(-1.4, 0)" />
      </g>
    </svg>
  );
}

const VARIANTS: Record<ThemeId, React.ReactNode> = {
  professional: (
    <>
      {/* Bare mark, no tile (user choice 2026-08-22, design/mockup-logo-
          simply-blue-round9.html §03/S5 + round11.html/R2). Basic was the only
          theme whose logo sat on a tile, which read as an app icon inside the
          sidebar; the other four all carry the mark alone.

          Two-tone without a second hue: the nodes are RINGS — white hole,
          blue wall — while trunk and origin node stay solid. The hole must be
          filled white, not `none`: the sidebar header is white today, but a
          transparent hole would show whatever sits behind it anywhere else.

          Geometry R2 (48-unit box widened to 50): the branch is unchanged from
          M1, the nodes moved OUT to (41.77|11.35) and (41.77|36.65). Measured
          reason: with the node at (38.5|12) the branch tip lands 2.69 units
          from the node centre, and its round cap (r 2.5) then covers 94 % of
          the 3.5-unit hole — the ring looked filled in. At distance 6.0 the cap
          ends exactly on the hole's edge. Moving the node (rather than
          shortening the branch) keeps the branch length of round 8. */}
      {/* `top: 0.7` centres the mark on the CAP BAND of the wordmark rather
          than on the flex line box (user choice 2026-08-25, design/mockup-
          logo-simply-blue-round14.html §02). Measured: at 14 px, Plus Jakarta
          Sans has a cap height of 10.6 px, so the centre of "SYFLO"'s ink sits
          0.7 px below the centre of the 20 px mark. With the old mixed-case
          "Syflo" this anchor was impossible to hit cleanly — the descender of
          the "y" pulled the ink band down and the mark overhung the caps by
          5.1 px. Uppercase has no descender, so the word is a clean bar. */}
      <svg
        width="20.83"
        height="20"
        viewBox="0 0 50 48"
        fill="none"
        aria-hidden="true"
        style={{ position: 'relative', top: 0.7 }}
      >
        <path d="M11 24 H 22 C 28 24, 29 15, 36 13" stroke="#2563EB" strokeWidth="5" strokeLinecap="round" />
        <path d="M22 24 C 28 24, 29 33, 36 35" stroke="#2563EB" strokeWidth="5" strokeLinecap="round" />
        <circle cx="8" cy="24" r="4" fill="#2563EB" />
        <circle cx="41.77" cy="11.35" r="5.5" fill="#FFFFFF" stroke="#2563EB" strokeWidth="4" />
        <circle cx="41.77" cy="36.65" r="5.5" fill="#FFFFFF" stroke="#2563EB" strokeWidth="4" />
      </svg>
      {/* Basic was the only theme without a display face for its wordmark — it
          used the same system font as every menu label, so the logo read as UI
          text. Plus Jakarta Sans 700 is its display face.

          Set in CAPS and in ONE colour (user choice 2026-08-25): the blue now
          lives only in the mark, so the logo also works in a single ink. Caps
          need tracking — 0.04em is the "knapp" step of round 14 §02 — and one
          point less size than the old mixed case, because a line of capitals
          reads bigger at the same pixel size. Hyrule and Matrix already set
          SYFLO in caps; Ink Blue and Mushroom Kingdom keep the two-tone name. */}
      <span
        style={{
          fontFamily: "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
          fontWeight: 700,
          fontSize: 14,
          letterSpacing: '0.04em',
          color: '#101828',
        }}
      >
        SYFLO
      </span>
    </>
  ),

  'ink-blue': (
    <>
      <svg width="20" height="20" viewBox="0 0 48 48" fill="none" aria-hidden="true">
        <circle cx="7" cy="24" r="5" fill="#3B82F6" stroke="#1C2B4A" strokeWidth="3" />
        <path d="M11 24 H 22 C 28 24, 29 15, 36 13" stroke="#1C2B4A" strokeWidth="4" strokeLinecap="round" />
        <path d="M22 24 C 28 24, 29 33, 36 35" stroke="#1C2B4A" strokeWidth="4" strokeLinecap="round" />
        <circle cx="39" cy="12.5" r="5.5" fill="#34D399" stroke="#1C2B4A" strokeWidth="3" />
        <circle cx="39" cy="35.5" r="5.5" fill="#3B82F6" stroke="#1C2B4A" strokeWidth="3" />
      </svg>
      <span
        style={{
          fontFamily: "'Space Grotesk', 'DM Sans', sans-serif",
          fontWeight: 700,
          fontSize: 17,
          letterSpacing: '-0.02em',
          color: '#14263F',
        }}
      >
        Sy<span style={{ color: '#3B82F6' }}>flo</span>
      </span>
    </>
  ),

  'mushroom-kingdom': (
    <>
      {/* Pixel mushroom, crispEdges so the "sprite" stays sharp when scaled */}
      <svg width="20" height="20" viewBox="0 0 64 64" aria-hidden="true">
        <g shapeRendering="crispEdges">
          <rect x="16" y="6" width="32" height="8" fill="#26264F" />
          <rect x="8" y="14" width="48" height="16" fill="#D8433B" />
          <rect x="24" y="14" width="16" height="12" fill="#FFF9EE" />
          <rect x="8" y="30" width="48" height="4" fill="#26264F" />
          <rect x="18" y="34" width="28" height="16" fill="#FCEBC7" />
          <rect x="16" y="50" width="32" height="4" fill="#26264F" />
        </g>
      </svg>
      {/* Wortmarke in der Pixel-Display-Schrift des Themes (wie die
          MODELS-/Sektions-Labels), nicht mehr Baloo 2 — Farben unverändert
          (Nutzerkorrektur 2026-07-22). */}
      <span
        style={{
          fontFamily: "'Press Start 2P', monospace",
          fontSize: 12,
          lineHeight: 1,
          color: '#23234A',
        }}
      >
        Sy<span style={{ color: '#D8433B' }}>flo</span>
      </span>
    </>
  ),

  hyrule: (
    <>
      <svg width="23" height="16" viewBox="0 0 86 60" fill="none" aria-hidden="true">
        <path d="M6 30 H 34 C 44 30, 46 16, 58 13" stroke="#2AA198" strokeWidth="5" strokeLinecap="round" />
        <path d="M34 30 C 44 30, 46 44, 58 47" stroke="#2AA198" strokeWidth="5" strokeLinecap="round" />
        <rect x="58" y="4" width="15" height="15" transform="rotate(45 65.5 11.5)" fill="#B8963A" />
        <rect x="58" y="38" width="15" height="15" transform="rotate(45 65.5 45.5)" fill="#B8963A" />
      </svg>
      <span
        style={{
          fontFamily: "'Marcellus', serif",
          fontSize: 15,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: '#33372A',
        }}
      >
        Syflo
      </span>
    </>
  ),

  matrix: (
    <>
      <MatrixMark size={20} />
      <span
        style={{
          fontFamily: "'Share Tech Mono', 'IBM Plex Mono', monospace",
          fontSize: 13,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: '#2BE76B',
          textShadow: '0 0 8px rgba(43, 231, 107, 0.35)',
        }}
      >
        SYFLO
      </span>
    </>
  ),
};

interface LogoProps {
  className?: string;
  // Vergrößert das Logo rein visuell (transform) — die Varianten behalten
  // ihre für die Sidebar abgestimmten Pixelmaße. Für den Empty-State (~1.6).
  scale?: number;
}

export function Logo({ className, scale = 1 }: LogoProps) {
  const theme = useSyncExternalStore(subscribeToTheme, readTheme);
  return (
    <span
      className={className}
      role="img"
      aria-label="Syflo"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 9,
        lineHeight: 1,
        ...(scale !== 1
          ? { transform: `scale(${scale})`, transformOrigin: 'center' }
          : null),
      }}
    >
      {VARIANTS[theme]}
    </span>
  );
}
