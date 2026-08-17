/**
 * openalex.js
 *
 * Primary enrichment backend. Replaces Semantic Scholar as Syflo's default
 * source of Field Map + Similar Papers data. OpenAlex (https://openalex.org)
 * has ~250M works, no API key requirement, and very generous rate limits
 * (~10 req/s and 100k req/day in the polite pool — see
 * https://docs.openalex.org/how-to-use-the-api/rate-limits-and-authentication).
 *
 * Why move off Semantic Scholar?
 *   • SS aggressively rate-limits the free tier (~100/5min) — even casual
 *     library use can blow through it.
 *   • SS frequently 404s older papers / non-CS work; OpenAlex has them.
 *   • OpenAlex exposes a `related_works` list directly on each work, so we
 *     don't need a separate recommendation endpoint.
 *
 * Polite-pool opt-in
 * ──────────────────
 * Per OpenAlex docs, sending a `mailto=` query parameter (or User-Agent header)
 * with a real email opts us into the polite pool, which has higher rate
 * limits than anonymous traffic. We hardcode the project owner's email here —
 * it's already in the repo via the Anthropic Co-Authored-By tags in commits,
 * so this isn't leaking anything new.
 *
 * API surface mirrors semantic-scholar.js
 * ───────────────────────────────────────
 * `enrichPaper` returns the same shape as the SS version, plus a `source`
 * field so callers/UI can tell which backend filled the record. The DB
 * column is still `ss_data_json` (rename later) — we just store the OpenAlex
 * work id (e.g. "W2741809807") in the `ss_id` slot.
 *
 * Fallback chain (in `routes/papers.js`):
 *   OpenAlex → Semantic Scholar (kept around so we don't lose its cache /
 *   rate-limit-aware code path for the rare paper OpenAlex misses)
 */

const SS = require('./semantic-scholar');

const OPENALEX_BASE = 'https://api.openalex.org';
const POLITE_MAIL = 'kavisenewiratne@apptronik.com';

// Build a polite-pool-aware URL. All callers go through this so we never
// forget the mailto= param.
function withMailto(url) {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}mailto=${encodeURIComponent(POLITE_MAIL)}`;
}

// Token-based Jaccard similarity, reused from semantic-scholar so the
// "verify a fuzzy title match is plausible" heuristic is consistent across
// backends.
const titleSimilarity = SS.titleSimilarity;

// arXiv id / DOI extraction also lives in SS — keep one canonical impl.
const extractArxivId = SS.extractArxivId;
const extractDoi = SS.extractDoi;

// Strip a few characters OpenAlex's search endpoint doesn't like (parens,
// colons), then truncate so the query stays reasonable. Same shape as the SS
// helper.
function cleanTitleForSearch(title) {
  return String(title || '')
    .replace(/[():,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// OpenAlex returns abstracts as an inverted index { token: [positions, ...] }
// — saves space in the dump but means clients have to rebuild the prose.
// Iterate every (token, position) pair and write the token at each position;
// gaps become single spaces. Returns null when the inverted index is missing
// or empty (older works don't always have abstracts).
function abstractFromInvertedIndex(idx) {
  if (!idx || typeof idx !== 'object') return null;
  const positions = [];
  for (const [token, posList] of Object.entries(idx)) {
    if (!Array.isArray(posList)) continue;
    for (const p of posList) {
      if (Number.isInteger(p) && p >= 0) positions.push([p, token]);
    }
  }
  if (positions.length === 0) return null;
  positions.sort((a, b) => a[0] - b[0]);
  // Build the array sparsely then join — handles missing positions as gaps.
  const max = positions[positions.length - 1][0];
  const arr = new Array(max + 1).fill('');
  for (const [pos, tok] of positions) arr[pos] = tok;
  return arr.filter(Boolean).join(' ');
}

// Cap on sibling chips shown in the Field Map. OpenAlex's `concepts` array can
// run 15–25 entries deep with cross-domain noise ("Geodesy", "Biology", …) for
// any CS paper that mentions a vaguely science-y word. Seven is what the
// design mockup specs — enough to feel rich, few enough to stay relevant.
const MAX_SIBLINGS = 7;

// Confidence threshold for `concepts` fallback. OpenAlex assigns very low
// scores (often < 0.1) to noisy keyword-overlap matches; 0.3 is the
// inflection point above which the tag is usually genuinely relevant.
const CONCEPT_MIN_SCORE = 0.3;

// Minimum sibling-chip count we aim for before falling back to the subfield
// topic-padding query. Five is the visual threshold from the mockup: any
// fewer and the Field Map strip looks anemic ("Boltzmann generators" sits at
// exactly 4 from `topics[]` alone, which is what motivated this padding).
const MIN_SIBLINGS_BEFORE_PADDING = 2;

// Reduce OpenAlex's topic data to Syflo's three-tier Field Map shape.
//
// Strategy (in order of preference):
//   1. `primary_topic` — OpenAlex's curated, per-work topic cluster. Has a
//      stable `{ display_name, subfield, field, domain }` shape. This is the
//      canonical source: it gives us a real cluster name ("Robot Learning
//      and Control") instead of a single keyword from `concepts`.
//   2. `topics[]` — ranked array of related topic clusters. Used to populate
//      the sibling-chip strip with peers of the primary topic.
//   3. `concepts[]` — legacy, noisy taxonomy with cross-domain leakage
//      (Geodesy, Biology, Geography on a robotics paper). Only used when
//      `primary_topic` is missing entirely, and filtered by score.
//
// Sibling chips are deduped against the three canonical tiers and capped at
// MAX_SIBLINGS so the UI never renders 20+ low-confidence noise tags.
//
// Note: this function is synchronous and does no network I/O. The
// subfield-topic padding (extra siblings pulled from OpenAlex when a paper
// has fewer than MIN_SIBLINGS_BEFORE_PADDING peers) lives in `enrichPaper`
// since it needs to hit the /topics endpoint.
function shapeFieldHierarchy(work) {
  const primary = work?.primary_topic;
  if (primary && primary.display_name) {
    const field = primary.field?.display_name || null;
    const subfield = primary.subfield?.display_name || null;
    const topic = primary.display_name || null;

    // Siblings: other `topics[]` entries that aren't the primary, plus the
    // canonical tier names so the chip strip stays informative.
    const siblings = [];
    const seen = new Set([field, subfield, topic].filter(Boolean));
    const otherTopics = Array.isArray(work.topics) ? work.topics : [];
    for (const t of otherTopics) {
      const n = t?.display_name;
      if (n && !seen.has(n)) { seen.add(n); siblings.push(n); }
      if (siblings.length >= MAX_SIBLINGS) break;
    }
    // `all` includes the canonical tiers + sibling topics (deduped, ordered).
    const all = [field, subfield, topic, ...siblings].filter(Boolean);
    return { field, subfield, topic, all };
  }

  // Legacy fallback: `concepts` taxonomy. Filter by score to drop the worst
  // of the cross-domain noise, then pick best-scoring per level.
  const concepts = Array.isArray(work?.concepts)
    ? work.concepts.filter((c) => (c?.score ?? 0) >= CONCEPT_MIN_SCORE)
    : [];
  if (concepts.length === 0) {
    return { field: null, subfield: null, topic: null, all: [] };
  }
  // Highest-scoring first, regardless of level — ties broken by level so a
  // narrower concept wins over a broader one at the same score.
  concepts.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const topAtLevel = (lvl) => concepts.find((c) => c.level === lvl) || null;
  const field = topAtLevel(0)?.display_name || null;
  const subfield = topAtLevel(1)?.display_name || null;
  const topic = topAtLevel(2)?.display_name || null;
  // `all` is every distinct display name, kept in score order and capped.
  const seen = new Set();
  const all = [];
  for (const c of concepts) {
    const n = c?.display_name;
    if (n && !seen.has(n)) { seen.add(n); all.push(n); }
    if (all.length >= MAX_SIBLINGS + 3) break; // +3 for the canonical tiers
  }
  return { field, subfield, topic, all };
}

// Map an OpenAlex work into Syflo's SemanticScholarSimilarPaper shape so the
// frontend types don't have to change. authorships → first 3 names; abstract
// rebuilt from the inverted index; open-access flag straight from oa.is_oa.
function shapeSimilar(work) {
  const authors = Array.isArray(work?.authorships)
    ? work.authorships
        .map((a) => a?.author?.display_name)
        .filter(Boolean)
        .slice(0, 3)
    : [];
  return {
    id: work?.id || null,
    title: work?.display_name || work?.title || null,
    authors,
    year: work?.publication_year ?? null,
    citations: work?.cited_by_count ?? 0,
    open_access: !!(work?.open_access && work.open_access.is_oa),
    abstract: abstractFromInvertedIndex(work?.abstract_inverted_index),
  };
}

// Generic single-work fetch. Returns the JSON body, or null on 404. Any
// other non-OK status throws so the caller's try/catch can decide whether to
// fall back or surface the error.
async function fetchWork(idExpr, fetchFn = fetch) {
  const url = withMailto(`${OPENALEX_BASE}/works/${encodeURIComponent(idExpr)}`);
  const res = await fetchFn(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`OpenAlex work lookup failed: ${res.status}`);
  return res.json();
}

// Exact-match arXiv lookup. OpenAlex accepts arXiv URLs as ids (it returns
// the work whose `ids.openalex` corresponds to that arXiv id) — much more
// reliable than fuzzy title search.
async function lookupByArxiv(arxivId, fetchFn = fetch) {
  if (!arxivId) return null;
  // `encodeURIComponent` on the full URL escapes the colon/slashes so the
  // server treats the value as a single id, not extra path segments.
  return fetchWork(`https://arxiv.org/abs/${arxivId}`, fetchFn);
}

