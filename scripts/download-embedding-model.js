/**
 * download-embedding-model.js — the `postinstall` step from mockup §00,
 * variant I3 ("automatically, while installing"), chosen on 2026-08-15.
 *
 * Why this script exists: embeddings are always local (ADR-0008), so the
 * retrieval mode for long papers has a hard dependency — bge-m3 — that until
 * now nobody announced. The user had to type `ollama pull bge-m3` in a
 * terminal, and only found out it was missing when a long paper stayed silent.
 * Since embeddings moved to node-llama-cpp, that dependency is a single GGUF
 * file, and a plain file download is something an install step can honestly
 * finish. So it does.
 *
 * The mockup's objection to I3 stands and is answered here rather than waved
 * away: a GB-sized download inside `postinstall` breaks npm conventions, so
 * this script must be switchable off (SYFLO_SKIP_MODEL), must never run in CI,
 * must print progress so a 605 MB fetch does not look like a hang, and must
 * never fail the installation — a missing embedding model only means retrieval
 * mode rests, the app itself runs.
 */

const fs = require('fs');
const path = require('path');
const { once } = require('events');

const {
  EMBEDDING_MODEL_FILE,
  EMBEDDING_MODEL_URL,
  EMBEDDING_MODEL_BYTES,
} = require('../backend/embeddings');
const { resolveDataDir } = require('../backend/paths');

/** Where the GGUF belongs: next to the user's data, not next to the code. */
function defaultModelDir(env = process.env) {
  return env.SYFLO_EMBEDDING_MODEL_DIR || path.join(resolveDataDir({ env }), 'models');
}

/**
 * Decide what the install step should do — without doing any of it.
 *
 * Kept separate from the download for the same reason paths.js splits
 * resolving from migrating: a decision can be tested exhaustively, and a
 * function that only answers a question can never move a user's files.
 */
function planDownload({ modelDir, env = process.env, fileSystem = fs, packageRoot = path.join(__dirname, '..') } = {}) {
  const dir = modelDir || defaultModelDir(env);
  // Every plan names the file, its source and its size — a skipped plan
  // included. Found by running the script by hand: when only the go-ahead plan
  // carried the URL, the opt-out branch printed "download it by hand:
  // undefined", i.e. the one case where the user has to do it themselves.
  const what = {
    targetPath: path.join(dir, EMBEDDING_MODEL_FILE),
    url: EMBEDDING_MODEL_URL,
    expectedBytes: EMBEDDING_MODEL_BYTES,
  };

  // Presence first: "it is already here" is the truest answer, and it is what
  // makes `npm update` cheap instead of a repeated 605 MB fetch.
  if (fileSystem.existsSync(what.targetPath)) {
    return { skip: true, reason: 'already-present', ...what };
  }

  // The off switch, and it is not optional politeness: a GB download inside
  // `postinstall` has to be refusable, or Syflo breaks metered connections,
  // Docker builds and anyone who installs with `--ignore-scripts`.
  if (env.SYFLO_SKIP_MODEL) {
    return { skip: true, reason: 'opted-out', ...what };
  }

  // Nobody watches a CI install, and no CI job wants the model: a pipeline
  // that installs Syflo to run its tests would pay 605 MB per run for a file
  // it throws away. `CI` is the one variable every runner sets.
  if (env.CI) {
    return { skip: true, reason: 'ci', ...what };
  }

  // A development checkout is not an installation. Without this, `npm install`
  // in a clone — the thing a contributor does first — would start a real
  // 605 MB download nobody asked for. A clone has .git and is not a global
  // install; `npm install -g syflo` from the same tree still downloads.
  if (env.npm_config_global !== 'true' && fileSystem.existsSync(path.join(packageRoot, '.git'))) {
    return { skip: true, reason: 'dev-checkout', ...what };
  }

  return { skip: false, ...what };
}

// Progress is reported every 5 % rather than per chunk: a 605 MB download
// arrives in tens of thousands of chunks, and a line per chunk would bury the
// rest of npm's output.
const PROGRESS_STEP = 0.05;

// How long to wait for the server to start answering. The body itself gets no
// deadline — 605 MB is slow on a slow line, and that is fine — but a silent
// socket would otherwise hang `npm install` with no output and no end. This
// repo has been bitten by a missing timeout before (CLAUDE.md).
const RESPONSE_TIMEOUT_MS = 60_000;

/**
 * Fetch the model to `plan.targetPath`.
 *
 * Why plain `fetch` and not node-llama-cpp's own `createModelDownloader`:
 * `postinstall` runs while npm is still assembling the tree, so a dependency's
 * ESM entry point (and its optional native binary) may not be importable yet —
 * and the one job that must not fail because of a half-installed tree is the
 * one that installs. Node 20's built-in `fetch` needs nothing but Node.
 *
 * Never throws. The install step wants a verdict it can print, not a stack
 * trace that npm turns into a failed installation.
 */
