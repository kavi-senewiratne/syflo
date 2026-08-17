/**
 * tests/transcript-highlights.test.js
 *
 * Farbige Markierungen im Transcript (design/mockup-transcript-selection.html,
 * Nutzerwahl Variante A 2026-08-16, Farben nachgereicht am selben Tag).
 *
 * Eigener Anker, eigene Tabelle: eine PDF-Markierung hängt an Seite und
 * Rechtecken, eine Chat-Markierung an einer Nachricht — eine
 * Transcript-Markierung hängt am VIDEO und an Zeichen-Offsets in seinem
 * Transcript-Text. Dazu kommt die Sekunde ihres Blocks: sie macht aus „zum
 * Text springen" ein „und hör es dir an" (Nutzerentscheid 2026-08-16, die
 * Sekunde wird gelesen, nie ausgewählt).
 */

const request = require('supertest');
const { createApp } = require('../server');
const { createDb } = require('../database');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'transcript_hl_test.db');

let app;
let db;
let videoId;
let chatId;

beforeEach(async () => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
  app = createApp(db);

  const chat = await request(app).post('/api/chats').send({ title: 'Video' });
  chatId = chat.body.id;
  videoId = 'v-test';
  db.prepare(
    `INSERT INTO videos (id, youtube_id, title, channel, duration_seconds, language, url, transcript, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    videoId, 'abc123', 'Intro to LLMs', 'Karpathy', 3587, 'en',
    'https://youtube.com/watch?v=abc123',
    '[00:00] Hi everyone.\n\n[07:30] A feature is the smallest unit we can still understand.',
    new Date().toISOString(),
  );
  db.prepare('UPDATE chats SET video_id = ? WHERE id = ?').run(videoId, chatId);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

const payload = (over = {}) => ({
  color: 'yellow',
  text: 'the smallest unit we can still understand',
  startOffset: 34,
  endOffset: 74,
  startSeconds: 450,
  ...over,
});

describe('transcript highlights', () => {
  it('saves a colored mark against the video, with the second of its block', async () => {
    const res = await request(app)
      .post(`/api/videos/${videoId}/transcript-highlights`)
      .send(payload());

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      videoId,
      color: 'yellow',
      startOffset: 34,
      endOffset: 74,
      startSeconds: 450,
    });

    const list = await request(app).get(`/api/videos/${videoId}/transcript-highlights`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].text).toBe('the smallest unit we can still understand');
  });

  it('recolors a mark instead of leaving a trail of duplicates', async () => {
    const created = await request(app)
      .post(`/api/videos/${videoId}/transcript-highlights`)
      .send(payload());

    const res = await request(app)
      .patch(`/api/transcript-highlights/${created.body.id}`)
      .send({ color: 'green' });

    expect(res.status).toBe(200);
    expect(res.body.color).toBe('green');
    const list = await request(app).get(`/api/videos/${videoId}/transcript-highlights`);
    expect(list.body).toHaveLength(1);
  });

  it('links the branch that was opened from the passage', async () => {
    const created = await request(app)
      .post(`/api/videos/${videoId}/transcript-highlights`)
      .send(payload());
    const branch = await request(app)
      .post('/api/chats')
      .send({ title: 'Über Features', parent_id: chatId, parent_word: 'a feature' });

    const res = await request(app)
      .patch(`/api/transcript-highlights/${created.body.id}`)
      .send({ childChatId: branch.body.id });

    expect(res.body.childChatId).toBe(branch.body.id);
  });

  it('outlives the branch it opened — deleting the chat keeps the mark', async () => {
    const created = await request(app)
      .post(`/api/videos/${videoId}/transcript-highlights`)
      .send(payload());
    const branch = await request(app)
      .post('/api/chats')
      .send({ title: 'Über Features', parent_id: chatId, parent_word: 'a feature' });
    await request(app)
      .patch(`/api/transcript-highlights/${created.body.id}`)
      .send({ childChatId: branch.body.id });

    await request(app).delete(`/api/chats/${branch.body.id}`);

    const list = await request(app).get(`/api/videos/${videoId}/transcript-highlights`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].childChatId).toBeNull();
  });

  it('deletes a mark', async () => {
    const created = await request(app)
      .post(`/api/videos/${videoId}/transcript-highlights`)
      .send(payload());

    const res = await request(app).delete(`/api/transcript-highlights/${created.body.id}`);

    expect(res.status).toBe(204);
    const list = await request(app).get(`/api/videos/${videoId}/transcript-highlights`);
    expect(list.body).toHaveLength(0);
  });

  it('marks a chapter passage too — same table, different source text', async () => {
    // User request 2026-08-16: chapters should be colorable as well. Their
    // offsets point into the OVERVIEW text, not the transcript, so the source
    // has to travel with the mark or the two would paint over each other.
    const res = await request(app)
      .post(`/api/videos/${videoId}/transcript-highlights`)
      .send(payload({ source: 'chapter', text: 'Was ist Mechanistic Interpretability?' }));

    expect(res.status).toBe(201);
    expect(res.body.source).toBe('chapter');

    const list = await request(app).get(`/api/videos/${videoId}/transcript-highlights`);
    expect(list.body[0].source).toBe('chapter');
  });

  it('defaults to the transcript when no source is given', async () => {
    const res = await request(app)
      .post(`/api/videos/${videoId}/transcript-highlights`)
      .send(payload());
    expect(res.body.source).toBe('transcript');
  });

  it('rejects a source it cannot paint', async () => {
    const res = await request(app)
      .post(`/api/videos/${videoId}/transcript-highlights`)
      .send(payload({ source: 'subtitles' }));
    expect(res.status).toBe(400);
  });

  it('rejects a color that is not one of the five', async () => {
    const res = await request(app)
      .post(`/api/videos/${videoId}/transcript-highlights`)
      .send(payload({ color: 'purple' }));

    expect(res.status).toBe(400);
  });

  it('accepts a passage without a second — a transcript may carry no marks', async () => {
    const res = await request(app)
      .post(`/api/videos/${videoId}/transcript-highlights`)
      .send(payload({ startSeconds: null }));

    expect(res.status).toBe(201);
    expect(res.body.startSeconds).toBeNull();
  });
});

// ─── Farbbalken des Mindmap-Knotens ────────────────────────────────────────
// Nutzer-Report mit Bild 2026-08-16: Zweige aus Transcript- oder
// Kapitel-Markierungen standen in der Mindmap ohne Farbe da. Die Abfrage in
// routes/chats.js kannte nur zwei Anker (PDF und Chat-Text) — der dritte
// fehlte, also blieb highlight_color null.

describe('the mindmap node knows the color it was branched from', () => {
  it('reports the color of a transcript mark on its branch', async () => {
    const branch = await request(app)
      .post('/api/chats')
      .send({ title: 'Über Features', parent_id: chatId, parent_word: 'a feature' });
    await request(app)
      .post(`/api/videos/${videoId}/transcript-highlights`)
      .send(payload({ color: 'green', childChatId: branch.body.id }));

    const tree = await request(app).get('/api/chats/tree');

    const found = tree.body
      .flatMap((c) => [c, ...(c.children ?? [])])
      .find((c) => c.id === branch.body.id);
    expect(found).toBeDefined();
    expect(found.highlight_color).toBe('green');
  });

  it('does the same for a chapter mark', async () => {
    const branch = await request(app)
      .post('/api/chats')
      .send({ title: 'Über Kapitel', parent_id: chatId, parent_word: 'Was ist das?' });
    await request(app)
      .post(`/api/videos/${videoId}/transcript-highlights`)
      .send(payload({ color: 'pink', source: 'chapter', childChatId: branch.body.id }));

    const tree = await request(app).get('/api/chats/tree');
    const found = tree.body
      .flatMap((c) => [c, ...(c.children ?? [])])
      .find((c) => c.id === branch.body.id);
    expect(found.highlight_color).toBe('pink');
  });
});

// ─── Highlights-Schublade ──────────────────────────────────────────────────
// Nutzer-Report 2026-08-16: „die pinken stehen nicht in Highlights". Die
// Aggregation kannte nur PDF- und Chat-Markierungen; die dritte Sorte fehlte,
// also fehlte sie auch in der Übersicht des Baums.

describe('tree-highlights includes the video marks', () => {
  it('lists transcript and chapter marks next to the chat ones', async () => {
    await request(app)
      .post(`/api/videos/${videoId}/transcript-highlights`)
      .send(payload({ color: 'blue' }));
    await request(app)
      .post(`/api/videos/${videoId}/transcript-highlights`)
      .send(payload({ color: 'pink', source: 'chapter', text: 'Was ist das?' }));

    const res = await request(app).get(`/api/chats/${chatId}/tree-highlights`);

    const kinds = res.body.map((i) => i.kind);
    expect(kinds).toContain('transcript');
    expect(kinds).toContain('chapter');
    const transcriptItem = res.body.find((i) => i.kind === 'transcript');
    expect(transcriptItem).toMatchObject({ color: 'blue', startSeconds: 450 });
    expect(transcriptItem.text).toContain('the smallest unit');
  });

  it('finds them from ANY chat of the tree, like the other kinds', async () => {
    const branch = await request(app)
      .post('/api/chats')
      .send({ title: 'Zweig', parent_id: chatId, parent_word: 'x' });
    await request(app)
      .post(`/api/videos/${videoId}/transcript-highlights`)
      .send(payload({ color: 'orange' }));

    const res = await request(app).get(`/api/chats/${branch.body.id}/tree-highlights`);

    expect(branch.body.parent_id).toBe(chatId);
    expect(res.body.map((i) => `${i.kind}:${i.color}`)).toContain('transcript:orange');
  });
});
