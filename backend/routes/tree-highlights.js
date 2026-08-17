/**
 * tree-highlights.js
 *
 * Read-only aggregation for the highlights drawer (design/
 * mockup-highlights-overview.html, Variant A): every highlight of a whole
 * chat tree — the tree paper's PDF highlights, the message highlights of
 * every chat in the tree, and (since 2026-08-16) the marks in the tree's
 * VIDEO: its transcript and its chapters — as one unified list.
 *
 * Accepts ANY chat id of the tree and resolves the root itself, so the
 * frontend can call it with whatever chat is active.
 *
 * Endpoint (mounted at /api in server.js):
 *   GET /api/chats/:chatId/tree-highlights
 */

const express = require('express');

function pdfRowToItem(row) {
  let rects = [];
  if (row.bbox_json) {
    try {
      const parsed = JSON.parse(row.bbox_json);
      if (Array.isArray(parsed)) rects = parsed;
      else if (parsed && Array.isArray(parsed.rects)) rects = parsed.rects;
    } catch (_err) {
      rects = [];
    }
  }
  return {
    kind: 'pdf',
    id: row.id,
    color: row.color,
    text: row.text || '',
    paperId: row.paper_id,
    pageNumber: row.page_number,
    rects,
    chatId: row.chat_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function chatRowToItem(row) {
  return {
    kind: 'chat',
    id: row.id,
    color: row.color,
    text: row.text,
    chatId: row.chat_id,
    chatTitle: row.chat_title,
    childChatId: row.child_chat_id,
    messageId: row.message_id,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// A mark in the tree's video. `kind` distinguishes the two texts it can sit
// in, because the drawer's jump goes to different places: the transcript view
// or the chapter list. startSeconds is what lets that jump land on the moment
// as well (user decision 2026-08-16).
function videoRowToItem(row) {
  return {
    kind: row.source === 'chapter' ? 'chapter' : 'transcript',
    id: row.id,
    color: row.color,
    text: row.text,
    videoId: row.video_id,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    startSeconds: row.start_seconds,
    childChatId: row.child_chat_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = (db) => {
  const router = express.Router();

  router.get('/chats/:chatId/tree-highlights', (req, res) => {
    const { chatId } = req.params;
    const chat = db.prepare('SELECT id FROM chats WHERE id = ?').get(chatId);
    if (!chat) return res.status(404).json({ error: 'chat not found' });

    // Walk UP to the root (the chat whose parent_id is NULL), then DOWN over
    // the whole subtree. Two small recursive CTEs instead of one clever one —
    // easier to read and each is bounded by the tree size.
    const root = db
      .prepare(
        `WITH RECURSIVE up(id, parent_id, paper_id, video_id) AS (
           SELECT id, parent_id, paper_id, video_id FROM chats WHERE id = ?
           UNION ALL
           SELECT c.id, c.parent_id, c.paper_id, c.video_id
             FROM chats c JOIN up ON c.id = up.parent_id
         )
         SELECT id, paper_id, video_id FROM up WHERE parent_id IS NULL`,
      )
      .get(chatId);

    const pdfItems = root.paper_id
      ? db
          .prepare(
            `SELECT h.id, h.color, h.chat_id, h.created_at, h.updated_at,
                    tr.paper_id, tr.text, tr.page_number, tr.bbox_json
               FROM highlights h
               JOIN text_ranges tr ON tr.id = h.text_range_id
              WHERE tr.paper_id = ?
              ORDER BY tr.page_number ASC, h.created_at ASC`,
          )
          .all(root.paper_id)
          .map(pdfRowToItem)
      : [];

    const chatItems = db
      .prepare(
        `WITH RECURSIVE tree(id, sort_path) AS (
           SELECT id, '' FROM chats WHERE id = ?
           UNION ALL
           -- Pre-order depth-first: a child's path string starts with its
           -- parent's, ISO timestamps have fixed length → lexicographic
           -- sorting = tree order (siblings by created_at).
           SELECT c.id, tree.sort_path || c.created_at || '/' || c.id
             FROM chats c JOIN tree ON c.parent_id = tree.id
         )
         SELECT mh.id, mh.color, mh.text, mh.start_offset, mh.end_offset,
                mh.child_chat_id, mh.created_at, mh.updated_at,
                m.id AS message_id, m.chat_id, c.title AS chat_title
           FROM message_highlights mh
           JOIN messages m ON m.id = mh.message_id
           JOIN chats c ON c.id = m.chat_id
           JOIN tree t ON t.id = m.chat_id
          ORDER BY t.sort_path ASC, m.created_at ASC, mh.start_offset ASC`,
      )
      .all(root.id)
      .map(chatRowToItem);

    // The video's marks, in reading order of the text they sit in.
    const videoItems = root.video_id
      ? db
          .prepare(
            `SELECT id, color, text, video_id, start_offset, end_offset,
                    start_seconds, source, child_chat_id, created_at, updated_at
               FROM transcript_highlights
              WHERE video_id = ?
              ORDER BY start_offset ASC, created_at ASC`,
          )
          .all(root.video_id)
          .map(videoRowToItem)
      : [];

    res.json([...pdfItems, ...videoItems, ...chatItems]);
  });

  return router;
};
