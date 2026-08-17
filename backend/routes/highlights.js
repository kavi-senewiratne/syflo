/**
 * highlights.js
 *
 * Persistent colored text highlights for papers, plus global rename-able
 * labels for each color. See design/mockup-paper-pdf-highlights-v2.html and
 * design/mockup-popup-edit-labels.html for the UI intent.
 *
 * Data model:
 *   text_ranges    — one row per selected span of text in a paper (page,
 *                    quote text, bounding rects in zoom=1 page-local coords).
 *   highlights     — one row per saved colored mark; references a text_range
 *                    and optionally a chat that was branched from it. The
 *                    chat link is ON DELETE SET NULL so highlights outlive
 *                    their chats (deleting a chat shouldn't wipe the user's
 *                    research marks on the paper).
 *   highlight_labels — one row per color (yellow/green/blue/pink/orange) with
 *                    a user-renamable display label. Defaults are seeded by
 *                    createDb(); PUTs persist user overrides.
 *
 * Endpoints are mounted at /api/ in server.js so paths look like:
 *   GET    /api/papers/:id/highlights
 *   POST   /api/papers/:id/highlights
 *   PATCH  /api/highlights/:hid
 *   DELETE /api/highlights/:hid
 *   GET    /api/highlight-labels
 *   PUT    /api/highlight-labels/:color
 */

const express = require('express');
const { randomUUID } = require('crypto');

const ALLOWED_COLORS = new Set(['yellow', 'green', 'blue', 'pink', 'orange']);
// The DEFAULT name of a color is UI copy, not data: it belongs to the App
// language and lives in frontend/src/strings.ts (user request 2026-08-06).
// This table therefore holds nothing but the user's own renames, and a color
// without a row is reported as null — the frontend fills it from strings.
const NO_OVERRIDE = { yellow: null, green: null, blue: null, pink: null, orange: null };
const MAX_LABEL_LEN = 24;

