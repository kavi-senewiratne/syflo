const express = require('express');
const fs = require('fs');
const { warmUpAncestorSummaries, getAncestorPath } = require('../ancestor-context');
const { getSetting } = require('../llm');
const {
  MAX_PASSAGE_CHARS, sanitizeTitle, branchTitleInstruction, parseBranchTitleReply,
} = require('../title');
const { callCloudLadder } = require('../quota');

// options.isQuotaCoolingDown / markQuotaCooldown: the chat's quota memory
// (server.js injects it) — the passage-title endpoint shares that ladder.
// A passage title is a nicety, never a blocker: the whole ladder gets one
// budget, each single call a shorter one. The frontend gives up after
// ~2.5 s anyway and shows the tidied passage instead.
const TITLE_BUDGET_MS = 9000;
const TITLE_CALL_MS = 5000;

module.exports = (db, { isQuotaCoolingDown, markQuotaCooldown } = {}) => {
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
        (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS message_count,
        -- Answers that actually said something: the '*Failed*'/'*Interrupted*'
        -- markers are UI state, not content (same exclusion as
        -- ancestor-context.js). The mindmap's "Ergebnis folgt …" placeholder
        -- hangs off this — a branch whose only answer failed established
        -- nothing, so promising an outcome there is a lie (2026-08-03).
        (SELECT COUNT(*) FROM messages m
          WHERE m.chat_id = c.id AND m.role = 'assistant'
            AND TRIM(m.content) NOT IN ('*Failed*', '*Interrupted*')) AS answer_count,
        -- Highlight kind of the branch: the color of the highlight it was
        -- opened from (mockup-mindmap-node-final.html — the node's color bar).
        -- ALL THREE anchor kinds count: a PDF highlight points at its branch
        -- via highlights.chat_id, a chat-text highlight and a transcript /
        -- chapter mark via child_chat_id. The third was missing until
        -- 2026-08-16 (user report with screenshot: video branches sat in the
        -- mindmap without a color bar).
        COALESCE(
          (SELECT h.color FROM highlights h WHERE h.chat_id = c.id
            ORDER BY h.created_at ASC LIMIT 1),
          (SELECT mh.color FROM message_highlights mh WHERE mh.child_chat_id = c.id
            ORDER BY mh.created_at ASC LIMIT 1),
          (SELECT th.color FROM transcript_highlights th WHERE th.child_chat_id = c.id
            ORDER BY th.created_at ASC LIMIT 1)
        ) AS highlight_color
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
    const {
      title, parent_id, parent_word, parent_context, parent_word_display, branch_origin,
    } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // parent_context only makes sense on a branch (PDF-selection surroundings,
    // capped defensively — the frontend already trims to 400 chars).
    const context = parent_word && typeof parent_context === 'string' && parent_context.trim()
      ? parent_context.trim().slice(0, 600)
      : null;

    // parent_word_display: the same passage with its math restored, for the
    // UI only (decision 2026-08-02). parent_word stays verbatim — it is what
    // the model gets as context, and a reconstruction is a guess.
    const display = parent_word && typeof parent_word_display === 'string' && parent_word_display.trim()
      ? parent_word_display.trim().slice(0, 600)
      : null;

    // Branch trace (design/mockup-branch-trace.html, variant A): only the two
    // commands WITHOUT a passage leave a line in the parent transcript, and
    // the anchor is resolved here rather than sent by the client — the client
    // would have to guess which message is currently last, and it is wrong
    // exactly when it matters (an answer that finished while the composer was
    // open). ORDER BY rowid: message ids are UUIDs since 2026-08-08, so id
    // order is not chronological, and created_at ties on kept /btw pairs.
    const origin = branch_origin === 'btw' || branch_origin === 'topic' ? branch_origin : null;
    const anchor = origin && parent_id
      ? db.prepare('SELECT id FROM messages WHERE chat_id = ? ORDER BY rowid DESC LIMIT 1')
        .get(parent_id)?.id ?? null
      : null;

    db.prepare(
      'INSERT INTO chats (id, title, parent_id, parent_word, parent_context, parent_word_display,'
      + ' branch_origin, branch_anchor_message_id, created_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, title, parent_id || null, parent_word || null, context, display, origin, anchor, now);

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

  // Title for a selected passage, BEFORE any chat exists.
  //
  // Why up front: a branch used to be created with the raw passage as its
  // provisional title and only got a real one after the first answer. For a
  // formula marked in a PDF that raw text is mangled ("x ( k ) = x ( k ) − E
  // [ x ( k ) ] √ Var" — the fraction bar is a drawn line, superscripts are
  // geometry), so the sidebar showed rubble until the user asked something.
  // The frontend calls this while the selection popup is open and passes the
  // finished title to POST / — the tree never shows the raw passage
  // (user requirement 2026-08-02: "the formatted formula, immediately").
  //
  // Ollama is deliberately excluded: it has exactly ONE KV cache slot, and a
  // standalone prompt would evict the conversation prefix (~40 s of prefill
  // on the next question, measured 2026-07-21). There the title keeps coming
  // from the post-answer path, which shares that prefix.
  router.post('/passage-title', async (req, res) => {
    const passage = typeof req.body?.passage === 'string' ? req.body.passage.trim() : '';
    if (!passage) return res.status(400).json({ error: 'passage is required' });

    const activeProvider = getSetting(db, 'llm_provider');
    if (activeProvider === 'ollama') return res.json({ title: null, quote: null });

    // Same failover ladder as chat, explain and the outcome line — it lives in
    // ../quota.js so no route invents its own (an exhausted Gemini quota must
    // not send the user back to raw PDF text when a Groq key is sitting right
    // there; that was the live failure measured 2026-08-02).
    // The budget is the point of the exercise: a title is a nicety, the
    // frontend waits ~2.5 s and then shows the tidied passage anyway.
    const result = await callCloudLadder(db, {
      activeProvider,
      messages: [branchTitleInstruction(passage.slice(0, MAX_PASSAGE_CHARS))],
      budgetMs: TITLE_BUDGET_MS,
      callMs: TITLE_CALL_MS,
      isCoolingDown: isQuotaCoolingDown,
      markCooldown: markQuotaCooldown,
      label: 'passage title',
    });

    // Every candidate was rate-limited, retired or gated — the caller tidies
    // the passage instead.
    if (!result) return res.json({ title: null, quote: null });

    // {title, quote}: the tree gets the short title, the branch header and
    // quote chip get the passage with its math restored (user decision
    // 2026-08-02, option B).
    return res.json(parseBranchTitleReply(result.raw, { maxQuoteChars: MAX_PASSAGE_CHARS, passage }));
  });

  // Update a chat: rename it, pin it, or both.
  //
  // `pinned` is a boolean and gets turned into a timestamp here rather than
  // being sent by the client — the sidebar's Pinned section orders itself
  // most-recently-pinned first, and only the server knows a clock the whole
  // app agrees on (design/mockup-pinned-chats.html, variant A).
  router.patch('/:id', (req, res) => {
    const { title, pinned } = req.body;
    const wantsPin = typeof pinned === 'boolean';
    // Filing into a category. `category_id: null` is a real instruction
    // ("unfile"), so presence of the key decides, not truthiness
    // (design/mockup-sidebar-categories-v2.html).
    const wantsFile = 'category_id' in req.body;
    if (!title && !wantsPin && !wantsFile) {
      return res.status(400).json({ error: 'title, pinned or category_id is required' });
    }

    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });

    // Only root chats can be pinned: the section lists trees, so a pinned
    // branch would be a row without the tree it belongs to.
    if (wantsPin && chat.parent_id) {
      return res.status(400).json({ error: 'Only root chats can be pinned' });
    }

    // Same scope for filing: a category lists TREES. A filed branch would sit
    // in the sidebar without the tree it belongs to, which is exactly the
    // reason pinning is root-only.
    if (wantsFile && req.body.category_id) {
      if (chat.parent_id) {
        return res.status(400).json({ error: 'Only root chats can be filed into a category' });
      }
      const category = db.prepare('SELECT id FROM categories WHERE id = ?').get(req.body.category_id);
      if (!category) return res.status(400).json({ error: 'Category not found' });
    }

    if (title) db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(title, req.params.id);

    // Filing and pinning both answer ONE question — where does this tree live —
    // so they cancel each other out. Holding both produced a chat that sat in a
    // category while its own menu still offered "Unpin"; the user hit exactly
    // that on 2026-08-16, and it is the logical completion of "filing wins".
    //
    // Only the POSITIVE gesture clears the other. Taking a chat out of a
    // category must not quietly unpin it, and unpinning must not unfile it —
    // otherwise undoing one action would silently undo a second.
    if (wantsFile) {
      db.prepare('UPDATE chats SET category_id = ? WHERE id = ?')
        .run(req.body.category_id ?? null, req.params.id);
      if (req.body.category_id) {
        db.prepare('UPDATE chats SET pinned_at = NULL WHERE id = ?').run(req.params.id);
      }
    }
    if (wantsPin) {
      // Re-pinning an already pinned chat refreshes its timestamp, which moves
      // it to the top of the section — the same gesture, a stronger statement.
      db.prepare('UPDATE chats SET pinned_at = ? WHERE id = ?')
        .run(pinned ? new Date().toISOString() : null, req.params.id);
      // The mirror image of the rule above: pinning takes the chat out of its
      // category, so the Pinned section can actually show it.
      if (pinned) {
        db.prepare('UPDATE chats SET category_id = NULL WHERE id = ?').run(req.params.id);
      }
    }

    res.json(db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id));
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
    // Highlights outlive their branch (Issue 06): only unlink, never delete.
    // Belt and braces — the schema's ON DELETE SET NULL already does this
    // (better-sqlite3 runs with foreign_keys ON), but keeping the UPDATE means
    // the unlink survives a future schema rebuild that drops the constraint.
    // message_highlights.child_chat_id relies on the FK alone and is covered by
    // tests/message-highlights.test.js.
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
