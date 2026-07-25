/**
 * tests/transcribe.test.js
 *
 * Integration tests for POST /api/transcribe (ADR-0004: on-device Whisper).
 * The whisper-server binary is replaced by tests/fake-whisper-server.js —
 * the manager under test still does the real work: lazy spawn, readiness
 * poll, multipart upload, idle shutdown.
 */

const request = require('supertest');
const path = require('path');
const { createApp } = require('../server');
const { createDb } = require('../database');
const { createWhisperManager, cleanTranscript } = require('../whisper');

const TEST_DB_PATH = path.join(__dirname, 'transcribe_test.db');
const fs = require('fs');

const FAKE_SERVER = path.join(__dirname, 'fake-whisper-server.js');
const PORT = 18991;

// Ein winziges, aber echtes WAV (44-Byte-Header + ein paar Samples) — der
// Endpoint soll echte Bytes durchreichen, nicht nur "irgendein Body".
function tinyWav() {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.write('WAVEfmt ', 8);
  header.write('data', 36);
  return Buffer.concat([header, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])]);
}

function makeManager(overrides = {}) {
  return createWhisperManager({
    buildCommand: (port) => ['node', FAKE_SERVER, String(port)],
    modelPath: __filename, // irgendeine existierende Datei
    port: PORT,
    idleMs: 60_000,
    ...overrides,
  });
}

let db;
let app;
let manager;

beforeEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
});

afterEach(async () => {
  if (manager) await manager.shutdown();
  manager = null;
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

describe('POST /api/transcribe', () => {
  it('returns the transcript for a posted WAV', async () => {
    manager = makeManager();
    app = createApp(db, { transcribe: { manager } });

    const res = await request(app)
      .post('/api/transcribe')
      .set('Content-Type', 'audio/wav')
      .send(tinyWav());

    expect(res.status).toBe(200);
    expect(res.body.text).toContain('fake transcript');
  });

  it('starts the whisper server lazily — no process before the first request', async () => {
    manager = makeManager();
    app = createApp(db, { transcribe: { manager } });

    expect(manager.isRunning()).toBe(false);

    await request(app)
      .post('/api/transcribe')
      .set('Content-Type', 'audio/wav')
      .send(tinyWav());

    expect(manager.isRunning()).toBe(true);
  });

  it('shuts the whisper server down after the idle timeout and restarts on demand', async () => {
    manager = makeManager({ idleMs: 150 });
    app = createApp(db, { transcribe: { manager } });

    await request(app)
      .post('/api/transcribe')
      .set('Content-Type', 'audio/wav')
      .send(tinyWav());
    expect(manager.isRunning()).toBe(true);

    // Idle-Timeout verstreichen lassen → Prozess muss weg sein.
    await new Promise(r => setTimeout(r, 500));
    expect(manager.isRunning()).toBe(false);

    // Nächstes Diktat startet ihn transparent neu.
    const res = await request(app)
      .post('/api/transcribe')
      .set('Content-Type', 'audio/wav')
      .send(tinyWav());
    expect(res.status).toBe(200);
    expect(res.body.text).toContain('fake transcript');
  });

  it('answers 503 with a setup hint when the model file is missing', async () => {
    manager = makeManager({ modelPath: path.join(__dirname, 'does-not-exist.bin') });
    app = createApp(db, { transcribe: { manager } });

    const res = await request(app)
      .post('/api/transcribe')
      .set('Content-Type', 'audio/wav')
      .send(tinyWav());

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/setup-whisper/);
    expect(manager.isRunning()).toBe(false);
  });

  it('forwards language=auto and the audio bytes to the whisper server', async () => {
    manager = makeManager();
    app = createApp(db, { transcribe: { manager } });

    const wav = tinyWav();
    const res = await request(app)
      .post('/api/transcribe')
      .set('Content-Type', 'audio/wav')
      .send(wav);

    // Der Fake spiegelt die empfangenen Multipart-Felder in den Text.
    expect(res.body.text).toContain('language=auto');
    expect(res.body.text).toContain(`bytes=${wav.length}`);
  });

  it('collapses whisper segment line breaks into single spaces', async () => {
    // whisper-server trennt Segmente mit \n — im Composer soll das Diktat
    // aber als EIN Fließtext-Block landen.
    manager = makeManager();
    app = createApp(db, { transcribe: { manager } });

    const res = await request(app)
      .post('/api/transcribe')
      .set('Content-Type', 'audio/wav')
      .send(tinyWav());

    expect(res.body.text).not.toMatch(/\n/);
    expect(res.body.text).toMatch(/fake transcript language=/);
  });

  it('rejects an empty body with 400', async () => {
    manager = makeManager();
    app = createApp(db, { transcribe: { manager } });

    const res = await request(app)
      .post('/api/transcribe')
      .set('Content-Type', 'audio/wav')
      .send();

    expect(res.status).toBe(400);
  });
});

// Whisper gibt bei Stille/Nicht-Sprache Marker aus den Trainings-Untertiteln
// zurück ([BLANK_AUDIO], [Musik], (soft music), ♪) — die dürfen nie als
// "Diktat" im Eingabefeld landen.
describe('cleanTranscript – Nicht-Sprach-Marker', () => {
  it('turns a silence-only transcript into an empty string', () => {
    expect(cleanTranscript('[BLANK_AUDIO]')).toBe('');
    expect(cleanTranscript(' [BLANK_AUDIO] \n [BLANK_AUDIO] ')).toBe('');
    expect(cleanTranscript('(leise Musik)')).toBe('');
    expect(cleanTranscript('♪♪♪')).toBe('');
    expect(cleanTranscript(null)).toBe('');
  });

  it('strips markers but keeps the actual speech around them', () => {
    expect(cleanTranscript('[BLANK_AUDIO] Hallo Welt (soft music)')).toBe('Hallo Welt');
    expect(cleanTranscript('Guten [Musik] Morgen')).toBe('Guten Morgen');
  });

  it('collapses whitespace/segment breaks and passes normal text through', () => {
    expect(cleanTranscript(' fake transcript\n language=auto ')).toBe('fake transcript language=auto');
  });
});
