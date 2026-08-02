/**
 * tests/papers-search.test.js
 *
 * Route tests for slice 07: GET /api/papers/search (OpenAlex + arXiv in
 * parallel, merged/deduped, Semantic Scholar only as double-outage fallback)
 * and POST /api/papers/from-url (download the PDF, bind it to the chat tree,
 * ADR-0002 409 on a tree that already has one). Search backends and the URL
 * fetch are injected via the router's options parameter — no real network.
 * Ported from Syflo's papers.test.js, adapted to Syflo's tree binding.
 */
process.env.OPENAI_API_KEY = 'test-key-for-unit-tests';
const express = require('express');
const request = require('supertest');
const path = require('path');
const fs = require('fs');
const { createDb } = require('../database');
const papersRouter = require('../routes/papers');

const TEST_DB_PATH = path.join(__dirname, 'papers-search-test.db');
const TEST_UPLOADS_DIR = path.join(__dirname, 'test-uploads-papers-search');

let app;
let db;
let mockSearchFn;
let mockArxivSearchFn;
let mockOpenalexSearchFn;
let mockUrlFetchFn;
let chatId;

beforeEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  if (fs.existsSync(TEST_UPLOADS_DIR)) fs.rmSync(TEST_UPLOADS_DIR, { recursive: true });
  fs.mkdirSync(TEST_UPLOADS_DIR, { recursive: true });
  db = createDb(TEST_DB_PATH);

  chatId = 'chat-1';
  db.prepare('INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)').run(
    chatId, 'test chat', '2026-07-12T00:00:00.000Z',
  );

  mockSearchFn = jest.fn(async (q) => ({
    results: [
      { id: 'ss-p1', title: `SS fallback for ${q}`, authors: ['A. Smith'], year: 2023, citations: 42, open_access_pdf_url: 'https://example.com/p1.pdf', abstract: null },
    ],
    rate_limited: false,
  }));
  mockArxivSearchFn = jest.fn(async (q) => ({
    results: [
      { id: '2303.00001', title: `arXiv result for ${q}`, authors: ['B. Jones'], year: 2023, citations: 0, open_access_pdf_url: 'https://arxiv.org/pdf/2303.00001.pdf', abstract: 'An abstract.' },
    ],
    rate_limited: false,
  }));
  mockOpenalexSearchFn = jest.fn(async (q) => ({
    results: [
      { id: 'https://openalex.org/W999', title: `OpenAlex result for ${q}`, authors: ['C. Lee'], year: 2024, citations: 100, open_access_pdf_url: 'https://example.org/oa.pdf', abstract: 'OA abstract.', doi: '10.1000/test' },
    ],
    rate_limited: false,
  }));
  mockUrlFetchFn = jest.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/pdf' : null) },
    async arrayBuffer() {
      return new TextEncoder().encode('%PDF-1.4\n%%EOF\n').buffer;
    },
  }));

  app = express();
  app.use(express.json());
  app.use('/api/papers', papersRouter(db, TEST_UPLOADS_DIR, {
    searchFn: mockSearchFn,
    arxivSearchFn: mockArxivSearchFn,
    openalexSearchFn: mockOpenalexSearchFn,
    urlFetchFn: mockUrlFetchFn,
  }));
  app.use((err, req, res, _next) => {
    res.status(500).json({ error: err.message });
  });
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  if (fs.existsSync(TEST_UPLOADS_DIR)) fs.rmSync(TEST_UPLOADS_DIR, { recursive: true });
});

