/**
 * pdf/mathAwareText.ts
 *
 * Rebuild a readable line from the glyph runs pdf.js reports for a PDF text
 * layer.
 *
 * A PDF carries no math — only glyphs with coordinates. Prose arrives as one
 * item per visual line, but a formula is shredded into dozens of tiny items,
 * one per glyph, with every subscript and superscript in its own item. Joining
 * those with a blank (what `extractColumnAwareSelectionText` did until
 * 2026-08-08) produces the string the user reported from the highlights
 * drawer:
 *
 *   ˆ P ( Z 1 = z 1 , · · · , Zn = zn ) = ∏ i ˆ P ( Zi = zi | ...
 *
 * The characters alone cannot be repaired: in `σ 2 B` the 2 is an exponent and
 * the B an index, while in `Z 1` the 1 is an index — identical on the character
 * level, distinguishable only by geometry. So every run is measured against
 * its neighbours:
 *
 *   - clearly shorter than the glyphs around it → a script, and its baseline
 *     says whether it is an index or an exponent
 *   - a lone accent overlapping a glyph         → combining mark on that glyph
 *   - anything else                             → a base glyph
 *
 * Scripts render as Unicode where Unicode has the character (Z₁, σ², ∑ᵀₜ₌₁) and
 * are appended bare otherwise (σ²B — no subscript capital B exists). This is
 * deliberately NOT a LaTeX reconstruction: no fraction bars, no radicals, no
 * matrices. Half-right LaTeX renders worse than honest text, so a stacked
 * fraction is left as two space-separated parts.
 *
 * Every threshold below is relative to a LOCAL reference height rather than a
 * per-line average. A line's average is worthless here: a formula line can be
 * mostly indices, and a single tall ∏ would otherwise demote every ordinary
 * letter around it to a script.
 */

/**
 * One pdf.js text item in DOM coordinates. `bottom` grows downwards and
 * `height` is the font box — together they locate the glyph's baseline
 * accurately enough to tell an index from an exponent.
 */
export interface GlyphRun {
  text: string;
  left: number;
  right: number;
  bottom: number;
  height: number;
}

// A script glyph is set at roughly 70% of the base size; 0.86 keeps the
// classification clear of font-metric noise without catching small caps.
const SCRIPT_HEIGHT_RATIO = 0.86;
// How many glyphs to either side count as a run's neighbourhood when sizing
// it up. Two is enough to see past a short index chain, and short enough that
// a big operator two glyphs away doesn't dominate ordinary letters.
const NEIGHBOUR_SPAN = 2;
// Baseline offset of a script, as a fraction of its base's height. The dumped
// PDFs put subscripts ~0.22 and superscripts ~0.33 of the base height off the
// centre line, so 0.15 separates them from same-line jitter.
const SCRIPT_OFFSET_RATIO = 0.15;
// Baseline shift that starts a new band — a fraction bar, a radical drawn over
// its argument, or simply the next line of prose.
const BAND_JUMP_RATIO = 0.5;
// Horizontal gap that counts as a real space, relative to base height.
const GAP_RATIO = 0.15;

// Standalone accents pdf.js emits as their own item, mapped to the combining
// mark that puts them back on the letter (`ˆ` + `P` → `P̂`). Marks that are
// already combining map to themselves.
const COMBINING_MARKS: Record<string, string> = {
  'ˆ': '̂', // modifier circumflex
  '̂': '̂',
  '˜': '̃', // modifier tilde
  '̃': '̃',
  '¯': '̄', // macron
  '̄': '̄',
  'ˉ': '̄',
  '˙': '̇', // dot above
  '̇': '̇',
  '´': '́', // acute
  '́': '́',
  '`': '̀', // grave
  '̀': '̀',
  '˘': '̆', // breve
  '̆': '̆',
  'ˇ': '̌', // caron
  '̌': '̌',
  '¨': '̈', // diaeresis
  '̈': '̈',
};

const SUBSCRIPTS: Record<string, string> = {
  0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉',
  '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎',
  a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ',
  o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
  β: 'ᵦ', γ: 'ᵧ', ρ: 'ᵨ', φ: 'ᵩ', χ: 'ᵪ',
};

const SUPERSCRIPTS: Record<string, string> = {
  0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹',
  '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
  a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', i: 'ⁱ', j: 'ʲ',
  k: 'ᵏ', l: 'ˡ', m: 'ᵐ', n: 'ⁿ', o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ',
  v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ',
  A: 'ᴬ', B: 'ᴮ', D: 'ᴰ', E: 'ᴱ', G: 'ᴳ', H: 'ᴴ', I: 'ᴵ', J: 'ᴶ', K: 'ᴷ', L: 'ᴸ',
  M: 'ᴹ', N: 'ᴺ', O: 'ᴼ', P: 'ᴾ', R: 'ᴿ', T: 'ᵀ', U: 'ᵁ', V: 'ⱽ', W: 'ᵂ',
  β: 'ᵝ', γ: 'ᵞ', δ: 'ᵟ', θ: 'ᶿ', φ: 'ᵠ', χ: 'ᵡ',
};

