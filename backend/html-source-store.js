/**
 * html-source-store.js — the one pipeline that turns an HTML document into a
 * stored HTML source bound to a tree (ADR-0013). Shared by the file upload
 * (routes/html-sources.js) and the URL import (routes/html-sources-url.js).
 *
 * freeze (decision 7) -> write the snapshot -> extract sections -> insert row
 * -> bind to the tree root -> start chunking/embedding in the background.
 */
const fs = require('fs');
const path = require('path');
const { extractSections, formatSections } = require('./html-source');
const { prepareSourceInBackground } = require('./retrieval');
const { freezeResources } = require('./html-freeze');

function createHtmlSourceStore(db, uploadsDir, options = {}) {
  const htmlDir = path.join(uploadsDir, 'html-sources');
  fs.mkdirSync(htmlDir, { recursive: true });

  // options.fetchFn / options.lookupFn: injectable so tests never hit the network.
  const freezeOptions = {};
  if (options.fetchFn) freezeOptions.fetchFn = options.fetchFn;
  if (options.lookupFn) freezeOptions.lookupFn = options.lookupFn;

  const getChat = db.prepare('SELECT * FROM chats WHERE id = ?');
  const insertSource = db.prepare(`
    INSERT INTO html_sources (id, title, html_path, extracted_text, sections_json, unfrozen_json, uploaded_at, source_url)
    VALUES (@id, @title, @html_path, @extracted_text, @sections_json, @unfrozen_json, @uploaded_at, @source_url)
  `);
  const bindToChat = db.prepare('UPDATE chats SET html_source_id = ?, title = ? WHERE id = ?');

  function resolveRoot(chatId) {
    let chat = getChat.get(chatId);
    while (chat && chat.parent_id) chat = getChat.get(chat.parent_id);
    return chat || null;
  }

  function format(row) {
    const out = {
      id: row.id,
      title: row.title,
      uploaded_at: row.uploaded_at,
      sections: JSON.parse(row.sections_json).map(({ level, heading }) => ({ level, heading })),
      unfrozen: row.unfrozen_json ? JSON.parse(row.unfrozen_json) : [],
    };
    if (row.source_url) out.source_url = row.source_url;
    return out;
  }

  // `htmlPath` is where the snapshot is written (the upload already sits there).
  async function storeSource({ id, htmlPath, html, root, fallbackTitle, baseUrl, sourceUrl = null }) {
    const { html: frozen, unfrozen } = await freezeResources(html, baseUrl ? { ...freezeOptions, baseUrl } : freezeOptions);
    fs.writeFileSync(htmlPath, frozen);
    const { title, text, sections } = await extractSections(frozen);
    const row = {
      id,
      title: title || fallbackTitle,
      html_path: htmlPath,
      extracted_text: text,
      sections_json: JSON.stringify(sections),
      unfrozen_json: JSON.stringify(unfrozen),
      uploaded_at: new Date().toISOString(),
      source_url: sourceUrl,
    };
    insertSource.run(row);
    bindToChat.run(row.id, row.title, root.id);
    // Long sources are chunked and embedded now, so the first question does not wait.
    prepareSourceInBackground(db, {
      sourceType: 'html', sourceId: row.id, embedFn: options.embedTextsFn,
      loadText: async () => formatSections(sections),
    });
    return row;
  }

  return { htmlDir, freezeOptions, resolveRoot, format, storeSource };
}

module.exports = { createHtmlSourceStore };