// Exact-match DOI lookup. Same id-expression strategy.
async function lookupByDoi(doi, fetchFn = fetch) {
  if (!doi) return null;
  return fetchWork(`https://doi.org/${doi}`, fetchFn);
}

// Title fallback. /works?search=... returns ranked hits; we pull 5 and pick
// the one with the best Jaccard similarity vs. the requested title, only if
// it crosses the 0.5 threshold. Returns null when nothing's plausible — the
// caller is then free to fall back to Semantic Scholar.
async function lookupByTitle(title, fetchFn = fetch, threshold = 0.5) {
  const q = cleanTitleForSearch(title);
  if (!q) return null;
  const url = withMailto(
    `${OPENALEX_BASE}/works?search=${encodeURIComponent(q)}&per-page=5`,
  );
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`OpenAlex title search failed: ${res.status}`);
  const body = await res.json();
  const hits = Array.isArray(body?.results) ? body.results : [];
  if (hits.length === 0) return null;
  let best = hits[0];
  let bestScore = titleSimilarity(title, best.display_name || '');
  for (let i = 1; i < hits.length; i += 1) {
    const score = titleSimilarity(title, hits[i].display_name || '');
    if (score > bestScore) {
      best = hits[i];
      bestScore = score;
    }
  }
  if (bestScore < threshold) return null;
  return best;
}

// Map an OpenAlex work into Syflo's SearchResult shape (the one the home-screen
// search bar renders). Differs from `shapeSimilar` in that it picks a usable
// PDF URL — every search hit needs one for the import affordance to enable —
// and exposes the DOI so the dedup pass in routes/papers.js can match against
// arXiv results carrying the same paper.
function shapeSearchResult(work) {
  const authors = Array.isArray(work?.authorships)
    ? work.authorships
        .map((a) => a?.author?.display_name)
        .filter(Boolean)
        .slice(0, 5)
    : [];
  // Collect every PDF URL OpenAlex knows about, deduped and ordered by
  // preference. The frontend sends the whole list to the import endpoint so
  // when the publisher (e.g. Sage) returns 403 on the canonical link, the
  // backend can try the institutional-repo / preprint mirror next without a
  // round-trip back to the user.
  //
  // Priority: best_oa_location (OpenAlex's curated pick) → primary_location
  // → every other `locations[]` entry → bare `open_access.oa_url`.
  const oa = work?.open_access || {};
  const pdfCandidates = [];
  const seenPdfs = new Set();
  const pushPdf = (url) => {
    if (typeof url !== 'string' || !url) return;
    if (seenPdfs.has(url)) return;
    seenPdfs.add(url);
    pdfCandidates.push(url);
  };
  pushPdf(work?.best_oa_location?.pdf_url);
  pushPdf(work?.primary_location?.pdf_url);
  if (Array.isArray(work?.locations)) {
    for (const loc of work.locations) pushPdf(loc?.pdf_url);
  }
  pushPdf(oa.oa_url);
  // Primary URL stays in the SearchResult contract; the candidates array is
  // additive so older frontends keep working.
  const pdf = pdfCandidates[0] || null;
  // DOI from OpenAlex always comes back as the full URL form
  // (https://doi.org/10.x/y). Normalize to the bare slug so the dedup compare
  // is symmetric with anything we pull off arXiv markdown.
  const doi = typeof work?.doi === 'string'
    ? work.doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase()
    : null;
  return {
    id: work?.id || null,
    title: typeof work?.display_name === 'string'
      ? work.display_name.replace(/\s+/g, ' ').trim()
      : (work?.title || ''),
    authors,
    year: work?.publication_year ?? null,
    citations: work?.cited_by_count ?? 0,
    open_access_pdf_url: pdf,
    abstract: abstractFromInvertedIndex(work?.abstract_inverted_index),
    // Optional fields used by the routes layer for dedup; harmless if the
    // frontend ignores them.
    doi,
    // Full PDF-URL chain so the import endpoint can fall back when the
    // primary URL 403s. Empty array when no OA copy is known.
    pdf_candidates: pdfCandidates,
  };
}

