/**
 * youtube.js
 *
 * External-source module for the "YouTube Transcript" feature (ADR-0005),
 * mirroring arxiv.js/openalex.js: thin wrappers with a stable result shape,
 * injectable into routes for tests.
 *
 * - searchVideos(query): video search via the local SearXNG instance
 *   (YouTube engine — no API key, same local-first stance as web search).
 * - fetchTranscript(youtubeId): full caption track + title/channel via
 *   YouTube's InnerTube API (youtubei.js — pure npm, no shipped binary).
 */

const SEARXNG_URL = process.env.SEARXNG_URL || 'http://localhost:8888';

// Same trim rationale as routes/search.js: the top hits are almost always
// the relevant ones, and the modal shows a short list anyway.
const MAX_RESULTS = 8;

// Pull the 11-char video id out of the URL shapes SearXNG's YouTube engine
// returns (watch?v=, youtu.be/, /shorts/, /embed/).
function extractYoutubeId(url) {
  if (!url || typeof url !== 'string') return null;
  const m =
    url.match(/[?&]v=([A-Za-z0-9_-]{11})/) ||
    url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/) ||
    url.match(/\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

async function searchVideos(query) {
  // SearXNG's YouTube engine drops the upload date (it never reads
  // publishedTimeText from the search page), so a parallel InnerTube search
  // supplies YouTube's own relative date ("9 months ago") to merge in by id.
  const [searxngResults, publishedById] = await Promise.all([
    searxngVideoSearch(query),
    fetchPublishedByVideoId(query),
  ]);
  const results = searxngResults.map((res) => ({
    ...res,
    published: publishedById.get(res.youtube_id) || null,
  }));
  // The two engines rank differently, so a few SearXNG hits miss InnerTube's
  // first search page (~20 videos). Fetch those dates one by one — in
  // parallel, so the whole search stays ~one getInfo (~1 s) slower at worst.
  await Promise.all(
    results
      .filter((res) => !res.published)
      .map(async (res) => {
        res.published = await fetchPublishedForVideo(res.youtube_id);
      }),
  );
  return results;
}

async function searxngVideoSearch(query) {
  const url = new URL('/search', SEARXNG_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('engines', 'youtube');
  url.searchParams.set('safesearch', '0');

  const r = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`SearXNG responded with HTTP ${r.status}`);
  const data = await r.json();

  return (data.results || [])
    .map((res) => {
      const youtube_id = extractYoutubeId(res.url);
      if (!youtube_id || !res.title) return null;
      return {
        youtube_id,
        title: res.title,
        // SearXNG's YouTube engine exposes the channel as `author` and the
        // duration as `length` ("59:47"); both are absent on some instances.
        channel: res.author || '',
        duration: res.length || null,
        thumbnail_url: res.thumbnail || null,
        url: res.url,
      };
    })
    .filter(Boolean)
    .slice(0, MAX_RESULTS);
}

// YouTube prefixes live/premiere uploads ("Streamed 1 year ago", "Premiered
// 2 weeks ago") — the modal only cares about the age, so drop the verb.
function cleanPublished(text) {
  return text ? text.replace(/^(?:Streamed|Premiered)\s+/i, '') : null;
}

// Best-effort: the date is decoration, so any InnerTube failure degrades to
// "no date" instead of failing the search (SearXNG stays the only hard
// dependency, as decided in ADR-0005).
async function fetchPublishedByVideoId(query) {
  const byId = new Map();
  try {
    const yt = await getInnertube();
    const search = await yt.search(query, { type: 'video' });
    for (const v of search.videos || []) {
      const published = cleanPublished(v?.published?.text);
      if (v?.id && published && !byId.has(v.id)) byId.set(v.id, published);
    }
  } catch {
    // ignore — results simply carry published: null
  }
  return byId;
}

// Single-video fallback for the ranking mismatch above. getInfo (player +
// watch-next) is the only InnerTube call that carries the date; getBasicInfo
// does not. relative_date keeps the wording consistent with the search path.
async function fetchPublishedForVideo(youtubeId) {
  try {
    const yt = await getInnertube();
    const info = await yt.getInfo(youtubeId);
    return cleanPublished(info.primary_info?.relative_date?.text || info.primary_info?.published?.text);
  } catch {
    return null;
  }
}

// ─── Transcript fetch (InnerTube via youtubei.js) ───────────────────────────

// youtubei.js is ESM-first; load it through Node's real ESM loader (same
// `new Function` trick as pdf-text.js so babel-jest keeps its hands off).
const importEsm = new Function('specifier', 'return import(specifier)');
let innertubePromise = null;
function getInnertube() {
  if (!innertubePromise) {
    innertubePromise = importEsm('youtubei.js').then((m) => m.Innertube.create());
  }
  return innertubePromise;
}

// Split YouTube's timedtext XML into {startMs, text} segments. Two formats
// occur: srv3 (<p t="160"><s>hi</s><s> there</s></p>) and srv1
// (<text start="0.16" dur="4.08">hi there</text>). The XML parser resolves
// the first entity level (&amp;#39; → &#39;) — the second level here.
const { XMLParser } = require('fast-xml-parser');

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function parseTimedText(xml) {
  if (!xml || !xml.trim()) return [];
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    parseAttributeValue: false,
    // The srv3 word segments carry their separator as a LEADING space
    // ("<s> everyone</s>") — default trimming would glue all words together.
    trimValues: false,
  });
  let doc;
  try {
    doc = parser.parse(xml);
  } catch (_) {
    return [];
  }
  const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const clean = (text) => decodeEntities(String(text)).replace(/\s+/g, ' ').trim();
  const segments = [];

  // srv3: word segments <s> per paragraph <p>; ignore <w> window elements.
  for (const p of asArray(doc?.timedtext?.body?.p)) {
    if (p == null || typeof p !== 'object') continue;
    const parts = asArray(p.s).map((s) => (typeof s === 'object' ? String(s['#text'] ?? '') : String(s)));
    const text = clean(parts.join('') || p['#text'] || '');
    if (text) segments.push({ startMs: Math.round(Number(p['@_t']) || 0), text });
  }
  if (segments.length > 0) return segments;

  // srv1: <text start="s.ss"> with seconds instead of milliseconds.
  for (const t of asArray(doc?.transcript?.text)) {
    const node = typeof t === 'object' ? t : { '#text': t };
    const text = clean(node['#text'] ?? '');
    if (text) segments.push({ startMs: Math.round((Number(node['@_start']) || 0) * 1000), text });
  }
  return segments;
}

