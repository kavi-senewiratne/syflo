/**
 * paths.js
 *
 * Where Syflo's data lives — and why it must not live next to the code.
 *
 * Until 2026-08-21 the database sat beside the source: `database.js` used
 * `__dirname`, `server.js` and `whisper.js` used `__dirname/..`, so the
 * database landed in `backend/` and the uploads in the repo root — two folders
 * for one dataset. Under the npm distribution (ADR-0009) that is worse than
 * untidy: `npm install -g syflo` puts the code in `node_modules/syflo`, and the
 * next `npm update` replaces that folder. The user's chats, trees and API keys
 * would go with it.
 *
 * The two jobs below are deliberately separate, and that separation is the
 * safety mechanism, not a style choice: on 2026-08-21 a single function that
 * both resolved AND migrated moved a real 11 MB database into a temp folder
 * because a test called it. So:
 *
 *   resolveDataDir()   answers a question. It creates nothing, moves nothing.
 *   migrateLegacyData() moves things, and throws unless BOTH paths are passed
 *                       in explicitly — there is no default a test could hit.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_FILENAME = 'syflo.db';
// SQLite's write-ahead log and shared-memory files belong to the database; a
// database moved without them can lose the most recent transactions.
const DB_SIDECARS = ['syflo.db-wal', 'syflo.db-shm'];

/**
 * The folder that holds the database and the uploads.
 *
 * `SYFLO_DATA_DIR` wins: the Electron build sets it to the app's support
 * directory, and that must keep working untouched. Otherwise `~/.syflo`, which
 * survives every reinstall.
 *
 * Pure on purpose — see the file header.
 */
function resolveDataDir({ env = process.env, homedir = os.homedir } = {}) {
  if (env.SYFLO_DATA_DIR) return env.SYFLO_DATA_DIR;
  return path.join(homedir(), '.syflo');
}

/**
 * Move a pre-npm installation's data into `dataDir`, once.
 *
 * Refuses to guess: both `legacyDir` (where `syflo.db` used to sit, i.e.
 * `backend/`) and `dataDir` must be given. `legacyUploadsDir` and
 * `legacyModelsDir` are optional because both lived one level up from the
 * database.
 *
 * The new location always wins: a file that already exists there is never
 * overwritten. If the new location already holds a database, the database and
 * the uploads are left alone entirely — moving them would discard newer work.
 *
 * The MODELS are deliberately not behind that gate. They are downloads, not
 * user data: nothing in them can be "newer work", and the installation that
 * needs them moved is precisely the one whose database has already arrived.
 * Gating them on the database is what left dictation broken after 2026-08-21
 * (see the models block below).
 *
 * Returns `{ moved: string[] }`, so the caller can log what happened instead
 * of the migration deciding on its own how loud to be.
 */
function migrateLegacyData({ legacyDir, legacyUploadsDir, legacyModelsDir, dataDir }) {
  if (!legacyDir) throw new Error('migrateLegacyData needs an explicit legacyDir');
  if (!dataDir) throw new Error('migrateLegacyData needs an explicit dataDir');

  const moved = [];
  const target = path.join(dataDir, DB_FILENAME);
  const source = path.join(legacyDir, DB_FILENAME);

  if (!fs.existsSync(target) && fs.existsSync(source)) {
    fs.mkdirSync(dataDir, { recursive: true });
    for (const name of [DB_FILENAME, ...DB_SIDECARS]) {
      const from = path.join(legacyDir, name);
      if (!fs.existsSync(from)) continue;
      fs.renameSync(from, path.join(dataDir, name));
      moved.push(name);
    }

    // Attachments are referenced by path in the database, so they have to
    // travel with it or every image in an old chat turns into a broken link.
    // Which also means they must NOT travel without it.
    if (legacyUploadsDir && fs.existsSync(legacyUploadsDir)) {
      const uploadsTarget = path.join(dataDir, 'uploads');
      if (!fs.existsSync(uploadsTarget)) {
        fs.renameSync(legacyUploadsDir, uploadsTarget);
        moved.push('uploads');
      }
    }
  }

  // whisper.js and the embedding download both resolve `models/` UNDER the
  // data dir, so a model left behind in the old location is a model the app
  // cannot see. Forgetting them in the 2026-08-21 move silently broke
  // dictation: whisper-server was installed and ggml-small.bin was on disk,
  // but 487 MB away from where whisper.js looked, and the only symptom was a
  // 503 telling the user to download it again.
  //
  // Merged file by file rather than renamed as a whole, because the embedding
  // model may already have been downloaded into the new location — a directory
  // rename would refuse or clobber it.
  if (legacyModelsDir && fs.existsSync(legacyModelsDir)) {
    const modelsTarget = path.join(dataDir, 'models');
    for (const name of fs.readdirSync(legacyModelsDir)) {
      const from = path.join(legacyModelsDir, name);
      const to = path.join(modelsTarget, name);
      if (!fs.statSync(from).isFile() || fs.existsSync(to)) continue;
      fs.mkdirSync(modelsTarget, { recursive: true });
      fs.renameSync(from, to);
      moved.push(path.join('models', name));
    }
  }
  return { moved };
}

module.exports = { resolveDataDir, migrateLegacyData, DB_FILENAME };
