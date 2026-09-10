/**
 * markdown/sanitizeMath.ts
 *
 * Repairs broken model LaTeX delimiters BEFORE the markdown/KaTeX pipeline so
 * a stray `$` can never swallow prose into a formula again (screenshot case
 * 2026-07-25: Gemini left one unpaired `$`, remark-math paired it across
 * `**bold**` and German body text, and the chat showed katex-error spans).
 *
 * Deliberately delimiter-only — the content of formulas is never "improved":
 *   1. Gemini delimiters: `\[`/`\]` → `$$`, `\(`/`\)` → `$` (each bracket on
 *      its own, so an unpaired `\[` becomes an unpaired `$$` that the
 *      balance check below can mask).
 *   2. Balance outside code: with an odd number of `$$` tokens the LAST one
 *      is masked to `\$\$`.
 *   3. Single `$` tokens (not `\$`, not part of `$$`) are paired left to
 *      right with a self-healing scan: a "pair" whose content spans a
 *      paragraph break (`\n\n`) is no formula — its OPENER is a stray (a
 *      price, a typo) and is masked alone, then pairing retries from the
 *      closer. Masking both delimiters instead used to let one early stray
 *      (`$0.08 / Million Tokens`, report 2026-09-04) shift every later
 *      pairing onto the wrong delimiters, so the guard masked the CLOSING
 *      `$` of real formulas and KaTeX showed `B \times K\` parse errors.
 *      A trailing unpaired `$` is masked on the final render.
 *
 * Code fences and inline code are carved out first and never touched.
 *
 * Streaming: the function runs on the currently VISIBLE prefix of a message,
 * so it must be stable on incomplete text — with `{ streaming: true }` the
 * odd-count masking is skipped (a trailing `$`/`$$` may simply be a formula
 * whose closer has not streamed in yet). The final render (streaming off)
 * applies the full repair. The function is idempotent: masked `\$` tokens
 * are ignored on re-runs.
 */

export interface SanitizeMathOptions {
  streaming?: boolean;
}

// Fenced blocks (``` / ~~~, unclosed ones swallow to the end — correct while
// streaming) and inline code spans. Captured so String.split keeps them.
const CODE_SPLIT_RE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g;

// One dollar token: escaped (ignored), display `$$`, or single `$`.
const DOLLAR_TOKEN_RE = /\\\$|\$\$|\$/g;

interface Token {
  part: number;
  pos: number;
  type: '$$' | '$';
}

interface Mask {
  part: number;
  pos: number;
  len: number;
  replacement: string;
}

// Text between two tokens, possibly spanning intermediate (code) parts.
function textBetween(parts: string[], open: Token, close: Token): string {
  if (open.part === close.part) {
    return parts[open.part].slice(open.pos + 1, close.pos);
  }
  let out = parts[open.part].slice(open.pos + 1);
  for (let i = open.part + 1; i < close.part; i++) out += parts[i];
  return out + parts[close.part].slice(0, close.pos);
}

export function sanitizeMath(md: string, opts: SanitizeMathOptions = {}): string {
  const streaming = opts.streaming === true;

  // Even indices = prose, odd indices = code (capture group of split).
  const parts = md.split(CODE_SPLIT_RE);

  // 1. Convert Gemini delimiters — outside code only, bracket by bracket.
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i]
      .replace(/\\\[/g, () => '$$')
      .replace(/\\\]/g, () => '$$')
      .replace(/\\\(/g, () => '$')
      .replace(/\\\)/g, () => '$');
  }

  // Collect dollar tokens outside code, skipping already-escaped `\$`.
  const tokens: Token[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    DOLLAR_TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DOLLAR_TOKEN_RE.exec(parts[i])) !== null) {
      if (m[0] === '\\$') continue;
      tokens.push({ part: i, pos: m.index, type: m[0] as Token['type'] });
    }
  }

  const masks: Mask[] = [];

  // 2a. Odd `$$` count → mask the last one (unless it may still be open).
  const doubles = tokens.filter(t => t.type === '$$');
  if (doubles.length % 2 === 1 && !streaming) {
    const last = doubles[doubles.length - 1];
    masks.push({ part: last.part, pos: last.pos, len: 2, replacement: '\\$\\$' });
  }

  // 3. Pair single `$` tokens left to right, self-healing around strays:
  // a pair spanning a paragraph break is no formula, so its opener is a
  // stray dollar — mask it alone and retry pairing from the closer, which
  // may well open the NEXT real formula. (Masking both used to derail the
  // pairing for the whole rest of the message after one stray.)
  const singles = tokens.filter(t => t.type === '$');
  let i = 0;
  while (i < singles.length) {
    if (i + 1 === singles.length) {
      // Trailing unpaired `$` — while streaming it may be a formula whose
      // closer has not arrived yet, so only the final render masks it.
      if (!streaming) {
        const last = singles[i];
        masks.push({ part: last.part, pos: last.pos, len: 1, replacement: '\\$' });
      }
      break;
    }
    const open = singles[i];
    const close = singles[i + 1];
    if (textBetween(parts, open, close).includes('\n\n')) {
      masks.push({ part: open.part, pos: open.pos, len: 1, replacement: '\\$' });
      i += 1;
    } else {
      i += 2;
    }
  }

  // Apply masks back-to-front so earlier offsets stay valid.
  masks.sort((a, b) => b.part - a.part || b.pos - a.pos);
  for (const mask of masks) {
    parts[mask.part] =
      parts[mask.part].slice(0, mask.pos) +
      mask.replacement +
      parts[mask.part].slice(mask.pos + mask.len);
  }

  return parts.join('');
}
