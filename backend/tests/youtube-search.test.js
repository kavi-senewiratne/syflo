/**
 * tests/youtube-search.test.js
 *
 * Integration tests for GET /api/youtube/search — the video search behind
 * the "YouTube Transcript" plus-menu item (ADR-0005). The search backend
 * (SearXNG's YouTube engine) is injected, same pattern as the paper search.
 */
process.env.OPENAI_API_KEY = 'test-key-for-unit-tests';
const request = require('supertest');
const { createApp } = require('../server');
const { createDb } = require('../database');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'youtube-search-test.db');

let db;

function makeApp(youtubeOptions) {
  return createApp(db, { youtube: youtubeOptions });
}

beforeEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

describe('cleanPublished', () => {
  const { cleanPublished } = require('../youtube');

  it('removes the Streamed/Premiered prefixes of livestreams and premieres', () => {
    expect(cleanPublished('Streamed 1 year ago')).toBe('1 year ago');
    expect(cleanPublished('Premiered 2 weeks ago')).toBe('2 weeks ago');
    expect(cleanPublished('9 months ago')).toBe('9 months ago');
    expect(cleanPublished(undefined)).toBeNull();
  });
});

describe('GET /api/youtube/search', () => {
  it('returns the videos found by the search backend', async () => {
    const searchVideosFn = jest.fn().mockResolvedValue([
      {
        youtube_id: 'zjkBMFhNj_g',
        title: 'Intro to Large Language Models',
        channel: 'Andrej Karpathy',
        duration: '59:47',
        published: '2 years ago',
        thumbnail_url: 'https://i.ytimg.com/vi/zjkBMFhNj_g/hqdefault.jpg',
        url: 'https://www.youtube.com/watch?v=zjkBMFhNj_g',
      },
    ]);
    const app = makeApp({ searchVideosFn });

    const res = await request(app).get('/api/youtube/search').query({ q: 'karpathy llm intro' });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toMatchObject({
      youtube_id: 'zjkBMFhNj_g',
      title: 'Intro to Large Language Models',
      channel: 'Andrej Karpathy',
      duration: '59:47',
      url: 'https://www.youtube.com/watch?v=zjkBMFhNj_g',
    });
    expect(searchVideosFn).toHaveBeenCalledWith('karpathy llm intro');
  });

  it('returns an empty result list for an empty query without hitting the backend', async () => {
    const searchVideosFn = jest.fn();
    const app = makeApp({ searchVideosFn });

    const res = await request(app).get('/api/youtube/search').query({ q: '   ' });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
    expect(searchVideosFn).not.toHaveBeenCalled();
  });

  it('answers 503 with a clear message when the search backend is unreachable', async () => {
    const searchVideosFn = jest.fn().mockRejectedValue(
      Object.assign(new Error('Could not reach SearXNG'), { cause: { code: 'ECONNREFUSED' } }),
    );
    const app = makeApp({ searchVideosFn });

    const res = await request(app).get('/api/youtube/search').query({ q: 'karpathy' });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/SearXNG/i);
  });
});
