/**
 * message-highlights.js
 *
 * Persistent colored text highlights inside chat messages. UI intent:
 * design/mockup-chat-highlights-ask-in-chat.html — same five fixed colors
 * and global labels as the PDF highlights (routes/highlights.js), but a
 * different anchor: message_id + character offsets into the message's
 * rendered plain text (the bubble's textContent), so highlights survive
 * reflow and re-rendering. No geometry is stored.
 *
 * Endpoints (mounted at /api in server.js):
 *   GET    /api/chats/:chatId/message-highlights
 *   POST   /api/chats/:chatId/message-highlights
 *   PATCH  /api/message-highlights/:mhid
 *   DELETE /api/message-highlights/:mhid
 */

const express = require('express');
const { randomUUID } = require('crypto');

const ALLOWED_COLORS = new Set(['yellow', 'green', 'blue', 'pink', 'orange']);

function rowToHighlight(row) {
  return {
    id: row.id,
    messageId: row.message_id,
    chatId: row.chat_id,
    childChatId: row.child_chat_id,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    text: row.text,
    color: row.color,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function loadHighlight(db, mhid) {
  return db
    .prepare(
      `SELECT mh.id, mh.message_id, mh.start_offset, mh.end_offset, mh.text,
              mh.color, mh.child_chat_id, mh.created_at, mh.updated_at, m.chat_id
         FROM message_highlights mh
         JOIN messages m ON m.id = mh.message_id
        WHERE mh.id = ?`,
    )
    .get(mhid);
}

module.exports = (db) => {
  const router = express.Router();

  // List every highlight on any message of a chat. One request per opened
  // chat is enough — highlights per chat stay small, no pagination.
  router.get('/chats/:chatId/message-highlights', (req, res) => {
    const { chatId } = req.params;
    const chat = db.prepare('SELECT id FROM chats WHERE id = ?').get(chatId);
    if (!chat) return res.status(404).json({ error: 'chat not found' });
    const rows = db
      .prepare(
        `SELECT mh.id, mh.message_id, mh.start_offset, mh.end_offset, mh.text,
                mh.color, mh.child_chat_id, mh.created_at, mh.updated_at, m.chat_id
           FROM message_highlights mh
           JOIN messages m ON m.id = mh.message_id
          WHERE m.chat_id = ?
          ORDER BY mh.created_at ASC`,
      )
      .all(chatId);
    res.json(rows.map(rowToHighlight));
  });

  // Create a highlight on one message of the chat. Overlapping highlights
  // are allowed for the same reason as on PDFs (yellow sentence, green key
  // word inside it).
  router.post('/chats/:chatId/message-highlights', (req, res) => {
    const { chatId } = req.params;
    const { messageId, color, text, startOffset, endOffset, childChatId } = req.body || {};

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

    const message = db
      .prepare('SELECT id, chat_id FROM messages WHERE id = ?')
      .get(messageId);
    if (!message) return res.status(404).json({ error: 'message not found' });
    if (message.chat_id !== chatId) {
      return res.status(400).json({ error: 'message does not belong to this chat' });
    }

    // If a child chat is linked, verify it exists. Otherwise the FK throws.
    if (childChatId) {
      const chat = db.prepare('SELECT id FROM chats WHERE id = ?').get(childChatId);
      if (!chat) return res.status(404).json({ error: 'chat not found' });
    }

    const mhid = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO message_highlights
         (id, message_id, start_offset, end_offset, text, color, child_chat_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(mhid, messageId, startOffset, endOffset, text, color, childChatId || null, now, now);

    res.status(201).json(rowToHighlight(loadHighlight(db, mhid)));
  });

  // PATCH: change color or (un)link a child chat. Offsets and text are
  // "where the highlight is" — moving it means delete + re-create, same
  // policy as PDF highlights.
  router.patch('/message-highlights/:mhid', (req, res) => {
    const { mhid } = req.params;
    const { color, childChatId } = req.body || {};
    const existing = loadHighlight(db, mhid);
    if (!existing) return res.status(404).json({ error: 'highlight not found' });

    if (color !== undefined && !ALLOWED_COLORS.has(color)) {
      return res
        .status(400)
        .json({ error: `color must be one of ${[...ALLOWED_COLORS].join(', ')}` });
    }
    // childChatId === null is meaningful (unlink), so we distinguish
    // "absent" from "explicit null". When present and not null, verify the
    // chat exists.
    if (childChatId !== undefined && childChatId !== null) {
      const chat = db.prepare('SELECT id FROM chats WHERE id = ?').get(childChatId);
      if (!chat) return res.status(404).json({ error: 'chat not found' });
    }

    const now = new Date().toISOString();
    const fields = [];
    const values = [];
    if (color !== undefined) {
      fields.push('color = ?');
      values.push(color);
    }
    if (childChatId !== undefined) {
      fields.push('child_chat_id = ?');
      values.push(childChatId);
    }
    if (fields.length === 0) {
      return res.status(400).json({ error: 'no editable fields provided' });
    }
    fields.push('updated_at = ?');
    values.push(now);
    values.push(mhid);

    db.prepare(`UPDATE message_highlights SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    res.json(rowToHighlight(loadHighlight(db, mhid)));
  });

  router.delete('/message-highlights/:mhid', (req, res) => {
    const { mhid } = req.params;
    const row = db.prepare('SELECT id FROM message_highlights WHERE id = ?').get(mhid);
    if (!row) return res.status(404).json({ error: 'highlight not found' });
    db.prepare('DELETE FROM message_highlights WHERE id = ?').run(mhid);
    res.status(204).end();
  });

  return router;
};
