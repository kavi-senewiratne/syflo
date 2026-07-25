/**
 * tests/MessageBubble.math.test.tsx
 *
 * LaTeX-Formeln in Assistenten-Antworten werden per KaTeX gesetzt statt
 * wörtlich angezeigt (Bug-Report 2026-07-22: „$O(n^2)$" stand roh im Chat).
 * Modelle schreiben sowohl $…$/$$…$$ als auch \(…\)/\[…\] — beides muss
 * gerendert werden.
 */

import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MessageBubble, normalizeMathDelimiters } from '../components/ChatArea/MessageBubble';
import type { Message } from '../types';

const mkMessage = (content: string): Message => ({
  id: 'a1',
  chat_id: '1',
  role: 'assistant',
  content,
  created_at: new Date().toISOString(),
});

const renderContent = (content: string) =>
  render(<MessageBubble message={mkMessage(content)} onWordRightClick={vi.fn()} />);

describe('math rendering in chat messages', () => {
  it('renders dollar-delimited inline math as KaTeX instead of raw text', () => {
    const { container } = renderContent('Attention scales in $O(n^2)$ time.');

    expect(container.querySelector('.katex')).not.toBeNull();
    expect(container.textContent).not.toContain('$O(n^2)$');
  });

  it('renders \\(...\\) inline math the way models often emit it', () => {
    const { container } = renderContent('The loss \\(\\mathcal{L}\\) decreases.');

    expect(container.querySelector('.katex')).not.toBeNull();
    expect(container.textContent).not.toContain('\\(');
  });

  it('renders \\[...\\] display math as a block formula', () => {
    const { container } = renderContent('Update rule:\n\n\\[\\theta \\leftarrow \\theta - \\eta \\nabla J(\\theta)\\]');

    expect(container.querySelector('.katex-display')).not.toBeNull();
  });

  it('leaves prose without math untouched', () => {
    const { container } = renderContent('Plain answer without formulas.');

    expect(container.querySelector('.katex')).toBeNull();
    expect(container.textContent).toContain('Plain answer without formulas.');
  });

  it('promotes \\displaystyle inline math to its own display block', () => {
    // Modelle quetschen Monster-Formeln per \displaystyle in den Satz —
    // inline gequetscht kollidieren sie mit Nachbarzeilen (Report 2026-07-22).
    const { container } = renderContent(
      'The zeta function: $\\displaystyle \\zeta(s) = \\sum_{n=1}^{\\infty} \\frac{1}{n^s}$ appears mid-sentence.',
    );

    expect(container.querySelector('.katex-display')).not.toBeNull();
  });

  it('promotes inline math containing an environment (matrix etc.) to a display block', () => {
    const { container } = renderContent(
      'It looks like $\\begin{matrix} a & b \\\\ c & d \\end{matrix}$ inline.',
    );

    expect(container.querySelector('.katex-display')).not.toBeNull();
  });

  it('keeps small inline math inline', () => {
    const { container } = renderContent('Runs in $O(n^2)$ time.');

    expect(container.querySelector('.katex')).not.toBeNull();
    expect(container.querySelector('.katex-display')).toBeNull();
  });

  it('unwraps dollar math that models wrap in inline code (Report 2026-07-24)', () => {
    // Kleine Modelle schreiben `$\hat{P}(...)$` — in Code-Spans rendert
    // KaTeX bewusst nicht, also stand die Formel roh im Chat.
    const { container } = renderContent(
      'die Gleichung `$\\hat{P}(w_t | w_{t-1}^1) \\approx \\hat{P}(w_t | w_{t-1}^{t-n+1})$` im Fokus',
    );

    expect(container.querySelector('.katex')).not.toBeNull();
    // kein Code-Span mehr übrig — die Formel wurde ausgepackt
    expect(container.querySelector('code')).toBeNull();
  });

  it('unwraps \\(...\\) math wrapped in inline code', () => {
    const { container } = renderContent('Der Verlust `\\(\\mathcal{L}_{total}\\)` sinkt.');

    expect(container.querySelector('.katex')).not.toBeNull();
    expect(container.textContent).not.toContain('\\(');
  });

  it('keeps env-var-style code spans with dollar signs as code', () => {
    const { container } = renderContent('Setze `$PATH$` in der Shell.');

    expect(container.querySelector('.katex')).toBeNull();
    expect(container.querySelector('code')).not.toBeNull();
    expect(container.textContent).toContain('$PATH$');
  });

  it('unwraps short dollar math in code spans like `$n-1$` (Report 2026-07-24, Runde 2)', () => {
    const { container } = renderContent('Es vergisst alles vor den letzten `$n-1$` Wörtern.');

    expect(container.querySelector('.katex')).not.toBeNull();
    expect(container.querySelector('code')).toBeNull();
  });

  it('unwraps bare LaTeX in code spans when a known command appears', () => {
    // Modelle schreiben auch `\hat{P}(w_t | w_{t-1}^1)` ganz ohne Dollar.
    const { container } = renderContent(
      'Linke Seite ( `\\hat{P}(w_t | w_{t-1}^{t-n+1})` ): das Ziel.',
    );

    expect(container.querySelector('.katex')).not.toBeNull();
    expect(container.querySelector('code')).toBeNull();
  });

  it('unwraps a lone symbol command like `\\approx`', () => {
    const { container } = renderContent('Rechte Seite ( `\\approx` ): die Näherung.');

    expect(container.querySelector('.katex')).not.toBeNull();
    expect(container.querySelector('code')).toBeNull();
  });

  it('keeps regex-style escapes like `\\d+` as code', () => {
    const { container } = renderContent('Nutze `\\d+` im Regex.');

    expect(container.querySelector('.katex')).toBeNull();
    expect(container.querySelector('code')).not.toBeNull();
  });
});

