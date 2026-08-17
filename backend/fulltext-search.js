/**
 * fulltext-search.js
 *
 * Find the free full text of a cited work on the open web
 * (design/mockup-citation-card-standard.html § 04).
 *
 * The paper links a PDF for barely a third of its references (53 of 149,
 * measured over the stored corpus 2026-08-10); the rest ended in "No
 * downloadable PDF available". SearXNG already runs locally for the YouTube
 * source, so the gap can be filled without asking the reader anything.
 *
 * THE READER NEVER SEES A HIT LIST (user decision 2026-08-10): whatever this
 * module returns becomes the reference's `pdfUrl`, and the card then looks
 * exactly like one whose PDF the paper did link. That is the whole reason the
 * rules below are strict — there is no list to correct a wrong answer, so a
 * doubtful hit must be dropped, not offered.
 */

const { titlesMatch, words } = require('./title-match');

/**
 * Does the printed row of a reference contain this hit's title?
 *
 * Used when nothing could be identified: there is no clean title to compare,
 * only the row as the paper typeset it — author, title, venue, year, all in
 * one line. Plain overlap fails there (the row carries words the title never
 * has), so the test runs ONE way: nearly every word of the hit's title must
 * appear in the row.
 *
 * Without this an unreadable row accepted any well-ranked PDF, which is the
 * one way the silent search could put a stranger into a tree.
 */
function rowContainsTitle(rawText, hitTitle) {
  const row = words(rawText);
  const hit = words(hitTitle);
  if (row.size === 0 || hit.size === 0) return false;
  let shared = 0;
  for (const w of hit) if (row.has(w)) shared++;
  return shared / hit.size >= 0.8;
}

/**
 * Hosts that serve the real thing, best first. A hit from anywhere else is
 * ignored even when it looks like a PDF: an unknown host is as likely to be a
 * slide deck or a mirror of the wrong version.
 */
const TRUSTED_HOSTS = [
  'arxiv.org',
  'aclanthology.org',
  'openreview.net',
  'proceedings.neurips.cc',
  'proceedings.mlr.press',
  'jmlr.org',
  'ojs.aaai.org',
  'papers.nips.cc',
];

/** Where a host ranks; unknown hosts never get here. */
function hostRank(host) {
  const i = TRUSTED_HOSTS.indexOf(host);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

/** The host of a URL, without "www.", or null if it is not a URL at all. */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * The URL that actually serves a PDF, or null.
 *
 * An arXiv abstract page is not a PDF, but it stands for one at a guessable
 * address — the same rule `references.pdfUrlFor` already applies to an arXiv
 * id. Everything else has to say `.pdf` itself.
 */
function pdfUrlOf(url) {
  const host = hostOf(url);
  if (!host) return null;
  const arxiv = /^(?:https?:\/\/)?(?:www\.)?arxiv\.org\/abs\/([^?#]+)/i.exec(url);
  if (arxiv) return `https://arxiv.org/pdf/${arxiv[1]}`;
  if (/\.pdf(?:$|[?#])/i.test(url)) return url;
  return null;
}

/**
 * How deep into the result list to look.
 *
 * The LLM's search tool trims to 8 to save context; here that threw away the
 * answer. Measured against the running SearXNG (2026-08-10): the arXiv page
 * for "Deep Residual Learning for Image Recognition" is hit number NINE,
 * behind a slide deck, GitHub and ResearchGate — the trusted sources sit
 * BELOW the popular ones, because popularity is not what we are after.
 */
const SEARCH_DEPTH = 20;

/** arXiv titles arrive as "[1512.03385] Real Title" — the id is not a word. */
function cleanHitTitle(title) {
  return String(title || '').replace(/^\s*\[\s*(?:arxiv:)?\d{4}\.\d{4,5}(?:v\d+)?\s*\]\s*/i, '');
}

/**
 * The query a reader would type: the title in quotes, the first author, the
 * year. A reference nothing could be read out of falls back to its printed
 * row — which already carries author, title and year, just unparsed.
 */
function queryFor({ title, authors, year, rawText }) {
  if (!title) return String(rawText || '').slice(0, 200);
  const parts = [`"${title}"`];
  if (authors?.length) parts.push(String(authors[0]).split(/\s+/).pop());
  if (year) parts.push(String(year));
  return parts.join(' ');
}

/**
 * Did this answer come from a search that could not actually run?
 *
 * Measured in the running app 2026-08-10: twenty serial searches were enough
 * for every engine behind SearXNG to shut us out — brave and google cse
 * "Suspended: too many requests", duckduckgo and startpage with a CAPTCHA.
 * SearXNG then answers 200 with an EMPTY result list, which reads exactly
 * like "this paper has no free full text". Sixteen references were recorded
 * as hopeless that way before anyone had looked at them.
 *
 * An empty list plus a suspended engine is therefore not an answer at all.
 */
function wasShutOut(results, unresponsiveEngines) {
  if (results.length > 0) return false;
  return (unresponsiveEngines || []).some(([, reason]) =>
    /captcha|suspend|too many requests|rate.?limit|access denied/i.test(String(reason)),
  );
}

/**
 * The best downloadable full text for a reference, or null when nothing is
 * good enough. `searchFn(query)` is injected — in production it is the same
 * SearXNG proxy the /api/search route uses.
 *
 * Returns `{ url, host }`: the host is what the card shows above the doors,
 * the one visible trace that this came from the web rather than the paper.
 */
async function findFulltext(reference, { searchFn } = {}) {
  const query = queryFor(reference);
  if (!query.trim()) return null;

  const { results = [], unresponsiveEngines } = (await searchFn(query, SEARCH_DEPTH)) || {};
  if (wasShutOut(results, unresponsiveEngines)) {
    const err = new Error('Web search is rate-limited or blocked; no answer to trust');
    // The caller must not cache this as a miss, and the prefetch queue must
    // back off rather than burn through the rest of the bibliography.
    err.suspended = true;
    throw err;
  }

  const known = reference.title || reference.parsedTitle || null;

  const candidates = [];
  for (const hit of results) {
    const url = pdfUrlOf(hit?.url);
    if (!url) continue;
    const host = hostOf(url);
    if (hostRank(host) === Number.MAX_SAFE_INTEGER) continue;
    // The hit has to be THIS work. A trusted host serving the wrong paper is
    // still the wrong paper — and nothing downstream would catch it.
    const hitTitle = cleanHitTitle(hit.title);
    const sameWork = known
      ? titlesMatch(known, hitTitle)
      : rowContainsTitle(reference.rawText, hitTitle);
    if (!sameWork) continue;
    candidates.push({ url, host, rank: hostRank(host) });
  }

  candidates.sort((a, b) => a.rank - b.rank);
  const best = candidates[0];
  return best ? { url: best.url, host: best.host } : null;
}

module.exports = { findFulltext, queryFor, pdfUrlOf, cleanHitTitle, TRUSTED_HOSTS, SEARCH_DEPTH };
