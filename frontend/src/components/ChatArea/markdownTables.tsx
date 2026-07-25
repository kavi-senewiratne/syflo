/**
 * components/ChatArea/markdownTables.tsx
 *
 * GFM-Tabellen-Renderer für ReactMarkdown: ohne eigene Renderer sind die
 * Zellen ungepolstert (das Typography-Plugin ist nicht installiert, .prose
 * stylt hier nichts) und th zentriert per Browser-Default, während td links
 * steht — Kopfzeile und Spalten wirken horizontal wie vertikal verrutscht
 * (Report 2026-07-24). Die Ausricht-Syntax aus Markdown (:---:) kommt als
 * align-Prop an und wird als Inline-Style durchgereicht, damit sie die
 * Utility-Klassen schlägt. Geteilt zwischen MessageBubble und
 * InheritedContextBanner, die dieselbe Markdown-Pipeline fahren.
 *
 * Trennlinien als gedimmtes currentColor statt border-gray-*: die Themes
 * (mushroom-kingdom, ink-blue) färben alle grauen Border-Utilities auf
 * volles Tinten-Navy um — die Zeilenlinien wurden so hart wie Rahmen
 * (Nutzer-Report 2026-07-24). Als Anteil der Textfarbe bleiben sie in
 * jedem Theme subtil und automatisch lesbar (gleicher Trick wie beim
 * Zitat-Styling der User-Bubble).
 */

import type { CSSProperties, ReactNode, ThHTMLAttributes } from 'react';

type CellProps = ThHTMLAttributes<HTMLTableCellElement>;

const HEADER_RULE = '1.5px solid color-mix(in srgb, currentColor 35%, transparent)';
const ROW_RULE = '1px solid color-mix(in srgb, currentColor 12%, transparent)';

export const gfmTableComponents = {
  table({ children }: { children?: ReactNode }) {
    return (
      <div className="my-3 overflow-x-auto">
        <table className="border-collapse">{children}</table>
      </div>
    );
  },
  th({ children, align, style }: CellProps) {
    return (
      <th
        style={{
          textAlign: (align ?? 'left') as CSSProperties['textAlign'],
          borderBottom: HEADER_RULE,
          ...style,
        }}
        className="px-3 py-1.5 align-bottom font-semibold first:pl-0 last:pr-0"
      >
        {children}
      </th>
    );
  },
  td({ children, align, style }: CellProps) {
    return (
      <td
        style={{
          textAlign: (align ?? 'left') as CSSProperties['textAlign'],
          borderBottom: ROW_RULE,
          ...style,
        }}
        className="px-3 py-1.5 align-top first:pl-0 last:pr-0"
      >
        {children}
      </td>
    );
  },
};
