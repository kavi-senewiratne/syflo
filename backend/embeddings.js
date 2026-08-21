/**
 * embeddings.js
 *
 * The local embedding provider. ADR-0008 keeps embeddings LOCAL always (the
 * source text never leaves the machine), but until now "local" meant Ollama:
 * retrieval.js called Ollama's /api/embed with bge-m3, which made Ollama a
 * hidden hard dependency even for a user who only ever talks to cloud models.
 * The bge-m3 pull (1.16 GB) also had no button and no hint in the app — it
 * only ever happened by hand in a terminal.
 *
 * Default is therefore node-llama-cpp (v3.20.0, MIT, checked 2026-08-12):
 * prebuilt binaries ship as optionalDependencies (13 MB for Apple Silicon),
 * it needs neither node-gyp nor Python, it embeds, and it brings its own
 * model downloader. Ollama stays as the FALLBACK, so nobody who has it
 * working today gets a regression.
 *
 * Local CHAT stays on Ollama: node-llama-cpp has no vision support, and the
 * whole warm-up/KV-cache machinery is Ollama-specific (CLAUDE.md guardrail —
 * no extra complexity on the local path).
 *
 * Public interface:
 *   embedTexts(texts, deps) → number[][] | { error: 'embedding-model-missing',
 *                                            detail }
 *   isEmbeddingModelPresent(deps) → boolean   (never loads the model)
 *   embeddingModelPath(deps) → string
 *
 * deps (all optional, all injectable — a test never loads a real model):
 *   provider(texts) → vectors   full override
 *   modelDir                    where the GGUF lives (default: <data>/models)
 *   loadLlama()                 → the node-llama-cpp module
 *   fileSystem                  for the presence check
 *   fetchFn, ollamaUrl, model   for the Ollama fallback
 */

const fs = require('fs');
const path = require('path');

// The ONE place the embedding model is named. The name is also the stamp in
// source_chunks.embedding_model (database.js:400): vectors of different
// models live in incompatible spaces, so a changed name has to invalidate
// the chunk cache. Changing the model here therefore re-embeds everything —
// which is exactly what the stamp is for.
const EMBEDDING_MODEL = 'bge-m3';
// bge-m3's output width. Storage does not need it (the Float32 BLOB carries
// its own length), but step 8's downloader verifies the GGUF against it: a
// file with another width is not bge-m3, and its vectors would poison the
// chunk cache.
const EMBEDDING_DIMENSIONS = 1024;
// The GGUF node-llama-cpp loads, and where it comes from. Both verified live
// on 2026-08-21 against the Hugging Face API — the name is lower-case q8_0,
// which an earlier guess got wrong, and a mismatch would make
// isEmbeddingModelPresent() always answer false. ggml-org is llama.cpp's own
// org and the repo is MIT.
const EMBEDDING_MODEL_FILE = 'bge-m3-q8_0.gguf';
const EMBEDDING_MODEL_URL =
  'https://huggingface.co/ggml-org/bge-m3-Q8_0-GGUF/resolve/main/bge-m3-q8_0.gguf';
// 634,553,760 bytes, measured from the response headers. Worth stating in the
// UI before the download starts: it is 605 MB, not the 1.16 GB that Ollama's
// f16 build of the same model weighs.
const EMBEDDING_MODEL_BYTES = 634553760;

// Same convention as whisper.js: models live next to the app data, and the
// directory is overridable so tests never touch a real home directory.
// The data folder comes from paths.js (SYFLO_DATA_DIR or ~/.syflo), so the
// model sits next to the database instead of next to the code — under
// `npm install -g syflo` the code folder is replaced by the next update.
const { resolveDataDir } = require('./paths');
const DEFAULT_MODEL_DIR =
  process.env.SYFLO_EMBEDDING_MODEL_DIR || path.join(resolveDataDir(), 'models');

/** Where the embedding GGUF is expected. */
function embeddingModelPath({ modelDir = DEFAULT_MODEL_DIR } = {}) {
  return path.join(modelDir, EMBEDDING_MODEL_FILE);
}

/**
 * Is the embedding model already on disk? A pure file check — it never loads
 * the 1.16 GB model, so the UI can ask it on every render for the download
 * hint (mockup §00).
 */
