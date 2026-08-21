/**
 * retrieval.js
 *
 * Retrieval mode for long sources (ADR-0006): papers/transcripts that blow
 * the context window are no longer bluntly cut off. Instead, the source is
 * split once into paragraph chunks and embedded (source_chunks), and per
 * question only the best-matching chunks go into the prompt — behind the
 * history, so the stable prefix (system prompt + skeleton + history) stays
 * byte-identical for Ollama's KV cache.
 */

// Target chunk size ~800 tokens (grill 2026-07-24): big enough for a
// coherent thought, small enough for pinpoint retrieval.
const CHUNK_TARGET_CHARS = 2800;
// Hard upper limit for a single chunk — only huge single paragraphs are
// split at sentence boundaries (with a 1-sentence overlap).
const CHUNK_MAX_CHARS = 4000;

// Section headings of scientific texts: numbered ("2.3 Results") or one of
// the usual keywords as its own short line.
const HEADING_KEYWORDS =
  /^(abstract|introduction|background|related work|methods?|methodology|model(s)? architecture|experiments?|evaluation|results?|discussion|limitations|conclusions?|acknowledg(e)?ments?|references|appendix)\b/i;

function isHeading(paragraph) {
  if (paragraph.includes('\n') || paragraph.length > 80) return false;
  if (/^\d+(\.\d+)*\.?\s+\S/.test(paragraph)) return true;
  return HEADING_KEYWORDS.test(paragraph);
}

// Splits ONE oversized paragraph at sentence boundaries into pieces
// ≤ targetChars, with the respective last sentence as overlap — no thought
// tears at the cut edge.
function splitOversizedParagraph(paragraph, targetChars) {
  const sentences = (paragraph.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [paragraph]).map(
    (s) => s.trim()
  );
  const pieces = [];
  let cur = [];
  let len = 0;
  for (const s of sentences) {
    if (cur.length > 0 && len + s.length + 1 > targetChars) {
      pieces.push(cur.join(' '));
      const overlap = cur[cur.length - 1];
      cur = [overlap];
      len = overlap.length;
    }
    cur.push(s);
    len += s.length + 1;
  }
  if (cur.length > 0) pieces.push(cur.join(' '));
  return pieces;
}

/**
 * Splits a source text into retrieval chunks at paragraph boundaries.
 * Every chunk carries the most recently seen section heading (heading) so
 * the model knows which part of the document an excerpt comes from.
 * Returns: [{ index, heading, text }] in document order.
 */
function chunkText(text, opts = {}) {
  const targetChars = opts.targetChars ?? CHUNK_TARGET_CHARS;
  const maxChars = opts.maxChars ?? CHUNK_MAX_CHARS;

  const paragraphs = String(text)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks = [];
  let buffer = [];
  let bufferLen = 0;
  let currentHeading = '';
  let chunkHeading = '';

  const flush = () => {
    if (buffer.length === 0) return;
    chunks.push({ index: chunks.length, heading: chunkHeading, text: buffer.join('\n\n') });
    buffer = [];
    bufferLen = 0;
  };

  for (const para of paragraphs) {
    // Giant paragraph: close the buffer and split at sentence boundaries.
    if (para.length > maxChars) {
      flush();
      for (const piece of splitOversizedParagraph(para, targetChars)) {
        chunks.push({ index: chunks.length, heading: currentHeading, text: piece });
      }
      if (isHeading(para)) currentHeading = para;
      continue;
    }

    if (buffer.length > 0 && bufferLen + 2 + para.length > targetChars) flush();
    if (buffer.length === 0) chunkHeading = isHeading(para) ? para : currentHeading;
    buffer.push(para);
    bufferLen += (buffer.length > 1 ? 2 : 0) + para.length;
    if (isHeading(para)) currentHeading = para;
  }
  flush();

  return chunks;
}

// Embedding model: bge-m3 (switch 2026-07-25, ADR-0006 addendum) — multi-
// lingual so German questions hit English paper chunks (benchmark:
// DE↔EN top-5 Jaccard 0.73 vs. 0.19 with nomic-embed-text). Named in exactly
// ONE place, embeddings.js, because the name is also the cache stamp in
// source_chunks.embedding_model.
const {
  embedTexts: embedTextsWithProvider,
  EMBEDDING_MODEL,
} = require('./embeddings');

