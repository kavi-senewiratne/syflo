/**
 * tests/retrieval.test.js
 *
 * Retrieval mode for long sources (ADR-0006): paragraph chunking with
 * section headers, embedding cache in source_chunks, cosine top-k in
 * document order and the stable paper skeleton for the prompt prefix.
 */

const path = require('path');
const fs = require('fs');
const { createDb } = require('../database');
const {
  chunkText,
  embedTexts,
  ensureSourceChunks,
  retrieveChunks,
  buildSkeleton,
} = require('../retrieval');

const TEST_DB_PATH = path.join(__dirname, 'retrieval_test.db');

// Builds a paper-like text: numbered sections with multiple paragraphs.
function paperText() {
  const para = (s) =>
    `${s} This paragraph talks about transformers and attention in enough ` +
    'detail to be a realistic unit of retrieval for the chat model.';
  return [
    'Attention Is All You Need',
    'Abstract',
    para('We propose a new architecture.'),
    '1 Introduction',
    para('Sequence models dominate.'),
    para('Recurrent networks are slow.'),
    '2 Model Architecture',
    para('The encoder stacks six layers.'),
    para('The decoder attends to the encoder.'),
    '5 Conclusion',
    para('Attention alone suffices.'),
  ].join('\n\n');
}

describe('chunkText', () => {
  it('covers the whole text with chunks at paragraph boundaries', () => {
    const text = paperText();
    const chunks = chunkText(text, { targetChars: 300 });

    expect(chunks.length).toBeGreaterThan(1);
    // Every paragraph of the original appears in exactly one chunk (no
    // loss, no cutting in the middle of a paragraph).
    for (const para of text.split('\n\n')) {
      expect(chunks.filter((c) => c.text.includes(para))).toHaveLength(1);
    }
    // Chunks carry their document position.
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it('attaches the most recent section heading to each chunk', () => {
    const chunks = chunkText(paperText(), { targetChars: 300 });

    const intro = chunks.find((c) => c.text.includes('Recurrent networks are slow.'));
    expect(intro.heading).toBe('1 Introduction');
    const model = chunks.find((c) => c.text.includes('The decoder attends'));
    expect(model.heading).toBe('2 Model Architecture');
  });

  it('respects the target size but never splits a paragraph across chunks', () => {
    const chunks = chunkText(paperText(), { targetChars: 300 });
    for (const c of chunks) {
      // A single paragraph may exceed the target — but not more than one
      // paragraph of overhang.
      expect(c.text.length).toBeLessThan(300 + 200);
    }
  });

  it('splits a single oversized paragraph at sentence boundaries with overlap', () => {
    const sentence = 'This is a long sentence about scaling laws and data. ';
    const huge = sentence.repeat(40).trim(); // ~2200 chars, ONE paragraph
    const chunks = chunkText(huge, { targetChars: 600, maxChars: 800 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(800);
    // Overlap: the beginning of each subsequent chunk repeats the end of the
    // previous one (last sentence) so no thought is torn at the cut edge.
    for (let i = 1; i < chunks.length; i += 1) {
      const prevEnd = chunks[i - 1].text.slice(-sentence.trim().length);
      expect(chunks[i].text.startsWith(prevEnd)).toBe(true);
    }
  });

  it('returns a single chunk for short texts', () => {
    const chunks = chunkText('One tiny paragraph.', { targetChars: 2800 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ index: 0, text: 'One tiny paragraph.' });
  });
});

// ─── embedTexts: Ollama's native embedding API ───────────────────────────────

describe('embedTexts', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('posts the texts to /api/embed and returns the embedding vectors', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[0.1, 0.2], [0.3, 0.4]] }),
    });

    const vecs = await embedTexts(['first', 'second']);

    expect(vecs).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    const [url, init] = global.fetch.mock.calls[0];
    expect(String(url)).toBe('http://localhost:11434/api/embed');
    expect(JSON.parse(init.body)).toEqual({ model: require('../retrieval').EMBEDDING_MODEL, input: ['first', 'second'] });
  });

  it('throws when the embedding model is unavailable (callers degrade)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'model "nomic-embed-text" not found' }),
    });
    await expect(embedTexts(['x'])).rejects.toThrow(/nomic-embed-text/);
  });
});