// Home-screen search backend. Hits /works?search=... and shapes hits into the
// frontend's SearchResult contract. Returns `{ results, rate_limited: false }`
// so routes/papers.js can treat the envelope identically to arXiv's.
//
// On non-OK responses we throw — the route's `Promise.allSettled` swallows
// that into a `rejected` state and proceeds with whatever arXiv returned.
async function searchPapers(query, limit = 20, fetchFn = fetch) {
  const q = (query || '').toString().trim();
  if (!q) return { results: [], rate_limited: false };

  const url = withMailto(
    `${OPENALEX_BASE}/works?search=${encodeURIComponent(q)}&per-page=${Math.max(1, Math.min(50, limit))}`,
  );
  const res = await fetchFn(url);
  if (!res.ok) {
    throw new Error(`OpenAlex search failed: ${res.status}`);
  }
  const body = await res.json();
  const hits = Array.isArray(body?.results) ? body.results : [];
  const results = hits.map(shapeSearchResult).filter((r) => r.title);
  return { results, rate_limited: false };
}

// ─────────────────────────────────────────────────────────────────────────
// Counter caches (Field Map "— 14 subfields" / "— 6 topics" hints, I3).
// ─────────────────────────────────────────────────────────────────────────
//
// Each counter-lookup is an extra OpenAlex call beyond the work-resolution +
// related-works fetches, so we don't want to repeat them on every enrichment.
// Two tiny in-memory Maps keyed by the bare OpenAlex id (F123, S456) act as
// poor-man's LRUs: when the cache exceeds MAX_COUNTER_CACHE entries we drop
// the oldest insertion (Map iteration order is insertion order in JS).
//
// Why no TTL? Counter values change at OpenAlex's curation pace — months,
// not minutes — and the cache lives only as long as the Node process, so
// long-lived staleness isn't a concern. A restart re-populates from scratch.
const MAX_COUNTER_CACHE = 100;
const subfieldCountCache = new Map(); // F-id → count
const topicCountCache = new Map();    // S-id → count

function cacheGet(map, key) {
  if (!map.has(key)) return undefined;
  const value = map.get(key);
  // Touch the entry: re-insert so it becomes the newest. Cheap "LRU".
  map.delete(key);
  map.set(key, value);
  return value;
}

