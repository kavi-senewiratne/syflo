/**
 * routes/youtube.js
 *
 * Routes behind the "YouTube Transcript" plus-menu item (ADR-0005): search
 * videos via InnerTube (youtube.js — it replaced the SearXNG YouTube engine
 * on 2026-08-15). The search backend is injectable for tests, same pattern as
 * routes/papers.js.
 */
const express = require('express');
const { randomUUID } = require('crypto');
const defaultYoutube = require('../youtube');
const { prepareSourceInBackground } = require('../retrieval');

module.exports = (db, options = {}) => {
  const router = express.Router();
  const searchVideosFn = options.searchVideosFn || defaultYoutube.searchVideos;
  const fetchTranscriptFn = options.fetchTranscriptFn || defaultYoutube.fetchTranscript;
  // Retrieval preparation (ADR-0006), injectable for tests.
  const embedTextsFn = options.embedTextsFn;

  const getChat = db.prepare('SELECT * FROM chats WHERE id = ?');
  const getVideo = db.prepare('SELECT * FROM videos WHERE id = ?');
  const insertVideo = db.prepare(`
    INSERT INTO videos (id, youtube_id, title, channel, duration_seconds, language, transcript, url, created_at)
    VALUES (@id, @youtube_id, @title, @channel, @duration_seconds, @language, @transcript, @url, @created_at)
  `);
  const bindVideoToChat = db.prepare('UPDATE chats SET video_id = ? WHERE id = ?');
  // Binding a video names the tree after it — same behavior as papers.
  const renameChatToVideo = db.prepare('UPDATE chats SET title = ? WHERE id = ?');

  // Walk parent_id up to the tree root. The root carries the tree's source.
  function resolveRoot(chatId) {
    let chat = getChat.get(chatId);
    while (chat && chat.parent_id) chat = getChat.get(chat.parent_id);
    return chat || null;
  }

  function formatVideo(row) {
    return {
      id: row.id,
      youtube_id: row.youtube_id,
      title: row.title,
      channel: row.channel,
      duration_seconds: row.duration_seconds,
      language: row.language,
      url: row.url,
      created_at: row.created_at,
    };
  }

  // GET /api/youtube/search?q=… — video search for the modal.
  router.get('/search', async (req, res) => {
    const q = (req.query.q || '').toString().trim();
    if (!q) return res.json({ results: [] });
    try {
      const results = await searchVideosFn(q);
      res.json({ results });
    } catch (err) {
      // The search now runs through InnerTube (2026-08-15), so the failure
      // mode is the network or YouTube itself — no local service to start.
      const msg = err?.cause?.code === 'ECONNREFUSED' || err?.cause?.code === 'ENOTFOUND'
        ? 'Could not reach YouTube. Check your internet connection.'
        : err.message || 'Video search failed';
      res.status(503).json({ error: msg });
    }
  });

  // POST /api/youtube/import — fetch the transcript of `youtube_id` and bind
  // it as the source of `chat_id`'s tree. Body: { chat_id, youtube_id }.
  router.post('/import', async (req, res) => {
    const chatId = (req.body?.chat_id || '').toString();
    const youtubeId = (req.body?.youtube_id || '').toString();
    if (!chatId) return res.status(400).json({ error: 'chat_id is required' });
    if (!/^[A-Za-z0-9_-]{11}$/.test(youtubeId)) {
      return res.status(400).json({ error: 'youtube_id is required (11-char video id)' });
    }
    const root = resolveRoot(chatId);
    if (!root) return res.status(404).json({ error: 'Chat not found' });
    // ADR-0005: one source per tree (PDF or video) — checked BEFORE the
    // fetch so the failure case burns no InnerTube request.
    if (root.paper_id || root.video_id) {
      return res.status(409).json({ error: 'tree-has-source', root_chat_id: root.id });
    }

    let info;
    try {
      info = await fetchTranscriptFn(youtubeId);
    } catch (err) {
      // No caption track (not even an automatic one): clear, non-technical
      // message for the modal; Whisper fallback deliberately left out
      // (ADR-0005).
      if (err?.code === 'no-transcript') {
        return res.status(422).json({
          error: 'no-transcript',
          message:
            'YouTube offers no captions for this video — not even auto-generated ones. Pick a different video.',
        });
      }
      // The captions exist but YouTube stayed silent through every attempt
      // (youtube.js explains the measurement). Say that it is temporary —
      // the modal used to show Node's raw "The operation was aborted due to
      // timeout", which reads like a broken app rather than a retry.
      if (err?.code === 'captions-unavailable') {
        return res.status(502).json({
          error: 'captions-unavailable',
          message:
            'YouTube did not hand over the captions this time. That is usually temporary — press Add again.',
        });
      }
      // Google's throttle, not our bug: retrying now makes it worse, so the
      // message asks for a wait instead of another press.
      if (err?.code === 'captions-rate-limited') {
        return res.status(429).json({
          error: 'captions-rate-limited',
          message:
            'YouTube is currently blocking transcript requests from this computer. Wait a few minutes and try again.',
        });
      }
      return res.status(502).json({ error: err.message || 'Transcript fetch failed' });
    }

    const row = {
      id: randomUUID(),
      youtube_id: youtubeId,
      title: info.title,
      channel: info.channel || '',
      duration_seconds: info.durationSeconds ?? null,
      language: info.language ?? null,
      transcript: defaultYoutube.buildTranscriptText(info.segments),
      url: `https://www.youtube.com/watch?v=${youtubeId}`,
      created_at: new Date().toISOString(),
    };
    const tx = db.transaction(() => {
      insertVideo.run(row);
      bindVideoToChat.run(row.id, root.id);
      renameChatToVideo.run(row.title, root.id);
    });
    tx();

    // Chunk/embed long transcripts in the background (ADR-0006) — the
    // first question does not wait for the embedding.
    prepareSourceInBackground(db, {
      sourceType: 'video',
      sourceId: row.id,
      embedFn: embedTextsFn,
      loadText: async () => row.transcript,
    });

    return res.status(201).json(formatVideo(row));
  });

  // GET /api/youtube/for-chat/:chatId — the video bound to this chat's tree
  // (resolved via the root), incl. the full transcript for the drawer.
  router.get('/for-chat/:chatId', (req, res) => {
    const root = resolveRoot(req.params.chatId);
    if (!root) return res.status(404).json({ error: 'Chat not found' });
    if (!root.video_id) return res.json({ video: null });
    const row = getVideo.get(root.video_id);
    return res.json({ video: row ? { ...formatVideo(row), transcript: row.transcript } : null });
  });

  return router;
};