/**
 * Fetch title, channel, duration, caption language and the full caption
 * track of one video. Throws an Error with code 'no-transcript' when the
 * video has no caption track at all (not even auto-generated).
 *
 * The fetch runs via the ANDROID client and the caption track's base_url:
 * the WEB routes are dead — get_transcript answers HTTP 400, and WEB
 * timedtext URLs deliver an empty 200 body without a POT token
 * (both verified live on 2026-07-24).
 */
async function fetchTranscript(youtubeId) {
  const yt = await getInnertube();
  const info = await yt.getBasicInfo(youtubeId, { client: 'ANDROID' });
  const basic = info.basic_info || {};

  const noTranscript = () => {
    const err = new Error('This video has no transcript');
    err.code = 'no-transcript';
    return err;
  };

  const tracks = info.captions?.caption_tracks || [];
  if (tracks.length === 0) throw noTranscript();
  // Prefer a manually maintained track over auto captions ('asr').
  const track = tracks.find((t) => t.kind !== 'asr') || tracks[0];

  const r = await fetch(track.base_url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`Caption fetch failed with HTTP ${r.status}`);
  const segments = parseTimedText(await r.text());
  if (segments.length === 0) throw noTranscript();

  return {
    title: basic.title || youtubeId,
    channel: basic.author || '',
    durationSeconds: Number(basic.duration) || null,
    language: track.language_code || null,
    segments,
  };
}

// ─── Minute marks ────────────────────────────────────────────────────────────

// One paragraph per ~30 s of video. Coarse on purpose: the marks cost ~1% of
// the character budget and buy time-anchored answers, the truncation note,
// and orientation in the transcript drawer (ADR-0005).
const PARAGRAPH_MS = 30_000;

function formatTimestamp(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Join caption segments into paragraphs, each prefixed with a coarse
 * `[MM:SS]` mark (or `[H:MM:SS]` past the first hour).
 */
function buildTranscriptText(segments) {
  const blocks = [];
  let current = null;
  for (const seg of segments) {
    if (!current || seg.startMs - current.startMs >= PARAGRAPH_MS) {
      current = { startMs: seg.startMs, parts: [] };
      blocks.push(current);
    }
    current.parts.push(seg.text);
  }
  return blocks
    .map((b) => `[${formatTimestamp(b.startMs)}] ${b.parts.join(' ')}`)
    .join('\n\n');
}

// ─── Chat context ────────────────────────────────────────────────────────────

/**
 * The video bound to the chat's tree (ADR-0005: the ROOT chat carries
 * video_id). Returns `{ title, channel, durationSeconds, text }` or null —
 * same contract as pdf-text.js's getTreePaperContext, so the two sources
 * share the prompt-budget slot.
 */
function getTreeVideoContext(db, chatId) {
  const getChat = db.prepare('SELECT id, parent_id, video_id FROM chats WHERE id = ?');
  let chat = getChat.get(chatId);
  while (chat && chat.parent_id) chat = getChat.get(chat.parent_id);
  if (!chat || !chat.video_id) return null;

  const video = db
    .prepare('SELECT title, channel, duration_seconds, transcript FROM videos WHERE id = ?')
    .get(chat.video_id);
  if (!video || !video.transcript) return null;
  return {
    videoId: chat.video_id,
    title: video.title,
    channel: video.channel,
    durationSeconds: video.duration_seconds,
    text: video.transcript,
  };
}

/**
 * When the context budget trimmed the transcript, tell the model WHERE the
 * cut happened (last surviving minute mark) so it says "I can't see that
 * part" instead of hallucinating the tail (ADR-0005). Returns null when
 * nothing was trimmed.
 */
function transcriptTruncationNote(fittedText, fullText, durationSeconds) {
  if (!fittedText || !fullText || fittedText.length >= fullText.length) return null;
  const marks = fittedText.match(/\[\d+:\d{2}(?::\d{2})?\]/g);
  const lastMark = marks ? marks[marks.length - 1] : '[00:00]';
  const total = durationSeconds ? ` of ${formatTimestamp(durationSeconds * 1000)}` : '';
  return (
    `\n[Note: the transcript is truncated at ${lastMark}${total} — ` +
    'content after this point is NOT included. If asked about it, say you cannot see that part of the video.]'
  );
}

module.exports = {
  searchVideos,
  cleanPublished,
  fetchTranscript,
  parseTimedText,
  buildTranscriptText,
  formatTimestamp,
  extractYoutubeId,
  getTreeVideoContext,
  transcriptTruncationNote,
  SEARXNG_URL,
};