// Never a blank in front of these, always one behind a separator.
const NO_SPACE_BEFORE = ',.;:)]}!?';
const SPACE_AFTER = ',;:';
const NO_SPACE_AFTER = '([{';
// Relational and arrow operators read as one word without breathing room
// ("zi|gi"), so they get blanks on both sides regardless of the PDF's kerning.
const OPERATORS = new Set([
  '=', '|', '<', '>', '≤', '≥', '≈', '≠', '≡', '∝', '∈', '∼',
  '←', '→', '⇒', '⇐', '↔', '+', '×', '÷', '±', '−',
]);

/** Translate a script's text, or null when Unicode can't express all of it. */
function toScript(text: string, table: Record<string, string>): string | null {
  let out = '';
  for (const ch of text) {
    const mapped = table[ch];
    if (!mapped) return null;
    out += mapped;
  }
  return out;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const centreX = (r: GlyphRun) => (r.left + r.right) / 2;
const centreY = (r: GlyphRun) => r.bottom - r.height / 2;

/**
 * Tallest glyph a run should be measured against: everything that overlaps it
 * horizontally, plus its immediate left and right neighbours.
 *
 * A script always sits inside its base glyph's x range (an index under ∏) or
 * within a glyph or two of it, so this catches every real case. Both wider and
 * narrower windows were wrong in practice: with a proximity window the "P" of
 * a second P̂ was swallowed by a 15.7pt ∏ beside it and demoted to a script,
 * silently dropping its accent (live check 2026-08-08); with immediate
 * neighbours only, the last glyph of an index chain ("σ 2 B", "Zi − 1") saw
 * nothing but other scripts and stayed full size. A per-line average fails
 * differently again — a line of mostly indices would promote the indices.
 */
function referenceHeight(sorted: readonly GlyphRun[], index: number): number {
  const run = sorted[index];
  let tallest = run.height;
  for (const other of sorted) {
    if (other !== run && other.right > run.left && other.left < run.right) {
      tallest = Math.max(tallest, other.height);
    }
  }
  const from = Math.max(0, index - NEIGHBOUR_SPAN);
  const to = Math.min(sorted.length - 1, index + NEIGHBOUR_SPAN);
  for (let i = from; i <= to; i += 1) tallest = Math.max(tallest, sorted[i].height);
  return tallest;
}

/** A base glyph plus everything that hangs off it. */
interface Unit {
  text: string;
  left: number;
  right: number;
  supers: GlyphRun[];
  subs: GlyphRun[];
}

function renderUnit(unit: Unit): string {
  // Exponent before index — the order σ²_B is written in, and the order the
  // limits of a big operator read in (∏ᵀₜ₌₁).
  let out = unit.text;
  for (const group of [
    { runs: unit.supers, table: SUPERSCRIPTS },
    { runs: unit.subs, table: SUBSCRIPTS },
  ]) {
    for (const run of [...group.runs].sort((a, b) => a.left - b.left)) {
      out += toScript(run.text, group.table) ?? run.text;
    }
  }
  return out;
}

/**
 * Does the PDF put a real space between two neighbouring units? Punctuation
 * and operators decide first — a PDF's kerning around a comma is far too tight
 * to read geometrically — and only then the measured gap.
 */
function needsSpace(prev: Unit, next: Unit, baseHeight: number): boolean {
  const prevLast = prev.text.at(-1) ?? '';
  const nextFirst = next.text[0] ?? '';
  if (NO_SPACE_BEFORE.includes(nextFirst)) return false;
  if (NO_SPACE_AFTER.includes(prevLast)) return false;
  if (SPACE_AFTER.includes(prevLast)) return true;
  if (OPERATORS.has(prev.text.trim()) || OPERATORS.has(next.text.trim())) return true;
  return next.left - prev.right > GAP_RATIO * baseHeight;
}

interface Classified {
  run: GlyphRun;
  isScript: boolean;
  accent: string | null;
}

/**
 * Classify every run once: accent, script, or base glyph. Accents are folded
 * into the glyph they overlap; a run counts as a script when it is clearly
 * shorter than the tallest glyph beside it.
 */
function classify(runs: readonly GlyphRun[]): Classified[] {
  const accentOf = new Map<GlyphRun, string>();
  const accents = new Set<GlyphRun>();
  for (const run of runs) {
    const mark = COMBINING_MARKS[run.text];
    if (!mark) continue;
    const cx = centreX(run);
    const host = runs.find(
      (other) =>
        other !== run &&
        !COMBINING_MARKS[other.text] &&
        cx >= other.left &&
        cx <= other.right,
    );
    if (!host) continue;
    accentOf.set(host, (accentOf.get(host) ?? '') + mark);
    accents.add(run);
  }

  const glyphs = runs.filter((r) => !accents.has(r));
  const sorted = [...glyphs].sort((a, b) => a.left - b.left);
  const scripts = new Set<GlyphRun>();
  sorted.forEach((run, i) => {
    if (run.height < SCRIPT_HEIGHT_RATIO * referenceHeight(sorted, i)) scripts.add(run);
  });
  // Reading order is preserved — only the height comparison needed x order.
  return glyphs.map((run) => ({
    run,
    isScript: scripts.has(run),
    accent: accentOf.get(run) ?? null,
  }));
}

/**
 * Split classified runs into bands that may safely be reordered by x.
 *
 * Sorting by left edge is only correct while the base glyphs really sit side
 * by side. A stacked fraction breaks that, and so does a selection spanning
 * several lines. Runs arrive in reading order, so a band ends wherever a BASE
 * glyph leaves the band's baseline — scripts never open a band, which is what
 * keeps the limits of ∏ attached to it.
 */
function splitBands(items: Classified[]): Classified[][] {
  const bands: Classified[][] = [];
  let current: Classified[] = [];
  let baseline: number | null = null;
  let baseHeight = 0;
  for (const item of items) {
    if (!item.isScript) {
      if (baseline !== null && Math.abs(item.run.bottom - baseline) > BAND_JUMP_RATIO * baseHeight) {
        // The upper limit of a big operator is emitted BEFORE the operator
        // (pdf.js orders by descending y), so it would be stranded in the
        // outgoing band — that made "1/m ∑ᵐᵢ₌₁" come out as "1 mᵐ ∑ᵢ₌₁".
        // Trailing scripts sitting within the incoming glyph move with it.
        const carried: Classified[] = [];
        while (current.length > 0) {
          const last = current[current.length - 1];
          const cx = centreX(last.run);
          if (!last.isScript || cx < item.run.left || cx > item.run.right) break;
          carried.unshift(current.pop()!);
        }
        bands.push(current);
        current = carried;
      }
      baseline = item.run.bottom;
      baseHeight = item.run.height;
    }
    current.push(item);
  }
  if (current.length > 0) bands.push(current);
  return bands.filter((band) => band.length > 0);
}

/** Turn one band into its units, in left-to-right reading order. */
function buildBand(items: Classified[]): { units: Unit[]; baseHeight: number } {
  const bases = items.filter((i) => !i.isScript).sort((a, b) => a.run.left - b.run.left);
  const unitOf = new Map<Classified, Unit>();
  const units: Unit[] = [];
  for (const base of bases) {
    const unit: Unit = {
      text: base.run.text + (base.accent ?? ''),
      left: base.run.left,
      right: base.run.right,
      supers: [],
      subs: [],
    };
    unitOf.set(base, unit);
    units.push(unit);
  }

  const bandCentre = median(bases.map((b) => centreY(b.run)));
  const bandHeight = median(bases.map((b) => b.run.height));

  for (const item of items) {
    if (!item.isScript) continue;
    const cx = centreX(item.run);
    // The base glyph this script belongs to: the one containing it, else the
    // nearest one starting to its left. Containment is what puts the limits of
    // "∏" on the ∏ rather than on the "=" in front of it.
    const host =
      bases.find((b) => cx >= b.run.left && cx <= b.run.right) ??
      [...bases].reverse().find((b) => b.run.left <= item.run.left) ??
      null;
    const refCentre = host ? centreY(host.run) : bandCentre;
    const refHeight = host ? host.run.height : bandHeight;
    const offset = centreY(item.run) - refCentre;
    const threshold = SCRIPT_OFFSET_RATIO * refHeight;
    const table = offset > 0 ? SUBSCRIPTS : SUPERSCRIPTS;

    if (Math.abs(offset) <= threshold) {
      // Small but on the baseline — not a script after all (small caps, a
      // narrow operator). Keep it inline as its own unit, accent included:
      // dropping it here is how the second "P̂" lost its hat.
      units.push({
        text: item.run.text + (item.accent ?? ''),
        left: item.run.left, right: item.run.right,
        supers: [], subs: [],
      });
      continue;
    }
    const unit = host ? unitOf.get(host) : null;
    if (!unit) {
      units.push({
        text: toScript(item.run.text, table) ?? item.run.text,
        left: item.run.left, right: item.run.right,
        supers: [], subs: [],
      });
      continue;
    }
    if (offset > 0) unit.subs.push(item.run);
    else unit.supers.push(item.run);
    unit.right = Math.max(unit.right, item.run.right);
  }

  units.sort((a, b) => a.left - b.left);
  return { units, baseHeight: bandHeight || median(items.map((i) => i.run.height)) };
}

/**
 * Compose the text of a selection from its glyph runs, which must arrive in
 * reading order. Bands are joined with a single blank, matching how the
 * previous `parts.join(' ')` flattened a multi-line drag into one quote.
 */
export function composeMathAwareText(runs: readonly GlyphRun[]): string {
  const usable = runs.filter(
    (r) => (r.text.trim() !== '' || COMBINING_MARKS[r.text]) && r.height > 0,
  );
  if (usable.length === 0) return '';

  const pieces: string[] = [];
  for (const band of splitBands(classify(usable))) {
    const { units, baseHeight } = buildBand(band);
    let line = '';
    for (let i = 0; i < units.length; i += 1) {
      if (i > 0 && needsSpace(units[i - 1], units[i], baseHeight)) line += ' ';
      line += renderUnit(units[i]);
    }
    const trimmed = line.trim();
    if (trimmed) pieces.push(trimmed);
  }
  return pieces.join(' ');
}
