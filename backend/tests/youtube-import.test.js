/**
 * tests/youtube-import.test.js
 *
 * Integration tests for POST /api/youtube/import — attaching a YouTube
 * transcript as the tree's source (ADR-0005). Like a paper, the video binds
 * to the tree ROOT; the transcript is stored in full with coarse minute
 * marks. The InnerTube fetch is injected.
 */
process.env.OPENAI_API_KEY = 'test-key-for-unit-tests';
const request = require('supertest');
const { createApp } = require('../server');
const { createDb } = require('../database');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'youtube-import-test.db');

let db;
let app;
let fetchTranscriptFn;

beforeEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
  fetchTranscriptFn = jest.fn().mockResolvedValue({
    title: 'Intro to Large Language Models',
    channel: 'Andrej Karpathy',
    durationSeconds: 3587,
    language: 'en',
    segments: [
      { startMs: 0, text: 'Hi everyone.' },
      { startMs: 90_000, text: 'So what is a large language model really?' },
    ],
  });
  app = createApp(db, { youtube: { fetchTranscriptFn } });
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

async function createChat(title, parent_id, parent_word) {
  const res = await request(app).post('/api/chats').send({ title, parent_id, parent_word });
  return res.body;
}

function importVideo(chatId, youtube_id = 'zjkBMFhNj_g') {
  return request(app).post('/api/youtube/import').send({ chat_id: chatId, youtube_id });
}

describe('POST /api/youtube/import', () => {
  it('fetches the transcript and binds the video to the chat tree', async () => {
    const chat = await createChat('New Chat');
    const res = await importVideo(chat.id);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      youtube_id: 'zjkBMFhNj_g',
      title: 'Intro to Large Language Models',
      channel: 'Andrej Karpathy',
      duration_seconds: 3587,
      language: 'en',
      url: 'https://www.youtube.com/watch?v=zjkBMFhNj_g',
    });
    expect(fetchTranscriptFn).toHaveBeenCalledWith('zjkBMFhNj_g');

    // The tree root carries the binding and is named after the video.
    const detail = await request(app).get(`/api/chats/${chat.id}`);
    expect(detail.body.video_id).toBe(res.body.id);
    expect(detail.body.title).toBe('Intro to Large Language Models');
  });

  it('binds to the tree ROOT when importing from a branch', async () => {
    const root = await createChat('Root');
    const branch = await createChat('Branch', root.id, 'attention');

    const res = await importVideo(branch.id);
    expect(res.status).toBe(201);

    const rootDetail = await request(app).get(`/api/chats/${root.id}`);
    expect(rootDetail.body.video_id).toBe(res.body.id);
    const branchDetail = await request(app).get(`/api/chats/${branch.id}`);
    expect(branchDetail.body.video_id).toBeNull();
    expect(branchDetail.body.title).toBe('Branch');
  });

  it('rejects a second video for the same tree with tree-has-source (ADR-0005)', async () => {
    const root = await createChat('Root');
    const branch = await createChat('Branch', root.id, 'attention');
    await importVideo(root.id);

    const res = await importVideo(branch.id, 'dQw4w9WgXcQ');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('tree-has-source');
    expect(res.body.root_chat_id).toBe(root.id);
    // Rejected before any network fetch — no wasted InnerTube request.
    expect(fetchTranscriptFn).toHaveBeenCalledTimes(1);
  });

  it('rejects a video when the tree already has a PDF (one source per tree)', async () => {
    const chat = await createChat('Paper tree');
    db.prepare(
      "INSERT INTO papers (id, title, authors_json, uploaded_at, pdf_path, status) VALUES ('p1', 'A paper', NULL, ?, '/tmp/p1.pdf', 'ready')",
    ).run(new Date().toISOString());
    db.prepare('UPDATE chats SET paper_id = ? WHERE id = ?').run('p1', chat.id);

    const res = await importVideo(chat.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('tree-has-source');
    expect(res.body.root_chat_id).toBe(chat.id);
  });

  it('answers 422 no-transcript for a video without any caption track', async () => {
    fetchTranscriptFn.mockRejectedValue(
      Object.assign(new Error('This video has no transcript'), { code: 'no-transcript' }),
    );
    const chat = await createChat('New Chat');

    const res = await importVideo(chat.id);

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('no-transcript');
    expect(res.body.message).toMatch(/no.*transcript|captions/i);
    // Nothing was bound — the tree stays sourceless.
    const detail = await request(app).get(`/api/chats/${chat.id}`);
    expect(detail.body.video_id).toBeNull();
  });

  it('answers 502 when the transcript fetch fails for other reasons', async () => {
    fetchTranscriptFn.mockRejectedValue(new Error('InnerTube exploded'));
    const chat = await createChat('New Chat');

    const res = await importVideo(chat.id);

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/InnerTube exploded/);
  });

  it('requires chat_id and youtube_id', async () => {
    const chat = await createChat('New Chat');
    expect((await request(app).post('/api/youtube/import').send({ youtube_id: 'x'.repeat(11) })).status).toBe(400);
    expect((await request(app).post('/api/youtube/import').send({ chat_id: chat.id })).status).toBe(400);
    expect((await importVideo('no-such-chat')).status).toBe(404);
  });
});

describe('GET /api/youtube/for-chat/:chatId', () => {
  it('serves the stored transcript with coarse minute marks, resolved via the root', async () => {
    const root = await createChat('Root');
    const branch = await createChat('Branch', root.id, 'attention');
    await importVideo(root.id);

    const res = await request(app).get(`/api/youtube/for-chat/${branch.id}`);

    expect(res.status).toBe(200);
    expect(res.body.video.title).toBe('Intro to Large Language Models');
    expect(res.body.video.transcript).toContain('[00:00]');
    expect(res.body.video.transcript).toContain('[01:30]');
    expect(res.body.video.transcript).toContain('Hi everyone.');
    expect(res.body.video.transcript).toContain('So what is a large language model really?');
  });

  it('returns { video: null } for a tree without a video', async () => {
    const chat = await createChat('Plain');
    const res = await request(app).get(`/api/youtube/for-chat/${chat.id}`);
    expect(res.status).toBe(200);
    expect(res.body.video).toBeNull();
  });
});