describe('GET /api/papers/search', () => {
  it('returns empty results when q is missing', async () => {
    const res = await request(app).get('/api/papers/search');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [], rate_limited: false });
    expect(mockArxivSearchFn).not.toHaveBeenCalled();
    expect(mockOpenalexSearchFn).not.toHaveBeenCalled();
    expect(mockSearchFn).not.toHaveBeenCalled();
  });

  it('queries OpenAlex and arXiv in parallel and merges the results', async () => {
    const res = await request(app).get('/api/papers/search?q=diffusion');
    expect(res.status).toBe(200);
    expect(mockOpenalexSearchFn).toHaveBeenCalledWith('diffusion', 20);
    expect(mockArxivSearchFn).toHaveBeenCalledWith('diffusion', 20);
    // SS must NOT be hit on the happy path.
    expect(mockSearchFn).not.toHaveBeenCalled();
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0].id).toBe('https://openalex.org/W999');
    expect(res.body.results[1].id).toBe('2303.00001');
  });

  it('dedupes via normalized title and keeps the OpenAlex entry', async () => {
    mockOpenalexSearchFn.mockResolvedValueOnce({
      results: [{
        id: 'W777', title: 'Attention Is All You Need',
        authors: ['Vaswani'], year: 2025, citations: 80000,
        open_access_pdf_url: 'https://example.org/attention.pdf', abstract: null,
        doi: null,
      }],
      rate_limited: false,
    });
    mockArxivSearchFn.mockResolvedValueOnce({
      results: [{
        id: '1706.03762', title: 'Attention is all you need.',
        authors: ['Vaswani'], year: 2017, citations: 0,
        open_access_pdf_url: 'https://arxiv.org/pdf/1706.03762.pdf', abstract: null,
      }],
      rate_limited: false,
    });
    const res = await request(app).get('/api/papers/search?q=attention');
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].id).toBe('W777');
    // arXiv's preprint year overrides OpenAlex's re-index year (known
    // OpenAlex quirk), and its id is carried for clean /pdf/ URL building.
    expect(res.body.results[0].year).toBe(2017);
    expect(res.body.results[0].arxiv_id).toBe('1706.03762');
  });

  it('returns the surviving backend when one primary fails', async () => {
    mockOpenalexSearchFn.mockRejectedValueOnce(new Error('OpenAlex blip'));
    const res = await request(app).get('/api/papers/search?q=diffusion');
    expect(res.status).toBe(200);
    expect(mockSearchFn).not.toHaveBeenCalled();
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].id).toBe('2303.00001');
  });

  it('falls back to Semantic Scholar only when BOTH primaries fail', async () => {
    mockOpenalexSearchFn.mockRejectedValueOnce(new Error('OA down'));
    mockArxivSearchFn.mockRejectedValueOnce(new Error('arXiv down'));
    const res = await request(app).get('/api/papers/search?q=diffusion');
    expect(res.status).toBe(200);
    expect(mockSearchFn).toHaveBeenCalledWith('diffusion', 8);
    expect(res.body.results[0].id).toBe('ss-p1');
  });

  it('returns 500 when all three backends throw', async () => {
    mockOpenalexSearchFn.mockRejectedValueOnce(new Error('OA dead'));
    mockArxivSearchFn.mockRejectedValueOnce(new Error('arXiv dead'));
    mockSearchFn.mockRejectedValueOnce(new Error('SS dead'));
    const res = await request(app).get('/api/papers/search?q=foo');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/SS dead/);
  });
});

