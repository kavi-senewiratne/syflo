/**
 * components/ChatArea/highlightCode.ts
 *
 * Highlight-Logik für CodeBlock.tsx (Nutzer-Wunsch 2026-07-24):
 * highlight.js läuft komplett lokal (offline-first, kein CDN). Die Sprache
 * kommt bevorzugt aus dem Markdown-Fence (```python); fehlt sie, rät
 * highlightAuto über eine kuratierte Sprachliste — unterhalb einer
 * Mindest-Relevanz bleibt der Code bewusst unhighlighted statt falsch bunt.
 * Eigenes Modul (kein tsx), damit CodeBlock.tsx nur Komponenten exportiert
 * (react-refresh/only-export-components).
 */

import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import latex from 'highlight.js/lib/languages/latex';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import r from 'highlight.js/lib/languages/r';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('css', css);
hljs.registerLanguage('go', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('latex', latex);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('python', python);
hljs.registerLanguage('r', r);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);

// Aliase (```py, ```js, …) auf registrierte Namen abbilden.
const ALIASES: Record<string, string> = {
  py: 'python', js: 'javascript', ts: 'typescript', jsx: 'javascript',
  tsx: 'typescript', sh: 'bash', shell: 'bash', zsh: 'bash', 'c++': 'cpp',
  html: 'xml', yml: 'yaml', tex: 'latex', md: 'markdown', golang: 'go',
};

// Nur über diese Menge raten — je kleiner der Kandidatenkreis, desto
// weniger Fehlgriffe bei kurzen Schnipseln.
const AUTO_LANGS = [
  'python', 'javascript', 'typescript', 'json', 'bash', 'cpp', 'java',
  'rust', 'go', 'sql', 'xml', 'css', 'yaml', 'r',
];

// Unterhalb dieser highlightAuto-Relevanz ist ein Treffer Rauschen —
// dann lieber neutraler Text als falsch eingefärbte Tokens.
const MIN_AUTO_RELEVANCE = 5;

// Anzeigenamen fürs Label; alles andere wird nur kapitalisiert.
const DISPLAY_NAMES: Record<string, string> = {
  cpp: 'C++', css: 'CSS', javascript: 'JavaScript', json: 'JSON',
  latex: 'LaTeX', sql: 'SQL', typescript: 'TypeScript', xml: 'HTML/XML',
  yaml: 'YAML', php: 'PHP', r: 'R',
};

export function displayName(lang: string): string {
  return DISPLAY_NAMES[lang] ?? lang.charAt(0).toUpperCase() + lang.slice(1);
}

export interface Highlighted {
  /** hljs-HTML (escaped) oder null, wenn unhighlighted gerendert wird. */
  html: string | null;
  /** Registrierter Sprachname fürs Label oder null (unbekannt). */
  language: string | null;
}

export function highlightCode(code: string, fenceLang?: string): Highlighted {
  const requested = fenceLang ? (ALIASES[fenceLang.toLowerCase()] ?? fenceLang.toLowerCase()) : null;
  if (requested && hljs.getLanguage(requested)) {
    return { html: hljs.highlight(code, { language: requested }).value, language: requested };
  }
  const auto = hljs.highlightAuto(code, AUTO_LANGS);
  if (auto.language && auto.relevance >= MIN_AUTO_RELEVANCE) {
    return { html: auto.value, language: auto.language };
  }
  return { html: null, language: requested };
}