// ─── ensureSourceChunks + retrieveChunks: the SQLite vector cache ────────────

describe('source chunk cache and retrieval', () => {
  let db;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    db = createDb(TEST_DB_PATH);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  // Deterministic fake embeddings: axis 0 = "attention", axis 1 = "banana".
  const fakeEmbed = jest.fn(async (texts) =>
    texts.map((t) => [t.includes('attention') ? 1 : 0, t.includes('banana') ? 1 : 0])
  );

  const ATTENTION_PARA =
    'The attention mechanism relates every token to every other token in the sequence.';
  const BANANA_PARA =
    'A banana contains potassium and grows in tropical climates around the world.';
  const SECOND_ATTENTION_PARA =
    'Multi-head attention runs several attention functions in parallel heads.';
  const TEXT = [ATTENTION_PARA, BANANA_PARA, SECOND_ATTENTION_PARA].join('\n\n');

  it('chunks, embeds and stores a source once — later calls hit the cache', async () => {
    fakeEmbed.mockClear();
    const first = await ensureSourceChunks(db, {
      sourceType: 'paper', sourceId: 'p1', text: TEXT, embedFn: fakeEmbed,
      chunkOpts: { targetChars: 60 },
    });
    expect(first).toBe(3);
    expect(fakeEmbed).toHaveBeenCalledTimes(1);

    const again = await ensureSourceChunks(db, {
      sourceType: 'paper', sourceId: 'p1', text: TEXT, embedFn: fakeEmbed,
      chunkOpts: { targetChars: 60 },
    });
    expect(again).toBe(3);
    expect(fakeEmbed).toHaveBeenCalledTimes(1); // cache hit, no re-embedding

    const rows = db
      .prepare("SELECT * FROM source_chunks WHERE source_type = 'paper' AND source_id = 'p1' ORDER BY chunk_index")
      .all();
    expect(rows).toHaveLength(3);
    expect(rows[0].content).toBe(ATTENTION_PARA);
    expect(rows[0].embedding).toBeInstanceOf(Buffer);
  });

  it('rebuilds the chunks when the source text changed (e.g. re-extraction)', async () => {
    await ensureSourceChunks(db, {
      sourceType: 'paper', sourceId: 'p1', text: 'Old truncated text.', embedFn: fakeEmbed,
    });
    fakeEmbed.mockClear();

    await ensureSourceChunks(db, {
      sourceType: 'paper', sourceId: 'p1', text: TEXT, embedFn: fakeEmbed,
      chunkOpts: { targetChars: 60 },
    });

    expect(fakeEmbed).toHaveBeenCalledTimes(1);
    const rows = db
      .prepare("SELECT content FROM source_chunks WHERE source_id = 'p1' ORDER BY chunk_index")
      .all();
    expect(rows.map((r) => r.content)).toEqual([ATTENTION_PARA, BANANA_PARA, SECOND_ATTENTION_PARA]);
  });

  it('retrieves the top-k chunks by cosine similarity, in document order', async () => {
    await ensureSourceChunks(db, {
      sourceType: 'paper', sourceId: 'p1', text: TEXT, embedFn: fakeEmbed,
      chunkOpts: { targetChars: 60 },
    });

    const hits = await retrieveChunks(db, {
      sourceType: 'paper', sourceId: 'p1',
      query: 'how does attention work?', k: 2, embedFn: fakeEmbed,
    });

    // The two attention chunks win — and appear in document order
    // (index 0 before index 2), not sorted by score.
    expect(hits.map((h) => h.text)).toEqual([ATTENTION_PARA, SECOND_ATTENTION_PARA]);
    expect(hits.map((h) => h.index)).toEqual([0, 2]);
  });

  it('throws when the embedder returns unusable vectors (callers fall back to truncation)', async () => {
    // A reachable but broken embedding endpoint (empty response)
    // must NOT pass as success — otherwise chunks without vectors sit
    // in the DB and retrieval silently returns nonsense.
    const brokenEmbed = jest.fn(async () => []);
    await expect(
      ensureSourceChunks(db, { sourceType: 'paper', sourceId: 'p1', text: TEXT, embedFn: brokenEmbed })
    ).rejects.toThrow(/vector/i);
    const n = db.prepare("SELECT COUNT(*) AS n FROM source_chunks WHERE source_id = 'p1'").get().n;
    expect(n).toBe(0);
  });

  it('returns an empty list when the source has no chunks', async () => {
    const hits = await retrieveChunks(db, {
      sourceType: 'paper', sourceId: 'unknown', query: 'x', k: 5, embedFn: fakeEmbed,
    });
    expect(hits).toEqual([]);
  });
});

