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
      <span
        style={{
          width: 18,
          height: 18,
          borderRadius: 5,
          background: '#2563EB',
          display: 'inline-grid',
          placeItems: 'center',
          flexShrink: 0,
        }}
      >
        {/* Der Ast endet AUF der Knotenmitte (38 / 12.5), nicht davor
            (mockup-logo-icons-basic-round8.html, M1, Nutzerwahl 2026-08-13).
            Vorher lief er schräg in die Flanke des Knotens: an der Innenseite
            blieb eine Kerbe stehen, der Knoten wirkte aufgesteckt statt
            angewachsen. Mit dem Ende in der Mitte liegt die runde Kappe des
            Astes mittig im Knoten, der Übergang ist auf beiden Seiten gleich.
            Der Radius fiel dazu von 6.5 auf 5 — ein Knoten, der nur noch 2
            über den Ast aufträgt, liest sich als verdickte Astspitze. */}
        <svg width="12" height="12" viewBox="0 0 48 48" fill="none" aria-hidden="true">
          <path d="M8 24 H 22 C 28 24, 29 15, 38 12.5" stroke="#FFFFFF" strokeWidth="6" strokeLinecap="round" />
          <path d="M22 24 C 28 24, 29 33, 38 35.5" stroke="#FFFFFF" strokeWidth="6" strokeLinecap="round" />
          <circle cx="38" cy="12.5" r="5" fill="#FFFFFF" />
          <circle cx="38" cy="35.5" r="5" fill="#FFFFFF" />
        </svg>
      </span>
      <span
        style={{
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
          fontWeight: 600,
          fontSize: 15,
          letterSpacing: '-0.01em',
          color: '#111827',
        }}
      >
        Syflo
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