/**
 * Embeds texts through the local embedding provider (embeddings.js:
 * node-llama-cpp first, Ollama as fallback).
 * Returns: one vector (number[]) per input text, in order.
 *
 * The provider reports a missing model as a state instead of throwing; here
 * it becomes a throw again, because that is what the callers already handle:
 * routes/messages.js catches it and degrades to full-text truncation
 * (prepareSourceInBackground just warns). Same behaviour as before, only the
 * provider underneath changed.
 */
async function embedTexts(texts, deps = {}) {
  const result = await embedTextsWithProvider(texts, deps);
  if (result && result.error) {
    throw new Error(`Embedding with ${EMBEDDING_MODEL} failed: ${result.detail || result.error}`);
  }
  return result;
}

// Cheap, stable hash of the source text — detects re-extractions (e.g. old
// 40k-truncated caches) so the chunks then get rebuilt.
function hashText(text) {
  return require('crypto').createHash('sha1').update(text).digest('hex');
}

function embeddingToBuffer(vec) {
  return Buffer.from(new Float32Array(vec).buffer);
}

function bufferToEmbedding(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Ensures a source (paper/video) is chunked and embedded in source_chunks.
 * Idempotent via the text hash: unchanged text is a pure cache hit, changed
 * text (re-extraction) rebuilds.
 * Returns: number of chunks. Throws when embedding fails.
 */
async function ensureSourceChunks(db, { sourceType, sourceId, text, embedFn = embedTexts, chunkOpts }) {
  const hash = hashText(text);
  // Cache hit only when text AND embedding model match — chunks of another
  // model are worthless (incompatible vector space) and get replaced.
  const existing = db
    .prepare(
      'SELECT COUNT(*) AS n FROM source_chunks WHERE source_type = ? AND source_id = ? AND text_hash = ? AND embedding_model = ?'
    )
    .get(sourceType, sourceId, hash, EMBEDDING_MODEL);
  if (existing.n > 0) return existing.n;

  const chunks = chunkText(text, chunkOpts);
  const vectors = await embedFn(chunks.map((c) => (c.heading ? `${c.heading}\n${c.text}` : c.text)));
  // A reachable but broken embedding endpoint (empty/missing vectors) is
  // NOT a success — otherwise the source would sit in the cache with
  // unusable embeddings and retrieval would silently return nonsense.
  const usable =
    Array.isArray(vectors) &&
    vectors.length === chunks.length &&
    vectors.every((v) => (Array.isArray(v) || ArrayBuffer.isView(v)) && v.length > 0);
  if (!usable) {
    throw new Error(`Embedding returned no usable vectors (${chunks.length} chunks)`);
  }

  const insert = db.prepare(
    `INSERT INTO source_chunks
       (id, source_type, source_id, chunk_index, heading, content, embedding, text_hash, embedding_model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const now = new Date().toISOString();
  db.transaction(() => {
    // Replace outdated chunks (different hash).
    db.prepare('DELETE FROM source_chunks WHERE source_type = ? AND source_id = ?').run(
      sourceType,
      sourceId
    );
    chunks.forEach((c, i) => {
      insert.run(
        crypto.randomUUID(),
        sourceType,
        sourceId,
        c.index,
        c.heading || null,
        c.text,
        embeddingToBuffer(vectors[i]),
        hash,
        EMBEDDING_MODEL,
        now
      );
    });
  })();
  return chunks.length;
}

/**
 * The k best-matching chunks of a source for a question — via cosine
 * similarity over all stored embeddings (JS suffices: ~100–200 chunks per
 * source), returned in DOCUMENT order so the excerpts in the prompt read
 * like a connecting thread through the paper.
 */
async function retrieveChunks(db, { sourceType, sourceId, query, k = RETRIEVE_K, embedFn = embedTexts }) {
  // Only chunks of the current model — foreign vectors would be number salad.
  const rows = db
    .prepare(
      'SELECT chunk_index, heading, content, embedding FROM source_chunks WHERE source_type = ? AND source_id = ? AND embedding_model = ?'
    )
    .all(sourceType, sourceId, EMBEDDING_MODEL);
  if (rows.length === 0) return [];

  const [queryVec] = await embedFn([query]);
  const scored = rows.map((r) => ({
    index: r.chunk_index,
    heading: r.heading || '',
    text: r.content,
    score: cosineSimilarity(queryVec, bufferToEmbedding(r.embedding)),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).sort((a, b) => a.index - b.index);
}

// How many chunks per question go into the prompt (grill 2026-07-24).
// 8 → 5 (addendum 2026-07-25): The excerpt block is the only part that is
// re-prefilled per question in retrieval mode. k=5 saves ~1.3k tokens
// (~4 s on the M4 Pro, measured ~300 tok/s prefill) per follow-up question;
// overview questions are caught by the skeleton anyway, not the chunks.
const RETRIEVE_K = 5;

// Sizes of the stable skeleton: beginning (title + abstract) and end
// (conclusion) — the parts needed for almost every question.
const SKELETON_HEAD_CHARS = 3000;
const SKELETON_TAIL_CHARS = 2500;

/**
 * The stable skeleton of a long source for the system prompt:
 * beginning (title/abstract), outline of all detected sections, end
 * (conclusion). Stays byte-identical per source — the KV cache prefix
 * survives every question.
 */
function buildSkeleton(text, opts = {}) {
  const headChars = opts.headChars ?? SKELETON_HEAD_CHARS;
  const tailChars = opts.tailChars ?? SKELETON_TAIL_CHARS;
  const full = String(text);

  const paragraphs = full
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const headings = paragraphs.filter(isHeading);
  // Cap the outline — pathological texts (every line "heading-like") must
  // not blow up the skeleton.
  const outline = headings.slice(0, 40);

  // Snap beginning/end to paragraph boundaries — half sentences confuse the
  // model more than a few fewer characters cost.
  const takeParagraphs = (list, budget) => {
    const taken = [];
    let len = 0;
    for (const p of list) {
      if (taken.length > 0 && len + 2 + p.length > budget) break;
      taken.push(p);
      len += (taken.length > 1 ? 2 : 0) + p.length;
    }
    return taken;
  };
  const head = takeParagraphs(paragraphs, headChars).join('\n\n');
  const tail =
    full.length > headChars + tailChars
      ? takeParagraphs([...paragraphs].reverse(), tailChars).reverse().join('\n\n')
      : '';

  const parts = [`[Beginning of the document]\n${head}`];
  if (outline.length > 0) parts.push(`[Section outline]\n${outline.map((h) => `- ${h}`).join('\n')}`);
  if (tail) parts.push(`[End of the document]\n${tail}`);
  return parts.join('\n\n');
}

/**
 * Fire-and-forget preparation of a freshly imported source: load the text
 * (for papers: extract + cache) and — only if it would blow the full-text
 * mode — chunk + embed. That way the first question waits neither for the
 * extraction nor for the embedding; the lazy path during prompt building
 * (messages.js) remains the safety net. Errors are never fatal.
 */
function prepareSourceInBackground(db, { sourceType, sourceId, loadText, embedFn, thresholdChars }) {
  const threshold =
    thresholdChars ?? require('./ancestor-context').MAX_SYSTEM_CONTEXT_CHARS;
  setImmediate(async () => {
    try {
      const text = await loadText();
      if (!text || text.length <= threshold) return;
      await ensureSourceChunks(db, {
        sourceType,
        sourceId,
        text,
        ...(embedFn ? { embedFn } : {}),
      });
    } catch (err) {
      console.warn(
        `[retrieval] Background preparation for ${sourceType} ${sourceId} failed: ${err.message}`
      );
    }
  });
}

module.exports = {
  chunkText,
  embedTexts,
  prepareSourceInBackground,
  ensureSourceChunks,
  retrieveChunks,
  buildSkeleton,
  CHUNK_TARGET_CHARS,
  CHUNK_MAX_CHARS,
  EMBEDDING_MODEL,
  RETRIEVE_K,
  SKELETON_HEAD_CHARS,
  SKELETON_TAIL_CHARS,
};
