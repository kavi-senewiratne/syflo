/**
 * routes/transcribe.js
 *
 * POST /api/transcribe — nimmt ein WAV (audio/wav, roher Body) entgegen und
 * antwortet mit { text }. Die eigentliche Erkennung macht der lazy
 * gestartete lokale whisper-server (siehe whisper.js, ADR-0004).
 *
 * options.manager ist für Tests injizierbar (gleiches Muster wie
 * options.system / options.messages in server.js).
 */

const express = require('express');
const { createWhisperManager, WhisperSetupError } = require('../whisper');

// Diagnose-Kennzahlen des empfangenen WAVs (16-bit-PCM, Header 44 Bytes):
// Dauer und Pegel. Ein Diktat, das "nichts erkennt", ist fast immer zu
// leises Audio (Mikro-Pegel/Abstand) — diese eine Logzeile unterscheidet
// "Audio kam leer/leise an" von "Whisper hat versagt" (Diagnose 2026-07-24).
function wavStats(buf) {
  const dataBytes = Math.max(0, buf.length - 44);
  const sampleRate = buf.length >= 28 ? buf.readUInt32LE(24) : 16000;
  const n = Math.floor(dataBytes / 2);
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(44 + i * 2) / 32768;
    sumSq += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  return {
    seconds: sampleRate > 0 ? n / sampleRate : 0,
    rms: n > 0 ? Math.sqrt(sumSq / n) : 0,
    peak,
  };
}

module.exports = (options = {}) => {
  const router = express.Router();
  const manager = options.manager || createWhisperManager();

  // 2 Minuten Diktat bei 16 kHz mono 16-bit ≈ 4 MB — 50 MB ist großzügig.
  router.post('/', express.raw({ type: 'audio/wav', limit: '50mb' }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Expected a non-empty audio/wav body' });
    }
    try {
      const text = await manager.transcribe(req.body);
      const { seconds, rms, peak } = wavStats(req.body);
      console.log(
        `[transcribe] ${seconds.toFixed(1)}s wav, rms=${rms.toFixed(4)}, peak=${peak.toFixed(3)}, ` +
        `text=${JSON.stringify(text.slice(0, 80))}` +
        (rms < 0.005 ? ' — audio nahezu still (Mikro-Pegel/Abstand prüfen?)' : ''),
      );
      res.json({ text });
    } catch (err) {
      if (err instanceof WhisperSetupError) {
        return res.status(503).json({ error: err.message });
      }
      console.error('[transcribe]', err.message);
      res.status(502).json({ error: `Transcription failed: ${err.message}` });
    }
  });

  return router;
};
