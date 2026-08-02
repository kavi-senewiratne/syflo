/**
 * tests/papers.test.js
 *
 * Integration tests for the minimal papers routes (PDF upload end-to-end,
 * slice 03). One PDF per chat tree (ADR-0002): the tree root chat carries
 * paper_id; uploading from any branch binds the PDF to the root.
 * No Marker parsing pipeline — papers are 'ready' as soon as they're stored.
 */
process.env.OPENAI_API_KEY = 'test-key-for-unit-tests';
const request = require('supertest');
const { createApp } = require('../server');
const { createDb } = require('../database');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'papers-test.db');

// Minimal but valid-enough PDF bytes (header + EOF marker).
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

let app;
let db;

beforeEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
  app = createApp(db);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

async function createChat(title, parent_id, parent_word) {
  const res = await request(app).post('/api/chats').send({ title, parent_id, parent_word });
  return res.body;
}

async function uploadPdf(chatId, filename = 'lease-agreement.pdf') {
  return request(app)
    .post('/api/papers')
    .field('chat_id', chatId)
    .attach('pdf', PDF_BYTES, { filename, contentType: 'application/pdf' });
}

describe('POST /api/papers — upload a PDF into a chat tree', () => {
  it('stores the PDF and binds it to the chat tree', async () => {
    const chat = await createChat('Lease questions');
    const res = await uploadPdf(chat.id);

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.title).toBe('lease-agreement');
    expect(res.body.status).toBe('ready');
    expect(res.body.pdf_url).toBe(`/api/papers/${res.body.id}/pdf`);

    // The tree root now carries the paper binding and is named after it.
    const detail = await request(app).get(`/api/chats/${chat.id}`);
    expect(detail.body.paper_id).toBe(res.body.id);
    expect(detail.body.title).toBe('lease-agreement');
  });

  it('binds to the tree ROOT when uploading from a branch', async () => {
    const root = await createChat('Root');
    const branch = await createChat('Branch', root.id, 'deposit');

    const res = await uploadPdf(branch.id);
    expect(res.status).toBe(201);

    const rootDetail = await request(app).get(`/api/chats/${root.id}`);
    expect(rootDetail.body.paper_id).toBe(res.body.id);
    expect(rootDetail.body.title).toBe('lease-agreement');
    const branchDetail = await request(app).get(`/api/chats/${branch.id}`);
    expect(branchDetail.body.paper_id).toBeNull();
    // Only the root is renamed — the branch keeps its own title.
    expect(branchDetail.body.title).toBe('Branch');
  });

  it('rejects a second PDF for the same tree with tree-has-source (ADR-0002/0005)', async () => {
    const root = await createChat('Root');
    const branch = await createChat('Branch', root.id, 'deposit');
    await uploadPdf(root.id);

    // Second attach — also from a branch of the same tree — is rejected.
    const res = await uploadPdf(branch.id, 'second.pdf');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('tree-has-source');
    expect(res.body.root_chat_id).toBe(root.id);
  });

  it('rejects a PDF when the tree already has a YouTube transcript (one source per tree, ADR-0005)', async () => {
    const chat = await createChat('Video tree');
    db.prepare(
      `INSERT INTO videos (id, youtube_id, title, channel, duration_seconds, language, transcript, url, created_at)
       VALUES ('v1', 'zjkBMFhNj_g', 'Intro to LLMs', 'Karpathy', 3587, 'en', '[00:00] Hi.', 'https://www.youtube.com/watch?v=zjkBMFhNj_g', ?)`,
    ).run(new Date().toISOString());
    db.prepare('UPDATE chats SET video_id = ? WHERE id = ?').run('v1', chat.id);

    const res = await uploadPdf(chat.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('tree-has-source');
    expect(res.body.root_chat_id).toBe(chat.id);
  });

  it('rejects non-PDF uploads', async () => {
    const chat = await createChat('Chat');
    const res = await request(app)
      .post('/api/papers')
      .field('chat_id', chat.id)
      .attach('pdf', Buffer.from('plain text'), { filename: 'notes.txt', contentType: 'text/plain' });
    expect(res.status).toBe(500);
  });

  it('returns 400 without chat_id and 404 for an unknown chat', async () => {
    const noChat = await request(app)
      .post('/api/papers')
      .attach('pdf', PDF_BYTES, { filename: 'a.pdf', contentType: 'application/pdf' });
    expect(noChat.status).toBe(400);

    const unknown = await request(app)
      .post('/api/papers')
      .field('chat_id', 'does-not-exist')
      .attach('pdf', PDF_BYTES, { filename: 'a.pdf', contentType: 'application/pdf' });
    expect(unknown.status).toBe(404);
  });
});

