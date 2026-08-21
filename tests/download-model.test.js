/**
 * Tests for the postinstall embedding-model download (mockup §00, variant I3).
 *
 * House rule for this file, same as tests/cli.test.js: NO test may reach the
 * network, and NO test may write into the real data directory. On 2026-08-21 a
 * test that used a default path moved 11 MB of real user data into a temp
 * folder — so `fetch`, the filesystem root and the environment are all passed
 * in, and every test that touches disk works inside its own `fs.mkdtempSync`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  planDownload,
  downloadModel,
  run,
} = require('../scripts/download-embedding-model');
const {
  EMBEDDING_MODEL_FILE,
  EMBEDDING_MODEL_URL,
  EMBEDDING_MODEL_BYTES,
} = require('../backend/embeddings');

// A throwaway directory per test. Returned path is real, so the presence check
// exercises real `fs` instead of a hand-written stub that could drift from it.
const tempDirs = [];
function tempModelDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syflo-model-test-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  // Only ever paths this file created itself — never a resolved data directory.
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('planDownload', () => {
  it('skips when the model file is already on disk, so npm update never re-downloads 605 MB', () => {
    const modelDir = tempModelDir();
    fs.writeFileSync(path.join(modelDir, EMBEDDING_MODEL_FILE), 'pretend GGUF');

    const plan = planDownload({ modelDir, env: {} });

    expect(plan.skip).toBe(true);
    expect(plan.reason).toBe('already-present');
  });

  it('skips when SYFLO_SKIP_MODEL is set, the documented off switch for the postinstall download', () => {
    const modelDir = tempModelDir();

    const plan = planDownload({ modelDir, env: { SYFLO_SKIP_MODEL: '1' } });

    expect(plan.skip).toBe(true);
    expect(plan.reason).toBe('opted-out');
  });

  it('skips on CI, where an unattended install should never pull 605 MB', () => {
    const modelDir = tempModelDir();

    const plan = planDownload({ modelDir, env: { CI: 'true' } });

    expect(plan.skip).toBe(true);
    expect(plan.reason).toBe('ci');
  });

  // Found while reviewing what the previous agent left behind: a developer
  // running plain `npm install` in a clone would have started a real 605 MB
  // download. A dev checkout has a .git directory and is not a global install;
  // that combination is the signal. The model belongs to an installation, not
  // to a source tree.
  it('skips a development checkout, where nobody asked for a 605 MB file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syflo-model-dev-'));
    fs.mkdirSync(path.join(dir, '.git'));

    const plan = planDownload({ modelDir: path.join(dir, 'models'), env: {}, packageRoot: dir });

    expect(plan).toMatchObject({ skip: true, reason: 'dev-checkout' });
    expect(plan.url).toBeTruthy();
  });

  it('still downloads for a global install, even from a checkout', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syflo-model-global-'));
    fs.mkdirSync(path.join(dir, '.git'));

    const plan = planDownload({
      modelDir: path.join(dir, 'models'),
      env: { npm_config_global: 'true' },
      packageRoot: dir,
    });

    expect(plan.skip).toBe(false);
  });

  it('otherwise names the exact file, source and size, so nothing downstream has to guess', () => {
    const modelDir = tempModelDir();

    // packageRoot points at a directory without .git: the suite runs inside a
    // clone, which is now a skip reason of its own.
    const plan = planDownload({ modelDir, env: {}, packageRoot: modelDir });

    expect(plan.skip).toBe(false);
    expect(plan.url).toBe(EMBEDDING_MODEL_URL);
    expect(plan.targetPath).toBe(path.join(modelDir, EMBEDDING_MODEL_FILE));
    expect(plan.expectedBytes).toBe(EMBEDDING_MODEL_BYTES);
  });

  // Found by running the script by hand: the opt-out branch printed
  // "download it by hand: undefined", because only the go-ahead plan carried
  // the URL. A skip is exactly when the user needs it most.
  it('names the source and size on a skipped plan too, so the catch-up hint is complete', () => {
    const modelDir = tempModelDir();

    for (const env of [{ SYFLO_SKIP_MODEL: '1' }, { CI: 'true' }]) {
      const plan = planDownload({ modelDir, env });
      expect(plan.url).toBe(EMBEDDING_MODEL_URL);
      expect(plan.expectedBytes).toBe(EMBEDDING_MODEL_BYTES);
    }
  });
});

// A fetch that never leaves the machine. `chunks` are the body pieces in
// order; an Error among them is thrown at that point, which is how a dropped
// connection mid-download looks to the consumer.
function fakeFetch(chunks, { ok = true, status = 200 } = {}) {
  return async () => ({
    ok,
    status,
    body: (async function* body() {
      for (const chunk of chunks) {
        if (chunk instanceof Error) throw chunk;
        yield Buffer.from(chunk);
      }
    })(),
  });
}

function planFor(modelDir, expectedBytes) {
  return {
    skip: false,
    url: 'https://example.invalid/bge-m3-q8_0.gguf',
    targetPath: path.join(modelDir, EMBEDDING_MODEL_FILE),
    expectedBytes,
  };
}

describe('downloadModel', () => {
  it('leaves no model file behind when the download is interrupted', async () => {
    const modelDir = tempModelDir();
    const plan = planFor(modelDir, 6);

    const result = await downloadModel(plan, {
      fetchFn: fakeFetch(['abc', new Error('socket hang up')]),
    });

    expect(result.ok).toBe(false);
    expect(fs.existsSync(plan.targetPath)).toBe(false);
  });

  it('throws away a file of the wrong size instead of keeping a GGUF that would crash the loader', async () => {
    const modelDir = tempModelDir();
    const plan = planFor(modelDir, 999);

    const result = await downloadModel(plan, { fetchFn: fakeFetch(['too short']) });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('size-mismatch');
    expect(fs.existsSync(plan.targetPath)).toBe(false);
    expect(fs.readdirSync(modelDir)).toEqual([]);
  });

  it('renames the completed download into place, leaving no .part behind', async () => {
    const modelDir = tempModelDir();
    const plan = planFor(modelDir, 6);

    const result = await downloadModel(plan, { fetchFn: fakeFetch(['abc', 'def']) });

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(plan.targetPath, 'utf8')).toBe('abcdef');
    expect(fs.readdirSync(modelDir)).toEqual([EMBEDDING_MODEL_FILE]);
  });

  it('gives up when the server never answers, instead of hanging the installation forever', async () => {
    const modelDir = tempModelDir();
    const plan = planFor(modelDir, 6);

    const result = await downloadModel(plan, {
      // A server that accepts the connection and then says nothing. Only the
      // abort signal can end this — which is the point being tested.
      fetchFn: (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      timeoutMs: 10,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('timeout');
  });

  // Deliberately a tiny body: a test may never move 605 MB. What is checked is
  // that progress is reported at all, not the wording — the format is allowed
  // to change without breaking a test.
  it('reports progress while downloading, so a 605 MB fetch does not look like a hang', async () => {
    const modelDir = tempModelDir();
    const plan = planFor(modelDir, 6);
    const onProgress = jest.fn();

    const result = await downloadModel(plan, { fetchFn: fakeFetch(['abc', 'def']), onProgress });

    expect(result.ok).toBe(true);
    expect(onProgress).toHaveBeenCalled();
  });
});

describe('run (the postinstall step itself)', () => {
  it('finishes the installation successfully even when the download fails, and says how to catch up', async () => {
    const modelDir = tempModelDir();
    const lines = [];

    const result = await run({
      modelDir,
      env: {},
      // Not a checkout: run() would otherwise take the dev-checkout skip.
      packageRoot: modelDir,
      log: (line) => lines.push(String(line)),
      fetchFn: async () => {
        throw new Error('getaddrinfo ENOTFOUND huggingface.co');
      },
    });

    expect(result.exitCode).toBe(0);
    const output = lines.join('\n');
    expect(output).toMatch(/retrieval/i);
    expect(output).toContain(EMBEDDING_MODEL_URL);
    expect(output).toContain(modelDir);
  });

  it('hands its progress reporter to the download instead of downloading silently', async () => {
    const modelDir = tempModelDir();
    const onProgress = jest.fn();

    await run({
      modelDir,
      env: {},
      // Not a checkout: run() would otherwise take the dev-checkout skip.
      packageRoot: modelDir,
      log: () => {},
      onProgress,
      // Report every chunk. The real 5 % step would produce nothing for a
      // 6-byte body, and a test may never move the real 605 MB.
      progressStep: 0,
      fetchFn: fakeFetch(['abc', 'def']),
    });

    expect(onProgress).toHaveBeenCalled();
  });
});
