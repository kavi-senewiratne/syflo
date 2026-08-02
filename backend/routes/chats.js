const express = require('express');
const fs = require('fs');
const { warmUpAncestorSummaries, getAncestorPath } = require('../ancestor-context');
const { getLLMClientFor, getSetting, noThinkExtras } = require('../llm');
const { MAX_PASSAGE_CHARS, sanitizeTitle, branchTitleInstruction } = require('../title');
const {
  isRateLimit, isDailyQuota, isModelUnavailable, msUntilUtcMidnight, cloudCandidates,
} = require('../quota');

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
    if (activeProvider === 'ollama') return res.json({ title: null });

    const messages = [branchTitleInstruction(passage.slice(0, MAX_PASSAGE_CHARS))];
    // A server-side hiccup is worth one retry: Gemini answered 503 on the
    // first of three live calls (measured 2026-08-02) and fine right after.
    const transient = (err) => {
      const status = err?.status ?? err?.response?.status;
      return typeof status === 'number' && status >= 500;
    };

    // Same failover ladder as chat and explain (../quota.js): an exhausted
    // Gemini quota must not send the user back to raw PDF text when a Groq
    // key is sitting right there — that was exactly the live failure
    // (429, measured 2026-08-02). Known-cold models are skipped, new walls
    // are written into the SAME cooldown memory the picker badges read.
    const cooling = isQuotaCoolingDown || (() => false);
    const all = cloudCandidates(db, activeProvider);
    let candidates = all.filter((c) => !cooling(c.provider, c.model));
    if (candidates.length === 0) candidates = all;

    // Hard time budget. A title is a nicety: the frontend waits ~2.5 s and
    // then shows the tidied passage, so anything beyond that is wasted work.
    // Without it one hanging candidate blocked the whole ladder for minutes
    // (measured 2026-08-02 — the request never returned).
    const deadline = Date.now() + TITLE_BUDGET_MS;
    const remaining = () => deadline - Date.now();

    for (const cand of candidates) {
      if (remaining() <= 0) break;
      let client;
      try {
        ({ client } = getLLMClientFor(db, cand.provider));
      } catch {
        continue; // no key / unknown provider — next candidate
      }
      let plain = false;   // set when the model rejects the no-thinking flag
      for (let attempt = 0; attempt < 2; attempt++) {
        if (remaining() <= 0) break;
        try {
          const completion = await client.chat.completions.create({
            model: cand.model,
            ...(plain ? {} : noThinkExtras(cand.provider)),
            messages,
          }, { signal: AbortSignal.timeout(Math.min(TITLE_CALL_MS, remaining())) });
          const raw = completion.choices[0]?.message?.content || '';
          return res.json({ title: raw.trim() ? sanitizeTitle(raw) : null });
        } catch (err) {
          if (attempt === 0 && transient(err)) {
            await new Promise((resolve) => setTimeout(resolve, 400));
            continue;
          }
          // Some models reject the no-thinking flag outright (Groq's
          // llama-3.3: "400 `reasoning_effort` is not supported with this
          // model", measured 2026-08-02) — one plain retry makes them usable.
          if (attempt === 0 && /reasoning_effort/i.test(err?.message || '')) {
            plain = true;
            continue;
          }
          const unavailable = isModelUnavailable(err);
          if (markQuotaCooldown) {
            if (unavailable) markQuotaCooldown(cand.provider, cand.model, 24 * 60 * 60 * 1000, 'retired');
            else if (isRateLimit(err) && isDailyQuota(err)) {
              markQuotaCooldown(cand.provider, cand.model, msUntilUtcMidnight(), 'daily');
            } else if (isRateLimit(err)) {
              markQuotaCooldown(cand.provider, cand.model, 90_000, 'minute');
            }
          }
          // EVERY failure moves on to the next candidate — a timeout or a
          // 400 used to end the whole ladder and hand back the raw passage
          // even though the very next model would have answered in 0.5 s
          // (measured 2026-08-02).
          if (!isRateLimit(err) && !unavailable) {
            console.error(`[chats] passage title via ${cand.provider}/${cand.model}: ${err.message}`);
          }
          break; // next candidate
        }
      }
    }

    // Every candidate was rate-limited or retired — the caller tidies the
    // passage instead.
    return res.json({ title: null });
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
