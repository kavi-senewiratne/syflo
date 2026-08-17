/**
 * transcript-highlights.js
 *
 * Colored marks inside a video's transcript
 * (design/mockup-transcript-selection.html, variant A, 2026-08-16).
 *
 * The third anchor in Syflo, and the only one that carries a TIME. A PDF mark
 * anchors to a page and its rectangles, a chat mark to a message and character
 * offsets; a transcript mark anchors to the video plus offsets into its
 * transcript text, and additionally stores the second of the block the passage
 * starts in. That second is read from the block, never picked by the reader
 * (user decision 2026-08-16) — it is what turns "scroll to the sentence" into
 * "and hear it".
 *
 * Endpoints (mounted at /api in server.js):
 *   GET    /api/videos/:videoId/transcript-highlights
 *   POST   /api/videos/:videoId/transcript-highlights
 *   PATCH  /api/transcript-highlights/:thid
 *   DELETE /api/transcript-highlights/:thid
 */

const express = require('express');
const { randomUUID } = require('crypto');

const ALLOWED_COLORS = new Set(['yellow', 'green', 'blue', 'pink', 'orange']);
// Which text a mark's offsets point into. 'chapter' marks live in the Video
// overview the chapter list is rendered from, 'transcript' marks in the raw
// transcript — same table, because both belong to the same video and behave
// identically everywhere else.
const ALLOWED_SOURCES = new Set(['transcript', 'chapter']);

function rowToHighlight(row) {
  return {
    id: row.id,
    videoId: row.video_id,
    childChatId: row.child_chat_id,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    text: row.text,
    startSeconds: row.start_seconds,
    source: row.source,
    color: row.color,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const loadHighlight = (db, thid) =>
  db.prepare('SELECT * FROM transcript_highlights WHERE id = ?').get(thid);

module.exports = (db) => {
  const router = express.Router();

  // Every mark on one video. One request per opened tree is enough — marks
  // per video stay small, no pagination.
  router.get('/videos/:videoId/transcript-highlights', (req, res) => {
    const rows = db
      .prepare('SELECT * FROM transcript_highlights WHERE video_id = ? ORDER BY start_offset ASC')
      .all(req.params.videoId);
    res.json(rows.map(rowToHighlight));
  });

  router.post('/videos/:videoId/transcript-highlights', (req, res) => {
    const { videoId } = req.params;
    const { color, text, startOffset, endOffset, startSeconds, childChatId, source } = req.body || {};

    if (!ALLOWED_COLORS.has(color)) {
      return res
        .status(400)
        .json({ error: `color must be one of ${[...ALLOWED_COLORS].join(', ')}` });
    }
    if (typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ error: 'text is required and must be non-empty' });
    }
    if (!Number.isInteger(startOffset) || startOffset < 0) {
      return res.status(400).json({ error: 'startOffset must be a non-negative integer' });
    }
    if (!Number.isInteger(endOffset) || endOffset <= startOffset) {
      return res.status(400).json({ error: 'endOffset must be an integer greater than startOffset' });
    }
    // A transcript without minute marks is rare but legal — then the mark
    // simply has no moment to jump to, and the way back stops at the text.
    if (startSeconds !== null && startSeconds !== undefined && !Number.isInteger(startSeconds)) {
      return res.status(400).json({ error: 'startSeconds must be an integer or null' });
    }

    if (source !== undefined && !ALLOWED_SOURCES.has(source)) {
      return res
        .status(400)
        .json({ error: `source must be one of ${[...ALLOWED_SOURCES].join(', ')}` });
    }

    const video = db.prepare('SELECT id FROM videos WHERE id = ?').get(videoId);
    if (!video) return res.status(404).json({ error: 'video not found' });

    if (childChatId) {
      const chat = db.prepare('SELECT id FROM chats WHERE id = ?').get(childChatId);
      if (!chat) return res.status(404).json({ error: 'chat not found' });
    }

    const thid = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO transcript_highlights
         (id, video_id, start_offset, end_offset, text, start_seconds, source, color, child_chat_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      thid, videoId, startOffset, endOffset, text,
      Number.isInteger(startSeconds) ? startSeconds : null,
      source || 'transcript',
      color, childChatId || null, now, now,
    );

    res.status(201).json(rowToHighlight(loadHighlight(db, thid)));
  });

  // PATCH: recolor, or (un)link the branch opened from the passage. Offsets
  // and text are WHERE the mark is — moving it means delete + re-create, the
  // same contract the PDF and chat marks follow.
  router.patch('/transcript-highlights/:thid', (req, res) => {
    const { thid } = req.params;
    const existing = loadHighlight(db, thid);
    if (!existing) return res.status(404).json({ error: 'highlight not found' });

    const { color, childChatId } = req.body || {};
    if (color !== undefined && !ALLOWED_COLORS.has(color)) {
      return res
        .status(400)
        .json({ error: `color must be one of ${[...ALLOWED_COLORS].join(', ')}` });
    }
    if (childChatId) {
      const chat = db.prepare('SELECT id FROM chats WHERE id = ?').get(childChatId);
      if (!chat) return res.status(404).json({ error: 'chat not found' });
    }

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE transcript_highlights
          SET color = ?, child_chat_id = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      color ?? existing.color,
      childChatId === undefined ? existing.child_chat_id : (childChatId || null),
      now,
      thid,
    );

    res.json(rowToHighlight(loadHighlight(db, thid)));
  });

  router.delete('/transcript-highlights/:thid', (req, res) => {
    const info = db.prepare('DELETE FROM transcript_highlights WHERE id = ?').run(req.params.thid);
    if (info.changes === 0) return res.status(404).json({ error: 'highlight not found' });
    res.status(204).end();
  });

  return router;
};
