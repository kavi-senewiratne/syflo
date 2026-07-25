/**
 * tests/retrieval.test.js
 *
 * Retrieval-Modus für lange Quellen (ADR-0006): Absatz-Chunking mit
 * Sektions-Headern, Embedding-Cache in source_chunks, Kosinus-Top-k in
 * Dokument-Reihenfolge und das stabile Paper-Skeleton für den Prompt-Prefix.
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

// Baut einen Paper-artigen Text: nummerierte Sektionen mit mehreren Absätzen.
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
    // Jeder Absatz des Originals taucht in genau einem Chunk auf (kein
    // Verlust, keine Zerschneidung mitten im Absatz).
    for (const para of text.split('\n\n')) {
      expect(chunks.filter((c) => c.text.includes(para))).toHaveLength(1);
    }
    // Chunks tragen ihre Dokument-Position.
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
      // Ein einzelner Absatz darf das Ziel überschreiten — mehr als ein
      // Absatz Überhang aber nicht.
      expect(c.text.length).toBeLessThan(300 + 200);
    }
  });

  it('splits a single oversized paragraph at sentence boundaries with overlap', () => {
    const sentence = 'This is a long sentence about scaling laws and data. ';
    const huge = sentence.repeat(40).trim(); // ~2200 Zeichen, EIN Absatz
    const chunks = chunkText(huge, { targetChars: 600, maxChars: 800 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(800);
    // Überlappung: der Anfang jedes Folge-Chunks wiederholt das Ende des
    // vorherigen (letzter Satz), damit kein Gedanke an der Schnittkante reißt.
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

// ─── embedTexts: Ollamas native Embedding-API ────────────────────────────────

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
    expect(JSON.parse(init.body)).toEqual({ model: 'nomic-embed-text', input: ['first', 'second'] });
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

// ─── ensureSourceChunks + retrieveChunks: der SQLite-Vektor-Cache ────────────

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

  // Deterministische Fake-Embeddings: Achse 0 = "attention", Achse 1 = "banana".
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
    expect(fakeEmbed).toHaveBeenCalledTimes(1); // Cache-Treffer, kein Re-Embedding

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

    // Die beiden attention-Chunks gewinnen — und stehen in Dokument-
    // Reihenfolge (Index 0 vor Index 2), nicht nach Score sortiert.
    expect(hits.map((h) => h.text)).toEqual([ATTENTION_PARA, SECOND_ATTENTION_PARA]);
    expect(hits.map((h) => h.index)).toEqual([0, 2]);
  });

  it('throws when the embedder returns unusable vectors (callers fall back to truncation)', async () => {
    // Ein erreichbarer, aber kaputter Embedding-Endpoint (leere Antwort)
    // darf NICHT als Erfolg durchgehen — sonst liegen Chunks ohne Vektoren
    // in der DB und das Retrieval liefert stumm Unsinn.
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

// ─── buildSkeleton: der stabile Prompt-Prefix für den Retrieval-Modus ────────

describe('buildSkeleton', () => {
  it('keeps the beginning (title/abstract), the section outline and the end (conclusion)', () => {
    const text = paperText();
    const skeleton = buildSkeleton(text, { headChars: 200, tailChars: 150 });

    // Anfang: Titel + Abstract.
    expect(skeleton).toContain('Attention Is All You Need');
    // Gliederung: alle erkannten Sektions-Überschriften.
    expect(skeleton).toContain('1 Introduction');
    expect(skeleton).toContain('2 Model Architecture');
    expect(skeleton).toContain('5 Conclusion');
    // Ende: die Conclusion selbst.
    expect(skeleton).toContain('Attention alone suffices.');
  });

  it('stays within its size bound even for huge texts', () => {
    const huge = Array.from({ length: 2000 }, (_, i) => `Paragraph ${i} about scaling.`).join('\n\n');
    const skeleton = buildSkeleton(huge, { headChars: 3000, tailChars: 2500 });
    expect(skeleton.length).toBeLessThan(8000);
  });
});