function cacheSet(map, key, value) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > MAX_COUNTER_CACHE) {
    // Evict the oldest insertion (first key in iteration order).
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

// Strip the OpenAlex URL prefix from a field/subfield id, returning the bare
// "F123" / "S456" form. The /subfields and /fields filter endpoints accept
// either form, but the bare id keeps URLs short and cache keys stable.
function bareOpenalexId(id) {
  if (!id) return '';
  return String(id).replace(/^https?:\/\/openalex\.org\/(?:fields\/|subfields\/|topics\/)?/i, '');
}

// Fetch how many subfields belong to a given OpenAlex field. Used to render
// the "FIELD — 14 subfields" counter-hint next to the Field tier in the
// FieldMap (mockup-infographic.html line ~253). One round-trip per cold
// field; subsequent calls hit `subfieldCountCache`.
//
// Uses `per_page=1` because we only care about `meta.count` — the actual
// results array is discarded. Best-effort: any non-OK response or thrown
// error returns null so the UI can simply skip the hint rather than crash.
async function fetchSubfieldCount(fieldId, fetchFn = fetch) {
  const bare = bareOpenalexId(fieldId);
  if (!bare) return null;
  const cached = cacheGet(subfieldCountCache, bare);
  if (cached !== undefined) return cached;
  const filter = `field.id:${bare}`;
  const url = withMailto(
    `${OPENALEX_BASE}/subfields?filter=${encodeURIComponent(filter)}&per-page=1`,
  );
  try {
    const res = await fetchFn(url);
    if (!res.ok) return null;
    const body = await res.json();
    const count = typeof body?.meta?.count === 'number' ? body.meta.count : null;
    if (count != null) cacheSet(subfieldCountCache, bare, count);
    return count;
  } catch (_) {
    return null;
  }
}

// Fetch how many topics belong to a given OpenAlex subfield. Powers the
// "SUBFIELD — 6 topics" counter-hint. Same caching + best-effort-failure
// posture as `fetchSubfieldCount`.
async function fetchTopicCount(subfieldId, fetchFn = fetch) {
  const bare = bareOpenalexId(subfieldId);
  if (!bare) return null;
  const cached = cacheGet(topicCountCache, bare);
  if (cached !== undefined) return cached;
  const filter = `subfield.id:${bare}`;
  const url = withMailto(
    `${OPENALEX_BASE}/topics?filter=${encodeURIComponent(filter)}&per-page=1`,
  );
  try {
    const res = await fetchFn(url);
    if (!res.ok) return null;
    const body = await res.json();
    const count = typeof body?.meta?.count === 'number' ? body.meta.count : null;
    if (count != null) cacheSet(topicCountCache, bare, count);
    return count;
  } catch (_) {
    return null;
  }
}

// Test-only: reset the counter caches between unit tests so a previous test's
// successful fetch doesn't mask a 500 in the next test. Not exported as part
// of the public API; only callable through the module's exports object.
function __resetCounterCaches() {
  subfieldCountCache.clear();
  topicCountCache.clear();
}

// Fetch the top topics for a given OpenAlex subfield, sorted by works_count
// (most-popular topics first). Used to pad the Field Map sibling chip strip
// for papers whose `primary_topic.topics[]` is too thin (Boltzmann generators
// has only 4 native siblings, but the user expects 5-7 in the mockup).
//
// The `subfieldId` argument accepts either the bare `S123` id or the full
// OpenAlex URL form (`https://openalex.org/subfields/S123`); we normalise to
// the bare id. Returns an array of `{ id, display_name }` objects, or [] on
// any failure / empty response — caller treats "no extra padding available"
// as a soft degradation, not an error.
async function fetchSubfieldTopics(subfieldId, limit = 8, fetchFn = fetch) {
  if (!subfieldId) return [];
  // Normalise to the bare S-id. OpenAlex accepts either form in the filter
  // expression but the bare id keeps the URL short and the cache key stable.
  const bare = String(subfieldId).replace(/^https?:\/\/openalex\.org\/(?:subfields\/)?/i, '');
  const filter = `subfield.id:${bare}`;
  const url = withMailto(
    `${OPENALEX_BASE}/topics?filter=${encodeURIComponent(filter)}&sort=works_count:desc&per-page=${Math.max(1, Math.min(25, limit))}`,
  );
  try {
    const res = await fetchFn(url);
    if (!res.ok) return [];
    const body = await res.json();
    const results = Array.isArray(body?.results) ? body.results : [];
    return results
      .map((t) => ({ id: t?.id || null, display_name: t?.display_name || null }))
      .filter((t) => t.display_name);
  } catch (_) {
    return [];
  }
}

// List subfields that belong to a given field. Used to populate the
// "peers" disclosure on the Subfield tier of the Field Map. Returns
// `{ id, display_name }[]` sorted by works_count desc, or [] on any failure.
async function fetchSubfieldsInField(fieldId, limit = 12, fetchFn = fetch) {
  if (!fieldId) return [];
  const bare = String(fieldId).replace(/^https?:\/\/openalex\.org\/(?:fields\/)?/i, '');
  const filter = `field.id:${bare}`;
  const url = withMailto(
    `${OPENALEX_BASE}/subfields?filter=${encodeURIComponent(filter)}&sort=works_count:desc&per-page=${Math.max(1, Math.min(25, limit))}`,
  );
  try {
    const res = await fetchFn(url);
    if (!res.ok) return [];
    const body = await res.json();
    const results = Array.isArray(body?.results) ? body.results : [];
    return results
      .map((t) => ({
        id: t?.id || null,
        display_name: t?.display_name || null,
        works_count: typeof t?.works_count === 'number' ? t.works_count : null,
      }))
      .filter((t) => t.display_name);
  } catch (_) {
    return [];
  }
}

// List fields that belong to a given domain. Used to populate the "peers"
// disclosure on the Field tier of the Field Map. OpenAlex only has 4 domains
// and 26 fields total, so the per-page cap is small.
async function fetchFieldsInDomain(domainId, limit = 12, fetchFn = fetch) {
  if (!domainId) return [];
  const bare = String(domainId).replace(/^https?:\/\/openalex\.org\/(?:domains\/)?/i, '');
  const filter = `domain.id:${bare}`;
  const url = withMailto(
    `${OPENALEX_BASE}/fields?filter=${encodeURIComponent(filter)}&sort=works_count:desc&per-page=${Math.max(1, Math.min(25, limit))}`,
  );
  try {
    const res = await fetchFn(url);
    if (!res.ok) return [];
    const body = await res.json();
    const results = Array.isArray(body?.results) ? body.results : [];
    return results
      .map((t) => ({
        id: t?.id || null,
        display_name: t?.display_name || null,
        works_count: typeof t?.works_count === 'number' ? t.works_count : null,
      }))
      .filter((t) => t.display_name);
  } catch (_) {
    return [];
  }
}

// Stop-words used by the padding-noise filter below. Short connectives that
// appear in many topic names but carry no semantic content. Kept in a Set so
// membership checks are O(1) per token.
const PADDING_STOPWORDS = new Set([
  'and', 'or', 'in', 'of', 'the', 'for', 'with', 'to', 'a', 'an', 'is',
  'on', 'by', 'from',
]);

// Extract content-words (lowercased, >3 chars, not stopwords) from a string.
// Used by the noise filter so two topic names are compared on substantive
// vocabulary only — "Geochemistry and Geologic Mapping" vs "Artificial
// Intelligence" share "and" / "in" without that meaning the topics are
// genuinely related.
function contentWords(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !PADDING_STOPWORDS.has(w));
}

