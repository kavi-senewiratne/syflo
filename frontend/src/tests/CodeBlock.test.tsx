/**
 * CodeBlock.test.tsx
 *
 * Gehighlightete Code-Blöcke in Chat-Antworten (Nutzer-Wunsch 2026-07-24):
 * Fence-Sprache wird respektiert (inkl. Aliase wie ```py), ohne Fence rät
 * highlightAuto, unsichere Treffer bleiben unhighlighted, und die Farben
 * laufen über --syflo-code-*-Variablen statt harter Utility-Klassen.
 */

import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CodeBlock } from '../components/ChatArea/CodeBlock';
import { highlightCode } from '../components/ChatArea/highlightCode';
import { MessageBubble } from '../components/ChatArea/MessageBubble';
import type { Message } from '../types';

const PYTHON = 'def greetings():\n    """Doc"""\n    print("Hello, World!")\n\ngreetings()';

describe('highlightCode', () => {
  it('nutzt die Fence-Sprache, wenn sie registriert ist', () => {
    const { html, language } = highlightCode(PYTHON, 'python');
    expect(language).toBe('python');
    expect(html).toContain('hljs-keyword');
    expect(html).toContain('hljs-string');
  });

  it('mappt Aliase wie py/ts/sh auf registrierte Sprachen', () => {
    expect(highlightCode(PYTHON, 'py').language).toBe('python');
    expect(highlightCode('const x: number = 1;', 'ts').language).toBe('typescript');
    expect(highlightCode('echo "hi"', 'sh').language).toBe('bash');
  });

  it('erkennt die Sprache ohne Fence automatisch', () => {
    const { language, html } = highlightCode(PYTHON);
    expect(language).toBe('python');
    expect(html).toContain('hljs-');
  });

  it('lässt uneindeutige Schnipsel unhighlighted statt falsch bunt', () => {
    const { html } = highlightCode('foo bar');
    expect(html).toBeNull();
  });

  it('escapt HTML im Code (kein Injection über dangerouslySetInnerHTML)', () => {
    const { html } = highlightCode('print("<script>alert(1)</script>")', 'python');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('CodeBlock', () => {
  it('zeigt das Sprach-Label und färbt über Theme-Variablen', () => {
    const { getByTestId } = render(<CodeBlock code={PYTHON} fenceLang="python" />);
    expect(getByTestId('code-block-lang').textContent).toBe('Python');
    const block = getByTestId('code-block');
    expect(block.className).toContain('syflo-code');
    expect(block.style.backgroundColor).toBe('var(--syflo-code-bg)');
    expect(block.style.color).toBe('var(--syflo-code-text)');
  });

  it('zeigt Anzeigenamen wie C++ und JavaScript korrekt', () => {
    const { getByTestId, rerender } = render(
      <CodeBlock code={'#include <stdio.h>\nint main() { return 0; }'} fenceLang="c++" />,
    );
    expect(getByTestId('code-block-lang').textContent).toBe('C++');
    rerender(<CodeBlock code={'const f = () => console.log(1);'} fenceLang="js" />);
    expect(getByTestId('code-block-lang').textContent).toBe('JavaScript');
  });

  it('rendert unbekannten Code ohne Label als neutralen Text', () => {
    const { getByTestId, queryByTestId } = render(<CodeBlock code="foo bar" />);
    expect(queryByTestId('code-block-lang')).toBeNull();
    expect(getByTestId('code-block').textContent).toContain('foo bar');
  });
});

describe('MessageBubble – Code-Blöcke', () => {
  function renderAssistant(content: string) {
    const message: Message = {
      id: 'a-code',
      chat_id: 'c1',
      role: 'assistant',
      content,
      created_at: new Date().toISOString(),
    };
    return render(<MessageBubble message={message} onWordRightClick={vi.fn()} />).container;
  }

  it('rendert einen Python-Fence als gehighlighteten CodeBlock', () => {
    const container = renderAssistant('```python\n' + PYTHON + '\n```');
    expect(container.querySelector('[data-testid="code-block"]')).not.toBeNull();
    expect(container.querySelector('.hljs-keyword')).not.toBeNull();
    expect(container.querySelector('[data-testid="code-block-lang"]')!.textContent).toBe('Python');
  });

  it('rendert einen Fence OHNE Sprache als Block (nicht als Inline-Chip)', () => {
    const container = renderAssistant('```\n' + PYTHON + '\n```');
    const block = container.querySelector('[data-testid="code-block"]');
    expect(block).not.toBeNull();
    // Auto-Erkennung greift auch hier.
    expect(container.querySelector('[data-testid="code-block-lang"]')!.textContent).toBe('Python');
  });

  it('lässt Inline-Code als Inline-Chip', () => {
    const container = renderAssistant('Nutze `print()` dafür.');
    expect(container.querySelector('[data-testid="code-block"]')).toBeNull();
    const inline = container.querySelector('code');
    expect(inline).not.toBeNull();
    expect(inline!.className).toContain('bg-gray-100');
  });
});
