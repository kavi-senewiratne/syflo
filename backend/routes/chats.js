const express = require('express');
const fs = require('fs');
const { warmUpAncestorSummaries, getAncestorPath } = require('../ancestor-context');

module.exports = (db) => {
  const router = express.Router();
  // Get all root chats (no parent)
  router.get('/', (req, res) => {
    const chats = db.prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM chats child WHERE child.parent_id = c.id) as child_count
      FROM chats c
      ORDER BY c.created_at DESC
    `).all();
    res.json(chats);
  });

  // Get full chat tree.
  // Each node carries a `preview` (first user message, truncated) and
  // `message_count` so the mindmap can show what each chat is actually about
  // instead of just titles.
  router.get('/tree', (req, res) => {
    const all = db.prepare(`
      SELECT c.*,
        (SELECT m.content
           FROM messages m
          WHERE m.chat_id = c.id AND m.role = 'user'
          ORDER BY m.created_at ASC
          LIMIT 1) AS preview,
        (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS message_count
      FROM chats c
      ORDER BY c.created_at ASC
    `).all();

    const PREVIEW_LIMIT = 140;
    const map = {};
    all.forEach(c => {
      // For branched chats the parent_word badge in the mindmap already says
      // what the chat is about. The user's first message in a branched chat
      // is often a vague follow-up ("go on", "more details", "it means to
      // come") that adds noise rather than context — so we skip the preview
      // and let the badge + title speak for themselves.
      const showPreview = !c.parent_id;
      const preview = showPreview && c.preview
        ? (c.preview.length > PREVIEW_LIMIT
            ? c.preview.slice(0, PREVIEW_LIMIT).trimEnd() + '…'
            : c.preview)
        : null;
      map[c.id] = { ...c, preview, children: [] };
    });
    const roots = [];
    all.forEach(c => {
      if (c.parent_id && map[c.parent_id]) {
        map[c.parent_id].children.push(map[c.id]);
      } else {
        roots.push(map[c.id]);
      }
    });
    // Sidebar shows newest trees at the top (2026-07-24). Only the roots are
    // reversed — the children stay ascending (ORDER BY above), they feed the
    // tree lines in creation order. String comparison is enough:
    // created_at is "YYYY-MM-DD HH:MM:SS" and sorts lexicographically.
    roots.sort((a, b) => b.created_at.localeCompare(a.created_at));
    res.json(roots);
  });

  // Ancestor chain of a chat (root → … → direct parent chat) with the
  // cached summaries — the UI's read-only view of the inherited context
  // (ParentContextPane). Only reads the cache, generates nothing.
  router.get('/:id/ancestors', (req, res) => {
    const chat = db.prepare('SELECT id FROM chats WHERE id = ?').get(req.params.id);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });

    const ancestors = getAncestorPath(db, req.params.id).map((a) => {
      // summary_display: JSON {gist, points[]} for the context banner —
      // parsed defensively, broken/missing entries become null
      // (the UI then falls back to the rendered full summary text).
      let display = null;
      if (a.summary_display) {
        try {
          display = JSON.parse(a.summary_display);
        } catch (_) { /* old/broken row — full-text fallback */ }
      }
      return {
        id: a.id,
        title: a.title,
        parent_word: a.parent_word,
        summary: a.summary || null,
        display,
      };
    });
    res.json(ancestors);
  });

  // Get single chat with messages (and attachments per message)
  router.get('/:id', (req, res) => {
    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });

    const messages = db.prepare(
      'SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC'
    ).all(req.params.id);

    const attachmentsByMsg = db.prepare(
      `SELECT id, message_id, alias, filename, mimetype, size
       FROM attachments WHERE chat_id = ? ORDER BY created_at ASC`
    ).all(req.params.id).reduce((acc, a) => {
      (acc[a.message_id] ||= []).push({
        id: a.id, alias: a.alias, filename: a.filename, mimetype: a.mimetype, size: a.size,
        url: `/uploads/${req.params.id}/${a.id}-${a.filename}`,
      });
      return acc;
    }, {});

    const messagesWithAttachments = messages.map(m => ({
      ...m,
      attachments: attachmentsByMsg[m.id] || [],
    }));

    const children = db.prepare(
      'SELECT * FROM chats WHERE parent_id = ? ORDER BY created_at ASC'
    ).all(req.params.id);

    res.json({ ...chat, messages: messagesWithAttachments, children });
  });

  // Create new chat
  router.post('/', (req, res) => {
    const { title, parent_id, parent_word, parent_context } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // parent_context only makes sense on a branch (PDF-selection surroundings,
    // capped defensively — the frontend already trims to 400 chars).
    const context = parent_word && typeof parent_context === 'string' && parent_context.trim()
      ? parent_context.trim().slice(0, 600)
      : null;

    db.prepare(
      'INSERT INTO chats (id, title, parent_id, parent_word, parent_context, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, title, parent_id || null, parent_word || null, context, now);

    // Warm-up (design 2026-07-20): The branch-off is the earliest signal
    // that the ancestor summaries will be needed shortly. Fire-and-forget —
    // the response doesn't wait; errors are caught by the lazy path on send.
    if (parent_id) {
      setImmediate(() => {
        warmUpAncestorSummaries(db, id).catch(() => {});
      });
    }

    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
    res.status(201).json(chat);
  });

  // Update chat title
  router.patch('/:id', (req, res) => {
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(title, req.params.id);
    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    res.json(chat);
  });

  // Delete a chat, all its branched children, all their messages, and any
  // uploaded attachment files. Order matters: attachments rows must go before
  // messages (FK), and messages before chats. We also unlink the actual files
  // on disk so the uploads/ dir doesn't grow with orphans.
  router.delete('/:id', (req, res) => {
    const collectAttachmentPaths = db.prepare('SELECT path FROM attachments WHERE chat_id = ?');
    const deleteAttachmentsForChat = db.prepare('DELETE FROM attachments WHERE chat_id = ?');
    const deleteMessagesForChat = db.prepare('DELETE FROM messages WHERE chat_id = ?');
    const deleteChat = db.prepare('DELETE FROM chats WHERE id = ?');
    const findChildren = db.prepare('SELECT id FROM chats WHERE parent_id = ?');
    // Highlights outlive their branch (Issue 06): only unlink, never
    // delete. Explicit instead of via FK, because foreign_keys are not
    // globally enabled here — the schema SET NULL alone would do nothing.
    const unlinkHighlightsForChat = db.prepare('UPDATE highlights SET chat_id = NULL WHERE chat_id = ?');

    const pathsToUnlink = [];
    const deleteRecursive = (id) => {
      findChildren.all(id).forEach(child => deleteRecursive(child.id));
      collectAttachmentPaths.all(id).forEach(row => pathsToUnlink.push(row.path));
      deleteAttachmentsForChat.run(id);
      deleteMessagesForChat.run(id);
      unlinkHighlightsForChat.run(id);
      deleteChat.run(id);
    };

    try {
      db.transaction(() => deleteRecursive(req.params.id))();
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }

    // Disk cleanup happens after the DB transaction commits. A unlink error
    // here is non-fatal — the rows are already gone, so it's just a leaked
    // file that the user can clean up manually.
    for (const p of pathsToUnlink) {
      fs.unlink(p, () => {});
    }

    res.json({ success: true });
  });

  return router;
};
