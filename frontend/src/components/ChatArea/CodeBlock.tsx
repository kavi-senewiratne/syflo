/**
 * components/ChatArea/CodeBlock.tsx
 *
 * Gehighlighteter Code-Block für Chat-Antworten (Nutzer-Wunsch 2026-07-24).
 * Die Highlight-Logik (Sprach-Erkennung, hljs-Setup) liegt in
 * highlightCode.ts; hier nur das Rendering.
 *
 * Farben laufen ausschließlich über --syflo-code-*-Variablen (index.css):
 * jedes Theme definiert seine eigene Palette, die Komponente kennt keine
 * konkreten Farbwerte. Kein Emoji, Label als Text (Projektregel).
 */

import { useMemo } from 'react';
import { displayName, highlightCode } from './highlightCode';

export function CodeBlock({ code, fenceLang }: { code: string; fenceLang?: string }) {
  const { html, language } = useMemo(() => highlightCode(code, fenceLang), [code, fenceLang]);

  return (
    <div
      data-testid="code-block"
      className="syflo-code my-3 overflow-hidden rounded-xl border"
      style={{
        backgroundColor: 'var(--syflo-code-bg)',
        borderColor: 'var(--syflo-code-border)',
        color: 'var(--syflo-code-text)',
      }}
    >
      {language && (
        <div
          data-testid="code-block-lang"
          className="px-4 pt-2.5 text-[10px] font-semibold uppercase tracking-wider select-none"
          style={{ color: 'var(--syflo-code-label)' }}
        >
          {displayName(language)}
        </div>
      )}
      <pre className={`overflow-x-auto px-4 pb-4 text-xs leading-relaxed ${language ? 'pt-1.5' : 'pt-4'}`}>
        {html !== null ? (
          // hljs escaped den Code selbst; sein HTML enthält nur span-Tokens.
          <code dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <code>{code}</code>
        )}
      </pre>
    </div>
  );
}