// Breite Batterie (Nutzerwunsch 2026-07-24): viele reale Modell-Ausgaben.
describe('math normalization — model-output shapes that must render', () => {
  it.each([
    [
      'balanced code-wrapped dollars',
      'die Gleichung `$\\hat{P}(w_t | w_{t-1}^1) \\approx \\hat{P}(w_t | w_{t-1}^{t-n+1})$` im Fokus',
    ],
    [
      'unbalanced dollars + double closing backtick (Report Runde 3)',
      'die Gleichung `$\\hat{P}(w_t | w_{t-1}^1) \\approx \\hat{P}(w_t | w_{t-1}^{t-n+1})`` im Fokus',
    ],
    ['double-backtick wrapped dollars', 'Formel ``$\\frac{a}{b}$`` hier'],
    ['fraction in bare code span', 'Der Bruch `\\frac{a}{b}` kürzt sich.'],
    ['greek letter in bare code span', 'Die Lernrate `\\alpha` ist klein.'],
    ['display brackets in code span', 'Summe: `\\[\\sum_{i=1}^{n} x_i\\]` fertig.'],
    ['double-dollar display in code span', 'Energie: `$$E = mc^2$$`'],
    ['\\(...\\) in code span', 'Der Verlust `\\(\\mathcal{L}_{total}\\)` sinkt.'],
    ['subscripted variable with dollars in code span', 'Gewichte `$w_{t-1}$` hier.'],
    ['operator name in code span', 'Es gilt `\\log p(x)` näherungsweise.'],
    ['sum with subscript directly after command (\\b-Falle)', 'Summe `\\sum_{i=1}^{n} x_i` fertig.'],
    ['double-backtick span without LaTeX command', 'Zeit ``$O(n^2)$`` braucht es.'],
    ['orphan opening backtick before math', 'Es gilt `$w_t$ im Modell.'],
    ['orphan closing backtick after math', 'Es gilt $w_t$` im Modell.'],
    ['unbalanced backticks with subscript signal', 'Kontext `$w_{t-1}`` Wörter.'],
  ])('%s', (_name, content) => {
    const { container } = renderContent(content);

    expect(container.querySelector('.katex')).not.toBeNull();
    expect(container.querySelector('code')).toBeNull();
  });

  it('unwraps several formula spans in one message', () => {
    const { container } = renderContent(
      'Links ( `\\hat{P}(w_t | w_{t-1}^1)` ), rechts ( `\\approx` ), Kontext `$n-1$` Wörter.',
    );

    expect(container.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(3);
    expect(container.querySelector('code')).toBeNull();
  });

  it('renders math and real code side by side', () => {
    const { container } = renderContent('Nutze `useMemo` für $O(1)$-Zugriff.');

    expect(container.querySelector('.katex')).not.toBeNull();
    expect(container.querySelector('code')).not.toBeNull();
    expect(container.textContent).toContain('useMemo');
  });
});

describe('math normalization — real code must stay code', () => {
  it.each([
    ['env var with both dollars', 'Setze `$PATH$` in der Shell.', '$PATH$'],
    ['regex escape', 'Nutze `\\d+` im Regex.', '\\d+'],
    ['plain shell command', 'Führe `npm install -g vite` aus.', 'npm install'],
    ['template literal placeholder', 'Schreibe `${var}` ins Template.', '${var}'],
    ['shell var inside a command', 'Committe mit `git commit -m "$MSG"`.', '$MSG'],
    ['windows path', 'Der Ordner `C:\\Users\\kavi` existiert.', 'C:\\Users\\kavi'],
    ['newline escape', 'Beende mit `\\n` die Zeile.', '\\n'],
  ])('%s', (_name, content, mustSurvive) => {
    const { container } = renderContent(content);

    expect(container.querySelector('.katex')).toBeNull();
    expect(container.querySelector('code')).not.toBeNull();
    expect(container.textContent).toContain(mustSurvive);
  });

  it('leaves fenced code blocks alone', () => {
    const { container } = renderContent(
      'Beispiel:\n\n```js\nconst price = "$100";\nconst n = "$n-1$";\n```\n',
    );

    expect(container.querySelector('.katex')).toBeNull();
    expect(container.querySelector('pre code')).not.toBeNull();
    expect(container.textContent).toContain('$100');
  });

  it('never merges two separate code spans into one formula', () => {
    // Fies für gierige Regexes: `$a` … `b$` sähe verschmolzen wie EIN $…$ aus.
    expect(normalizeMathDelimiters('erst `$a` dann `b$` Ende')).toBe(
      'erst `$a` dann `b$` Ende',
    );
    expect(normalizeMathDelimiters('`\\(x\\)` und `\\(y\\)`')).toBe('$x$ und $y$');
  });
});
