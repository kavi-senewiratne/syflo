/**
 * semantic-scholar.js
 *
 * Wrapper around Semantic Scholar's public API. Used by the papers pipeline to
 * fetch a paper's field-of-study hierarchy and a list of similar papers — the
 * data that powers Syflo's Infographic "Field Map" and "Similar Papers"
 * sections (PRD §6.3). Also exposes a generic /paper/search proxy used by the
 * home-screen search bar.
 *
 * Paper-id resolution strategy (best → worst):
 *   1. arXiv id  — `paper/arXiv:{id}` — exact, no false positives
 *   2. DOI       — `paper/DOI:{doi}`  — exact
 *   3. Title     — `paper/search?query=…` — fuzzy; we verify similarity
 *
 * The arXiv/DOI strategies are vastly preferred because the title search is
 * a frequent source of empty results: it returns nothing when the canonical
 * title contains odd punctuation or differs slightly from what Marker
 * extracted (subtitle vs. main title, missing colon, etc.).
 *
 * Rate-limiting strategy
 * ──────────────────────
 * SS's free tier allows ~100 req / 5 min per IP, which is easy to blow through
 * if every keystroke triggers a search. To keep us under the cap and to make
 * repeat lookups feel instant, we keep two in-memory caches:
 *
 *   • searchCache       — query → { results, rate_limited }   TTL 10 min
 *   • paperLookupCache  — title-key → top match               TTL 1 day
 *
 * Cache keys are the lowercase/trimmed query, so "Diffusion Policy" and
 * "  diffusion policy  " share an entry. The maps are bounded (LRU-ish via
 * insertion order) so they can't grow without bound across a long session.
 *
 * If the user sets the SEMANTIC_SCHOLAR_API_KEY env var (recommended for
 * heavy use — see https://api.semanticscholar.org/api-docs/), we forward it
 * as the `x-api-key` header so SS gives us a much higher rate-limit budget.
 *
 * When a 429 does slip through we surface a structured result so the route
 * can pass Retry-After back to the frontend, which then schedules an auto-retry.
 */

const SS_GRAPH = 'https://api.semanticscholar.org/graph/v1';
const SS_REC = 'https://api.semanticscholar.org/recommendations/v1';

// Fields we always request from /paper endpoints. SS returns minimal data when
// `fields` is omitted (just paperId + title), so the explicit list is required
// to get fieldsOfStudy / s2FieldsOfStudy populated.
// `venue` rides along for the citation card's fold — where the work appeared
// (2026-08-12). One more field on a request we already make.
const PAPER_FIELDS = 'paperId,title,authors,year,citationCount,venue,openAccessPdf,abstract,fieldsOfStudy,s2FieldsOfStudy,externalIds';
const RECOMMENDATION_FIELDS = 'paperId,title,authors,year,citationCount,openAccessPdf,abstract';

// TTLs.
const SEARCH_TTL_MS = 10 * 60 * 1000;        // 10 minutes
const PAPER_LOOKUP_TTL_MS = 24 * 60 * 60 * 1000; // 1 day

// Soft caps so a long session can't grow the maps unbounded. When we hit the
// cap we drop the oldest entry (JS Map iteration is insertion order).
const SEARCH_CACHE_MAX = 200;
const PAPER_LOOKUP_CACHE_MAX = 500;

const searchCache = new Map();        // key → { expiresAt, value }
const paperLookupCache = new Map();   // key → { expiresAt, value }

function cacheGet(map, key) {
  const entry = map.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    map.delete(key);
    return undefined;
  }
  // Refresh LRU position so hot entries survive eviction.
  map.delete(key);
  map.set(key, entry);
  return entry.value;
}

function cacheSet(map, key, value, ttlMs, maxSize) {
  if (map.size >= maxSize) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, { expiresAt: Date.now() + ttlMs, value });
}

