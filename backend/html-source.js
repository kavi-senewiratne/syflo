/**
 * html-source.js — turns an uploaded HTML file into what the chat may read
 * (ADR-0013, decision 6): the VISIBLE text in reading order, no scripts, no
 * styles, no JSON payloads.
 *
 * parse5 is ESM-only, so it is imported lazily (same reason as pdfjs.js).
 */

// Elements whose content never reaches the reader.
const HIDDEN = new Set(['script', 'style', 'noscript', 'template', 'head', 'svg', 'canvas']);
// Elements that start and end a line of text; everything else flows inline.
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul',
]);

let parse5Promise;
function loadParse5() {
  if (!parse5Promise) parse5Promise = import('parse5');
  return parse5Promise;
}

const HEADING_LEVEL = { h1: 1, h2: 2, h3: 3 };

// Walk the tree once, producing lines: a block boundary closes the current
// line, and a line closed by an h1–h3 is marked with that heading level.
function collectLines(node, lines, state) {
  if (node.nodeName === '#text') {
    state.current += node.value;
    return;
  }
  const tag = node.tagName;
  if (tag && HIDDEN.has(tag)) return;
  const isBlock = tag && BLOCK.has(tag);
  if (isBlock) flushLine(lines, state);
  for (const child of node.childNodes || []) collectLines(child, lines, state);
  if (isBlock) flushLine(lines, state, HEADING_LEVEL[tag]);
}

function findTitle(node) {
  if (node.tagName === 'title') return (node.childNodes || []).map((c) => c.value || '').join('').replace(/\s+/g, ' ').trim();
  for (const child of node.childNodes || []) {
    const found = findTitle(child);
    if (found) return found;
  }
  return '';
}

function flushLine(lines, state, level) {
  const text = state.current.replace(/\s+/g, ' ').trim();
  if (text) lines.push({ text, level });
  state.current = '';
}

// Group the lines under the heading that precedes them.
function toSections(lines) {
  const sections = [];
  for (const { text, level } of lines) {
    if (level) sections.push({ level, heading: text, lines: [] });
    else if (sections.length) sections[sections.length - 1].lines.push(text);
  }
  return sections.map((s) => ({ level: s.level, heading: s.heading, text: s.lines.join('\n') }));
}

async function extractSections(html) {
  const { parse } = await loadParse5();
  const document = parse(html);
  const lines = [];
  const state = { current: '' };
  collectLines(document, lines, state);
  flushLine(lines, state);
  return { title: findTitle(document), text: lines.map((l) => l.text).join('\n'), sections: toSections(lines) };
}

// What the chat reads: one `## heading` block per section, the section's
// lines as separate paragraphs (so the chunker can cut between them).
function formatSections(sections) {
  return sections
    .map((s) => [`## ${s.heading}`, ...s.text.split('\n').filter(Boolean)].join('\n\n'))
    .join('\n\n');
}

const SKELETON_SECTION_CHARS = 2500;

// Retrieval-mode stand-in (ADR-0006): title, section outline, first and last
// section (capped). Byte-stable per source so the KV-cache prefix survives.
function buildHtmlSkeleton(title, sections) {
  const cap = (s) => (s.length > SKELETON_SECTION_CHARS ? `${s.slice(0, SKELETON_SECTION_CHARS)}...` : s);
  const parts = [`[Title]\n${title}`];
  if (sections.length > 0) {
    parts.push(
      `[Section outline]\n${sections.slice(0, 80).map((s) => `${'  '.repeat(Math.max(0, s.level - 1))}- ${s.heading}`).join('\n')}`
    );
    parts.push(`[First section]\n${cap(formatSections([sections[0]]))}`);
    if (sections.length > 1) {
      parts.push(`[Last section]\n${cap(formatSections([sections[sections.length - 1]]))}`);
    }
  }
  return parts.join('\n\n');
}

/**
 * The HTML source bound to the chat's tree (the ROOT chat carries
 * html_source_id) — same contract as getTreeVideoContext. Returns
 * { htmlSourceId, title, text, skeleton } or null.
 */
function getTreeHtmlContext(db, chatId) {
  const getChat = db.prepare('SELECT id, parent_id, html_source_id FROM chats WHERE id = ?');
  let chat = getChat.get(chatId);
  while (chat && chat.parent_id) chat = getChat.get(chat.parent_id);
  if (!chat || !chat.html_source_id) return null;
  const row = db
    .prepare('SELECT title, sections_json FROM html_sources WHERE id = ?')
    .get(chat.html_source_id);
  if (!row) return null;
  const sections = JSON.parse(row.sections_json);
  if (sections.length === 0) return null;
  return {
    htmlSourceId: chat.html_source_id,
    title: row.title,
    text: formatSections(sections),
    skeleton: buildHtmlSkeleton(row.title, sections),
  };
}

module.exports = { extractSections, getTreeHtmlContext, formatSections };