// Shape returned to the frontend. We join highlights with their text_range
// so callers don't have to fetch both — the UI never wants a highlight
// without its text/rects/page.
function rowToHighlight(row) {
  let rects = [];
  let prefix = null;
  let suffix = null;
  let quoteHash = null;
  if (row.bbox_json) {
    try {
      const parsed = JSON.parse(row.bbox_json);
      // Accept both legacy single-rect shape and the new multi-rect shape so
      // future migrations don't have to rewrite stored JSON.
      if (Array.isArray(parsed)) {
        rects = parsed;
      } else if (parsed && Array.isArray(parsed.rects)) {
        rects = parsed.rects;
        prefix = parsed.prefix ?? null;
        suffix = parsed.suffix ?? null;
        quoteHash = parsed.quoteHash ?? null;
      }
    } catch (_err) {
      // Corrupted bbox_json: return an empty rects array rather than 500.
      // The frontend treats no-rects highlights as "broken anchor — show in
      // sidebar but skip overlay".
      rects = [];
    }
  }
  return {
    id: row.id,
    paperId: row.paper_id,
    color: row.color,
    text: row.text || '',
    pageNumber: row.page_number,
    rects,
    prefix,
    suffix,
    quoteHash,
    chatId: row.chat_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function loadHighlight(db, hid) {
  return db
    .prepare(
      `SELECT h.id, h.color, h.chat_id, h.created_at, h.updated_at,
              tr.paper_id, tr.text, tr.page_number, tr.bbox_json
         FROM highlights h
         JOIN text_ranges tr ON tr.id = h.text_range_id
        WHERE h.id = ?`,
    )
    .get(hid);
}

module.exports = (db) => {
  const router = express.Router();

  // ─── Highlights ───────────────────────────────────────────────────────────

  // List every highlight on a paper. Ordered by created_at so the sidebar
  // shows newest-first when the parent component reverses it, or oldest-first
  // when it doesn't. We don't paginate — papers rarely accumulate hundreds of
  // highlights, and the JSON payload is small (rects + short quote per row).
  router.get('/papers/:paperId/highlights', (req, res) => {
    const { paperId } = req.params;
    const rows = db
      .prepare(
        `SELECT h.id, h.color, h.chat_id, h.created_at, h.updated_at,
                tr.paper_id, tr.text, tr.page_number, tr.bbox_json
           FROM highlights h
           JOIN text_ranges tr ON tr.id = h.text_range_id
          WHERE tr.paper_id = ?
          ORDER BY h.created_at ASC`,
      )
      .all(paperId);
    res.json(rows.map(rowToHighlight));
  });

  // Create a highlight. Always inserts a fresh text_range — we don't try to
  // dedupe overlapping selections because the user might genuinely want two
  // differently-colored highlights on overlapping text (e.g. yellow on a
  // sentence, green on a key word inside it).
  router.post('/papers/:paperId/highlights', (req, res) => {
    const { paperId } = req.params;
    const { color, text, pageNumber, rects, prefix, suffix, quoteHash, chatId } = req.body || {};

    // Validate required fields. We're explicit instead of "if-falsy" because
    // pageNumber=0 is a legitimate value for the first page in some viewers
    // (PDF.js is 1-based, so 0 is invalid — but the explicit isInteger check
    // says "wrong type" rather than letting it silently coerce).
    if (!ALLOWED_COLORS.has(color)) {
      return res
        .status(400)
        .json({ error: `color must be one of ${[...ALLOWED_COLORS].join(', ')}` });
    }
    if (typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ error: 'text is required and must be non-empty' });
    }
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      return res.status(400).json({ error: 'pageNumber must be a positive integer' });
    }
    if (!Array.isArray(rects) || rects.length === 0) {
      return res.status(400).json({ error: 'rects must be a non-empty array' });
    }

    // Verify the paper exists. Without this check the FK constraint would
    // throw a generic 500 — better to return a clear 404.
    const paper = db.prepare('SELECT id FROM papers WHERE id = ?').get(paperId);
    if (!paper) return res.status(404).json({ error: 'paper not found' });

    // If a chat is linked, verify it exists. Otherwise the FK throws.
    if (chatId) {
      const chat = db.prepare('SELECT id FROM chats WHERE id = ?').get(chatId);
      if (!chat) return res.status(404).json({ error: 'chat not found' });
    }

    const trId = randomUUID();
    const hid = randomUUID();
    const now = new Date().toISOString();
    const bboxJson = JSON.stringify({
      rects,
      prefix: typeof prefix === 'string' ? prefix : null,
      suffix: typeof suffix === 'string' ? suffix : null,
      quoteHash: typeof quoteHash === 'string' ? quoteHash : null,
    });

    const insertTr = db.prepare(
      'INSERT INTO text_ranges (id, paper_id, text, page_number, bbox_json) VALUES (?, ?, ?, ?, ?)',
    );
    const insertH = db.prepare(
      'INSERT INTO highlights (id, text_range_id, chat_id, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const tx = db.transaction(() => {
      insertTr.run(trId, paperId, text.trim(), pageNumber, bboxJson);
      insertH.run(hid, trId, chatId || null, color, now, now);
    });
    tx();

    res.status(201).json(rowToHighlight(loadHighlight(db, hid)));
  });

  // PATCH: change color or (un)link a chat. Anything else (text, page, rects)
  // is intentionally read-only — those represent "where the highlight is",
  // and changing them would mean making a new highlight rather than editing
  // the existing one. The UI delete + re-create flow handles that case.
  router.patch('/highlights/:hid', (req, res) => {
    const { hid } = req.params;
    const { color, chatId } = req.body || {};
    const existing = loadHighlight(db, hid);
    if (!existing) return res.status(404).json({ error: 'highlight not found' });

    if (color !== undefined && !ALLOWED_COLORS.has(color)) {
      return res
        .status(400)
        .json({ error: `color must be one of ${[...ALLOWED_COLORS].join(', ')}` });
    }
    // chatId === null is meaningful (unlink), so we distinguish "absent" from
    // "explicit null". When present and not null, verify the chat exists.
    if (chatId !== undefined && chatId !== null) {
      const chat = db.prepare('SELECT id FROM chats WHERE id = ?').get(chatId);
      if (!chat) return res.status(404).json({ error: 'chat not found' });
    }

    const now = new Date().toISOString();
    const fields = [];
    const values = [];
    if (color !== undefined) {
      fields.push('color = ?');
      values.push(color);
    }
    if (chatId !== undefined) {
      fields.push('chat_id = ?');
      values.push(chatId);
    }
    if (fields.length === 0) {
      return res.status(400).json({ error: 'no editable fields provided' });
    }
    fields.push('updated_at = ?');
    values.push(now);
    values.push(hid);

    db.prepare(`UPDATE highlights SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    res.json(rowToHighlight(loadHighlight(db, hid)));
  });

  // DELETE: removes the highlight AND its underlying text_range. The text
  // range exists only to anchor highlights/branches, and we don't share a
  // single text_range across multiple highlights — so cascading the delete
  // is safe and avoids orphan rows accumulating in text_ranges.
  router.delete('/highlights/:hid', (req, res) => {
    const { hid } = req.params;
    const row = db
      .prepare('SELECT text_range_id FROM highlights WHERE id = ?')
      .get(hid);
    if (!row) return res.status(404).json({ error: 'highlight not found' });
    // Deleting the text_range cascades to the highlight row via FK.
    db.prepare('DELETE FROM text_ranges WHERE id = ?').run(row.text_range_id);
    res.status(204).end();
  });

  // ─── Labels ───────────────────────────────────────────────────────────────

  // GET — all 5 colors, each carrying the user's own name or null. Never a
  // default: naming an unrenamed color here would freeze it into the language
  // that happened to be active when the row was written.
  router.get('/highlight-labels', (_req, res) => {
    const rows = db.prepare('SELECT color, label FROM highlight_labels').all();
    const out = { ...NO_OVERRIDE };
    for (const r of rows) {
      if (ALLOWED_COLORS.has(r.color) && String(r.label || '').trim()) out[r.color] = r.label;
    }
    res.json(out);
  });

  // PUT — rename one color. An empty string DROPS the override (the "Reset to
  // default" affordance in the inline editor), so the color goes back to
  // following the App language; the response says so with label: null. Length
  // capped at 24 chars so the popup row doesn't reflow into a multi-line mess.
  router.put('/highlight-labels/:color', (req, res) => {
    const { color } = req.params;
    if (!ALLOWED_COLORS.has(color)) {
      return res.status(400).json({ error: 'unknown color' });
    }
    const raw = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
    if (raw.length === 0) {
      db.prepare('DELETE FROM highlight_labels WHERE color = ?').run(color);
      return res.json({ color, label: null });
    }
    const label = raw.slice(0, MAX_LABEL_LEN);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO highlight_labels (color, label, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(color) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at`,
    ).run(color, label, now);
    res.json({ color, label });
  });

  return router;
};

module.exports.ALLOWED_COLORS = ALLOWED_COLORS;
