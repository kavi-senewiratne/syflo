/**
 * components/ChatArea/InlineMarkdown.tsx
 *
 * Inline markdown+KaTeX rendering for short quote strings (the
 * "Branched from" banner). The chat bubbles' pipeline renders block
 * elements; here paragraphs are unwrapped so the quote flows inline with
 * its label and stays clampable (line-clamp needs continuous inline
 * content). Without this, a parent_word like "Energie $E(w_t)$…" showed
 * its raw LaTeX in the banner (live incident 2026-07-26).
 */

import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { normalizeMathDelimiters } from './MessageBubble';

export function InlineMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        p: ({ children }) => <>{children}</>,
        // A hard line break (source line ending in 2+ spaces before \n)
        // renders as a real <br/>, which no amount of white-space:nowrap on
        // an ancestor can suppress — it broke the "always one continuous
        // line" contract for PDF-selection quotes with embedded newlines
        // (user report 2026-07-31). A space keeps the flow unbroken.
        br: () => ' ',
      }}
    >
      {normalizeMathDelimiters(text)}
    </ReactMarkdown>
  );
}
