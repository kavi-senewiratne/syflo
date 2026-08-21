/**
 * tests/embeddings.test.js
 *
 * The embedding provider (ADR-0008: embeddings always run LOCALLY).
 * Until now retrieval.js embedded through Ollama, which made Ollama a hidden
 * hard dependency even for a user who only ever talks to cloud models — and
 * the bge-m3 pull (1.16 GB) had no button in the app at all. embeddings.js
 * moves the default onto node-llama-cpp (v3.20.0, MIT, prebuilt binaries as
 * optionalDependencies, no node-gyp/Python) and keeps Ollama as the fallback,
 * so nothing gets worse. Local CHAT stays on Ollama — node-llama-cpp has no
 * vision support.
 *
 * No test ever downloads a model: the provider and the model directory are
 * injected, and the only files touched live in a fresh mkdtemp directory.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  embedTexts,
  isEmbeddingModelPresent,
  EMBEDDING_MODEL,
  EMBEDDING_MODEL_FILE,
} = require('../embeddings');

// A model directory that looks like the model is already downloaded, without
// ever writing 1.16 GB: node-llama-cpp is injected, so the file content is
// never read.
function makeModelDir({ withModel }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syflo-embed-'));
  if (withModel) fs.writeFileSync(path.join(dir, EMBEDDING_MODEL_FILE), 'not a real gguf');
  return dir;
}

describe('embedTexts', () => {
  it('returns one vector per input text, in input order', async () => {
    // Deterministic fake provider: the vector encodes the input position, so
    // a reordering would be visible.
    const provider = jest.fn(async (texts) => texts.map((t, i) => [i, t.length]));

    const vectors = await embedTexts(['first', 'second text', 'third'], { provider });

    expect(vectors).toEqual([[0, 5], [1, 11], [2, 5]]);
    expect(provider).toHaveBeenCalledWith(['first', 'second text', 'third']);
  });
});

// ─── Provider choice: node-llama-cpp by default, Ollama as fallback ──────────

describe('provider choice', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  // Minimal stand-in for node-llama-cpp's embedding API
  // (getLlama → loadModel → createEmbeddingContext → getEmbeddingFor).
  function fakeLlamaModule({ loadedPaths = [] } = {}) {
    return {
      getLlama: jest.fn(async () => ({
        loadModel: jest.fn(async ({ modelPath }) => {
          loadedPaths.push(modelPath);
          return {
            createEmbeddingContext: jest.fn(async () => ({
              getEmbeddingFor: jest.fn(async (text) => ({ vector: [text.length, 1] })),
            })),
          };
        }),
      })),
    };
  }

  it('embeds through node-llama-cpp when the model file is there', async () => {
    const modelDir = makeModelDir({ withModel: true });
    const loadedPaths = [];
    const loadLlama = jest.fn(async () => fakeLlamaModule({ loadedPaths }));
    global.fetch = jest.fn(); // Ollama must NOT be touched

    const vectors = await embedTexts(['abc', 'de'], { modelDir, loadLlama });

    expect(vectors).toEqual([[3, 1], [2, 1]]);
    expect(loadedPaths).toEqual([path.join(modelDir, EMBEDDING_MODEL_FILE)]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('falls back to Ollama when node-llama-cpp cannot serve the model', async () => {
    // Nothing downloaded yet, and the prebuilt binary is missing for this
    // platform — the old Ollama path has to keep working unchanged.
    const modelDir = makeModelDir({ withModel: false });
    const loadLlama = jest.fn(async () => { throw new Error('no prebuilt binary'); });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[0.1, 0.2], [0.3, 0.4]] }),
    });

    const vectors = await embedTexts(['first', 'second'], { modelDir, loadLlama });

    expect(vectors).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    const [url, init] = global.fetch.mock.calls[0];
    expect(String(url)).toBe('http://localhost:11434/api/embed');
    expect(JSON.parse(init.body)).toEqual({ model: EMBEDDING_MODEL, input: ['first', 'second'] });
  });
});

// ─── The download hint needs to know without loading (mockup §00) ────────────

describe('isEmbeddingModelPresent', () => {
  it('reports the model on disk without loading it', () => {
    const loadLlama = jest.fn();

    const withModel = makeModelDir({ withModel: true });
    const withoutModel = makeModelDir({ withModel: false });

    expect(isEmbeddingModelPresent({ modelDir: withModel, loadLlama })).toBe(true);
    expect(isEmbeddingModelPresent({ modelDir: withoutModel, loadLlama })).toBe(false);
    // The check is a file lookup — never a 1.16 GB load.
    expect(loadLlama).not.toHaveBeenCalled();
  });
});

// ─── Missing model is a state, not an exception ───────────────────────────────
// retrieval.js callers already degrade to full-text truncation on a failed
// embedding (routes/messages.js catches and warns). The state keeps that
// behaviour but gives the UI something it can name.

describe('missing embedding model', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('returns { error: embedding-model-missing } when neither provider has the model', async () => {
    const modelDir = makeModelDir({ withModel: false });
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'model "bge-m3" not found' }),
    });

    const result = await embedTexts(['x'], { modelDir });

    expect(result).toMatchObject({ error: 'embedding-model-missing' });
    expect(result.detail).toMatch(/bge-m3/);
  });

  it('treats an absent Ollama (nothing installed at all) as the same state', async () => {
    const modelDir = makeModelDir({ withModel: false });
    global.fetch = jest.fn().mockRejectedValue(new TypeError('fetch failed'));

    const result = await embedTexts(['x'], { modelDir });

    expect(result).toMatchObject({ error: 'embedding-model-missing' });
  });
});
