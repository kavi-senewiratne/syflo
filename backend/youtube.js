/**
 * youtube.js
 *
 * External-source module for the "YouTube Transcript" feature (ADR-0005),
 * mirroring arxiv.js/openalex.js: thin wrappers with a stable result shape,
 * injectable into routes for tests.
 *
 * - searchVideos(query): video search via YouTube's InnerTube API
 *   (youtubei.js — no API key, no local service; replaced the SearXNG
 *   YouTube engine on 2026-08-15).
 * - fetchTranscript(youtubeId): full caption track + title/channel via
 *   YouTube's InnerTube API (youtubei.js — pure npm, no shipped binary).
 */

// Same trim rationale as routes/search.js: the top hits are almost always
// the relevant ones, and the modal shows a short list anyway.
const MAX_RESULTS = 8;

// Pull the 11-char video id out of every URL shape YouTube uses
// (watch?v=, youtu.be/, /shorts/, /embed/) — used by the import-by-URL path.
function extractYoutubeId(url) {
  if (!url || typeof url !== 'string') return null;
  const m =
    url.match(/[?&]v=([A-Za-z0-9_-]{11})/) ||
    url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/) ||
    url.match(/\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// One search, one source: InnerTube already carries the upload date the
// modal shows, so there is nothing left to merge in by video id.
async function searchVideos(query) {
  return innertubeVideoSearch(query);
}

// Video search via InnerTube (2026-08-15). Until then this ran through the
// local SearXNG YouTube engine, which forced a Docker dependency AND a
// SECOND InnerTube search per query, because SearXNG never reads
// publishedTimeText — the upload date had to be merged in by video id, with
// a per-video getInfo fallback for the ranking mismatch between the two
// engines. InnerTube carries every field the modal shows (measured live:
// 21 hits, title/author/duration/published/thumbnail complete on all of
// them), so one search replaces two and nothing can be missing per instance.
async function innertubeVideoSearch(query) {
  const yt = await getInnertube();
  const search = await yt.search(query, { type: 'video' });
  return (search.videos || [])
    .map((v) => {
      const youtube_id = v?.id;
      const title = v?.title?.text;
      if (!youtube_id || !title) return null;
      return {
        youtube_id,
        title,
        channel: v?.author?.name || '',
        // "10:04" — same shape SearXNG's `length` had, so the modal is unchanged.
        duration: v?.duration?.text || null,
        thumbnail_url: v?.thumbnails?.[0]?.url || null,
        url: `https://www.youtube.com/watch?v=${youtube_id}`,
        published: cleanPublished(v?.published?.text),
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

// The timedtext endpoint answers in ~100 ms or not at all. Measured live on
// 2026-08-28 over 20 calls: every success landed between 90 ms and 10 s
// (median well under 1 s), and about a third of the calls never answered at
// all — the same URL then kept hanging while a freshly signed one went
// through. get_transcript is no alternative: it 400s on every client
// (WEB/IOS/ANDROID/MWEB, re-verified the same day).
//
// So the failure is not slowness, it is silence, and waiting longer buys
// nothing — a short window with several attempts does. Four attempts at 8 s
// leave the worst case where the old single 30 s attempt was, but turn a
// ~1-in-3 import failure into a ~1-in-100 one.
const CAPTION_ATTEMPTS = 4;
const CAPTION_ATTEMPT_TIMEOUT_MS = 8_000;
const CAPTION_RETRY_DELAY_MS = 400;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch title, channel, duration, caption language and the full caption
 * track of one video.
 *
 * Throws an Error with code 'no-transcript' when the video carries no
 * caption track at all (not even auto-generated), and 'captions-unavailable'
 * when the track exists but YouTube would not hand it over — the retryable
 * failure above, which the modal must phrase as "try again", not as "this
 * video has no captions".
 *
 * The fetch runs via the ANDROID client and the caption track's base_url:
 * the WEB routes are dead — get_transcript answers HTTP 400, and WEB
 * timedtext URLs deliver an empty 200 body without a POT token
 * (both verified live on 2026-07-24).
 *
 * `options` exists for the tests: `innertube` injects a fake client,
 * `retryDelayMs` takes the backoff out of the test runtime.
 */
async function fetchTranscript(youtubeId, options = {}) {
  const yt = options.innertube || (await getInnertube());
  const retryDelayMs = options.retryDelayMs ?? CAPTION_RETRY_DELAY_MS;

  const noTranscript = () => {
    const err = new Error('This video has no transcript');
    err.code = 'no-transcript';
    return err;
  };
  const captionsUnavailable = (cause) => {
    const err = new Error('YouTube did not hand over the captions for this video');
    err.code = 'captions-unavailable';
    if (cause) err.cause = cause;
    return err;
  };
  const rateLimited = (status) => {
    const err = new Error(`YouTube is rate-limiting caption requests (HTTP ${status})`);
    err.code = 'captions-rate-limited';
    return err;
  };

  let lastError = null;
  for (let attempt = 0; attempt < CAPTION_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await delay(retryDelayMs * attempt);

    // Re-read the track on every attempt: base_url carries a signature with
    // its own `ei`/`expire`, and a URL that just timed out stayed dead in
    // the measurements while a freshly issued one went through.
    const info = await yt.getBasicInfo(youtubeId, { client: 'ANDROID' });
    const basic = info.basic_info || {};
    const tracks = info.captions?.caption_tracks || [];
    // A video without captions has none a second later either — the only
    // failure here that retrying cannot help.
    if (tracks.length === 0) throw noTranscript();
    // Prefer a manually maintained track over auto captions ('asr').
    const track = tracks.find((t) => t.kind !== 'asr') || tracks[0];

    let segments;
    try {
      const r = await fetch(track.base_url, { signal: AbortSignal.timeout(CAPTION_ATTEMPT_TIMEOUT_MS) });
      // 429 is Google's throttle page ("Sorry…", 1 kB of HTML where the
      // track is 250 kB), measured 2026-08-28 after a burst of requests.
      // Retrying INTO a throttle only deepens it, so this one leaves the
      // loop immediately — the opposite of the silent failure above.
      if (r.status === 429 || r.status === 403) throw rateLimited(r.status);
      if (!r.ok) throw new Error(`Caption fetch failed with HTTP ${r.status}`);
      segments = parseTimedText(await r.text());
    } catch (err) {
      if (err?.code === 'captions-rate-limited') throw err;
      lastError = err;
      continue;
    }
    // An empty body is the endpoint's other way of saying "not now": the
    // track is listed, so this is not a video without captions (one live
    // response carried 1 kB where the full track is 250 kB).
    if (segments.length === 0) {
      lastError = captionsUnavailable();
      continue;
    }

    return {
      title: basic.title || youtubeId,
      channel: basic.author || '',
      durationSeconds: Number(basic.duration) || null,
      language: track.language_code || null,
      segments,
    };
  }

  throw captionsUnavailable(lastError);
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
    'content after this point is NOT included. If asked about it, say you cannot see that part of the video. ' +
    // The total above is the number the model reaches for when it needs an
    // ending. Measured 2026-09-02 (Neel Nanda, 3:57:44): the transcript was cut
    // at 1:41:43, and the overview closed with "## Superposition and
    // Polysemanticity [1:41:43 - 3:57:44]" — a 2 h 16 min section over material
    // it had never seen. That mark then read as full coverage, so nothing asked
    // to be continued and 57 % of the video silently disappeared.
    `Never write a time mark past ${lastMark}: your last section must END at or before it, ` +
    'even if that leaves the video unfinished. Stopping there is correct — the rest is written later. ' +
    // User report with picture 2026-09-04: every round signed off with
    // "*Ende des verfügbaren Transkripts bei [36:30].*", and since rounds are
    // appended into one message the reader ended up with a row of these
    // between the chapters. The app already knows where the cut is — it put
    // this note here — so the sentence buys nothing and costs the overview.
    'Do NOT write a closing sentence saying where the transcript ends: the app knows, ' +
    'and the rounds are joined into ONE answer, so such a line would sit in the middle of it.]'
  );
}

/**
 * The second the fitted transcript reaches, or null when nothing was cut.
 *
 * The companion to the note above, and the reason it exists: an instruction
 * can be ignored, this number cannot. Stored with the answer so the progress
 * measure knows what the model was actually able to see (see
 * overview-progress.js — a mark past this second is an echo, not coverage).
 */
function transcriptCutSeconds(fittedText, fullText) {
  if (!fittedText || !fullText || fittedText.length >= fullText.length) return null;
  const marks = fittedText.match(/\[(\d+):(\d{2})(?::(\d{2}))?\]/g);
  if (!marks) return null;
  const m = /\[(\d+):(\d{2})(?::(\d{2}))?\]/.exec(marks[marks.length - 1]);
  return m[3] === undefined
    ? Number(m[1]) * 60 + Number(m[2])
    : Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
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
  transcriptCutSeconds,
};
