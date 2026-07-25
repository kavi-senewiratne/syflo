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
    // Sidebar zeigt neueste Bäume oben (2026-07-24). Nur die Roots drehen —
    // die children bleiben aufsteigend (ORDER BY oben), sie speisen die
    // Baumlinien in Erstellungs-Reihenfolge. String-Vergleich reicht:
    // created_at ist "YYYY-MM-DD HH:MM:SS" und sortiert lexikografisch.
    roots.sort((a, b) => b.created_at.localeCompare(a.created_at));
    res.json(roots);
  });

  // Vorfahren-Kette eines Chats (Wurzel → … → direkter Elternchat) mit den
  // gecachten Summaries — die Read-only-Sicht des UIs auf den geerbten
  // Kontext (ParentContextPane). Liest nur den Cache, erzeugt nichts.
  router.get('/:id/ancestors', (req, res) => {
    const chat = db.prepare('SELECT id FROM chats WHERE id = ?').get(req.params.id);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });

    const ancestors = getAncestorPath(db, req.params.id).map((a) => {
      // summary_display: JSON {gist, points[]} für das Kontext-Banner —
      // defensiv geparst, kaputte/fehlende Einträge werden zu null
      // (das UI fällt dann auf den gerenderten Summary-Volltext zurück).
      let display = null;
      if (a.summary_display) {
        try {
          display = JSON.parse(a.summary_display);
        } catch (_) { /* alte/kaputte Zeile — Volltext-Fallback */ }
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
    const { title, parent_id, parent_word } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      'INSERT INTO chats (id, title, parent_id, parent_word, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, title, parent_id || null, parent_word || null, now);

    // Warm-up (Design 2026-07-20): Die Abzweigung ist das früheste Signal,
    // dass die Vorfahren-Summaries gleich gebraucht werden. Fire-and-forget —
    // die Antwort wartet nicht, Fehler fängt der Lazy-Pfad beim Senden ab.
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
    // Highlights überleben ihren Branch (Issue 06): nur entkoppeln, nie
    // löschen. Explizit statt per FK, weil foreign_keys hier nicht global
    // aktiviert sind — das Schema-SET-NULL allein würde nichts tun.
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