describe('POST /api/papers — background retrieval preparation (ADR-0006)', () => {
  // > MAX_SYSTEM_CONTEXT_CHARS (~40k) → retrieval-mode candidate.
  const LONG_TEXT = Array.from(
    { length: 520 },
    (_, i) => `Paragraph ${i} discussing background material in sufficient detail to fill space.`
  ).join('\n\n');

  function appWith(extractedText, embedFn) {
    return createApp(db, {
      papers: {
        extractPdfTextFn: jest.fn().mockResolvedValue(extractedText),
        embedTextsFn: embedFn,
      },
    });
  }

  async function uploadVia(app2, chatId) {
    return request(app2)
      .post('/api/papers')
      .field('chat_id', chatId)
      .attach('pdf', PDF_BYTES, { filename: 'long.pdf', contentType: 'application/pdf' });
  }

  // The hook is fire-and-forget — briefly wait for setImmediate work.
  const flushBackground = () => new Promise((r) => setTimeout(r, 50));

  it('extracts, chunks and embeds a long paper right after upload', async () => {
    const fakeEmbed = jest.fn(async (texts) => texts.map(() => [0.1, 0.2]));
    const app2 = appWith(LONG_TEXT, fakeEmbed);
    const chat = await request(app2).post('/api/chats').send({ title: 'Long' });

    const res = await uploadVia(app2, chat.body.id);
    expect(res.status).toBe(201);
    await flushBackground();

    // Full text is in the cache — the first question no longer extracts …
    const row = db.prepare('SELECT extracted_text FROM papers WHERE id = ?').get(res.body.id);
    expect(row.extracted_text).toBe(LONG_TEXT);
    // … and the chunks with their embeddings are ready — the first question
    // does not wait for embedding.
    const n = db
      .prepare('SELECT COUNT(*) AS n FROM source_chunks WHERE source_id = ?')
      .get(res.body.id).n;
    expect(n).toBeGreaterThan(5);
  });

  it('caches the text but skips chunking for short papers (full-text mode)', async () => {
    const fakeEmbed = jest.fn(async (texts) => texts.map(() => [0.1, 0.2]));
    const app2 = appWith('SHORT PAPER TEXT', fakeEmbed);
    const chat = await request(app2).post('/api/chats').send({ title: 'Short' });

    const res = await uploadVia(app2, chat.body.id);
    await flushBackground();

    const row = db.prepare('SELECT extracted_text FROM papers WHERE id = ?').get(res.body.id);
    expect(row.extracted_text).toBe('SHORT PAPER TEXT');
    expect(fakeEmbed).not.toHaveBeenCalled();
  });

  it('never fails the upload when background preparation dies', async () => {
    const app2 = createApp(db, {
      papers: {
        extractPdfTextFn: jest.fn().mockRejectedValue(new Error('corrupt')),
        embedTextsFn: jest.fn(),
      },
    });
    const chat = await request(app2).post('/api/chats').send({ title: 'Broken' });

    const res = await uploadVia(app2, chat.body.id);
    expect(res.status).toBe(201);
    await flushBackground();
    // No cache, no chunks — but the upload itself went through.
    const row = db.prepare('SELECT extracted_text FROM papers WHERE id = ?').get(res.body.id);
    expect(row.extracted_text).toBeNull();
  });
});

describe('GET /api/papers/for-chat/:chatId — restore on reload', () => {
  it('returns the tree paper for any chat in the tree', async () => {
    const root = await createChat('Root');
    const branch = await createChat('Branch', root.id, 'deposit');
    const uploaded = await uploadPdf(root.id);

    const viaBranch = await request(app).get(`/api/papers/for-chat/${branch.id}`);
    expect(viaBranch.status).toBe(200);
    expect(viaBranch.body.paper.id).toBe(uploaded.body.id);
    expect(viaBranch.body.paper.pdf_url).toBe(`/api/papers/${uploaded.body.id}/pdf`);
  });

  it('returns paper: null for a tree without a PDF', async () => {
    const chat = await createChat('Plain chat');
    const res = await request(app).get(`/api/papers/for-chat/${chat.id}`);
    expect(res.status).toBe(200);
    expect(res.body.paper).toBeNull();
  });
});

describe('GET /api/papers/:id/pdf — serve the stored PDF', () => {
  it('serves the uploaded bytes with the PDF content type', async () => {
    const chat = await createChat('Chat');
    const uploaded = await uploadPdf(chat.id);

    const res = await request(app).get(`/api/papers/${uploaded.body.id}/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(Buffer.compare(res.body, PDF_BYTES)).toBe(0);
  });

  it('404s for an unknown paper id', async () => {
    const res = await request(app).get('/api/papers/nope/pdf');
    expect(res.status).toBe(404);
  });
});