// Pad an already-shaped `fields` block with extra siblings drawn from the
// subfield-wide topic list. No-op when the existing chip strip already meets
// MIN_SIBLINGS_BEFORE_PADDING. Returns a new shape — never mutates the input.
//
// Dedup runs against every existing tier (field/subfield/topic + sibling
// chips already in `all`) so we don't double-tag a chip. Final cap stays at
// MAX_SIBLINGS sibling chips plus the three canonical tiers.
//
// Noise filter (I2): OpenAlex's `subfield.topics` collection is noisy for
// poorly-curated subfields like "Artificial Intelligence", where the top-N
// topics include cross-domain padding ("Geochemistry and Geologic Mapping",
// "Computational Physics and Python Applications"). We retain a padding
// topic only when at least one content-word (>3 chars, not a stopword) is
// shared with the paper's own subfield / field / topic tier — case
// insensitive. The shared-word check is the cheapest signal that
// distinguishes "Educational Robotics and Engineering" (shares "Robotics"
// with the RL-in-Robotics topic) from "Geochemistry and Geologic Mapping"
// (shares nothing).
//
// Fallback: when fewer than MIN_SIBLINGS_BEFORE_PADDING extras survive the
// filter we return the UNFILTERED padded result with `paddingFiltered: false`
// so the Field Map strip isn't suddenly empty. The flag is preserved through
// the output shape so downstream consumers / debugging can tell whether the
// chips were vetted or not.
function padFieldHierarchyWithSubfield(fields, extraTopics) {
  if (!fields) return fields;
  const tiers = [fields.field, fields.subfield, fields.topic].filter(Boolean);
  const existing = Array.isArray(fields.all) ? fields.all : [];
  // Already enough siblings — keep the original shape untouched.
  const existingSiblings = existing.filter((n) => !tiers.includes(n));
  if (existingSiblings.length >= MIN_SIBLINGS_BEFORE_PADDING) return fields;
  if (!Array.isArray(extraTopics) || extraTopics.length === 0) return fields;

  // Pool of content-words from the paper's canonical tiers. Topics that share
  // at least one of these survive the filter.
  const tierWords = new Set();
  for (const tier of tiers) for (const w of contentWords(tier)) tierWords.add(w);

  const sharesWord = (name) => {
    if (tierWords.size === 0) return true; // no signal to filter on
    for (const w of contentWords(name)) if (tierWords.has(w)) return true;
    return false;
  };

  // First pass: filtered list.
  const seenFiltered = new Set([...tiers, ...existingSiblings]);
  const filtered = [...existingSiblings];
  for (const t of extraTopics) {
    const n = t?.display_name;
    if (!n || seenFiltered.has(n)) continue;
    if (!sharesWord(n)) continue;
    seenFiltered.add(n);
    filtered.push(n);
    if (filtered.length >= MAX_SIBLINGS) break;
  }

  // If filtering left us with too few topics, fall back to the unfiltered
  // pad so the Field Map strip isn't suddenly anemic. Flag the result so the
  // caller / UI can tell which path was taken.
  if (filtered.length >= MIN_SIBLINGS_BEFORE_PADDING) {
    return {
      ...fields,
      all: [...tiers, ...filtered],
      paddingFiltered: true,
    };
  }

  // Fallback: ungated pad (original behaviour) + flag.
  const seenUnfiltered = new Set([...tiers, ...existingSiblings]);
  const padded = [...existingSiblings];
  for (const t of extraTopics) {
    const n = t?.display_name;
    if (!n || seenUnfiltered.has(n)) continue;
    seenUnfiltered.add(n);
    padded.push(n);
    if (padded.length >= MAX_SIBLINGS) break;
  }
  return {
    ...fields,
    all: [...tiers, ...padded],
    paddingFiltered: false,
  };
}

