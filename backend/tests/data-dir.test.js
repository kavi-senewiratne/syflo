/**
 * tests/data-dir.test.js
 *
 * Where Syflo keeps its data. Two separate concerns, deliberately split after
 * an earlier attempt moved the developer's REAL database into a temp folder
 * (2026-08-21):
 *
 *   - resolveDataDir() only ANSWERS a question. It never creates, moves or
 *     deletes anything, so calling it can do no harm.
 *   - migrateLegacyData() does the moving, and it refuses to run unless both
 *     paths are handed to it explicitly. There is no default that could point
 *     at a real installation.
 *
 * Every test below passes its own temp directories in. Nothing here can reach
 * the real home directory even if it wanted to.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveDataDir, migrateLegacyData } = require('../paths');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `syflo-test-${prefix}-`));
}

describe('resolveDataDir', () => {
  it('honours SYFLO_DATA_DIR, which is how the Electron build points at its bundle', () => {
    expect(resolveDataDir({ env: { SYFLO_DATA_DIR: '/somewhere/else' }, homedir: () => '/home/x' }))
      .toBe('/somewhere/else');
  });

  it('falls back to a folder in the home directory, never next to the code', () => {
    // The whole point: under `npm install -g syflo` the code lives in
    // node_modules, which the next update replaces.
    expect(resolveDataDir({ env: {}, homedir: () => '/home/x' })).toBe(path.join('/home/x', '.syflo'));
  });

  it('creates nothing — asking must be free of side effects', () => {
    const home = tempDir('resolve');
    resolveDataDir({ env: {}, homedir: () => home });
    expect(fs.existsSync(path.join(home, '.syflo'))).toBe(false);
  });
});

describe('migrateLegacyData', () => {
  it('moves an existing database and its write-ahead files to the new folder', () => {
    const legacyDir = tempDir('legacy');
    const dataDir = path.join(tempDir('data'), '.syflo');
    fs.writeFileSync(path.join(legacyDir, 'syflo.db'), 'the-real-data');
    fs.writeFileSync(path.join(legacyDir, 'syflo.db-wal'), 'wal');
    fs.writeFileSync(path.join(legacyDir, 'syflo.db-shm'), 'shm');

    const result = migrateLegacyData({ legacyDir, dataDir });

    expect(result.moved).toEqual(['syflo.db', 'syflo.db-wal', 'syflo.db-shm']);
    expect(fs.readFileSync(path.join(dataDir, 'syflo.db'), 'utf8')).toBe('the-real-data');
    expect(fs.existsSync(path.join(legacyDir, 'syflo.db'))).toBe(false);
  });

  it('moves the uploads folder along, so attachments do not lose their files', () => {
    const legacyRoot = tempDir('legacy-root');
    const legacyDir = path.join(legacyRoot, 'backend');
    fs.mkdirSync(legacyDir);
    fs.writeFileSync(path.join(legacyDir, 'syflo.db'), 'db');
    const uploads = path.join(legacyRoot, 'uploads', 'chat-1');
    fs.mkdirSync(uploads, { recursive: true });
    fs.writeFileSync(path.join(uploads, 'page.png'), 'png');
    const dataDir = path.join(tempDir('data'), '.syflo');

    migrateLegacyData({ legacyDir, legacyUploadsDir: path.join(legacyRoot, 'uploads'), dataDir });

    expect(fs.readFileSync(path.join(dataDir, 'uploads', 'chat-1', 'page.png'), 'utf8')).toBe('png');
  });

  it('never touches anything once the new folder already has a database', () => {
    // The new location wins. Overwriting it would throw away newer work.
    const legacyDir = tempDir('legacy');
    const dataDir = tempDir('data');
    fs.writeFileSync(path.join(legacyDir, 'syflo.db'), 'old');
    fs.writeFileSync(path.join(dataDir, 'syflo.db'), 'new');

    const result = migrateLegacyData({ legacyDir, dataDir });

    expect(result.moved).toEqual([]);
    expect(fs.readFileSync(path.join(dataDir, 'syflo.db'), 'utf8')).toBe('new');
    expect(fs.readFileSync(path.join(legacyDir, 'syflo.db'), 'utf8')).toBe('old');
  });

  it('moves the whisper/embedding models along — dictation looks for them under the data dir', () => {
    const legacyRoot = tempDir('legacy-root');
    const legacyDir = path.join(legacyRoot, 'backend');
    fs.mkdirSync(legacyDir);
    fs.writeFileSync(path.join(legacyDir, 'syflo.db'), 'db');
    const models = path.join(legacyRoot, 'models');
    fs.mkdirSync(models);
    fs.writeFileSync(path.join(models, 'ggml-small.bin'), 'whisper');
    const dataDir = path.join(tempDir('data'), '.syflo');

    const result = migrateLegacyData({ legacyDir, legacyModelsDir: models, dataDir });

    expect(result.moved).toContain(path.join('models', 'ggml-small.bin'));
    expect(fs.readFileSync(path.join(dataDir, 'models', 'ggml-small.bin'), 'utf8')).toBe('whisper');
  });

  it('still moves the models when the database has already arrived — that is the broken install', () => {
    // The 2026-08-21 move took the database and left the 487 MB whisper model
    // behind, so dictation answered 503 while the file sat on disk. Everyone
    // hit by that has a data dir WITH a database, which is exactly the case
    // the database gate skips — so the models must not be behind it.
    const legacyRoot = tempDir('legacy-root');
    const legacyDir = path.join(legacyRoot, 'backend');
    fs.mkdirSync(legacyDir);
    const models = path.join(legacyRoot, 'models');
    fs.mkdirSync(models);
    fs.writeFileSync(path.join(models, 'ggml-small.bin'), 'whisper');
    const dataDir = path.join(tempDir('data'), '.syflo');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'syflo.db'), 'already here');

    const result = migrateLegacyData({ legacyDir, legacyModelsDir: models, dataDir });

    expect(result.moved).toEqual([path.join('models', 'ggml-small.bin')]);
    expect(fs.readFileSync(path.join(dataDir, 'models', 'ggml-small.bin'), 'utf8')).toBe('whisper');
    // …and the database it found there is untouched.
    expect(fs.readFileSync(path.join(dataDir, 'syflo.db'), 'utf8')).toBe('already here');
  });

  it('keeps a model already downloaded into the new folder', () => {
    const legacyRoot = tempDir('legacy-root');
    const legacyDir = path.join(legacyRoot, 'backend');
    fs.mkdirSync(legacyDir);
    const models = path.join(legacyRoot, 'models');
    fs.mkdirSync(models);
    fs.writeFileSync(path.join(models, 'bge-m3-q8_0.gguf'), 'stale copy');
    const dataDir = path.join(tempDir('data'), '.syflo');
    fs.mkdirSync(path.join(dataDir, 'models'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'models', 'bge-m3-q8_0.gguf'), 'the one in use');

    const result = migrateLegacyData({ legacyDir, legacyModelsDir: models, dataDir });

    expect(result.moved).toEqual([]);
    expect(fs.readFileSync(path.join(dataDir, 'models', 'bge-m3-q8_0.gguf'), 'utf8')).toBe('the one in use');
  });

  it('refuses to run without both paths, so no default can point at a real install', () => {
    expect(() => migrateLegacyData({ legacyDir: '/a' })).toThrow(/dataDir/);
    expect(() => migrateLegacyData({ dataDir: '/b' })).toThrow(/legacyDir/);
  });

  it('does nothing when there is no legacy database to move', () => {
    const legacyDir = tempDir('legacy');
    const dataDir = path.join(tempDir('data'), '.syflo');
    expect(migrateLegacyData({ legacyDir, dataDir }).moved).toEqual([]);
  });
});
