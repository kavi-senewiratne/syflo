/**
 * retrieval.js
 *
 * Retrieval-Modus für lange Quellen (ADR-0006): Papers/Transkripte, die das
 * Kontextfenster sprengen, werden nicht mehr stumpf abgeschnitten. Stattdessen
 * wird die Quelle einmalig in Absatz-Chunks zerlegt und eingebettet
 * (source_chunks), und pro Frage wandern nur die passendsten Chunks in den
 * Prompt — hinter der Historie, damit der stabile Prefix (System-Prompt +
 * Skeleton + Historie) für Ollamas KV-Cache byte-identisch bleibt.
 */

// Ziel-Chunkgröße ~800 Tokens (Grill 2026-07-24): groß genug für einen
// zusammenhängenden Gedanken, klein genug für punktgenaues Retrieval.
const CHUNK_TARGET_CHARS = 2800;
// Harte Obergrenze für einen einzelnen Chunk — nur riesige Einzel-Absätze
// werden an Satzgrenzen (mit 1-Satz-Überlappung) zerteilt.
const CHUNK_MAX_CHARS = 4000;

// Sektions-Überschriften wissenschaftlicher Texte: nummeriert ("2.3 Results")
// oder eines der üblichen Schlüsselwörter als eigene kurze Zeile.
const HEADING_KEYWORDS =
  /^(abstract|introduction|background|related work|methods?|methodology|model(s)? architecture|experiments?|evaluation|results?|discussion|limitations|conclusions?|acknowledg(e)?ments?|references|appendix)\b/i;

function isHeading(paragraph) {
  if (paragraph.includes('\n') || paragraph.length > 80) return false;
  if (/^\d+(\.\d+)*\.?\s+\S/.test(paragraph)) return true;
  return HEADING_KEYWORDS.test(paragraph);
}

// Zerteilt EINEN übergroßen Absatz an Satzgrenzen in Stücke ≤ targetChars,
// mit dem jeweils letzten Satz als Überlappung — kein Gedanke reißt an der
// Schnittkante.
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
 * Zerlegt einen Quelltext in Retrieval-Chunks an Absatzgrenzen.
 * Jeder Chunk trägt die zuletzt gesehene Sektions-Überschrift (heading),
 * damit das Modell weiß, aus welchem Teil des Dokuments ein Auszug stammt.
 * Rückgabe: [{ index, heading, text }] in Dokument-Reihenfolge.
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
    // Riesen-Absatz: Puffer abschließen und an Satzgrenzen zerteilen.
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

// Embedding-Modell (Grill 2026-07-24): klein (~300 MB), läuft neben dem
// Chat-Modell, ohne dessen KV-Cache zu verdrängen. start.command pullt es
// im Hintergrund; fehlt es, werfen wir — Aufrufer degradieren auf die alte
// Volltext-Kürzung.
const EMBEDDING_MODEL = 'nomic-embed-text';

// Batch-Größe pro /api/embed-Aufruf — hält einzelne Requests klein, ohne
// pro Chunk einen HTTP-Roundtrip zu zahlen.
const EMBED_BATCH_SIZE = 32;

/**
 * Bettet Texte über Ollamas native Embedding-API ein.
 * Rückgabe: ein Vektor (number[]) pro Eingabetext, in Reihenfolge.
 */
async function embedTexts(texts, { model = EMBEDDING_MODEL } = {}) {
  const vectors = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const res = await fetch('http://localhost:11434/api/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: batch }),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body && body.error) detail = body.error;
      } catch (_) { /* Status reicht */ }
      throw new Error(`Embedding with ${model} failed: ${detail}`);
    }
    const data = await res.json();
    vectors.push(...(data.embeddings || []));
  }
  return vectors;
}

// Billiger, stabiler Hash des Quelltexts — erkennt Re-Extraktionen (z. B.
// alte 40k-gekappte Caches), damit die Chunks dann neu gebaut werden.
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
 * Stellt sicher, dass eine Quelle (Paper/Video) gechunkt und eingebettet in
 * source_chunks liegt. Idempotent über den Text-Hash: unveränderter Text ist
 * ein reiner Cache-Treffer, geänderter Text (Re-Extraktion) baut neu.
 * Rückgabe: Anzahl der Chunks. Wirft, wenn das Embedding fehlschlägt.
 */
