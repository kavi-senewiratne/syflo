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

    -- Globale Settings als Key-Value-Store. Aktuelle Keys:
    --   llm_provider:      'ollama' | 'openai'
    --   openai_api_key:    raw secret (nur intern, wird nie ans Frontend geschickt)
    --   openai_model:      z. B. 'gpt-4o' oder 'gpt-4o-mini'
    --   ollama_model:      z. B. 'llama3.2-vision:11b'
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- Papers: PDF, das an einen Chat tree gebunden ist (ADR-0002: max. eins
    -- pro Tree, der Root-Chat trägt paper_id). Minimaler Syflo-Port ohne
    -- Marker-Pipeline — status ist direkt 'ready', 'parsing'/'failed' bleiben
    -- im CHECK für Schema-Kompatibilität mit Syflo.
    CREATE TABLE IF NOT EXISTS papers (
      id TEXT PRIMARY KEY,
      title TEXT,
      authors_json TEXT,
      uploaded_at TEXT NOT NULL,
      pdf_path TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('parsing', 'ready', 'failed'))
    );

    -- Videos: YouTube transcript als zweite Quellenart (ADR-0005: ein Baum
    -- hat höchstens EINE Quelle — Paper ODER Video; der Root-Chat trägt
    -- paper_id bzw. video_id). transcript hält den vollen Untertitel-Text
    -- mit groben Minutenmarken pro Absatz.
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

    -- Text-Anker für Highlights (Syflo-Port, Slice 04). bbox_json hält die
    -- Multi-Rects in Zoom=1-Seitenkoordinaten; start/end_offset bleiben für
    -- Schema-Kompatibilität mit Syflo erhalten (dort: Markdown-Anker).
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

    -- Farbige Highlights. chat_id ist ON DELETE SET NULL — ein Highlight
    -- überlebt seinen Branch (Issue 06). Da SQLite-FKs hier nicht global
    -- aktiviert sind, entkoppelt der Chat-Delete-Pfad (routes/chats.js)
    -- zusätzlich explizit.
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

    -- Chat-Text-Highlights (design/mockup-chat-highlights-ask-in-chat.html).
    -- Anders als PDF-Highlights (text_ranges.bbox_json, geometrisch) ankern
    -- sie an message_id + Zeichen-Offsets in den gerenderten Klartext der
    -- Nachricht (textContent der Bubble) — dadurch reflow-sicher. text hält
    -- den markierten Wortlaut zur Verifikation beim Re-Anchoring.
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

    -- Globale Farb-Labels — eine Zeile pro Farbe, vom Nutzer umbenennbar
    -- (Slice 05). Seeds unten via INSERT OR IGNORE, damit Umbenennungen
    -- Backend-Neustarts überleben.
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

  // Migration: chats.paper_id (nullable) — der Root-Chat eines Trees ist an
  // ein Paper gebunden. Idempotent: PRAGMA-Check vor ALTER (wie in Syflo).
  const chatsCols = db.prepare('PRAGMA table_info(chats)').all();
  if (!chatsCols.some((c) => c.name === 'paper_id')) {
    db.exec('ALTER TABLE chats ADD COLUMN paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL');
  }

  // Migration: chats.video_id (nullable) — Gegenstück zu paper_id für die
  // zweite Quellenart (ADR-0005). Nur der Root-Chat eines Trees trägt sie.
  if (!chatsCols.some((c) => c.name === 'video_id')) {
    db.exec('ALTER TABLE chats ADD COLUMN video_id TEXT REFERENCES videos(id) ON DELETE SET NULL');
  }

  // Migration: chats.summary + chats.summary_last_message_id — gecachte
  // LLM-Zusammenfassung des Chats für den geerbten Vorfahren-Kontext von
  // Branches. Reiner Cache (jederzeit regenerierbar); summary_last_message_id
  // hält die id der letzten abgedeckten Nachricht für den Staleness-Check.
  if (!chatsCols.some((c) => c.name === 'summary')) {
    db.exec('ALTER TABLE chats ADD COLUMN summary TEXT');
  }
  if (!chatsCols.some((c) => c.name === 'summary_last_message_id')) {
    db.exec('ALTER TABLE chats ADD COLUMN summary_last_message_id TEXT');
  }

  // Migration: chats.summary_display — JSON {gist, points[]} für die
  // Kontext-Banner-Anzeige (mockup-context-banner-variants.html §01).
  // Reine Anzeige-Ableitung der Summary, geht NICHT in den Prompt; null bei
  // alten Summaries → das UI fällt auf den gerenderten Volltext zurück.
  if (!chatsCols.some((c) => c.name === 'summary_display')) {
    db.exec('ALTER TABLE chats ADD COLUMN summary_display TEXT');
  }

  // Migration: papers.extracted_text — lazily filled plain-text cache of the
  // PDF, fed into the chat context so the model can answer questions about
  // the paper (see pdf-text.js).
  const papersCols = db.prepare('PRAGMA table_info(papers)').all();
  if (!papersCols.some((c) => c.name === 'extracted_text')) {
    db.exec('ALTER TABLE papers ADD COLUMN extracted_text TEXT');
  }

  // Migration: source_chunks — Absatz-Chunks + Embeddings für den Retrieval-
  // Modus langer Quellen (retrieval.js, ADR-0006). Reiner Cache: jederzeit
  // aus papers.extracted_text bzw. videos.transcript regenerierbar.
  // text_hash hält den Hash des Quelltexts, aus dem die Chunks entstanden —
  // ändert er sich (z. B. Re-Extraktion eines gekappten Caches), wird neu
  // gechunkt. embedding ist ein Float32-BLOB (Kosinus-Suche in JS; bei
  // ~100–200 Chunks pro Quelle braucht es keine Vektor-Datenbank).
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

  return db;
}

module.exports = { createDb, DB_PATH };
