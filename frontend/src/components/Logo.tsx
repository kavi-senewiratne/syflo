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
      {/* The mark stays centred on the CAP BAND, not on the flex line box —
          the eye reads that band as "the word". Re-measured for round 15's
          system-font setting (user choice 2026-08-25, design/mockup-logo-
          round15.html §01/§03): at 15 px/700 the system face has a cap height
          of 10.84 px and a baseline 13.5 px down a 15 px box, which puts the
          cap-band centre 0.58 px below the centre of the 20 px mark.

          The descender is back with mixed case (2.8 px on the "y"), which is
          exactly what round 14 avoided by going uppercase. Anchoring on the
          cap band rather than the full ink band is what keeps that descender
          out of the vertical decision: it hangs below the bar, it does not
          move it. */}
      <svg
        width="20.83"
        height="20"
        viewBox="0 0 50 48"
        fill="none"
        aria-hidden="true"
        style={{ position: 'relative', top: 0.58 }}
      >
        <path d="M11 24 H 22 C 28 24, 29 15, 36 13" stroke="#2563EB" strokeWidth="5" strokeLinecap="round" />
        <path d="M22 24 C 28 24, 29 33, 36 35" stroke="#2563EB" strokeWidth="5" strokeLinecap="round" />
        <circle cx="8" cy="24" r="4" fill="#2563EB" />
        <circle cx="41.77" cy="11.35" r="5.5" fill="#FFFFFF" stroke="#2563EB" strokeWidth="4" />
        <circle cx="41.77" cy="36.65" r="5.5" fill="#FFFFFF" stroke="#2563EB" strokeWidth="4" />
      </svg>
      {/* Round 15 (user choice 2026-08-25, design/mockup-logo-round15.html
          §01, the "Vorschlag" card): the wordmark uses the SAME face as the
          rest of this theme — no display font — set mixed case, with "flo" in
          the mark's own blue.

          This reverses round 9 (which added Plus Jakarta Sans because the logo
          font "did not match the theme") and round 14's caps. Kept from those
          rounds: 700 weight and 15 px, so the name still reads as a name and
          not as a menu label — the system face builds narrower than Plus
          Jakarta at the same pixel size (measured: "Syflo" is 37.9 px wide,
          cap height 11.2 px). Tracking goes slightly negative (-0.02em): caps
          needed opening up, mixed case does not.

          One blue, not two: "flo" takes #2563EB, the exact ink of the mark, so
          mark and syllable are the same colour rather than a near-match. */}
      {/* Round 16 (user choice 2026-08-28, design/mockup-logo-round16.html
          §02 variant B + §04 variant 2) lowers weight and blackness — the two
          things that made the wordmark the heaviest and darkest text on the
          empty state, where it sits right above the 32 px serif headline.

          Weight 700 -> 600. The 700 was inherited from round 9's Plus Jakarta
          Sans and carried over unexamined when round 15 went back to the system
          face, which builds heavier at the same number. Measured (canvas, stem
          width over cap height — the usual "how bold does this read" ratio):
          700 = 20.9 %, 600 = 18.6 %, and the serif headline it sits above is
          12.4 %. At 700 the name out-weighted the actual headline.

          Colour #101828 (gray-900) -> #1E2939 (gray-800), the exact ink of that
          headline; the name was the only text in the view on gray-900 (contrast
          on white 17.75:1 vs the headline's 14.67:1), which read as a different
          black rather than as emphasis.

          Cap height is 10.75 px at 700, 600 and 500 alike, so the mark's
          `top: 0.58` offset above is unaffected by this change. */}
      <span
        style={{
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
          fontWeight: 600,
          fontSize: 15,
          letterSpacing: '-0.02em',
          color: '#1E2939',
        }}
      >
        Sy<span style={{ color: '#2563EB' }}>flo</span>
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
      {/* The branch mark, not the mushroom (user choice 2026-08-25,
          design/mockup-logo-round15.html §05, variant A). The dock icon has
          carried this pixel branch all along — a trunk, two steps, two nodes —
          and only the sidebar head still showed a mushroom, so the app said
          two different things about what Syflo is.

          Colors since 2026-09-10 (design/mockup-logo-mushroom-colors.html,
          §03 variant H3): accent-red trunk, both nodes in question-block
          gold — the dock icon's own pair, just two inks. This replaces the
          navy trunk + gold/red nodes of round 15/§05; the user wanted the
          near-black out of the mark (the wordmark's "Sy" keeps the text ink,
          that one was not in question). crispEdges so the sprite stays sharp
          at any scale. */}
      <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
        <g shapeRendering="crispEdges">
          <g fill="#D8433B">
            <rect x="4" y="20" width="16" height="8" />
            <rect x="16" y="12" width="10" height="8" />
            <rect x="16" y="28" width="10" height="8" />
          </g>
          <rect x="26" y="4" width="14" height="14" fill="#EFB43A" />
          <rect x="26" y="30" width="14" height="14" fill="#EFB43A" />
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