async function ensureSourceChunks(db, { sourceType, sourceId, text, embedFn = embedTexts, chunkOpts }) {
  const hash = hashText(text);
  const existing = db
    .prepare(
      'SELECT COUNT(*) AS n FROM source_chunks WHERE source_type = ? AND source_id = ? AND text_hash = ?'
    )
    .get(sourceType, sourceId, hash);
  if (existing.n > 0) return existing.n;

  const chunks = chunkText(text, chunkOpts);
  const vectors = await embedFn(chunks.map((c) => (c.heading ? `${c.heading}\n${c.text}` : c.text)));
  // Erreichbarer, aber kaputter Embedding-Endpoint (leere/fehlende Vektoren)
  // ist KEIN Erfolg — sonst läge die Quelle mit unbrauchbaren Embeddings im
  // Cache und das Retrieval lieferte stumm Unsinn.
  const usable =
    Array.isArray(vectors) &&
    vectors.length === chunks.length &&
    vectors.every((v) => (Array.isArray(v) || ArrayBuffer.isView(v)) && v.length > 0);
  if (!usable) {
    throw new Error(`Embedding returned no usable vectors (${chunks.length} chunks)`);
  }

  const insert = db.prepare(
    `INSERT INTO source_chunks
       (id, source_type, source_id, chunk_index, heading, content, embedding, text_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const now = new Date().toISOString();
  db.transaction(() => {
    // Veraltete Chunks (anderer Hash) ersetzen.
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
        now
      );
    });
  })();
  return chunks.length;
}

/**
 * Die k passendsten Chunks einer Quelle für eine Frage — per Kosinus-
 * Ähnlichkeit über alle gespeicherten Embeddings (JS reicht: ~100–200
 * Chunks pro Quelle), zurückgegeben in DOKUMENT-Reihenfolge, damit die
 * Auszüge im Prompt wie ein roter Faden durchs Paper lesen.
 */
async function retrieveChunks(db, { sourceType, sourceId, query, k = RETRIEVE_K, embedFn = embedTexts }) {
  const rows = db
    .prepare(
      'SELECT chunk_index, heading, content, embedding FROM source_chunks WHERE source_type = ? AND source_id = ?'
    )
    .all(sourceType, sourceId);
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

// Wie viele Chunks pro Frage in den Prompt wandern (Grill 2026-07-24).
// 8 → 5 (Nachtrag 2026-07-25): Der Excerpt-Block ist der einzige Teil, der
// im Retrieval-Modus pro Frage neu prefillt wird. k=5 spart ~1,3k Tokens
// (~4 s auf dem M4 Pro, gemessen ~300 tok/s Prefill) pro Folgefrage;
// Überblicksfragen fängt ohnehin das Skeleton ab, nicht die Chunks.
const RETRIEVE_K = 5;

// Größen des stabilen Skeletons: Anfang (Titel + Abstract) und Ende
// (Conclusion) — die Teile, die man für fast jede Frage braucht.
const SKELETON_HEAD_CHARS = 3000;
const SKELETON_TAIL_CHARS = 2500;

/**
 * Das stabile Grundgerüst einer langen Quelle für den System-Prompt:
 * Anfang (Titel/Abstract), Gliederung aller erkannten Sektionen, Ende
 * (Conclusion). Bleibt pro Quelle byte-identisch — der KV-Cache-Prefix
 * überlebt jede Frage.
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
  // Gliederung deckeln — pathologische Texte (jede Zeile "heading-artig")
  // dürfen das Skeleton nicht sprengen.
  const outline = headings.slice(0, 40);

  // Anfang/Ende an Absatzgrenzen einrasten — halbe Sätze verwirren das
  // Modell mehr, als ein paar Zeichen weniger kosten.
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
 * Fire-and-forget-Vorbereitung einer frisch importierten Quelle: Text laden
 * (bei Papers: extrahieren + cachen) und — nur wenn er den Volltext-Modus
 * sprengen würde — chunken + einbetten. So wartet die erste Frage weder auf
 * die Extraktion noch auf das Embedding; der Lazy-Pfad beim Prompt-Bau
 * (messages.js) bleibt das Sicherheitsnetz. Fehler sind nie fatal.
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
        `[retrieval] Hintergrund-Vorbereitung für ${sourceType} ${sourceId} fehlgeschlagen: ${err.message}`
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
