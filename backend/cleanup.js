// Startup sweep for abandoned chats (user report 2026-09-12).
//
// The frontend deletes an abandoned empty chat when the user navigates away
// inside the app (cleanupAbandonedChat in App.tsx) — but quitting the app,
// reloading, or a failed source import never triggers a navigation, so one
// empty "New chat" per session piled up under "Older" in the sidebar. The
// backend is the one place every leak path passes through: sweep on startup.
//
// Only unambiguously worthless chats are deleted, mirroring the frontend's
// criteria: root chats with no messages, no branches, no bound source
// (PDF/video), no attachments, and not pinned. The grace period protects the
// one live case: in dev the backend restarts while the frontend keeps
// running — a just-created empty chat may still be open on screen.

const GRACE_MS = 15 * 60 * 1000;

function sweepAbandonedChats(db, { olderThanMs = GRACE_MS, now = Date.now() } = {}) {
  // created_at is an ISO-8601 UTC string, so lexicographic comparison is
  // chronological comparison.
  const cutoff = new Date(now - olderThanMs).toISOString();
  const result = db.prepare(`
    DELETE FROM chats
    WHERE parent_id IS NULL
      AND paper_id IS NULL
      AND video_id IS NULL
      AND pinned_at IS NULL
      AND created_at < ?
      AND id NOT IN (SELECT chat_id FROM messages)
      AND id NOT IN (SELECT parent_id FROM chats WHERE parent_id IS NOT NULL)
      AND id NOT IN (SELECT chat_id FROM attachments)
  `).run(cutoff);
  return result.changes;
}

module.exports = { sweepAbandonedChats };
