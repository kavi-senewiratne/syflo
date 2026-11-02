/**
 * routes/html-sources-url.js — URL import of an HTML source (ADR-0013,
 * "Web pages"). POST /api/html-sources/from-url {chat_id, url} fetches (or
 * renders) the page and then runs the same pipeline as an upload.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { extractSections } = require('../html-source');
const { createHtmlSourceStore } = require('../html-source-store');
const { createUrlImporter, UrlImportError } = require('../url-import');

const MIN_TEXT_CHARS = 200;

// Good enough for a snapshot: the source lives on its own origin either way.
function stripScripts(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
}

module.exports = (db, uploadsDir, options = {}) => {
  const router = express.Router();
  const store = createHtmlSourceStore(db, uploadsDir, options);
  const fetchPage = createUrlImporter(options.urlImport);

  router.post('/from-url', async (req, res, next) => {
    let htmlPath;
    try {
      const chatId = (req.body.chat_id || '').toString();
      if (!chatId) return res.status(400).json({ error: 'chat_id is required' });
      const root = store.resolveRoot(chatId);
      if (!root) return res.status(404).json({ error: 'Chat not found' });
      if (root.paper_id || root.video_id || root.html_source_id) {
        return res.status(409).json({ error: 'tree-has-source', root_chat_id: root.id });
      }

      const page = await fetchPage(req.body.url);
      const { finalUrl } = page;
      // A rendered page is a snapshot of an already built DOM: its scripts would
      // run again inside the source iframe and build the page a second time.
      const html = page.rendered ? stripScripts(page.html) : page.html;
      const { text } = await extractSections(html);
      if (text.replace(/\s+/g, ' ').trim().length < MIN_TEXT_CHARS) {
        return res.status(422).json({ error: 'no-readable-text' });
      }

      const id = randomUUID();
      htmlPath = path.join(store.htmlDir, `${id}.html`);
      const row = await store.storeSource({
        id, htmlPath, html, root, baseUrl: finalUrl, sourceUrl: finalUrl, fallbackTitle: new URL(finalUrl).hostname,
      });
      return res.status(201).json(store.format(row));
    } catch (err) {
      if (htmlPath) { try { fs.unlinkSync(htmlPath); } catch (_) { /* never written */ } }
      if (err instanceof UrlImportError) return res.status(err.status).json({ error: err.error });
      return next(err);
    }
  });

  return router;
};