describe('mergeSearchResults helper', () => {
  const { mergeSearchResults } = papersRouter;

  it('dedupes on DOI across sources', () => {
    const merged = mergeSearchResults(
      [{ id: 'W1', title: 'Paper A', doi: '10.1/A' }],
      [{ id: 'arxiv-1', title: 'Paper A (preprint edition)', doi: '10.1/a' }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('W1');
  });

  it('keeps distinct papers from both sources in OpenAlex-first order', () => {
    const merged = mergeSearchResults(
      [{ id: 'W1', title: 'Paper A' }],
      [{ id: 'arxiv-2', title: 'Paper B' }],
    );
    expect(merged.map((r) => r.id)).toEqual(['W1', 'arxiv-2']);
  });
});

describe('POST /api/papers/from-url', () => {
  it('rejects when url or chat_id is missing', async () => {
    const noUrl = await request(app).post('/api/papers/from-url').send({ chat_id: chatId });
    expect(noUrl.status).toBe(400);
    expect(noUrl.body.error).toMatch(/url is required/);

    const noChat = await request(app).post('/api/papers/from-url').send({ url: 'https://arxiv.org/pdf/1.pdf' });
    expect(noChat.status).toBe(400);
    expect(noChat.body.error).toMatch(/chat_id is required/);
  });

  it('rejects malformed url and non-http schemes', async () => {
    const bad = await request(app).post('/api/papers/from-url').send({ url: 'not a url', chat_id: chatId });
    expect(bad.status).toBe(400);
    const ftp = await request(app).post('/api/papers/from-url').send({ url: 'ftp://x.com/p.pdf', chat_id: chatId });
    expect(ftp.status).toBe(400);
  });

  it('downloads the PDF, binds it to the tree root and responds 201 ready', async () => {
    db.prepare('INSERT INTO chats (id, title, parent_id, created_at) VALUES (?, ?, ?, ?)').run(
      'child-1', 'branch', chatId, '2026-07-12T00:00:00.000Z',
    );
    // Import from within a branch — must still land on the ROOT (ADR-0002).
    const res = await request(app)
      .post('/api/papers/from-url')
      .send({ url: 'https://arxiv.org/abs/1706.03762', title: 'Attention Is All You Need', chat_id: 'child-1' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('ready');
    expect(res.body.title).toBe('Attention Is All You Need');
    expect(res.body.pdf_url).toMatch(/^\/api\/papers\/.+\/pdf$/);
    // The /abs/ URL was normalized to the /pdf/ URL.
    expect(mockUrlFetchFn).toHaveBeenCalledWith(
      'https://arxiv.org/pdf/1706.03762.pdf',
      expect.anything(),
    );
    const root = db.prepare('SELECT paper_id FROM chats WHERE id = ?').get(chatId);
    expect(root.paper_id).toBe(res.body.id);
    // The file is on disk.
    const paperRow = db.prepare('SELECT pdf_path FROM papers WHERE id = ?').get(res.body.id);
    expect(fs.existsSync(paperRow.pdf_path)).toBe(true);
  });

  it('responds 409 tree-has-source without starting a download (ADR-0002/0005)', async () => {
    db.prepare(
      "INSERT INTO papers (id, uploaded_at, pdf_path, status) VALUES ('p-existing', '2026-07-12T00:00:00.000Z', '/dev/null', 'ready')",
    ).run();
    db.prepare('UPDATE chats SET paper_id = ? WHERE id = ?').run('p-existing', chatId);

    const res = await request(app)
      .post('/api/papers/from-url')
      .send({ url: 'https://arxiv.org/pdf/1.pdf', chat_id: chatId });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('tree-has-source');
    expect(res.body.root_chat_id).toBe(chatId);
    expect(mockUrlFetchFn).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown chat', async () => {
    const res = await request(app)
      .post('/api/papers/from-url')
      .send({ url: 'https://arxiv.org/pdf/1.pdf', chat_id: 'missing' });
    expect(res.status).toBe(404);
  });

  it('tries fallback_urls one by one when the publisher blocks the primary URL', async () => {
    mockUrlFetchFn
      .mockResolvedValueOnce({
        ok: false, status: 403,
        headers: { get: () => null },
        async arrayBuffer() { return new ArrayBuffer(0); },
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/pdf' : null) },
        async arrayBuffer() { return new TextEncoder().encode('%PDF-1.4\n%%EOF\n').buffer; },
      });

    const res = await request(app).post('/api/papers/from-url').send({
      url: 'https://journals.sagepub.com/doi/pdf/10.1/x.pdf',
      fallback_urls: ['https://arxiv.org/pdf/1711.00000.pdf'],
      chat_id: chatId,
    });

    expect(res.status).toBe(201);
    expect(mockUrlFetchFn).toHaveBeenCalledTimes(2);
    expect(mockUrlFetchFn.mock.calls[1][0]).toBe('https://arxiv.org/pdf/1711.00000.pdf');
  });

  it('follows citation_pdf_url from an academic HTML landing page', async () => {
    mockUrlFetchFn
      .mockResolvedValueOnce({
        ok: true, status: 200,
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/html' : null) },
        async arrayBuffer() { return new ArrayBuffer(0); },
        async text() {
          return '<html><head><meta name="citation_pdf_url" content="https://pub.example.com/real.pdf"></head></html>';
        },
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/pdf' : null) },
        async arrayBuffer() { return new TextEncoder().encode('%PDF-1.4\n%%EOF\n').buffer; },
      });

    const res = await request(app).post('/api/papers/from-url').send({
      url: 'https://pub.example.com/landing',
      chat_id: chatId,
    });

    expect(res.status).toBe(201);
    expect(mockUrlFetchFn.mock.calls[1][0]).toBe('https://pub.example.com/real.pdf');
  });

  it('routes a non-academic HTML response to 422 not-a-paper', async () => {
    mockUrlFetchFn.mockResolvedValueOnce({
      ok: true, status: 200,
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
      async arrayBuffer() { return new ArrayBuffer(0); },
      async text() { return '<!doctype html><html><head><title>Random Blog</title></head><body><h1>Hello</h1></body></html>'; },
    });

    const res = await request(app)
      .post('/api/papers/from-url')
      .send({ url: 'https://some-blog.example.com/post', chat_id: chatId });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('not-a-paper');
    expect(res.body.message).toMatch(/doesn.t lead to a research paper/i);
  });

  it('reports a publisher block (502) with action guidance when academic signals are present', async () => {
    mockUrlFetchFn
      .mockResolvedValueOnce({
        ok: true, status: 200,
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/html' : null) },
        async arrayBuffer() { return new ArrayBuffer(0); },
        async text() {
          return '<html><head><meta name="citation_pdf_url" content="https://pub.example.com/paper.pdf"><meta name="citation_doi" content="10.1234/abc"></head></html>';
        },
      })
      .mockResolvedValueOnce({
        ok: false, status: 403,
        headers: { get: () => null },
        async arrayBuffer() { return new ArrayBuffer(0); },
      });

    const res = await request(app)
      .post('/api/papers/from-url')
      .send({ url: 'https://pub.example.com/landing', chat_id: chatId });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Publisher blocks direct download/);
  });
});