// Fetch the details of up to `limit` related works in a single batched call.
// OpenAlex lets us filter by a pipe-separated id list — one round-trip
// instead of N. Returns an array of work objects (possibly empty) — failures
// degrade to [] because "no similar papers" is better than blowing up the
// upload pipeline.
async function fetchRelatedWorks(work, limit = 6, fetchFn = fetch) {
  const related = Array.isArray(work?.related_works) ? work.related_works : [];
  if (related.length === 0) return [];
  // OpenAlex ids look like "https://openalex.org/W123…" — the filter accepts
  // either the bare id or the URL form, but the bare id keeps the query
  // shorter. Strip the prefix defensively.
  const ids = related
    .slice(0, limit)
    .map((id) => String(id).replace(/^https?:\/\/openalex\.org\//i, ''));
  const filter = `ids.openalex:${ids.join('|')}`;
  const url = withMailto(
    `${OPENALEX_BASE}/works?filter=${encodeURIComponent(filter)}&per-page=${limit}`,
  );
  try {
    const res = await fetchFn(url);
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body?.results) ? body.results : [];
  } catch (_) {
    return [];
  }
}

// Shape a referenced OpenAlex work into Syflo's reference-row contract.
// Smaller than `shapeSimilar` on purpose — references are dense (one paper
// can cite 50+ others) and the UI only renders title, authors, year, DOI.
function shapeReference(work) {
  const authors = Array.isArray(work?.authorships)
    ? work.authorships
        .map((a) => a?.author?.display_name)
        .filter(Boolean)
        .slice(0, 5)
    : [];
  // Bare-slug DOI (matching shapeSearchResult) so the frontend can link out
  // to doi.org consistently. Null when OpenAlex has no DOI on the record.
  const doi = typeof work?.doi === 'string'
    ? work.doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase()
    : null;
  return {
    id: work?.id || null,
    title: work?.display_name || work?.title || null,
    authors,
    year: work?.publication_year ?? null,
    doi,
    // Both arrive in the very response above and used to be dropped: 33 of
    // 171 stored references carried an OpenAlex id and no citation count, and
    // not one carried a venue (measured 2026-08-12). The card's fold then had
    // nothing to show for a work OpenAlex knows well.
    citations: work?.cited_by_count ?? null,
    venue: venueOf(work),
  };
}

/**
 * Where a work appeared, as OpenAlex names it. `primary_location` is the
 * publisher's copy; `best_oa_location` is often a repository ("arXiv"), which
 * is where to READ it, not where it was published — so the primary wins.
 */
function venueOf(work) {
  return (
    work?.primary_location?.source?.display_name ||
    work?.best_oa_location?.source?.display_name ||
    null
  );
}

// Fetch the full details of every OpenAlex work in `referenced_works[]` and
// return them shaped as references. OpenAlex caps the `ids.openalex` filter at
// ~50 ids per request, so we batch the input list and concat results.
// Failures on individual batches degrade to skipping that batch — better to
// return a partial reference list than nothing at all.
//
// Returns an empty array when the input has no references. Order is preserved
// so the UI can render in citation order.
async function fetchReferences(referencedWorks, fetchFn = fetch) {
  const ids = (Array.isArray(referencedWorks) ? referencedWorks : [])
    .map((id) => String(id).replace(/^https?:\/\/openalex\.org\//i, ''))
    .filter(Boolean);
  if (ids.length === 0) return [];

  const BATCH = 50;
  // Track results keyed by id so we can re-order to match the input later.
  const byId = new Map();
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const filter = `ids.openalex:${slice.join('|')}`;
    // per-page must match the batch size or OpenAlex will paginate and we'd
    // silently lose the tail of each batch.
    const url = withMailto(
      `${OPENALEX_BASE}/works?filter=${encodeURIComponent(filter)}&per-page=${slice.length}`,
    );
    try {
      const res = await fetchFn(url);
      if (!res.ok) continue;
      const body = await res.json();
      const results = Array.isArray(body?.results) ? body.results : [];
      for (const w of results) {
        const bareId = String(w?.id || '').replace(/^https?:\/\/openalex\.org\//i, '');
        if (bareId) byId.set(bareId, shapeReference(w));
      }
    } catch (_) {
      // best-effort: skip this batch on network blip
    }
  }
  // Preserve citation order. Any ids OpenAlex couldn't resolve are dropped
  // silently — we don't have anything to display for them and the UI doesn't
  // need a placeholder.
  return ids
    .map((id) => byId.get(id))
    .filter(Boolean);
}

// Resolve a paper to an OpenAlex work using the best identifier available.
// arXiv → DOI → title-search (Jaccard-verified). Returns `{ work, source }`
// or null. Failures on individual strategies don't abort the chain — we want
// to try every available signal before giving up and letting SS take over.
async function resolveWork({ title, arxivId, doi }, fetchFn = fetch) {
  if (arxivId) {
    try {
      const w = await lookupByArxiv(arxivId, fetchFn);
      if (w && w.id) return { work: w, source: 'arxiv' };
    } catch (err) {
      console.error(`[openalex.resolveWork] arXiv:${arxivId} failed:`, err.message);
    }
  }
  if (doi) {
    try {
      const w = await lookupByDoi(doi, fetchFn);
      if (w && w.id) return { work: w, source: 'doi' };
    } catch (err) {
      console.error(`[openalex.resolveWork] DOI:${doi} failed:`, err.message);
    }
  }
  if (title) {
    try {
      const w = await lookupByTitle(title, fetchFn);
      if (w && w.id) return { work: w, source: 'title' };
    } catch (err) {
      console.error(`[openalex.resolveWork] title search failed:`, err.message);
    }
  }
  return null;
}

// Venue-name fragments that unambiguously identify a paper as Computer
// Science / AI / ML, regardless of what OpenAlex's `primary_topic` says.
// OpenAlex misclassifies several flagship ML papers as "Decision Sciences"
// or "Mathematics" (e.g. DAgger lands in "Advanced Bandit Algorithms
// Research" → "Operations Research" → "Decision Sciences"). When the venue
// is one of these the field is settled — force CS/AI.
//
// Case-insensitive substring match against `primary_location.source.display_name`.
const CS_VENUE_FRAGMENTS = [
  'NeurIPS', 'NIPS', 'ICML', 'AISTATS', 'ICLR', 'JMLR',
  'CVPR', 'ACL', 'EMNLP',
];

// CS topic-name keywords. arXiv hosts work from many disciplines, so the
// venue alone isn't a CS signal — but if OpenAlex's primary_topic name
// already mentions classical ML / RL / theory terms AND the host is arXiv,
// we can confidently treat the work as CS even when OpenAlex's higher
// tiers ("Decision Sciences", "Mathematics") collapse it into a generic
// bucket (e.g. DAgger → "Advanced Bandit Algorithms Research").
const CS_TOPIC_KEYWORDS = [
  'learning', 'neural', 'imitation', 'reinforcement', 'bandit', 'regret',
  'stochastic', 'gradient', 'policy', 'online', 'classifier', 'agent',
  'ai-based', 'machine learning', 'deep ',
];
const ARXIV_VENUE_RE = /\barxiv\b/i;

function looksLikeArxivCsTopic(venueName, topicName) {
  if (!venueName || !topicName) return false;
  if (!ARXIV_VENUE_RE.test(String(venueName))) return false;
  const topic = String(topicName).toLowerCase();
  return CS_TOPIC_KEYWORDS.some((kw) => topic.includes(kw));
}

// OpenAlex `primary_topic.field.display_name` values that are notoriously
// generic for ML/RL papers — DAgger ("Decision Sciences"), various theory
// work ("Mathematics"). When we see one of these AND Semantic Scholar's
// `s2FieldsOfStudy` calls the paper "Computer Science", we prefer SS.
const GENERIC_OA_FIELDS = new Set([
  'decision sciences',
  'mathematics',
  'business, management and accounting',
  'economics, econometrics and finance',
]);

// Detect whether `name` belongs to the CS-venue allowlist. Tolerates either
// the bare venue acronym ("ICML") or the full conference name
// ("International Conference on Machine Learning").
function isCsVenue(name) {
  if (!name) return false;
  const s = String(name);
  for (const frag of CS_VENUE_FRAGMENTS) {
    // Word-boundary-ish match so "ACL" doesn't match "Practical".
    const re = new RegExp(`\\b${frag}\\b`, 'i');
    if (re.test(s)) return true;
  }
  return false;
}

// Extract a usable category list from an SS `s2FieldsOfStudy` payload.
// Returns the categories (lowercased) above the confidence floor — same
// 0.5 threshold semantic-scholar.js uses for its own field-shaping so we
// don't accept tags SS itself would discard.
function ssCategories(s2Fields) {
  if (!Array.isArray(s2Fields)) return [];
  return s2Fields
    .filter((e) => e && (e.score == null || e.score >= 0.5) && e.category)
    .map((e) => String(e.category));
}

// Apply field-of-study overrides on top of the OpenAlex-derived shape.
// Priority (highest → lowest):
//   1. Venue override — primary_location.source.display_name matches one of
//      the CS_VENUE_FRAGMENTS. Field is forced to "Computer Science" and
//      subfield to "Artificial Intelligence". OpenAlex's `topic` and the
//      sibling-chip strip are kept (still useful as detail).
//   2. SS override — OpenAlex field is generic (Decision Sciences /
//      Mathematics / ...) AND SS's s2FieldsOfStudy declares "Computer
//      Science". Prefer SS for `field`. Keep OpenAlex's `subfield` unless
//      SS exposes a more specific ML/AI category ("Machine Learning",
//      "Artificial Intelligence") — overlay then.
//   3. No override — return the input shape untouched.
//
// Always returns a NEW object (never mutates `fields`). Returns the input
// unchanged when `fields` is null/undefined.
function applyFieldOverrides(fields, { venueName, s2Fields } = {}) {
  if (!fields) return fields;
  // 1. Venue override is the strongest signal — conference venue alone
  //    settles the field/subfield without needing SS. Also matches
  //    "arXiv + CS-keyword topic" since arXiv preprints are how many ML
  //    papers enter OpenAlex without proper conference attribution.
  if (isCsVenue(venueName) || looksLikeArxivCsTopic(venueName, fields.topic)) {
    return {
      ...fields,
      field: 'Computer Science',
      subfield: 'Artificial Intelligence',
      fieldOverrideSource: isCsVenue(venueName) ? 'venue' : 'arxiv-topic',
      // Keep tier ordering consistent for the UI: field, subfield, topic,
      // then any existing siblings (deduped to avoid surfacing the override
      // twice if OpenAlex's original strip already contained it).
      all: dedupeTiers(['Computer Science', 'Artificial Intelligence', fields.topic, ...(fields.all || [])]),
    };
  }
  // 2. SS override only fires when OpenAlex is generic AND SS has a
  //    confident CS verdict. Anything else: trust OpenAlex.
  const cats = ssCategories(s2Fields);
  const lowerCats = new Set(cats.map((c) => c.toLowerCase()));
  const oaFieldLower = String(fields.field || '').toLowerCase();
  if (lowerCats.has('computer science') && GENERIC_OA_FIELDS.has(oaFieldLower)) {
    // Pick a more specific SS subfield when available (Machine Learning,
    // Artificial Intelligence). Keep the OpenAlex subfield otherwise — it's
    // usually more granular than SS's broad tags.
    const specificCats = ['Artificial Intelligence', 'Machine Learning'];
    let subfield = fields.subfield;
    for (const cat of specificCats) {
      if (lowerCats.has(cat.toLowerCase())) { subfield = cat; break; }
    }
    return {
      ...fields,
      field: 'Computer Science',
      subfield,
      fieldOverrideSource: 's2',
      all: dedupeTiers(['Computer Science', subfield, fields.topic, ...(fields.all || [])]),
    };
  }
  return fields;
}

// Order-preserving dedup of a chip-strip array. Drops empty/null entries.
function dedupeTiers(arr) {
  const out = [];
  const seen = new Set();
  for (const n of arr) {
    if (!n) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

// One-call helper used by the upload pipeline. Resolves the paper, fetches
// its related works, and shapes everything into the existing ss_data blob —
// plus a `source: 'openalex'` tag so the UI can label which backend filled
// the record.
//
// Signature mirrors semantic-scholar.enrichPaper so the routes layer can swap
// between them with no other changes. `input` may be a bare title string OR
// an object `{ title, arxivId, doi, markdown }`. When `markdown` is provided
// we auto-extract arXiv id / DOI for an exact match.
//
// Returns null when OpenAlex has no match at all — callers should treat that
// as the trigger to fall back to Semantic Scholar.
async function enrichPaper(input, opts = {}) {
  const fetchFn = opts.fetchFn || fetch;
  const args = typeof input === 'string'
    ? { title: input, markdown: opts.markdown, arxivId: opts.arxivId, doi: opts.doi }
    : { ...(input || {}) };
  if (args.markdown) {
    if (!args.arxivId) args.arxivId = extractArxivId(args.markdown);
    if (!args.doi) args.doi = extractDoi(args.markdown);
  }
  console.error(
    `[openalex.enrichPaper] start title="${(args.title || '').slice(0, 60)}" arxivId=${args.arxivId || '-'} doi=${args.doi || '-'}`,
  );
  try {
    const resolved = await resolveWork(args, fetchFn);
    if (!resolved) {
      console.error('[openalex.enrichPaper] no resolution');
      return null;
    }
    const { work, source: resolvedVia } = resolved;
    console.error(`[openalex.enrichPaper] resolved via=${resolvedVia} id=${work.id}`);
    // Pull the top related works in one batched call so the Similar Papers
    // panel is populated alongside the Field Map.
    const relatedRaw = await fetchRelatedWorks(work, 6, fetchFn);
    // Pad the sibling-chip strip with subfield-wide topics when the paper's
    // own `topics[]` list is too thin. The Boltzmann-generators paper, for
    // instance, only has 4 native siblings — the mockup wants 5-7. We make
    // the padding query best-effort: a failure here just leaves the existing
    // (sparse) shape in place rather than blocking the enrichment response.
    let fields = shapeFieldHierarchy(work);
    const subfieldId = work?.primary_topic?.subfield?.id;
    const existingSiblings = (fields.all || []).filter(
      (n) => ![fields.field, fields.subfield, fields.topic].includes(n),
    );
    if (existingSiblings.length < MIN_SIBLINGS_BEFORE_PADDING && subfieldId) {
      const extra = await fetchSubfieldTopics(subfieldId, 8, fetchFn);
      fields = padFieldHierarchyWithSubfield(fields, extra);
    }

    // Field-overrides for ML/CS papers that OpenAlex routinely misclassifies
    // (I1). Two signals, evaluated in priority order:
    //
    //   • Venue: NeurIPS / ICML / AISTATS / ICLR / JMLR / CVPR / ACL / EMNLP
    //     → force Computer Science / Artificial Intelligence. Settles it
    //       without any SS round-trip.
    //   • Semantic Scholar s2FieldsOfStudy: only fetched when OpenAlex's
    //     field is one of the GENERIC_OA_FIELDS ("Decision Sciences",
    //     "Mathematics", ...). Lazy fetch keeps the common case (OpenAlex is
    //     already correct) free of extra network calls.
    //
    // The SS resolution path mirrors what semantic-scholar.enrichPaper does
    // internally — arXiv id / DOI / title — but we only need the
    // `s2FieldsOfStudy` field, so a single lookup is enough. Failures are
    // best-effort: we fall through to "no override" rather than blocking the
    // entire enrichment response.
    const venueName = work?.primary_location?.source?.display_name || null;
    let s2Fields = null;
    if (!isCsVenue(venueName)
        && GENERIC_OA_FIELDS.has(String(fields.field || '').toLowerCase())) {
      try {
        const ssResolved = await SS.resolvePaper(
          { title: args.title, arxivId: args.arxivId, doi: args.doi },
          fetchFn,
        );
        if (ssResolved?.match?.s2FieldsOfStudy) {
          s2Fields = ssResolved.match.s2FieldsOfStudy;
        }
      } catch (err) {
        console.error('[openalex.enrichPaper] SS s2FieldsOfStudy lookup failed:', err.message);
      }
    }
    fields = applyFieldOverrides(fields, { venueName, s2Fields });

    // Counter-hints for the Field Map tiers (mockup-infographic.html, I3).
    // The mockup renders "FIELD — 14 subfields" / "SUBFIELD — 6 topics"
    // next to each tier label. Fields/subfield counts come from dedicated
    // aggregation endpoints; sibling count is whatever survived shaping
    // (existing `all` minus the three canonical tiers).
    //
    // Field-override paths (venue / s2) can rewrite the field+subfield to
    // "Computer Science" / "Artificial Intelligence" even when OpenAlex's
    // own primary_topic pointed somewhere else. We always pull the OpenAlex
    // ids straight from `primary_topic` so the counter reflects the actual
    // OpenAlex hierarchy the user is reading about — even if the LABEL was
    // overridden, the subfield-count is still a useful magnitude signal.
    const fieldOaId = work?.primary_topic?.field?.id || null;
    const subfieldOaId = work?.primary_topic?.subfield?.id || null;
    // Fire counter fetches in parallel — each is one OpenAlex call, no
    // ordering dependency between them. Promise.all on best-effort helpers
    // (each returns null on failure rather than throwing), so a 429/500
    // degrades gracefully to "skip the hint".
    //
    // Also fetches peer lists for the Field/Subfield disclosure dropdowns
    // (V1-refined design) so the user can see what other fields/subfields
    // exist at the same level. Topic-level peers already come from
    // `work.topics[]` via shapeFieldHierarchy.
    const domainOaId = work?.primary_topic?.domain?.id || work?.primary_topic?.field?.domain?.id || null;
    const [subfieldCount, topicCount, fieldPeersRaw, subfieldPeersRaw] = await Promise.all([
      fieldOaId ? fetchSubfieldCount(fieldOaId, fetchFn) : null,
      subfieldOaId ? fetchTopicCount(subfieldOaId, fetchFn) : null,
      domainOaId ? fetchFieldsInDomain(domainOaId, 12, fetchFn) : [],
      fieldOaId ? fetchSubfieldsInField(fieldOaId, 12, fetchFn) : [],
    ]);
    // Shape peer lists into the same {id, display_name} entries the frontend
    // already expects. Filter out the current tier so the disclosure list
    // doesn't show "Computer Science" in the Computer Science peers.
    const fieldPeers = Array.isArray(fieldPeersRaw)
      ? fieldPeersRaw.filter((p) => p.display_name && p.display_name !== fields.field)
      : [];
    const subfieldPeers = Array.isArray(subfieldPeersRaw)
      ? subfieldPeersRaw.filter((p) => p.display_name && p.display_name !== fields.subfield)
      : [];
    // Topic-level peers are the existing siblings (everything in `all` that
    // isn't one of the three canonical tier names). Frontend used to get
    // these via `fields.all`; we expose them explicitly so the disclosure
    // can iterate without re-filtering.
    const tierNamesForPeers = new Set([fields.field, fields.subfield, fields.topic].filter(Boolean));
    const topicPeers = Array.isArray(fields.all)
      ? fields.all
          .filter((n) => !tierNamesForPeers.has(n))
          .map((display_name) => ({ id: null, display_name }))
      : [];
    // siblingCount: # peers shown beyond the three canonical tiers. Mirrors
    // what FieldMap.tsx renders, so the "+5 peer topics" hint matches the
    // actual chip-strip length.
    const tierNames = new Set([fields.field, fields.subfield, fields.topic].filter(Boolean));
    const siblingCount = Array.isArray(fields.all)
      ? fields.all.filter((n) => !tierNames.has(n)).length
      : 0;
    // Only attach counters that came back as numbers. Leaving them undefined
    // for null/failed lookups lets the UI cleanly skip the hint instead of
    // rendering "— null subfields".
    if (typeof subfieldCount === 'number') fields = { ...fields, subfieldCount };
    if (typeof topicCount === 'number') fields = { ...fields, topicCount };
    fields = {
      ...fields,
      siblingCount,
      // Per-tier peer lists for the V1-refined FieldMap dropdowns. Empty arrays
      // are fine — frontend just disables the toggle in that case.
      field_peers: fieldPeers,
      subfield_peers: subfieldPeers,
      topic_peers: topicPeers,
    };

    // OpenAlex carries the canonical author list on `work.authorships[]`.
    // Persisting it here lets routes/papers.js (line ~659) overwrite Marker's
    // heuristic author extraction — which routinely picks up keyword tags
    // (e.g. ". Embeddings, Softmax" for the Attention paper) or affiliation
    // blocks — and lets the database.js startup backfill repair old rows.
    const authors = Array.isArray(work?.authorships)
      ? work.authorships
          .map((a) => a?.author?.display_name)
          .filter((n) => typeof n === 'string' && n.trim())
      : [];

    // Pull the host-paper's citation count + open-access URL into the
    // top-level shape. The frontend Hero block renders citation as a
    // prominent action button (V8 design), so we need it on the main
    // record, not just inside `similar[]` entries.
    const hostCitations = typeof work?.cited_by_count === 'number'
      ? work.cited_by_count
      : null;
    const hostOaUrl = work?.open_access?.oa_url
      || work?.best_oa_location?.pdf_url
      || work?.primary_location?.pdf_url
      || null;

    return {
      ss_id: work.id,
      ss_title: work.display_name || work.title || null,
      resolved_via: resolvedVia,
      source: 'openalex',
      authors,
      fields,
      citations: hostCitations,
      open_access_pdf_url: hostOaUrl,
      similar: relatedRaw.map(shapeSimilar),
      fetched_at: new Date().toISOString(),
    };
  } catch (err) {
    console.error('[openalex.enrichPaper] FAILED:', err.message);
    // Don't return `{ error }` — that'd cause the upload route to skip
    // persistence and we'd never fall back to SS. Returning null signals
    // "try the next backend".
    return null;
  }
}

module.exports = {
  enrichPaper,
  searchPapers,
  resolveWork,
  lookupByArxiv,
  lookupByDoi,
  lookupByTitle,
  fetchRelatedWorks,
  fetchSubfieldTopics,
  fetchSubfieldsInField,
  fetchFieldsInDomain,
  fetchSubfieldCount,
  fetchTopicCount,
  __resetCounterCaches,
  padFieldHierarchyWithSubfield,
  applyFieldOverrides,
  isCsVenue,
  fetchReferences,
  fetchWork,
  shapeReference,
  shapeFieldHierarchy,
  shapeSimilar,
  shapeSearchResult,
  abstractFromInvertedIndex,
  cleanTitleForSearch,
  // Re-exported from semantic-scholar so callers can grab everything from
  // one module if they prefer.
  titleSimilarity,
  extractArxivId,
  extractDoi,
};