function isEmbeddingModelPresent({ modelDir, fileSystem = fs } = {}) {
  try {
    return fileSystem.existsSync(embeddingModelPath({ modelDir }));
  } catch (_) {
    return false;
  }
}

// node-llama-cpp is ESM-only, the backend is CommonJS — hence the dynamic
// import. It is also the reason the loader is injectable: a test must never
// pull in the native binary.
const defaultLoadLlama = () => import('node-llama-cpp');

// One loaded model per path: the GGUF is ~600 MB in RAM, and every question
// in retrieval mode embeds again. Loading per call would make retrieval
// unusable.
const contextCache = new Map();

async function llamaEmbeddingContext({ modelDir, loadLlama = defaultLoadLlama }) {
  const modelPath = embeddingModelPath({ modelDir });
  if (!contextCache.has(modelPath)) {
    contextCache.set(
      modelPath,
      (async () => {
        const { getLlama } = await loadLlama();
        const llama = await getLlama();
        const model = await llama.loadModel({ modelPath });
        return model.createEmbeddingContext();
      })()
    );
  }
  return contextCache.get(modelPath);
}

/**
 * The node-llama-cpp provider, or null when it is not usable (model file
 * missing, prebuilt binary missing for this platform, load failure). Null
 * means: fall back to Ollama.
 */
async function llamaProvider(deps) {
  if (!isEmbeddingModelPresent(deps)) return null;
  let context;
  try {
    context = await llamaEmbeddingContext(deps);
  } catch (err) {
    // A failed load must not be cached — the next call (e.g. after the
    // download in step 8) should try again.
    contextCache.delete(embeddingModelPath(deps));
    console.warn(`[embeddings] node-llama-cpp unavailable (${err.message}) — using Ollama.`);
    return null;
  }
  return async (texts) => {
    const vectors = [];
    for (const text of texts) {
      const embedding = await context.getEmbeddingFor(text);
      vectors.push(Array.from(embedding.vector));
    }
    return vectors;
  };
}

// The one named state callers get instead of a stack trace: no provider on
// this machine can embed, because the model was never downloaded. Anything
// else (a broken response, a 500) keeps throwing — that is a bug, not a
// missing download.
const EMBEDDING_MODEL_MISSING = 'embedding-model-missing';

function missingModelError(detail) {
  const err = new Error(detail);
  err.embeddingState = EMBEDDING_MODEL_MISSING;
  return err;
}

// Batch size per Ollama /api/embed call — keeps individual requests small
// without paying an HTTP roundtrip per chunk (unchanged from retrieval.js).
const EMBED_BATCH_SIZE = 32;

/**
 * The Ollama fallback: the path that has been in production since ADR-0006.
 * Kept verbatim so a machine that embeds fine today keeps embedding fine.
 */
function ollamaProvider({
  model = EMBEDDING_MODEL,
  fetchFn = (...args) => fetch(...args),
  ollamaUrl = 'http://localhost:11434',
} = {}) {
  return async (texts) => {
    const vectors = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
      let res;
      try {
        res = await fetchFn(`${ollamaUrl}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, input: batch }),
        });
      } catch (err) {
        // No Ollama listening — the exact case this step exists for: a user
        // who only uses cloud models should never have needed Ollama.
        throw missingModelError(`Ollama is not reachable (${err.message})`);
      }
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (body && body.error) detail = body.error;
        } catch (_) { /* status is enough */ }
        // 404 / "not found" = the model was never pulled.
        if (res.status === 404 || /not found/i.test(detail)) throw missingModelError(detail);
        throw new Error(detail);
      }
      const data = await res.json();
      vectors.push(...(data.embeddings || []));
    }
    return vectors;
  };
}

/**
 * Embeds texts. Returns one vector per input text, in input order — the
 * shape retrieval.js expects.
 */
async function embedTexts(texts, deps = {}) {
  const provider = deps.provider || (await llamaProvider(deps)) || ollamaProvider(deps);
  try {
    return await provider(texts);
  } catch (err) {
    if (err.embeddingState) return { error: err.embeddingState, detail: err.message };
    throw err;
  }
}

module.exports = {
  embedTexts,
  isEmbeddingModelPresent,
  embeddingModelPath,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL_FILE,
  EMBEDDING_MODEL_URL,
  EMBEDDING_MODEL_BYTES,
  EMBEDDING_MODEL_MISSING,
};