function normalizeKey(s) {
  return (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

// Exposed primarily so tests can start from a clean slate.
function clearCaches() {
  searchCache.clear();
  paperLookupCache.clear();
}

// Strip publishers/keywords that Semantic Scholar's search doesn't like.
function cleanTitleForSearch(title) {
  return title
    .replace(/[():,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// Build the default request-init for an SS call. Picks up the API key from the
// env var so deployments that have one get higher rate-limit budgets without
// any extra wiring. Apply to every SS fetch.
function ssHeaders() {
  const key = process.env.SEMANTIC_SCHOLAR_API_KEY;
  return key ? { 'x-api-key': key } : undefined;
}

function fetchSs(fetchFn, url) {
  const headers = ssHeaders();
  return headers ? fetchFn(url, { headers }) : fetchFn(url);
}

// Parse a Retry-After header. SS sometimes returns it as seconds, sometimes
// as an HTTP date. Returns a Number of seconds (>= 0) or null if absent/invalid.
function parseRetryAfter(res) {
  const raw = res?.headers?.get?.('retry-after') ?? res?.headers?.get?.('Retry-After');
  if (!raw) return null;
  const asInt = Number(raw);
  if (Number.isFinite(asInt) && asInt >= 0) return Math.min(asInt, 600);
  const asDate = Date.parse(raw);
  if (!Number.isNaN(asDate)) {
    const secs = Math.ceil((asDate - Date.now()) / 1000);
    return secs > 0 ? Math.min(secs, 600) : 0;
  }
  return null;
}

// Normalize a title for similarity comparison: lowercase, drop punctuation,
// collapse whitespace. Used to verify a fuzzy SS match is plausible.
function normalizeForCompare(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Token-based Jaccard similarity in [0, 1]. Cheap and good enough to detect
// "different paper that happens to share a couple of words" vs "same paper
// modulo punctuation/subtitle".
function titleSimilarity(a, b) {
  const ta = new Set(normalizeForCompare(a).split(' ').filter(Boolean));
  const tb = new Set(normalizeForCompare(b).split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersect = 0;
  for (const t of ta) if (tb.has(t)) intersect += 1;
  const union = ta.size + tb.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

// Extract an arXiv id from a paper's markdown body. arXiv preprints include
// the canonical id either in a footer ("arXiv:1011.0686") or on the first
// page header. Returns the bare id (e.g. "1011.0686" or "2303.04137v2") or
// null.
function extractArxivId(text) {
  if (!text) return null;
  // Modern format (4 digits . 4-5 digits, optional version): 2303.04137v2
  const modern = text.match(/arXiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)/i);
  if (modern) return modern[1];
  // Legacy format (subject-class/seqnumber): hep-th/9901001
  const legacy = text.match(/arXiv:\s*([a-z\-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/i);
  if (legacy) return legacy[1];
  return null;
}

// Extract a DOI from a paper's markdown body. Matches the common
// "doi.org/10.xxxx/..." and bare "10.xxxx/..." forms. Returns the DOI string
// (no leading "https://doi.org/") or null.
function extractDoi(text) {
  if (!text) return null;
  const m = text.match(/\b(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)/i);
  if (!m) return null;
  // Strip common trailing punctuation that markdown often glues to the DOI.
  return m[1].replace(/[.,;)\]]+$/, '');
}

// Try to look up a paper by an exact identifier (arXiv id or DOI). Returns
// the SS paper object (with PAPER_FIELDS populated) or null on 404.
async function lookupById(idExpr, fetchFn = fetch) {
  const url = `${SS_GRAPH}/paper/${encodeURIComponent(idExpr)}?fields=${PAPER_FIELDS}`;
  const res = await fetchSs(fetchFn, url);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Semantic Scholar id lookup failed: ${res.status}`);
  }
  return res.json();
}

// Find a paper by title via /paper/search. Returns the top match (by relevance)
// or null if nothing found. The caller is responsible for verifying the match
// is reasonable (e.g., title similarity check).
//
// We request PAPER_FIELDS up-front so a single round-trip yields both the
// id-resolution and the field-hierarchy — saving one HTTP call when search
// is the only viable strategy.
//
// Cached for 1 day on the lowercase/trimmed title — looking up "Diffusion
// Policy" twice in a session (or the next day) no longer re-hits SS.
async function findPaperByTitle(title, fetchFn = fetch) {
  const q = cleanTitleForSearch(title);
  if (!q) return null;
  const key = normalizeKey(q);
  const cached = cacheGet(paperLookupCache, key);
  if (cached !== undefined) return cached;

  const url = `${SS_GRAPH}/paper/search?query=${encodeURIComponent(q)}&limit=5&fields=${PAPER_FIELDS}`;
  const res = await fetchSs(fetchFn, url);
  if (!res.ok) {
    throw new Error(`Semantic Scholar search failed: ${res.status}`);
  }
  const body = await res.json();
  const top = body.data && body.data.length > 0 ? body.data[0] : null;
  cacheSet(paperLookupCache, key, top, PAPER_LOOKUP_TTL_MS, PAPER_LOOKUP_CACHE_MAX);
  return top;
}

// Like findPaperByTitle but inspects the top N hits and returns whichever has
// the best title-similarity ≥ threshold (default 0.5). Falls back to the top
// hit when nothing crosses the bar — callers can decide to discard it.
async function findPaperByTitleVerified(title, fetchFn = fetch, threshold = 0.5) {
  const q = cleanTitleForSearch(title);
  if (!q) return null;
  const url = `${SS_GRAPH}/paper/search?query=${encodeURIComponent(q)}&limit=5&fields=${PAPER_FIELDS}`;
  const res = await fetchSs(fetchFn, url);
  if (!res.ok) {
    throw new Error(`Semantic Scholar search failed: ${res.status}`);
  }
  const body = await res.json();
  const hits = Array.isArray(body.data) ? body.data : [];
  if (hits.length === 0) return null;
  let best = hits[0];
  let bestScore = titleSimilarity(title, best.title);
  for (let i = 1; i < hits.length; i += 1) {
    const score = titleSimilarity(title, hits[i].title);
    if (score > bestScore) {
      best = hits[i];
      bestScore = score;
    }
  }
  best._similarity = bestScore;
  best._verified = bestScore >= threshold;
  return best;
}

// Fetch the field-of-study hierarchy + topic list for a known S2 paper id.
// Used only when the resolved paper object doesn't already carry the fields
// (e.g., older callers of lookupById/findPaperByTitle that requested a thin
// projection).
async function fetchFields(paperId, fetchFn = fetch) {
  const url = `${SS_GRAPH}/paper/${paperId}?fields=fieldsOfStudy,s2FieldsOfStudy`;
  const res = await fetchSs(fetchFn, url);
  if (!res.ok) {
    throw new Error(`Semantic Scholar fields fetch failed: ${res.status}`);
  }
  return res.json();
}

// Fetch up to `limit` papers similar to the given S2 paper id.
//
// Tries the dedicated Recommendations API first
// (api.semanticscholar.org/recommendations/v1/papers/forpaper/{id}) — that's
// the endpoint SS actually maintains for "more like this". When it returns
// 404 (paper not in the recommendation graph), the legacy graph endpoint is
// tried as a fallback. Either path returns { recommendedPapers: [...] };
// failures are swallowed into an empty array so a missing rec graph never
// blocks the upload pipeline.
async function fetchRecommendations(paperId, limit = 4, fetchFn = fetch) {
  // Primary: dedicated Recommendations API.
  const recUrl = `${SS_REC}/papers/forpaper/${paperId}?limit=${limit}&fields=${RECOMMENDATION_FIELDS}`;
  let res = await fetchSs(fetchFn, recUrl);
  if (res.ok) return res.json();
  // Non-404 from primary: fall through to legacy. (Don't throw —
  // recommendations are best-effort.)

  // Fallback: legacy /graph/v1/paper/{id}/recommendations. Some older
  // integrations and many existing tests assume this path.
  const legacyUrl = `${SS_GRAPH}/paper/${paperId}/recommendations?limit=${limit}&fields=${RECOMMENDATION_FIELDS}`;
  res = await fetchSs(fetchFn, legacyUrl);
  if (res.ok) return res.json();
  if (res.status === 404) return { recommendedPapers: [] };
  throw new Error(`Semantic Scholar recommendations failed: ${res.status}`);
}

// Take raw Semantic Scholar field data and reduce it to Syflo's three-tier
// Field-Map shape: { field, subfield, topic }. We pick from fieldsOfStudy
// (broad, like "Computer Science") and s2FieldsOfStudy (specific). When data
// is sparse, only `field` may be set.
//
// When the specific list (s2FieldsOfStudy) leaves us without a "topic" tier,
// fall back to the most prominent title content-word so the leaf tier of the
// Field Map isn't blank. This is purely cosmetic — the title-word is rendered
// as the leaf "Topic" so the three-tier panel stays visually intact.
// Confidence floor for s2FieldsOfStudy. Entries below this score are usually
// keyword-overlap noise from S2's auto-tagging (a robotics paper tagged
// "Geodesy" because it once mentioned the word "navigation"). 0.5 matches
// what S2's own field-classifier-confidence docs treat as "likely correct".
const S2_FIELDS_MIN_SCORE = 0.5;

// Cap on chips shown in the Field Map. See openalex.js for the rationale —
// kept in sync so both backends produce comparably trimmed payloads.
const MAX_FIELD_CHIPS = 10; // 3 tiers + up to 7 siblings

function shapeFieldHierarchy(raw) {
  const broad = Array.isArray(raw?.fieldsOfStudy) ? raw.fieldsOfStudy : [];
  // s2FieldsOfStudy entries look like { category, source, score? }. The score
  // is the per-tag confidence from S2's classifier — filter to drop the
  // long tail of low-confidence noise tags (e.g. "Biology" on a CS paper).
  // Entries without a score are kept (older S2 dumps don't always include it).
  const specific = Array.isArray(raw?.s2FieldsOfStudy)
    ? raw.s2FieldsOfStudy
        .filter((e) => e && (e.score == null || e.score >= S2_FIELDS_MIN_SCORE))
        .map((e) => e.category)
        .filter(Boolean)
    : [];
  // First broad item is treated as the "field"; first distinct specific item
  // as the "subfield"; second distinct as the "topic". This is a heuristic —
  // SS doesn't expose a real hierarchy.
  const distinct = [...new Set([...broad, ...specific])].slice(0, MAX_FIELD_CHIPS);
  let topic = distinct[2] || null;
  if (!topic && raw?.title) {
    topic = pickTitleTopic(raw.title);
  }
  return {
    field: distinct[0] || null,
    subfield: distinct[1] || null,
    topic,
    all: distinct,
  };
}

// Pick a single content-word from a paper title to use as a "topic" leaf when
// SS doesn't give us a third tier. Strips stop-words and grabs the longest
// remaining token (proxy for "most informative"). Title-cased for display.
function pickTitleTopic(title) {
  const stop = new Set([
    'the', 'a', 'an', 'and', 'or', 'of', 'for', 'with', 'via', 'on', 'in',
    'to', 'from', 'by', 'using', 'into', 'over', 'is', 'are', 'as', 'at',
  ]);
  const words = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !stop.has(w));
  if (words.length === 0) return null;
  // Longest word wins — short connectives have already been filtered.
  let best = words[0];
  for (const w of words) if (w.length > best.length) best = w;
  return best.charAt(0).toUpperCase() + best.slice(1);
}

function shapeRecommendation(rec) {
  return {
    id: rec.paperId,
    title: rec.title,
    authors: Array.isArray(rec.authors) ? rec.authors.map((a) => a.name).filter(Boolean) : [],
    year: rec.year ?? null,
    citations: rec.citationCount ?? 0,
    open_access: !!(rec.openAccessPdf && rec.openAccessPdf.url),
    abstract: rec.abstract ?? null,
  };
}

// Fallback "similar papers" source: when SS's recommendation graph has nothing
// for this paper, run a fields-of-study-driven search and return the most-cited
// papers in the same broad field. Not as good as the recommender — but vastly
// better than an empty Compare-section.
async function findSimilarByFields(seed, limit = 4, fetchFn = fetch) {
  // Prefer the specific (s2FieldsOfStudy) category over the broad one so the
  // result list isn't "all of CS".
  const specific = Array.isArray(seed?.s2FieldsOfStudy)
    ? seed.s2FieldsOfStudy.map((e) => e.category).filter(Boolean)
    : [];
  const broad = Array.isArray(seed?.fieldsOfStudy) ? seed.fieldsOfStudy : [];
  const queryTerm = specific[0] || broad[0];
  if (!queryTerm) return [];
  // Build a query from the title head + the field — gives SS's BM25 a strong
  // hint without locking us into the exact title.
  const titleHead = (seed?.title || '').split(/\s+/).slice(0, 6).join(' ');
  const q = cleanTitleForSearch(`${titleHead} ${queryTerm}`);
  if (!q) return [];
  const url = `${SS_GRAPH}/paper/search?query=${encodeURIComponent(q)}&limit=${limit + 1}&fields=${RECOMMENDATION_FIELDS}`;
  const res = await fetchSs(fetchFn, url);
  if (!res.ok) return [];
  const body = await res.json();
  const hits = Array.isArray(body.data) ? body.data : [];
  // Drop the seed paper itself if it shows up in its own similarity list.
  return hits.filter((p) => p.paperId !== seed.paperId).slice(0, limit);
}

// Resolve a paper to its Semantic Scholar entry using whichever identifier
// the caller can supply. Tries arXiv id → DOI → title (verified by jaccard
// similarity ≥ 0.5). Returns { match, source } or null.
//
// `source` is one of 'arxiv' | 'doi' | 'title' and is purely informational —
// it shows up in the persisted ss_data so we can debug "why no fields" by
// inspecting the row.
//
// We re-raise 429 (rate-limit) errors instead of swallowing them, so the
// caller (`enrichPaper`) can choose NOT to persist a poisoned record. The
// previous "swallow everything" behaviour caused a 429 on the arXiv fast-path
// to silently fall through to title-search, and a 429 there got persisted as
// `{ error: "...429" }` — locking the paper into the "no Field Map / no
// Similar Papers" state forever (cached error blob blocks retries).
async function resolvePaper({ title, arxivId, doi }, fetchFn = fetch) {
  if (arxivId) {
    try {
      const m = await lookupById(`arXiv:${arxivId}`, fetchFn);
      if (m && m.paperId) return { match: m, source: 'arxiv' };
    } catch (err) {
      console.error(`[ss.resolvePaper] arXiv:${arxivId} lookup failed:`, err.message);
      if (/\b429\b/.test(err.message)) throw err;
    }
  }
  if (doi) {
    try {
      const m = await lookupById(`DOI:${doi}`, fetchFn);
      if (m && m.paperId) return { match: m, source: 'doi' };
    } catch (err) {
      console.error(`[ss.resolvePaper] DOI:${doi} lookup failed:`, err.message);
      if (/\b429\b/.test(err.message)) throw err;
    }
  }
  if (title) {
    const m = await findPaperByTitleVerified(title, fetchFn, 0.5);
    if (m && m.paperId) return { match: m, source: 'title' };
  }
  return null;
}

// One-call helper used by the upload pipeline. Resolves the paper via the
// best available identifier, fetches its fields + similar papers, and shapes
// the result into Syflo's ss_data blob. Returns null when no match exists.
//
// `input` may be either a bare title string (back-compat with the original
// enrichFromTitle signature) or an object: { title, arxivId, doi, markdown }.
// When `markdown` is provided, arXiv id / DOI are auto-extracted from it if
// not already supplied — the upload pipeline almost always has the parsed
// markdown around.
async function enrichPaper(input, opts = {}) {
  const fetchFn = opts.fetchFn || fetch;
  // Accept the legacy `(title, { markdown, arxivId, doi, fetchFn })` shape
  // alongside the newer `({ title, markdown, ... })` object form. When `input`
  // is a string, we still want to pick up `markdown` / `arxivId` / `doi` from
  // the options bag — otherwise the upload pipeline (which calls
  // `enrichFn(finalTitle, { markdown })`) silently loses the markdown and
  // never gets the arXiv-id / DOI fast-path, yielding empty Field-Map +
  // Similar-Papers panels.
  const args = typeof input === 'string'
    ? { title: input, markdown: opts.markdown, arxivId: opts.arxivId, doi: opts.doi }
    : { ...(input || {}) };
  // Auto-extract identifiers from the markdown body when the caller didn't
  // supply them. Cheap, and dramatically improves match accuracy for arXiv
  // preprints (e.g. the canonical "arXiv:1011.0686" footer).
  if (args.markdown) {
    if (!args.arxivId) args.arxivId = extractArxivId(args.markdown);
    if (!args.doi) args.doi = extractDoi(args.markdown);
  }
  console.error(
    `[ss.enrichPaper] start title="${(args.title || '').slice(0, 60)}" arxivId=${args.arxivId || '-'} doi=${args.doi || '-'}`,
  );
  try {
    const resolved = await resolvePaper(args, fetchFn);
    if (!resolved) {
      console.error('[ss.enrichPaper] no resolution (404 on every strategy)');
      return null;
    }
    const { match, source } = resolved;
    console.error(`[ss.enrichPaper] resolved via=${source} ss_id=${match.paperId}`);
    // If lookupById returned a full record, we already have the fields;
    // otherwise fetch them separately. (The title-search path also requests
    // PAPER_FIELDS so this branch is usually a no-op.)
    let fieldsRaw = match;
    const hasFieldsKeys = 'fieldsOfStudy' in match || 's2FieldsOfStudy' in match;
    const hasFieldsValues =
      (Array.isArray(match.fieldsOfStudy) && match.fieldsOfStudy.length > 0) ||
      (Array.isArray(match.s2FieldsOfStudy) && match.s2FieldsOfStudy.length > 0);
    if (!hasFieldsKeys || !hasFieldsValues) {
      // SS sometimes returns the keys with null/[] values even when fields=
      // is passed — refetching with the dedicated fields-only projection
      // tends to return more complete data. Best-effort: fall back to `match`
      // on failure.
      fieldsRaw = await fetchFields(match.paperId, fetchFn).catch((err) => {
        console.error('[ss.enrichPaper] fetchFields failed:', err.message);
        return match;
      });
    }
    const recsRaw = await fetchRecommendations(match.paperId, 4, fetchFn)
      .catch((err) => {
        console.error('[ss.enrichPaper] fetchRecommendations failed:', err.message);
        return { recommendedPapers: [] };
      });
    let similarRaw = Array.isArray(recsRaw?.recommendedPapers) ? recsRaw.recommendedPapers : [];
    // Fallback path: when the recommendation graph is empty for this paper
    // (very common for older / less-cited work), pivot to a fields-of-study
    // search. Better than showing nothing.
    if (similarRaw.length === 0) {
      similarRaw = await findSimilarByFields(fieldsRaw, 4, fetchFn).catch(() => []);
    }
    console.error(
      `[ss.enrichPaper] done fields=${JSON.stringify(shapeFieldHierarchy(fieldsRaw || {}))} similar=${similarRaw.length}`,
    );
    return {
      ss_id: match.paperId,
      ss_title: match.title,
      resolved_via: source,
      fields: shapeFieldHierarchy(fieldsRaw || {}),
      similar: similarRaw.map(shapeRecommendation),
      // Top-level citations + open-access for the CURRENT paper — drives the
      // HeroBlock pills. Frontend was always reading these; the bug was that
      // we never extracted them from the fetched field-of-study payload.
      citations: fieldsRaw?.citationCount ?? null,
      open_access_pdf_url: fieldsRaw?.openAccessPdf?.url ?? null,
      // Surface canonical author list so the route can overwrite Marker's
      // heuristic extraction (Marker often grabs the affiliation block or
      // keyword tags instead of names). Array of plain-string names.
      authors: Array.isArray(fieldsRaw?.authors)
        ? fieldsRaw.authors.map((a) => a?.name).filter((n) => typeof n === 'string' && n.trim())
        : [],
      fetched_at: new Date().toISOString(),
    };
  } catch (err) {
    // Surface the error message but don't break the upload path; callers
    // will store this in parse_error metadata if they care.
    //
    // For 429 (rate-limit) we add `rate_limited: true` so the caller can
    // choose NOT to persist the blob — persisting `{ error: "...429" }` is
    // what previously caused Field Map / Similar Papers to be permanently
    // empty: the broken cache blocks future re-fetches.
    console.error('[ss.enrichPaper] FAILED:', err.message);
    const out = { error: err.message };
    if (/\b429\b/.test(err.message)) out.rate_limited = true;
    return out;
  }
}

// Back-compat shim. The original API took just a title and `{ fetchFn }`.
// Several callers (and tests) still use it, so we keep the same signature
// but funnel into the richer enrichPaper helper.
async function enrichFromTitle(title, opts = {}) {
  return enrichPaper(title, opts);
}

// Shape a Semantic Scholar `citedPaper` record into Syflo's reference-row
// contract (mirrors the OpenAlex `shapeReference` over in openalex.js so the
// frontend doesn't care which backend produced the row).
//
// SS returns `{ data: [{ citedPaper: {...} }, ...] }` from the /references
// endpoint. Each citedPaper looks like:
//   { paperId, title, authors: [{ name }], year, externalIds: { DOI, ArXiv, ... } }
// — see https://api.semanticscholar.org/api-docs/graph for the full shape.
function shapeSsReference(citedPaper) {
  if (!citedPaper || typeof citedPaper !== 'object') return null;
  const authors = Array.isArray(citedPaper.authors)
    ? citedPaper.authors.map((a) => a && a.name).filter(Boolean).slice(0, 5)
    : [];
  // SS exposes the DOI under externalIds.DOI as the bare slug (no leading
  // doi.org/). Lowercase to match the OpenAlex normalisation so dedup keys
  // are symmetric between sources.
  const rawDoi = citedPaper.externalIds && citedPaper.externalIds.DOI;
  const doi = typeof rawDoi === 'string' && rawDoi ? rawDoi.toLowerCase() : null;
  return {
    id: citedPaper.paperId || null,
    title: citedPaper.title || null,
    authors,
    year: citedPaper.year ?? null,
    doi,
  };
}

// Sleep helper used by the 429-retry backoff. Kept as a separate function so
// tests can monkey-patch it to zero-out the actual delay.
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fields requested from /paper/{id}/references. We pull a slightly richer set
// than the OpenAlex reference shape because SS doesn't always return both an
// id and a DOI — `externalIds` lets the caller fall back to whichever the
// frontend can link out to.
const SS_REFERENCE_FIELDS = 'title,authors,year,externalIds,abstract';

// Semantic Scholar fallback for the references endpoint. Used when OpenAlex's
// `referenced_works[]` is empty (a known data gap for some papers — DAgger,
// Boltzmann generators, etc.) but the paper has either a DOI or an arXiv id
// the SS API can resolve.
//
// Identifier priority (most → least specific):
//   1. DOI       — `DOI:<slug>`  — exact, unambiguous
//   2. arXiv id  — `arXiv:<id>`  — exact for preprints
//   3. Other identifier expressions accepted by SS as-is (e.g. an internal
//      S2 paperId, or a CorpusId:N expression a caller might already have)
//
// The identifier is URL-encoded so the colon in "DOI:..." / "arXiv:..." isn't
// interpreted as a path delimiter by the SS gateway.
//
// Rate-limit handling: SS's free tier is ~1 RPS / 100-per-5-min. On a 429 we
// retry up to `maxRetries` times with exponential backoff (1s, 2s, 4s, …),
// honouring the Retry-After header when present. After the final 429 we
// return an empty array — references are best-effort; better an empty list
// than blowing up the route. Non-429 non-OK responses also degrade to [] so
// a transient SS hiccup never throws.
async function fetchReferencesFromSS(
  { doi, arxivId, ssId } = {},
  fetchFn = fetch,
  opts = {},
) {
  // Pick the best identifier expression. SS accepts these prefixed forms:
  //   DOI:10.x/y          (preferred — DOIs are globally unique)
  //   arXiv:1011.0686     (also exact for preprints)
  //   <ssId verbatim>     (already a valid SS id expression, e.g. CorpusId:42
  //                       or the bare 40-char SHA paperId)
  let idExpr = null;
  if (doi) {
    idExpr = `DOI:${doi}`;
  } else if (arxivId) {
    idExpr = `arXiv:${arxivId}`;
  } else if (ssId) {
    idExpr = ssId;
  }
  if (!idExpr) return [];

  const limit = Math.max(1, Math.min(1000, opts.limit ?? 100));
  const maxRetries = opts.maxRetries ?? 3;
  const baseBackoffMs = opts.baseBackoffMs ?? 1000;
  // Tests can swap in a no-op sleep to keep the suite fast.
  const sleepFn = opts.sleepFn || delay;
  const url = `${SS_GRAPH}/paper/${encodeURIComponent(idExpr)}/references?fields=${SS_REFERENCE_FIELDS}&limit=${limit}`;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let res;
    try {
      res = await fetchSs(fetchFn, url);
    } catch (err) {
      // Network blip on a retry-able attempt — back off and try again. On the
      // final attempt we degrade to [] (best-effort contract).
      if (attempt < maxRetries) {
        await sleepFn(baseBackoffMs * (2 ** attempt));
        continue;
      }
      console.error('[ss.fetchReferencesFromSS] network error after retries:', err.message);
      return [];
    }
    if (res.status === 429) {
      // Honour Retry-After when present; otherwise exponential backoff. We
      // never spin longer than ~10 minutes (`parseRetryAfter` already caps).
      const retryAfter = parseRetryAfter(res);
      const sleepMs = retryAfter !== null
        ? Math.max(retryAfter * 1000, 100)
        : baseBackoffMs * (2 ** attempt);
      if (attempt < maxRetries) {
        await sleepFn(sleepMs);
        continue;
      }
      console.error(`[ss.fetchReferencesFromSS] 429 after ${maxRetries} retries — giving up`);
      return [];
    }
    if (res.status === 404) return [];
    if (!res.ok) {
      console.error(`[ss.fetchReferencesFromSS] non-OK status ${res.status}`);
      return [];
    }
    let body;
    try {
      body = await res.json();
    } catch (_) {
      return [];
    }
    const entries = Array.isArray(body?.data) ? body.data : [];
    // SS wraps each row as { citedPaper: {...} } (occasionally with extra
    // metadata like `isInfluential`). Map → shape → drop any row that lost
    // its title in transit (the frontend has nothing useful to render).
    return entries
      .map((e) => shapeSsReference(e?.citedPaper))
      .filter((r) => r && r.title);
  }
  return [];
}

// Search Semantic Scholar for papers matching `query`. Returns a list of
// summary objects (title, authors, year, citations, open-access PDF URL).
// Used by the home-screen search bar.
//
// 429 (rate limit) is treated as a soft failure — returns an empty list with
// `rate_limited: true` and (when SS sent Retry-After) `retry_after_seconds`
// so the frontend can show a countdown and auto-retry.
//
// Successful results are cached for 10 minutes. A 429 is NOT cached (we want
// the next request to be a fresh attempt, gated by the retry-after delay).
async function searchPapers(query, limit = 8, fetchFn = fetch) {
  const q = cleanTitleForSearch(query);
  if (!q) return { results: [], rate_limited: false };

  const key = `${normalizeKey(q)}::${limit}`;
  const cached = cacheGet(searchCache, key);
  if (cached) return { ...cached, cached: true };

  const url = `${SS_GRAPH}/paper/search?query=${encodeURIComponent(q)}&limit=${limit}&fields=paperId,title,authors,year,citationCount,openAccessPdf,abstract`;
  const res = await fetchSs(fetchFn, url);
  if (res.status === 429) {
    const retryAfter = parseRetryAfter(res);
    const out = { results: [], rate_limited: true };
    if (retryAfter !== null) out.retry_after_seconds = retryAfter;
    return out;
  }
  if (!res.ok) {
    throw new Error(`Semantic Scholar search failed: ${res.status}`);
  }
  const body = await res.json();
  const results = (body.data || []).map((p) => ({
    id: p.paperId,
    title: p.title,
    authors: Array.isArray(p.authors) ? p.authors.map((a) => a.name).filter(Boolean) : [],
    year: p.year ?? null,
    citations: p.citationCount ?? 0,
    open_access_pdf_url: p.openAccessPdf?.url ?? null,
    abstract: p.abstract ?? null,
  }));
  const value = { results, rate_limited: false };
  cacheSet(searchCache, key, value, SEARCH_TTL_MS, SEARCH_CACHE_MAX);
  return value;
}

module.exports = {
  enrichPaper,
  enrichFromTitle,
  resolvePaper,
  lookupById,
  findPaperByTitle,
  findPaperByTitleVerified,
  fetchFields,
  fetchRecommendations,
  findSimilarByFields,
  shapeFieldHierarchy,
  shapeRecommendation,
  cleanTitleForSearch,
  extractArxivId,
  extractDoi,
  titleSimilarity,
  searchPapers,
  clearCaches,
  parseRetryAfter,
  fetchReferencesFromSS,
  shapeSsReference,
  // Exposed for tests / advanced callers — generally callers should use the
  // higher-level helpers above.
  _internal: { searchCache, paperLookupCache },
};
