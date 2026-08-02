/**
 * MathText.test.tsx
 *
 * Titles and short labels render inline $…$ math via KaTeX (user report
 * 2026-07-26: sidebar/header/mindmap titles showed raw LaTeX). MathText is
 * deliberately NOT a markdown pipeline — a stray `_` or `*` in a title must
 * never turn into emphasis — and its helpers keep native tooltips plain and
 * keep length caps from cutting through a math span.
 */

import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MathText, plainMathText, clipMathText } from '../components/MathText';

describe('MathText', () => {
  it('renders $…$ segments through KaTeX and keeps the rest literal', () => {
    const { container } = render(<MathText text={'About: $w_{t-1}$ context'} />);
    expect(container.querySelector('.katex')).not.toBeNull();
    expect(container.textContent).toContain('About:');
    expect(container.textContent).toContain('context');
    // The delimiter itself never reaches the DOM as text.
    expect(container.textContent).not.toContain('$');
  });

  it('renders display math ($$…$$) inline without leaking delimiters', () => {
    const { container } = render(<MathText text={'$$\\sum_i e_{y_i}$$'} />);
    expect(container.querySelector('.katex')).not.toBeNull();
    expect(container.textContent).not.toContain('$');
  });

  it('folds \\(…\\) delimiters into math', () => {
    const { container } = render(<MathText text={'Norm \\(\\|x\\|_2\\)'} />);
    expect(container.querySelector('.katex')).not.toBeNull();
  });

  it('does NOT interpret markdown — underscores outside math stay literal', () => {
    const { container } = render(<MathText text={'file_name_with_underscores'} />);
    expect(container.querySelector('em')).toBeNull();
    expect(container.textContent).toBe('file_name_with_underscores');
  });

  it('leaves unbalanced delimiters as literal text', () => {
    const { container } = render(<MathText text={'costs 5$ total'} />);
    expect(container.querySelector('.katex')).toBeNull();
    expect(container.textContent).toBe('costs 5$ total');
  });
});

describe('plainMathText', () => {
  it('strips delimiters but keeps the LaTeX body for tooltips', () => {
    expect(plainMathText('About: $w_t$ and $$E$$')).toBe('About: w_t and E');
    expect(plainMathText('no math')).toBe('no math');
  });
});

describe('clipMathText', () => {
  it('leaves short strings untouched', () => {
    expect(clipMathText('short $x$', 60)).toBe('short $x$');
  });

  it('never cuts through a $…$ span — backs off to before the span', () => {
    const text = 'prefix ' + '$\\sum_{i=1}^{n} e_{y_i} w_t$' + ' suffix';
    const clipped = clipMathText(text, 12); // lands inside the span
    expect((clipped.match(/\$/g) || []).length % 2).toBe(0);
    expect(clipped).toBe('prefix…');
  });
});