async function downloadModel(
  plan,
  {
    fetchFn = (...args) => fetch(...args),
    fileSystem = fs,
    onProgress = () => {},
    progressStep = PROGRESS_STEP,
    timeoutMs = RESPONSE_TIMEOUT_MS,
  } = {}
) {
  // The download lands in `<target>.part` and is renamed only once the whole
  // file is there. Writing to the final name directly would leave a truncated
  // GGUF that looks like a finished model: isEmbeddingModelPresent() would say
  // yes, and node-llama-cpp would crash trying to load it.
  const partPath = `${plan.targetPath}.part`;
  try {
    fileSystem.mkdirSync(path.dirname(plan.targetPath), { recursive: true });
  } catch (err) {
    // A read-only or unwritable data directory is a real case (a locked-down
    // machine, a stale SYFLO_DATA_DIR) and it is not a reason to fail an
    // installation.
    return { ok: false, error: 'target-unwritable', detail: err.message };
  }

  // The deadline covers the handshake only, and is cleared the moment headers
  // arrive — otherwise it would cut off a legitimately slow 605 MB body.
  const clock = new AbortController();
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    clock.abort();
  }, timeoutMs);

  let response;
  try {
    response = await fetchFn(plan.url, { signal: clock.signal });
  } catch (err) {
    return { ok: false, error: timedOut ? 'timeout' : 'network-error', detail: err.message };
  } finally {
    clearTimeout(deadline);
  }
  if (!response.ok) {
    return { ok: false, error: 'http-error', detail: `HTTP ${response.status}` };
  }

  const out = fileSystem.createWriteStream(partPath);
  let received = 0;
  let reportedAt = 0;
  try {
    for await (const chunk of response.body) {
      // Respect backpressure: 605 MB arriving faster than the disk accepts it
      // would otherwise pile up in memory.
      if (!out.write(chunk)) await once(out, 'drain');
      received += chunk.length;
      const share = plan.expectedBytes ? received / plan.expectedBytes : 0;
      if (share - reportedAt >= progressStep) {
        reportedAt = share;
        onProgress({ received, total: plan.expectedBytes, share });
      }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    // A partial file has no value — there is no resume here — and leaving it
    // would only confuse the next run.
    discard(fileSystem, partPath);
    return { ok: false, error: 'download-interrupted', detail: err.message, received };
  }

  // The size is the cheap integrity check that catches the realistic failures:
  // a proxy's HTML error page served with 200, or a connection that ended
  // cleanly but early. A short GGUF is worse than no GGUF — node-llama-cpp
  // aborts the process when it cannot parse one.
  if (plan.expectedBytes && received !== plan.expectedBytes) {
    discard(fileSystem, partPath);
    return { ok: false, error: 'size-mismatch', expected: plan.expectedBytes, received };
  }

  fileSystem.renameSync(partPath, plan.targetPath);
  return { ok: true, bytes: received };
}

/** Remove a leftover intermediate file, never making noise about it. */
function discard(fileSystem, filePath) {
  try {
    fileSystem.unlinkSync(filePath);
  } catch (_) { /* already gone is the outcome we wanted */ }
}

function megabytes(bytes) {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

// Every explanation of a missing model ends the same way, and it has to say
// three things: what is missing, what still works without it, and how to get
// it later. A message that only says "failed" leaves the user with a silent
// retrieval mode and no idea why.
function catchUpNotes(plan) {
  return [
    '  Retrieval mode for long papers stays off until the model is there;',
    '  everything else in Syflo works as normal.',
    '  To fetch it later, re-run: npm install -g syflo',
    `  Or download it by hand: ${plan.url}`,
    `  and save it as: ${plan.targetPath}`,
  ];
}

/**
 * The `postinstall` entry point.
 *
 * Returns an exit code instead of calling `process.exit`, so the decision
 * "does this failure fail the installation?" is a testable value. The answer
 * is always no: a missing embedding model rests one feature, while a non-zero
 * exit from `postinstall` aborts `npm install -g syflo` entirely.
 */
async function run({
  modelDir,
  env = process.env,
  fileSystem = fs,
  fetchFn,
  log = console.log,
  onProgress,
  progressStep,
  packageRoot,
} = {}) {
  const plan = planDownload({ modelDir, env, fileSystem, packageRoot });

  if (plan.skip) {
    if (plan.reason === 'already-present') {
      log(`[syflo] Embedding model already present (${plan.targetPath}).`);
    } else if (plan.reason === 'opted-out') {
      log('[syflo] SYFLO_SKIP_MODEL is set — skipping the embedding model download.');
      for (const line of catchUpNotes(plan)) log(line);
    } else if (plan.reason === 'ci') {
      log('[syflo] CI detected — skipping the embedding model download.');
    } else if (plan.reason === 'dev-checkout') {
      log('[syflo] Development checkout — skipping the embedding model download.');
      for (const line of catchUpNotes(plan)) log(line);
    }
    return { exitCode: 0, plan };
  }

  log(
    `[syflo] Downloading the embedding model for retrieval mode (${megabytes(plan.expectedBytes)}).`
  );
  log('        Set SYFLO_SKIP_MODEL=1 to skip this next time.');

  const result = await downloadModel(plan, {
    fetchFn,
    fileSystem,
    progressStep,
    // Plain lines, no carriage-return redrawing: npm captures this output and
    // may not be a terminal at all, and a rewritten line would be garbage in a
    // log file.
    onProgress:
      onProgress ||
      (({ received, total, share }) =>
        log(`        ${Math.round(share * 100)} % — ${megabytes(received)} of ${megabytes(total)}`)),
  });

  if (result.ok) {
    log(`[syflo] Embedding model ready: ${plan.targetPath}`);
    return { exitCode: 0, plan, result };
  }

  log(`[syflo] Could not download the embedding model (${result.error}).`);
  for (const line of catchUpNotes(plan)) log(line);
  return { exitCode: 0, plan, result };
}

module.exports = { planDownload, downloadModel, run };

// Run as `postinstall`. The catch-all is the last guard for the same rule the
// whole file follows: whatever goes wrong here, `npm install -g syflo` must
// still succeed. process.exitCode (not process.exit) lets buffered output
// flush.
if (require.main === module) {
  run()
    .catch((err) => {
      console.log(`[syflo] Skipping the embedding model download (${err.message}).`);
    })
    .then(() => {
      process.exitCode = 0;
    });
}
