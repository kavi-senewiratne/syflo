/**
 * routes/html-sources.js — HTML as the third source kind (ADR-0013).
 *
 * POST /api/html-sources uploads a single .html file (multipart field "html")
 * and binds it to the tree of `chat_id`. The stored file is a snapshot copy;
 * the chat reads only its extracted visible text (html-source.js).
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { createHtmlSourceStore } = require('../html-source-store');
const { freezeResources } = require('../html-freeze');

const MAX_HTML_BYTES = 25 * 1024 * 1024;

// A cheap sniff on the first 64 KB: at least one well-known HTML tag.
function looksLikeHtml(text) {
  return /<\s*(!doctype\s+html|html|head|body|div|p|h[1-6]|section|article|main)\b/i.test(text.slice(0, 65536));
}

module.exports = (db, uploadsDir, options = {}) => {
  const router = express.Router();
  const htmlDir = path.join(uploadsDir, 'html-sources');
  fs.mkdirSync(htmlDir, { recursive: true });

  const upload = multer({
    storage: multer.diskStorage({
      destination: htmlDir,
      filename: (req, file, cb) => {
        const id = randomUUID();
        req._htmlSourceId = id;
        cb(null, `${id}.html`);
      },
    }),
    limits: { fileSize: MAX_HTML_BYTES },
  });

  const store = createHtmlSourceStore(db, uploadsDir, options);
  const { freezeOptions, resolveRoot, format } = store;

  router.post('/', upload.single('html'), async (req, res, next) => {
    const discard = () => {
      if (req.file) {
        try { fs.unlinkSync(req.file.path); } catch (_) { /* already gone */ }
      }
    };
    try {
      if (!req.file) return res.status(400).json({ error: 'No HTML uploaded (field name must be "html")' });
      const chatId = (req.body.chat_id || '').toString();
      if (!chatId) { discard(); return res.status(400).json({ error: 'chat_id is required' }); }
      const root = resolveRoot(chatId);
      if (!root) { discard(); return res.status(404).json({ error: 'Chat not found' }); }

      if (root.paper_id || root.video_id || root.html_source_id) {
        discard();
        return res.status(409).json({ error: 'tree-has-source', root_chat_id: root.id });
      }
      const original = fs.readFileSync(req.file.path, 'utf8');
      if (!looksLikeHtml(original)) {
        discard();
        return res.status(415).json({ error: 'Only HTML files are accepted' });
      }
      // Decision 7: embed network resources; failures never block the upload.
      const row = await store.storeSource({
        id: req._htmlSourceId,
        htmlPath: req.file.path,
        html: original,
        root,
        fallbackTitle: req.file.originalname.replace(/\.html?$/i, ''),
      });
      return res.status(201).json(format(row));
    } catch (err) {
      discard();
      return next(err);
    }
  });

  router.get('/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM html_sources WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'HTML source not found' });
    return res.json(format(row));
  });

  // "Try again": re-run the freezer over the STORED copy. Resources that are
  // already inlined are not resources any more, so only the missing ones are
  // fetched.
  router.post('/:id/freeze', async (req, res, next) => {
    try {
      const row = db.prepare('SELECT * FROM html_sources WHERE id = ?').get(req.params.id);
      if (!row) return res.status(404).json({ error: 'HTML source not found' });
      const { html, unfrozen: stillMissing } = await freezeResources(fs.readFileSync(row.html_path, 'utf8'), freezeOptions);
      fs.writeFileSync(row.html_path, html);
      // A blocked address was neutralized in the copy, so the freezer no longer
      // sees it — but it stays a resource that was NOT frozen.
      const blocked = JSON.parse(row.unfrozen_json || '[]').filter((u) => u.reason === 'blocked-local-address');
      const unfrozen = [...blocked, ...stillMissing.filter((u) => !blocked.some((b) => b.url === u.url && b.kind === u.kind))];
      const unfrozenJson = JSON.stringify(unfrozen);
      db.prepare('UPDATE html_sources SET unfrozen_json = ? WHERE id = ?').run(unfrozenJson, row.id);
      return res.json(format({ ...row, unfrozen_json: unfrozenJson }));
    } catch (err) {
      return next(err);
    }
  });

  return router;
};
