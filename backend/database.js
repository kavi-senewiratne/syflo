const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// In production (Electron-bundled app), the backend folder is read-only inside
// the .app bundle. The Electron main process sets SYFLO_DATA_DIR to a
// per-user writable location (e.g. ~/Library/Application Support/Syflo).
// In normal development (running `npm start` from backend/), no env var is
// set and we fall back to the backend folder for backwards compatibility.
const DATA_DIR = process.env.SYFLO_DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'syflo.db');

function createDb(dbPath = DB_PATH) {
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      parent_id TEXT,
      parent_word TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (parent_id) REFERENCES chats(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (chat_id) REFERENCES chats(id)
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      filename TEXT NOT NULL,
      mimetype TEXT NOT NULL,
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id),
      FOREIGN KEY (chat_id) REFERENCES chats(id)
    );

    CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

    -- Global settings as a key-value store. Current keys:
    --   llm_provider:      'ollama' | 'openai'
    --   openai_api_key:    raw secret (internal only, never sent to the frontend)
    --   openai_model:      e.g. 'gpt-4o' or 'gpt-4o-mini'
    --   ollama_model:      e.g. 'llama3.2-vision:11b'
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- Papers: PDF bound to a chat tree (ADR-0002: at most one per tree, the
    -- root chat carries paper_id). Minimal Syflo port without the marker
    -- pipeline — status is 'ready' right away, 'parsing'/'failed' stay in
    -- the CHECK for schema compatibility with Syflo.
    CREATE TABLE IF NOT EXISTS papers (
      id TEXT PRIMARY KEY,
      title TEXT,
      authors_json TEXT,
      uploaded_at TEXT NOT NULL,
      pdf_path TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('parsing', 'ready', 'failed'))
    );

    -- Videos: YouTube transcript as the second source type (ADR-0005: a tree
    -- has at most ONE source — paper OR video; the root chat carries
    -- paper_id or video_id respectively). transcript holds the full subtitle
    -- text with rough minute marks per paragraph.
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      youtube_id TEXT NOT NULL,
      title TEXT NOT NULL,
      channel TEXT,
      duration_seconds INTEGER,
      language TEXT,
      transcript TEXT NOT NULL,
      url TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Text anchors for highlights (Syflo port, slice 04). bbox_json holds the
    -- multi-rects in zoom=1 page coordinates; start/end_offset are kept for
    -- schema compatibility with Syflo (there: Markdown anchors).
    CREATE TABLE IF NOT EXISTS text_ranges (
      id TEXT PRIMARY KEY,
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      start_offset INTEGER,
      end_offset INTEGER,
      text TEXT,
      page_number INTEGER,
      bbox_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_text_ranges_paper ON text_ranges(paper_id);

    -- Colored highlights. chat_id is ON DELETE SET NULL — a highlight
    -- survives its branch (issue 06). Since SQLite FKs are not enabled
    -- globally here, the chat delete path (routes/chats.js) additionally
    -- detaches explicitly.
    CREATE TABLE IF NOT EXISTS highlights (
      id TEXT PRIMARY KEY,
      text_range_id TEXT NOT NULL REFERENCES text_ranges(id) ON DELETE CASCADE,
      chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
      color TEXT NOT NULL CHECK(color IN ('yellow','green','blue','pink','orange')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_highlights_chat ON highlights(chat_id);
    CREATE INDEX IF NOT EXISTS idx_highlights_text_range ON highlights(text_range_id);

    -- Chat text highlights (design/mockup-chat-highlights-ask-in-chat.html).
    -- Unlike PDF highlights (text_ranges.bbox_json, geometric), they anchor
    -- to message_id + character offsets into the rendered plain text of the
    -- message (textContent of the bubble) — making them reflow-safe. text
    -- holds the highlighted wording for verification during re-anchoring.
    CREATE TABLE IF NOT EXISTS message_highlights (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      text TEXT NOT NULL,
      color TEXT NOT NULL CHECK(color IN ('yellow','green','blue','pink','orange')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_message_highlights_message ON message_highlights(message_id);

    -- Global color labels — one row per color, renamable by the user
    -- (slice 05). Seeded below via INSERT OR IGNORE so renames survive
    -- backend restarts.
    CREATE TABLE IF NOT EXISTS highlight_labels (
      color TEXT PRIMARY KEY CHECK(color IN ('yellow','green','blue','pink','orange')),
      label TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const seedLabel = db.prepare(
    'INSERT OR IGNORE INTO highlight_labels (color, label, updated_at) VALUES (?, ?, ?)',
  );
  const nowIso = new Date().toISOString();
  const defaultLabels = {
    yellow: 'Important',
    green: 'Agree',
    blue: 'Reference',
    pink: 'Question',
    orange: 'Disagree',
  };
  for (const [color, label] of Object.entries(defaultLabels)) {
    seedLabel.run(color, label, nowIso);
  }

  // Migration: chats.paper_id (nullable) — the root chat of a tree is bound
  // to a paper. Idempotent: PRAGMA check before ALTER (as in Syflo).
  const chatsCols = db.prepare('PRAGMA table_info(chats)').all();
  if (!chatsCols.some((c) => c.name === 'paper_id')) {
    db.exec('ALTER TABLE chats ADD COLUMN paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL');
  }

  // Migration: chats.video_id (nullable) — counterpart to paper_id for the
  // second source type (ADR-0005). Only the root chat of a tree carries it.
  if (!chatsCols.some((c) => c.name === 'video_id')) {
    db.exec('ALTER TABLE chats ADD COLUMN video_id TEXT REFERENCES videos(id) ON DELETE SET NULL');
  }

  // Migration: chats.summary + chats.summary_last_message_id — cached LLM
  // summary of the chat for the inherited ancestor context of branches.
  // Pure cache (regenerable at any time); summary_last_message_id holds the
  // id of the last covered message for the staleness check.
  if (!chatsCols.some((c) => c.name === 'summary')) {
    db.exec('ALTER TABLE chats ADD COLUMN summary TEXT');
  }
  if (!chatsCols.some((c) => c.name === 'summary_last_message_id')) {
    db.exec('ALTER TABLE chats ADD COLUMN summary_last_message_id TEXT');
  }

  // Migration: chats.summary_display — JSON {gist, points[]} for the
  // context banner display (mockup-context-banner-variants.html §01).
  // Pure display derivation of the summary, does NOT go into the prompt;
  // null for old summaries → the UI falls back to the rendered full text.
  if (!chatsCols.some((c) => c.name === 'summary_display')) {
    db.exec('ALTER TABLE chats ADD COLUMN summary_display TEXT');
  }

  // Migration: chats.parent_context — for branches opened from a PDF
  // selection: the text-layer lines around the selection, captured in the
  // frontend at selection time (decision 2026-07-26). The PDF text layer
  // flattens math notation ("Rm" for R^m), so the branch prompt needs the
  // surroundings to make the selected term interpretable. Null for
  // chat-selection branches (parent_word already carries the full passage).
  if (!chatsCols.some((c) => c.name === 'parent_context')) {
    db.exec('ALTER TABLE chats ADD COLUMN parent_context TEXT');
  }

  // Migration: messages.fail_reason — machine-readable cause on '*Failed*'
  // markers (mockup-model-flow §05/§06). Deterministic causes (no_key,
  // bad_key, no_vision, local_missing) stay true across reloads, so the UI
  // can keep their specific card; time-dependent quota flags remain
  // transient by design and are NEVER stored here.
  const messagesCols = db.prepare('PRAGMA table_info(messages)').all();
  if (!messagesCols.some((c) => c.name === 'fail_reason')) {
    db.exec('ALTER TABLE messages ADD COLUMN fail_reason TEXT');
  }

  // Migration: messages.pending — 1 while a question waits in the send queue
  // (mockup-model-flow §10). Persisted at enqueue so a reload can never lose
  // a typed question; cleared (and re-stamped) at dequeue. Pending rows are
  // excluded from prompts and timestamp logic.
  if (!messagesCols.some((c) => c.name === 'pending')) {
    db.exec('ALTER TABLE messages ADD COLUMN pending INTEGER NOT NULL DEFAULT 0');
  }

  // Migration: papers.extracted_text — lazily filled plain-text cache of the
  // PDF, fed into the chat context so the model can answer questions about
  // the paper (see pdf-text.js).
  const papersCols = db.prepare('PRAGMA table_info(papers)').all();
  if (!papersCols.some((c) => c.name === 'extracted_text')) {
    db.exec('ALTER TABLE papers ADD COLUMN extracted_text TEXT');
  }

  // Migration: message_highlights.child_chat_id — the chat branched from
  // this chat-text highlight, mirroring highlights.chat_id (PDF side). Same
  // ON DELETE SET NULL: the highlight outlives its branch.
  const messageHighlightsCols = db.prepare('PRAGMA table_info(message_highlights)').all();
  if (!messageHighlightsCols.some((c) => c.name === 'child_chat_id')) {
    db.exec(
      'ALTER TABLE message_highlights ADD COLUMN child_chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL',
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_message_highlights_child_chat ON message_highlights(child_chat_id)',
    );
  }

  // Migration: source_chunks — paragraph chunks + embeddings for the
  // retrieval mode of long sources (retrieval.js, ADR-0006). Pure cache:
  // regenerable at any time from papers.extracted_text or videos.transcript.
  // text_hash holds the hash of the source text the chunks were built from —
  // if it changes (e.g. re-extraction of a truncated cache), chunking is
  // redone. embedding is a Float32 BLOB (cosine search in JS; with ~100–200
  // chunks per source no vector database is needed).
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_chunks (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL CHECK(source_type IN ('paper', 'video')),
      source_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      heading TEXT,
      content TEXT NOT NULL,
      embedding BLOB,
      text_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_source_chunks_source
      ON source_chunks(source_type, source_id, chunk_index);
  `);

  // Migration: usage_log — token counts of every response (ADR-0008 slice 7).
  // Basis of the cost estimate (× registry price table) and the free-tier
  // daily counter. Pure metrics, NEVER conversation content.
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_log (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_log_created ON usage_log(created_at);
  `);

  // Migration: embedding_model — the stamp of the model that embedded the
  // chunks (ADR-0006 addendum 2026-07-25). Vectors of different models live
  // in incompatible spaces; a mismatch means a rebuild. Existing rows
  // without a stamp come from nomic-embed-text (the model before the switch
  // to bge-m3) and are rebuilt on the next access.
  const chunkCols = db.prepare("PRAGMA table_info('source_chunks')").all();
  if (!chunkCols.some((c) => c.name === 'embedding_model')) {
    db.exec("ALTER TABLE source_chunks ADD COLUMN embedding_model TEXT NOT NULL DEFAULT 'nomic-embed-text'");
  }

  return db;
}

module.exports = { createDb, DB_PATH };
