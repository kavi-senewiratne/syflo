/**
 * html-highlights.js
 *
 * Colored marks inside an HTML source — the fourth highlight kind (ADR-0013
 * decision 5). The anchor is a QUOTE anchor { exact, prefix, suffix }: the
 * text plus surrounding context, re-found by the in-page bridge on open
 * (offsets would drift once MathJax typesets or a quiz reveals text). The
 * backend only stores and returns it. `section` is the heading the passage
 * sits in. The linked chat is a menu item, never the click (`chatId` is data).
 *
 * Endpoints (mounted at /api/html-highlights in server.js):
 *   GET    /api/html-highlights?html_source_id=
 *   POST   /api/html-highlights
 *   PATCH  /api/html-highlights/:id
 *   DELETE /api/html-highlights/:id
 */

const express = require('express');
const { randomUUID } = require('crypto');

const ALLOWED_COLORS = new Set(['yellow', 'green', 'blue', 'pink', 'orange']);
const COLOR_ERROR = `color must be one of ${[...ALLOWED_COLORS].join(', ')}`;

function parseAnchor(json) {
  try {
    return JSON.parse(json);
  } catch (_err) {
    return null;
  }
}

function rowToHighlight(row) {
  return {
    id: row.id,
    htmlSourceId: row.html_source_id,
    chatId: row.chat_id,
    color: row.color,
    anchor: parseAnchor(row.anchor_json),
    section: row.section,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const isValidAnchor = (a) =>
  a !== null &&
  typeof a === 'object' &&
  typeof a.exact === 'string' && a.exact.trim().length > 0 &&
  typeof a.prefix === 'string' &&
  typeof a.suffix === 'string';

const loadHighlight = (db, id) =>
  db.prepare('SELECT * FROM html_highlights WHERE id = ?').get(id);

module.exports = (db) => {
  const router = express.Router();

  router.get('/', (req, res) => {
    const sourceId = req.query.html_source_id;
    if (typeof sourceId !== 'string' || !sourceId) {
      return res.status(400).json({ error: 'html_source_id is required' });
    }
    const rows = db
      .prepare('SELECT * FROM html_highlights WHERE html_source_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(sourceId);
    res.json(rows.map(rowToHighlight));
  });

  router.post('/', (req, res) => {
    const { htmlSourceId, color, anchor, section, chatId } = req.body || {};

    if (!ALLOWED_COLORS.has(color)) return res.status(400).json({ error: COLOR_ERROR });
    if (!isValidAnchor(anchor)) {
      return res
        .status(400)
        .json({ error: 'anchor must have a non-empty exact string and prefix/suffix strings' });
    }
    if (section !== undefined && section !== null && typeof section !== 'string') {
      return res.status(400).json({ error: 'section must be a string or null' });
    }

    const source = db.prepare('SELECT id FROM html_sources WHERE id = ?').get(htmlSourceId);
    if (!source) return res.status(404).json({ error: 'html source not found' });

    if (chatId) {
      const chat = db.prepare('SELECT id FROM chats WHERE id = ?').get(chatId);
      if (!chat) return res.status(404).json({ error: 'chat not found' });
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    // Store only the three known anchor fields — nothing else rides along.
    const stored = { exact: anchor.exact, prefix: anchor.prefix, suffix: anchor.suffix };
    db.prepare(
      `INSERT INTO html_highlights
         (id, html_source_id, chat_id, color, anchor_json, section, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, htmlSourceId, chatId || null, color, JSON.stringify(stored), section ?? null, now, now);

    res.status(201).json(rowToHighlight(loadHighlight(db, id)));
  });

  // PATCH: recolor, or (un)link the chat opened from the passage. The anchor
  // is WHERE the mark is — moving it means delete + re-create.
  router.patch('/:id', (req, res) => {
    const existing = loadHighlight(db, req.params.id);
    if (!existing) return res.status(404).json({ error: 'highlight not found' });

    const { color, chatId } = req.body || {};
    if (color !== undefined && !ALLOWED_COLORS.has(color)) {
      return res.status(400).json({ error: COLOR_ERROR });
    }
    if (chatId) {
      const chat = db.prepare('SELECT id FROM chats WHERE id = ?').get(chatId);
      if (!chat) return res.status(404).json({ error: 'chat not found' });
    }

    db.prepare('UPDATE html_highlights SET color = ?, chat_id = ?, updated_at = ? WHERE id = ?').run(
      color ?? existing.color,
      chatId === undefined ? existing.chat_id : chatId || null,
      new Date().toISOString(),
      existing.id,
    );
    res.json(rowToHighlight(loadHighlight(db, existing.id)));
  });

  router.delete('/:id', (req, res) => {
    const info = db.prepare('DELETE FROM html_highlights WHERE id = ?').run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'highlight not found' });
    res.status(204).end();
  });

  return router;
};
