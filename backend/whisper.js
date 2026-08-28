/**
 * whisper.js
 *
 * Lifecycle of the local whisper-server (ADR-0004): the process is NOT a
 * permanent resident. It is lazily started on the first dictation and
 * terminated again after an idle period — on 24 GB unified memory next to
 * the Ollama vision models, a permanently resident STT model would only be
 * additional swap risk for token generation.
 *
 * Public interface: createWhisperManager(options) →
 *   transcribe(wavBuffer) → Promise<string>   (throws WhisperSetupError
 *                                              when the model is missing)
 *   isRunning() → boolean
 *   shutdown()  → Promise<void>
 *
 * Language is NOT prescribed: language=auto — Whisper detects German/
 * English itself, mixed sentences included (grill decision 2026-07-23,
 * no UI toggle).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const { resolveDataDir } = require('./paths');

const DATA_DIR = resolveDataDir();

const DEFAULT_MODEL = process.env.WHISPER_MODEL
  || path.join(DATA_DIR, 'models', 'ggml-small.bin');
const DEFAULT_BIN = process.env.WHISPER_SERVER_BIN || 'whisper-server';
// 8888 = Jupyter, 8890 = SearXNG — 8891 is free (see latency notes).
const DEFAULT_PORT = Number(process.env.WHISPER_PORT || 8891);
const DEFAULT_IDLE_MS = 10 * 60 * 1000;

/** Model (or binary) is missing — the caller should return a 503 with instructions. */
class WhisperSetupError extends Error {}

// Whisper "transcribes" silence and non-speech as markers from its training
// subtitles: [BLANK_AUDIO], [Musik], (soft music), ♪ … Such purely
// descriptive insertions are not dictation — they get thrown out. If
// nothing remains, the frontend gets an empty text and appends nothing to
// the input field.
const NON_SPEECH_MARKERS = /\[[^\]]*\]|\([^)]*\)|♪+/g;

// whisper-server also separates segments with \n — for the composer field
// the dictation should be one flowing-text block.
function cleanTranscript(raw) {
  return (raw || '')
    .replace(NON_SPEECH_MARKERS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function createWhisperManager({
  buildCommand = (port) => [
    DEFAULT_BIN,
    '-m', DEFAULT_MODEL,
    '--host', '127.0.0.1',
    '--port', String(port),
  ],
  modelPath = DEFAULT_MODEL,
  port = DEFAULT_PORT,
  idleMs = DEFAULT_IDLE_MS,
  readyTimeoutMs = 20_000,
} = {}) {
  let child = null;
  let readyPromise = null;
  let idleTimer = null;

  function isRunning() {
    return child !== null;
  }

  function clearIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  // Re-armed after every dictation; when it expires, the server is
  // terminated and the RAM is free again.
  function armIdleTimer() {
    clearIdleTimer();
    idleTimer = setTimeout(() => { shutdown(); }, idleMs);
    // A pending idle timer must not block process exit (tests, server
    // stop).
    if (idleTimer.unref) idleTimer.unref();
  }

  async function waitUntilReady() {
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (!child) throw new Error('whisper-server exited before becoming ready');
      try {
        await fetch(`http://127.0.0.1:${port}/`);
        return;
      } catch (_) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    throw new Error('whisper-server did not become ready in time');
  }

  function ensureStarted() {
    if (readyPromise) return readyPromise;

    if (!modelPath || !fs.existsSync(modelPath)) {
      return Promise.reject(new WhisperSetupError(
        `Whisper model not found at ${modelPath}. ` +
        'Run scripts/setup-whisper.sh to download it.'
      ));
    }

    const [bin, ...args] = buildCommand(port);
    try {
      child = spawn(bin, args, { stdio: 'ignore' });
    } catch (err) {
      child = null;
      return Promise.reject(new WhisperSetupError(
        `Could not start ${bin}: ${err.message}. Is whisper-cpp installed?`
      ));
    }
    child.on('error', () => { /* the exit handler below cleans up */ });
    child.on('exit', () => {
      child = null;
      readyPromise = null;
      clearIdleTimer();
    });

    readyPromise = waitUntilReady().catch(err => {
      // Failed start: reset state so the next attempt starts fresh.
      const failed = child;
      child = null;
      readyPromise = null;
      if (failed) try { failed.kill('SIGTERM'); } catch (_) {}
      throw err instanceof WhisperSetupError ? err : new WhisperSetupError(
        `whisper-server failed to start: ${err.message}. Is whisper-cpp installed ` +
        '(brew install whisper-cpp)?'
      );
    });
    return readyPromise;
  }

  async function transcribe(wavBuffer) {
    await ensureStarted();
    clearIdleTimer(); // do not shut down during the request

    try {
      const form = new FormData();
      form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
      form.append('language', 'auto');
      // verbose_json instead of json for ONE extra field: the language whisper
      // decided on. A user reported German coming back as English (2026-08-28)
      // and nothing in the log could tell the two possible causes apart —
      // whisper detecting 'english' and translating, or whisper detecting
      // 'german' and something downstream replacing the text. The line below
      // separates them at the moment it happens. `text` is identical in both
      // formats, so nothing else changes.
      form.append('response_format', 'verbose_json');

      const res = await fetch(`http://127.0.0.1:${port}/inference`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`whisper-server answered ${res.status}: ${detail.slice(0, 200)}`);
      }
      const json = await res.json();
      const text = cleanTranscript(json.text);
      console.log(
        `[whisper] detected=${json.language || 'unknown'} ` +
        `audio=${Number(json.duration || 0).toFixed(1)}s chars=${text.length}`
      );
      return text;
    } finally {
      armIdleTimer();
    }
  }

  async function shutdown() {
    clearIdleTimer();
    readyPromise = null;
    const running = child;
    child = null;
    if (!running) return;
    await new Promise(resolve => {
      running.once('exit', resolve);
      try { running.kill('SIGTERM'); } catch (_) { resolve(); }
      // Safety net in case SIGTERM is ignored.
      setTimeout(() => {
        try { running.kill('SIGKILL'); } catch (_) {}
        resolve();
      }, 2000).unref?.();
    });
  }

  return { transcribe, isRunning, shutdown };
}

module.exports = { createWhisperManager, WhisperSetupError, cleanTranscript };
