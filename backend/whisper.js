/**
 * whisper.js
 *
 * Lebenszyklus des lokalen whisper-server (ADR-0004): der Prozess ist KEIN
 * Dauerbewohner. Er wird beim ersten Diktat lazy gestartet und nach einer
 * Leerlaufzeit wieder beendet — auf 24 GB Unified Memory neben den
 * Ollama-Vision-Modellen wäre ein permanent residentes STT-Modell nur
 * zusätzliches Swap-Risiko für die Token-Generierung.
 *
 * Öffentliche Schnittstelle: createWhisperManager(options) →
 *   transcribe(wavBuffer) → Promise<string>   (wirft WhisperSetupError,
 *                                              wenn das Modell fehlt)
 *   isRunning() → boolean
 *   shutdown()  → Promise<void>
 *
 * Sprache wird NICHT vorgegeben: language=auto — Whisper erkennt Deutsch/
 * Englisch selbst, gemischte Sätze eingeschlossen (Grill-Entscheidung
 * 2026-07-23, kein UI-Umschalter).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.SYFLO_DATA_DIR || path.join(__dirname, '..');

const DEFAULT_MODEL = process.env.WHISPER_MODEL
  || path.join(DATA_DIR, 'models', 'ggml-small.bin');
const DEFAULT_BIN = process.env.WHISPER_SERVER_BIN || 'whisper-server';
// 8888 = Jupyter, 8890 = SearXNG — 8891 ist frei (siehe Latenz-Notizen).
const DEFAULT_PORT = Number(process.env.WHISPER_PORT || 8891);
const DEFAULT_IDLE_MS = 10 * 60 * 1000;

/** Modell (oder Binary) fehlt — der Aufrufer soll eine 503 mit Anleitung geben. */
class WhisperSetupError extends Error {}

// Whisper "transkribiert" Stille und Nicht-Sprache als Marker aus seinen
// Trainings-Untertiteln: [BLANK_AUDIO], [Musik], (soft music), ♪ … Solche
// rein beschreibenden Einschübe sind kein Diktat — sie fliegen raus. Bleibt
// nichts übrig, bekommt das Frontend einen leeren Text und hängt nichts ans
// Eingabefeld an.
const NON_SPEECH_MARKERS = /\[[^\]]*\]|\([^)]*\)|♪+/g;

// whisper-server trennt Segmente außerdem mit \n — für das Composer-Feld
// soll das Diktat ein Fließtext-Block sein.
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

  // Nach jedem Diktat neu aufgezogen; läuft er ab, wird der Server beendet
  // und der RAM ist wieder frei.
  function armIdleTimer() {
    clearIdleTimer();
    idleTimer = setTimeout(() => { shutdown(); }, idleMs);
    // Ein wartender Idle-Timer darf den Prozess-Exit (Tests, Server-Stop)
    // nicht blockieren.
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
    child.on('error', () => { /* Exit-Handler unten räumt auf */ });
    child.on('exit', () => {
      child = null;
      readyPromise = null;
      clearIdleTimer();
    });

    readyPromise = waitUntilReady().catch(err => {
      // Fehlstart: Zustand zurücksetzen, damit der nächste Versuch frisch ist.
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
    clearIdleTimer(); // während der Anfrage nicht abschalten

    try {
      const form = new FormData();
      form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
      form.append('language', 'auto');
      form.append('response_format', 'json');

      const res = await fetch(`http://127.0.0.1:${port}/inference`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`whisper-server answered ${res.status}: ${detail.slice(0, 200)}`);
      }
      const json = await res.json();
      return cleanTranscript(json.text);
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
      // Sicherheitsnetz, falls SIGTERM ignoriert wird.
      setTimeout(() => {
        try { running.kill('SIGKILL'); } catch (_) {}
        resolve();
      }, 2000).unref?.();
    });
  }

  return { transcribe, isRunning, shutdown };
}

module.exports = { createWhisperManager, WhisperSetupError, cleanTranscript };