// ─── buildSkeleton: the stable prompt prefix for retrieval mode ──────────────

describe('buildSkeleton', () => {
  it('keeps the beginning (title/abstract), the section outline and the end (conclusion)', () => {
    const text = paperText();
    const skeleton = buildSkeleton(text, { headChars: 200, tailChars: 150 });

    // Beginning: title + abstract.
    expect(skeleton).toContain('Attention Is All You Need');
    // Outline: all recognized section headings.
    expect(skeleton).toContain('1 Introduction');
    expect(skeleton).toContain('2 Model Architecture');
    expect(skeleton).toContain('5 Conclusion');
    // End: the conclusion itself.
    expect(skeleton).toContain('Attention alone suffices.');
  });

  it('stays within its size bound even for huge texts', () => {
    const huge = Array.from({ length: 2000 }, (_, i) => `Paragraph ${i} about scaling.`).join('\n\n');
    const skeleton = buildSkeleton(huge, { headChars: 3000, tailChars: 2500 });
    expect(skeleton.length).toBeLessThan(8000);
  });
});

// ─── Model stamp (ADR-0008 slice 6 / ADR-0006 addendum) ──────────────────────
// Vectors from different embedding models are not comparable. The chunk
// cache therefore carries the model that built it — a mismatch (model
// switch) rebuilds the cache automatically instead of silently returning
// nonsense.

describe('embedding model stamp', () => {
  const fakeEmbed = () => {
    const fn = jest.fn(async (texts) => texts.map(() => [1, 0, 0]));
    return fn;
  };

  let db;
  beforeEach(() => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    db = createDb(TEST_DB_PATH);
  });
  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  it('uses bge-m3 as the embedding model (multilingual, benchmark 2026-07-25)', () => {
    expect(require('../retrieval').EMBEDDING_MODEL).toBe('bge-m3');
  });

  it('stamps every cached chunk with the embedding model', async () => {
    const embedFn = fakeEmbed();
    await ensureSourceChunks(db, {
      sourceType: 'paper', sourceId: 'p1', text: paperText(), embedFn,
    });
    const rows = db.prepare('SELECT DISTINCT embedding_model FROM source_chunks').all();
    expect(rows).toEqual([{ embedding_model: require('../retrieval').EMBEDDING_MODEL }]);
  });

  it('rebuilds the cache when the stamp does not match the current model', async () => {
    const embedFn = fakeEmbed();
    const text = paperText();
    await ensureSourceChunks(db, { sourceType: 'paper', sourceId: 'p1', text, embedFn });
    expect(embedFn).toHaveBeenCalledTimes(1);

    // Same text, same hash → pure cache hit, no re-embedding.
    await ensureSourceChunks(db, { sourceType: 'paper', sourceId: 'p1', text, embedFn });
    expect(embedFn).toHaveBeenCalledTimes(1);

    // Cache (simulated) still stems from the old model → rebuild.
    db.prepare("UPDATE source_chunks SET embedding_model = 'nomic-embed-text'").run();
    await ensureSourceChunks(db, { sourceType: 'paper', sourceId: 'p1', text, embedFn });
    expect(embedFn).toHaveBeenCalledTimes(2);
    const rows = db.prepare('SELECT DISTINCT embedding_model FROM source_chunks').all();
    expect(rows).toEqual([{ embedding_model: require('../retrieval').EMBEDDING_MODEL }]);
  });

  it('ignores stale chunks from another model at retrieval time', async () => {
    const embedFn = fakeEmbed();
    await ensureSourceChunks(db, { sourceType: 'paper', sourceId: 'p1', text: paperText(), embedFn });
    db.prepare("UPDATE source_chunks SET embedding_model = 'nomic-embed-text'").run();

    const hits = await retrieveChunks(db, {
      sourceType: 'paper', sourceId: 'p1', query: 'attention', embedFn,
    });
    expect(hits).toEqual([]);
  });
});
