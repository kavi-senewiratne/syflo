/**
 * markdown/wideMath.ts
 *
 * Eine Inline-Formel, die breiter als ihre Zeile ist, wird zur eigenen
 * waagerecht scrollbaren Zeile — genau die Behandlung, die Display-Formeln
 * (`$$…$$`) schon immer haben (Nutzerentscheid 2026-08-13,
 * design/mockup-simply-blue-fixes.html §03, Variante A).
 *
 * Ursache, am 13.08.2026 in der laufenden App gemessen: `.katex-html` trägt
 * `max-width: 100%`, aber kein `overflow`. Der Kasten hört an der Spaltengrenze
 * auf, die Formel nicht — bei einer 308 px schmalen Elternspalte stand ein
 * 146 px breiter Kasten mit 239 px Tinte, also 93 px sichtbar außerhalb der
 * Blase; die Spalte bekam dadurch 334 px Scrollbreite und der Text lief über
 * die weiße Fläche hinaus (Nutzer-Report 2026-08-13).
 *
 * Warum nicht einfach `overflow-x: auto` auf `.katex-html`: das ist ein
 * Inline-Block, und ein Inline-Block mit `overflow != visible` legt seine
 * Grundlinie auf die untere Rand-Kante. Genau diese Grundlinie ist am
 * 09.08.2026 in mehreren Runden auf die Prosa-Zeile eingemessen worden, damit
 * Markierungen und ihr Unterstrich sitzen (siehe index.css). Als BLOCK auf
 * eigener Zeile stellt sich die Frage nicht: dort gibt es keine Nachbarschrift,
 * an der eine Grundlinie ausgerichtet sein müsste.
 *
 * Die Messung ist von der Entscheidung getrennt, weil jsdom kein Layout hat
 * (jede Breite ist 0). `applyWideMath` rechnet mit Zahlen und ist testbar;
 * `markWideFormulas` liest die Zahlen aus dem DOM.
 */

// Gesetzt auf der `.katex`-Box; index.css macht daraus den Block mit
// Scroll-Container.
export const WIDE_MATH_ATTR = 'data-syflo-math-wide';

// Unter dieser Überschreitung ist es Rundung, kein Überlauf: Zoomstufen und
// fraktionale Zeilenbreiten liefern reihenweise Werte wie 239,4 gegen 239, und
// ohne Toleranz flackerten Formeln bei jeder Messung in die Blockform.
const SLACK_PX = 2;

/**
 * Die äußersten Inline-`.katex`-Boxen unter `root`.
 *
 * Display-Formeln bleiben außen vor — `.katex-display` ist bereits ein
 * eigener Scroll-Container (index.css). Verschachtelte `.katex` ebenso: nur die
 * äußerste Box wird umgeschaltet, sonst kämen Scroll-Container in
 * Scroll-Containern heraus.
 */
export function inlineFormulas(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.katex')).filter(
    (el) => !el.parentElement?.closest('.katex, .katex-display'),
  );
}

export interface FormulaWidth {
  el: HTMLElement;
  /** Breite der gesetzten Formel selbst (scrollWidth der `.katex-html`). */
  ink: number;
  /** Platz, den die Zeile hergibt (clientWidth des umgebenden Blocks). */
  available: number;
}

/**
 * Setzt/entfernt die Block-Markierung anhand gemessener Breiten.
 *
 * `available === 0` heißt „nicht messbar" (ausgeblendete Blase, jsdom) und
 * nicht „nichts passt hinein" — dort bleibt alles, wie es ist.
 */
export function applyWideMath(widths: FormulaWidth[]): void {
  for (const { el, ink, available } of widths) {
    const wide = available > 0 && ink > available + SLACK_PX;
    if (wide) el.setAttribute(WIDE_MATH_ATTR, '');
    else el.removeAttribute(WIDE_MATH_ATTR);
  }
}

// Der Block, dessen Breite die Zeile bestimmt. Im Inline-Zustand ist das der
// Absatz um die Formel, im Block-Zustand derselbe Absatz — dieselbe Zahl in
// beiden Zuständen, deshalb kann die Messung nicht zwischen zwei Zuständen
// hin- und herschwingen.
function lineBox(el: HTMLElement): HTMLElement | null {
  return el.parentElement?.closest('p, li, blockquote, td, th, div') ?? null;
}

/** Misst jede Inline-Formel unter `root` und schaltet sie um. */
export function markWideFormulas(root: Element): void {
  const widths: FormulaWidth[] = [];
  for (const el of inlineFormulas(root)) {
    const html = el.querySelector<HTMLElement>('.katex-html');
    const box = lineBox(el);
    if (!html || !box) continue;
    // scrollWidth der `.katex-html` ist in BEIDEN Zuständen die Tinte: inline
    // deckelt `max-width: 100%` nur die clientWidth, im Block-Zustand hebt
    // index.css den Deckel auf.
    widths.push({ el, ink: html.scrollWidth, available: box.clientWidth });
  }
  applyWideMath(widths);
}
