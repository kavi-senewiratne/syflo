const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Where the data lives is decided in one place (paths.js) — the Electron
// bundle still points here via SYFLO_DATA_DIR, everything else uses ~/.syflo.
// It used to be `__dirname`, which under `npm install -g syflo` means
// node_modules: the next update would have deleted every chat.
const { resolveDataDir, DB_FILENAME } = require('./paths');

const DATA_DIR = resolveDataDir();
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, DB_FILENAME);

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

    -- Colored marks in a video's TRANSCRIPT (design/mockup-transcript-selection.html,
    -- variant A, 2026-08-16). A third anchor next to the PDF's page+rects and
    -- the chat's message+offsets: the video plus character offsets into its
    -- transcript text. start_seconds is the mark of the block the passage
    -- starts in — read from the block, never picked (user decision
    -- 2026-08-16) — and it is what lets the way back land on the sentence AND
    -- the moment. child_chat_id is ON DELETE SET NULL for the same reason as
    -- on papers: research marks outlive the chats they opened.
    CREATE TABLE IF NOT EXISTS transcript_highlights (
      id TEXT PRIMARY KEY,
      video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      text TEXT NOT NULL,
      start_seconds INTEGER,
      -- WHICH text the offsets point into (user request 2026-08-16, chapters
      -- became colorable too): the raw transcript, or the Video overview the
      -- chapter list is rendered from. Two different texts, one table — the
      -- anchor is the same shape, and both marks belong to the same video.
      source TEXT NOT NULL DEFAULT 'transcript' CHECK(source IN ('transcript','chapter')),
      color TEXT NOT NULL CHECK(color IN ('yellow','green','blue','pink','orange')),
      child_chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_transcript_highlights_video ON transcript_highlights(video_id);
    CREATE INDEX IF NOT EXISTS idx_transcript_highlights_child_chat ON transcript_highlights(child_chat_id);

    -- Global color labels — one row per color the user RENAMED (slice 05).
    -- Deliberately NOT seeded (change 2026-08-06): the default name of a
    -- color is UI copy that follows the App language and lives in
    -- frontend/src/strings.ts, so a seeded row would freeze one language
    -- into the database. A missing row means "use the language default".
    CREATE TABLE IF NOT EXISTS highlight_labels (
      color TEXT PRIMARY KEY CHECK(color IN ('yellow','green','blue','pink','orange')),
      label TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Migration 2026-08-06: drop the rows that are still the old seeded English
  // defaults, so those colors pick up the new localized categories. A row the
  // user actually typed differs from all five and survives untouched.
  db.prepare(
    `DELETE FROM highlight_labels
      WHERE (color = 'yellow' AND label = 'Important')
         OR (color = 'green'  AND label = 'Agree')
         OR (color = 'blue'   AND label = 'Reference')
         OR (color = 'pink'   AND label = 'Question')
         OR (color = 'orange' AND label = 'Disagree')`,
  ).run();

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

  // Migration: chats.outcome — the mindmap node's second line: 4–8 words on
  // what the conversation produced (decision 2026-08-02,
  // design/mockup-mindmap-node-final.html §03). Filled by the title call that
  // runs after the first answer — which no longer overwrites the title, so a
  // node can show the passage title AND the outcome without an extra LLM call.
  // Null for branches that were never answered; the node then shows the title
  // alone.
  if (!chatsCols.some((c) => c.name === 'outcome')) {
    db.exec('ALTER TABLE chats ADD COLUMN outcome TEXT');
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

  // Migration: chats.parent_word_display — the passage as it should be SHOWN
  // (user decision 2026-08-02, option B). A formula marked in a PDF arrives
  // as "σ 2 B ← 1 m m ∑ i =1 ( x i − μ B ) 2"; the model restores it to
  // `$\sigma_B^2 \leftarrow \frac{1}{m}\sum_{i=1}^m (x_i - \mu_B)^2$` and
  // the branch header, quote chip and mindmap badge render that.
  // parent_word stays the VERBATIM extraction: it is what goes to the model
  // as context, and a reconstruction is a guess — the guess may decorate the
  // UI, it must not silently become the source. Null → show parent_word.
  if (!chatsCols.some((c) => c.name === 'parent_word_display')) {
    db.exec('ALTER TABLE chats ADD COLUMN parent_word_display TEXT');
  }

  // Migration: chats.branch_anchor_message_id + chats.branch_origin — the
  // branch trace (design/mockup-branch-trace.html, variant A, decided
  // 2026-08-09). A branch opened from a SELECTION already leaves a mark in
  // its parent: the coloured passage carrying message_highlights.child_chat_id.
  // `/btw` and `/branch` have no passage, so until now they left the parent
  // transcript untouched — the fork existed only in the sidebar and the map.
  //
  // What those two commands do have is a place in TIME: the last message that
  // existed in the parent when the command was sent. That id is the anchor;
  // the transcript draws a branch line right after that message, and the
  // branch header links back to it.
  //
  // ON DELETE SET NULL mirrors message_highlights.child_chat_id and DOES fire:
  // better-sqlite3 turns foreign_keys ON by default, unlike the sqlite3 CLI
  // (verified 2026-08-10 — an earlier comment here claimed the opposite and
  // sent a bug hunt to the wrong layer).
  // The renderer still never trusts the anchor to resolve: an id that
  // matches no message in the parent floats its line to the TOP of the
  // transcript, exactly like a branch opened in an empty chat.
  // branch_origin is 'btw' | 'topic' — selection branches deliberately get
  // NEITHER column: their passage is the better, more precise trace and a
  // second announcement of the same branch is noise (decision 2026-08-09).
  if (!chatsCols.some((c) => c.name === 'branch_anchor_message_id')) {
    db.exec(
      'ALTER TABLE chats ADD COLUMN branch_anchor_message_id TEXT '
      + 'REFERENCES messages(id) ON DELETE SET NULL',
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_chats_branch_anchor ON chats(branch_anchor_message_id)',
    );
  }
  if (!chatsCols.some((c) => c.name === 'branch_origin')) {
    db.exec('ALTER TABLE chats ADD COLUMN branch_origin TEXT');
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

  // Migration: transcript_highlights.source — the table shipped hours before
  // chapters became colorable (both on 2026-08-16), so an existing dev
  // database has the table but not the column.
  const thCols = db.prepare('PRAGMA table_info(transcript_highlights)').all();
  if (thCols.length > 0 && !thCols.some((c) => c.name === 'source')) {
    db.exec("ALTER TABLE transcript_highlights ADD COLUMN source TEXT NOT NULL DEFAULT 'transcript'");
  }

  // Migration: messages.truncated — 1 when the provider ended this answer
  // mid-thought (finish_reason 'length'/'content_filter'/MAX_TOKENS, or a
  // missing finish chunk). Persisted, not just logged: a cut-off answer is
  // indistinguishable from a finished one by its text alone, so without this
  // column the "continue writing" card would vanish on reload and the user
  // would be left believing a half answer was the whole one (live incident
  // 2026-08-16: a Video overview stopped at 5:12 of 22:47).
  if (!messagesCols.some((c) => c.name === 'truncated')) {
    db.exec('ALTER TABLE messages ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0');
  }

  // Migration: messages.quote_highlight_id — the highlight an "Ask in chat"
  // quote was taken from (design/mockup-quote-jump-to-source.html, variant A).
  // The quote itself lives inside content as markdown blockquote lines; this
  // is the anchor that makes it clickable, so the bubble can jump back to the
  // passage. Deliberately ONE column and no FK: the id points at either
  // highlights (PDF) or message_highlights (chat text), and the frontend
  // resolves which via the tree-highlights list — a lookup that also answers
  // "does the source still exist?". Messages sent before this column existed,
  // and PDF selections saved without a color (no highlight row at all,
  // decision 2026-07-21), keep it null and render as plain quotes.
  if (!messagesCols.some((c) => c.name === 'quote_highlight_id')) {
    db.exec('ALTER TABLE messages ADD COLUMN quote_highlight_id TEXT');
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

  // Reference links: the citations a paper prints and the works behind them.
  //
  // paper_references is the bibliography — one row per DISTINCT anchor, since
  // a work cited five times has one reference row. `work_*` is filled by the
  // OpenAlex match and stays NULL for a row nothing resolved; such a row
  // still shows its printed `raw_text` in the UI.
  //
  // paper_citations is the click targets — one row per mark in the running
  // text, in PDF user space so the frontend can scale it to any zoom.
  //
  // Both are a CACHE, rebuildable from the PDF at any time, so they cascade
  // away with the paper and carry no migration burden of their own.
  db.exec(`
    CREATE TABLE IF NOT EXISTS paper_references (
      id TEXT PRIMARY KEY,
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      anchor TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      raw_text TEXT NOT NULL,
      label TEXT,
      work_openalex_id TEXT,
      work_title TEXT,
      work_authors_json TEXT,
      work_year INTEGER,
      work_citations INTEGER,
      -- Where OpenAlex says the work appeared, kept apart from parsed_venue
      -- (which is read off the printed row) so a resolved fact and a guess
      -- stay distinguishable.
      work_venue TEXT,
      -- Set once the second source has been asked for the facts of this row,
      -- hit or miss.
      facts_done INTEGER NOT NULL DEFAULT 0,
      doi TEXT,
      arxiv_id TEXT,
      pdf_url TEXT,
      -- Read off the printed row itself (reference-parse.js). Kept apart from
      -- the work_* columns so the UI can still tell "OpenAlex knows this" from
      -- "we read it off the page", while both fill the same card layout.
      parsed_title TEXT,
      parsed_authors_json TEXT,
      parsed_venue TEXT,
      parsed_year INTEGER,
      -- Set once a title lookup has run for this row, hit or miss. A row
      -- nothing can find must not be searched again on every click.
      lookup_done INTEGER NOT NULL DEFAULT 0,
      -- The silent web search for a full text the paper never linked
      -- (fulltext-search.js). fulltext_host is the only trace of the search
      -- the card shows; fulltext_done marks a miss as well as a hit.
      fulltext_url TEXT,
      fulltext_host TEXT,
      fulltext_done INTEGER NOT NULL DEFAULT 0,
      UNIQUE(paper_id, anchor)
    );

    CREATE TABLE IF NOT EXISTS paper_citations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      reference_id TEXT REFERENCES paper_references(id) ON DELETE CASCADE,
      anchor TEXT NOT NULL,
      page INTEGER NOT NULL,
      x0 REAL NOT NULL, y0 REAL NOT NULL, x1 REAL NOT NULL, y1 REAL NOT NULL,
      -- The line the glyphs of this mark sit on. The rect above is the LINK
      -- BOX, whose distance to that line differs per paper, so the underline
      -- is hung off the baseline instead (pdf-citations.js). NULL means the
      -- geometry predates the measurement and gets refreshed on next read.
      baseline REAL
    );

    CREATE INDEX IF NOT EXISTS idx_paper_citations_paper
      ON paper_citations(paper_id, page);
    CREATE INDEX IF NOT EXISTS idx_paper_references_paper
      ON paper_references(paper_id);
  `);

  // Migration: paper_references.parsed_* — for databases created before the
  // printed row was parsed (2026-08-09).
  const refCols = db.prepare("PRAGMA table_info('paper_references')").all();
  for (const [name, type] of [
    ['parsed_title', 'TEXT'],
    ['parsed_authors_json', 'TEXT'],
    ['parsed_venue', 'TEXT'],
    ['parsed_year', 'INTEGER'],
    ['lookup_done', 'INTEGER NOT NULL DEFAULT 0'],
    // The silent web search for a full text the paper never linked
    // (design/mockup-citation-card-standard.html § 04, 2026-08-10).
    // `fulltext_host` is the one thing the card admits about the search;
    // `fulltext_done` remembers a MISS too, so a row nothing can find is not
    // searched again on every click — the same economy as lookup_done.
    // Where OpenAlex says the work appeared. Separate from parsed_venue (read
    // off the printed row), so the UI can still tell a resolved fact from a
    // guess — and prefer the resolved one (2026-08-12).
    ['work_venue', 'TEXT'],
    // Set once the second source has been asked for this row's facts, hit or
    // miss — a reference nothing can find must not be asked again on every
    // click (2026-08-12).
    ['facts_done', 'INTEGER NOT NULL DEFAULT 0'],
    ['fulltext_url', 'TEXT'],
    ['fulltext_host', 'TEXT'],
    ['fulltext_done', 'INTEGER NOT NULL DEFAULT 0'],
  ]) {
    if (!refCols.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE paper_references ADD COLUMN ${name} ${type}`);
    }
  }

  // Migration: paper_citations.baseline — for databases whose citation
  // geometry was written before the underline was hung off the text baseline
  // (2026-08-10). Old rows keep NULL and are re-measured from the PDF on the
  // next read (references.js), so no re-import is needed.
  const citeCols = db.prepare("PRAGMA table_info('paper_citations')").all();
  if (!citeCols.some((c) => c.name === 'baseline')) {
    db.exec('ALTER TABLE paper_citations ADD COLUMN baseline REAL');
  }

  // Migration: papers.citation_geometry_version — which measurement the rows
  // in paper_citations came from. 0 means "written before the underline was
  // hung off the text baseline" (2026-08-10); such a paper is re-measured from
  // its own PDF on the next read, so no re-import is needed.
  const paperCols1 = db.prepare('PRAGMA table_info(papers)').all();
  if (!paperCols1.some((c) => c.name === 'citation_geometry_version')) {
    db.exec('ALTER TABLE papers ADD COLUMN citation_geometry_version INTEGER NOT NULL DEFAULT 0');
  }

  // Migration: papers.references_status — 'pending' | 'ready' | 'none'.
  // 'none' is the honest answer for a Word export or a scan: extraction ran
  // and found nothing, so the UI must not keep showing a spinner.
  const paperCols2 = db.prepare('PRAGMA table_info(papers)').all();
  if (!paperCols2.some((c) => c.name === 'references_status')) {
    db.exec("ALTER TABLE papers ADD COLUMN references_status TEXT NOT NULL DEFAULT 'pending'");
  }
  // Migration: papers.openalex_id — which work this PDF IS. It answers
  // "do I already have this one?" when a citation offers to open a paper,
  // so the same work never becomes two trees.
  if (!paperCols2.some((c) => c.name === 'openalex_id')) {
    db.exec('ALTER TABLE papers ADD COLUMN openalex_id TEXT');
  }

  // Migration: chats.cited_from_chat_id / cited_ref_label — where a tree came
  // from when it was opened out of another paper's citation. Mirrors the
  // "Branched from" line the branch header already shows, pointed at a
  // different kind of parent (design/mockup-paper-reference-links.html § 07).
  const chatCols2 = db.prepare('PRAGMA table_info(chats)').all();
  if (!chatCols2.some((c) => c.name === 'cited_from_chat_id')) {
    db.exec('ALTER TABLE chats ADD COLUMN cited_from_chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL');
  }
  if (!chatCols2.some((c) => c.name === 'cited_ref_label')) {
    db.exec('ALTER TABLE chats ADD COLUMN cited_ref_label TEXT');
  }

  // Migration: chats.pinned_at — a root chat the user keeps coming back to,
  // lifted out of the date sections into one "Pinned" section at the top of
  // the sidebar (design/mockup-pinned-chats.html, variant A, decided
  // 2026-08-11). NULL means not pinned; that is the only state that exists
  // today, so the section simply doesn't render until something is pinned.
  //
  // A TIMESTAMP rather than a boolean flag: the section orders itself
  // most-recently-pinned first, which needs no second column, and it keeps
  // the same shape as every other "when did this happen" column in the schema.
  // Only ROOT chats are ever pinned — the sidebar section lists trees, and a
  // pinned branch would have no tree to sit in (enforced in routes/chats.js).
  if (!chatCols2.some((c) => c.name === 'pinned_at')) {
    db.exec('ALTER TABLE chats ADD COLUMN pinned_at TEXT');
  }

  // Migration: categories — containers for ROOT chats that the USER names,
  // next to the two groupings the system imposes (Pinned, and the relative
  // date sections). design/mockup-sidebar-categories-v2.html, decided
  // 2026-08-16.
  //
  // A subcategory is just a category with a parent — one table, not two, so
  // renaming and deleting are the same code at both levels. Depth is capped at
  // TWO by a rule in routes/categories.js, not by the schema: SQLite cannot
  // express "a row with a parent may not have children", and encoding it as a
  // level column would let the two representations drift apart.
  //
  // `collapsed` lives here because it belongs to the category, which has a row
  // to hang off. The collapse state of the DATE sections has no such row and
  // stays in the frontend's localStorage next to the sidebar's own flag.
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id TEXT REFERENCES categories(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      collapsed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);

  // chats.category_id — NULL means "uncategorised", which is where every chat
  // starts and where a chat returns when its category is deleted. It points at
  // either level: filing into "Robotics" and filing into "Robotics / Teleop
  // data" are the same column, because a subcategory is a category.
  if (!chatCols2.some((c) => c.name === 'category_id')) {
    db.exec('ALTER TABLE chats ADD COLUMN category_id TEXT REFERENCES categories(id) ON DELETE SET NULL');
  }

  // Invariant: a chat is filed OR pinned, never both — the two answer the same
  // question (where does this tree live), and holding both left chats sitting
  // in a category while their menu still offered "Unpin" (user report
  // 2026-08-16). routes/chats.js keeps this true going forward; this repairs
  // rows written before the rule existed. Idempotent and normally a no-op.
  db.exec('UPDATE chats SET pinned_at = NULL WHERE category_id IS NOT NULL AND pinned_at IS NOT NULL');

  return db;
}

module.exports = { createDb, DB_PATH };
