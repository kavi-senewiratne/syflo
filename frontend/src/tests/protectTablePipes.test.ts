import { describe, it, expect } from 'vitest';
import { protectTablePipes } from '../markdown/protectTablePipes';

describe('protectTablePipes', () => {
  // The reported case: |V| inside a cell tore the row into extra cells and the
  // formula stayed raw text (screenshot 2026-08-06).
  it('turns cardinality bars inside a table cell into \\vert', () => {
    const row = '| Softmax | $O(|V| \\cdot n \\cdot m)$ | Summe |';
    const out = protectTablePipes(row);
    expect(out).toBe('| Softmax | $O(\\vert V\\vert  \\cdot n \\cdot m)$ | Summe |');
    // The cell count is what the table parser sees — 3 cells, not 5.
    expect(out.split('|').length - 2).toBe(3);
  });

  it('keeps the double bar as \\Vert', () => {
    expect(protectTablePipes('| a | $\\|x\\|_2$ |')).toBe('| a | $\\Vert x\\Vert _2$ |');
  });

  it('leaves pipes outside math alone', () => {
    const row = '| $x^2$ | plain | text |';
    expect(protectTablePipes(row)).toBe(row);
  });

  it('leaves prose lines alone', () => {
    const prose = 'Die Menge $|V|$ ist das Vokabular.';
    expect(protectTablePipes(prose)).toBe(prose);
  });

  it('leaves a formula with a column spec alone', () => {
    const row = '| a | $\\begin{array}{c|c} 1 & 2 \\end{array}$ |';
    expect(protectTablePipes(row)).toBe(row);
  });

  it('does not touch table rows inside a code fence', () => {
    const md = ['```markdown', '| a | $|V|$ |', '```', '| b | $|V|$ |'].join('\n');
    const out = protectTablePipes(md).split('\n');
    expect(out[1]).toBe('| a | $|V|$ |');
    expect(out[3]).toBe('| b | $\\vert V\\vert $ |');
  });

  it('handles display math in a cell', () => {
    expect(protectTablePipes('| a | $$|V|$$ |')).toBe('| a | $$\\vert V\\vert $$ |');
  });

  it('is idempotent', () => {
    const row = '| Softmax | $O(|V| \\cdot n)$ |';
    const once = protectTablePipes(row);
    expect(protectTablePipes(once)).toBe(once);
  });
});
