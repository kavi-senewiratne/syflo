/**
 * reference-facts.js
 *
 * The two facts a reference card shows in its fold and cannot make up: where
 * the work appeared, and how often it has been cited.
 *
 * OpenAlex supplies both for the works it knows, and since 2026-08-12 we
 * actually keep them. But it does not know every work: measured over the
 * stored corpus that day, 118 of 171 references had no citation count and 50
 * no venue. Whatever is still missing when a card opens is looked up in the
 * background — Semantic Scholar as the second source, exactly as the paper
 * search already uses it — and the open card fills in when the answer lands
 * (user request 2026-08-12).
 *
 * Nothing here is load-bearing: a reference with no facts is perfectly
 * readable, it simply has less in its fold. So every failure is silent and
 * every answer is optional.
 */

const defaultOpenAlex = require('./openalex');
const defaultSemanticScholar = require('./semantic-scholar');
const { titlesMatch } = require('./title-match');

/**
 * Which of the three facts a reference is still missing.
 *
 * `citations: 0` is an ANSWER — a paper nobody has cited yet — not a gap.
 * Treating it as one would send the same reference back to the source on
 * every single click.
 */
function missingFacts({ citations, venue, year }) {
  const gaps = [];
  if (citations === null || citations === undefined) gaps.push('citations');
  if (!venue) gaps.push('venue');
  if (year === null || year === undefined) gaps.push('year');
  return gaps;
}

/**
 * Ask the second source for a reference's facts. Returns
 * `{ citations, venue, year }` — any of them null — or null when there is
 * nothing to ask about, nothing found, or the hit is a different work.
 *
 * An identifier is used in preference to the title: a DOI or an arXiv id is
 * exact, while a title search is a guess that can land on a similarly named
 * paper. The title is only a query when nothing better exists, and then the
 * answer has to survive the same match test the full-text search applies.
 */
async function fetchReferenceFacts(reference, deps = {}) {
  const openalexByArxivFn = deps.openalexByArxivFn || defaultOpenAlex.lookupByArxiv;
  const openalexByDoiFn = deps.openalexByDoiFn || defaultOpenAlex.lookupByDoi;
  const openalexByTitleFn = deps.openalexByTitleFn || defaultOpenAlex.lookupByTitle;
  const lookupByIdFn = deps.lookupByIdFn || defaultSemanticScholar.lookupById;
  const lookupByTitleFn = deps.lookupByTitleFn || defaultSemanticScholar.findPaperByTitle;

  const { title, arxivId, doi } = reference || {};
  const idExpr = arxivId ? `arXiv:${arxivId}` : doi ? `DOI:${doi}` : null;
  if (!idExpr && !title) return null;

  let hit = null;

  // OpenAlex first, and through EVERY identifier it has: exact, keyless, and
  // its record already carries both facts. Semantic Scholar answers 429
  // without an API key (measured against the live services 2026-08-12), so it
  // cannot be the primary source — but it is a fine fallback.
  //
  // The chain matters: lookupByArxiv('1601.06733') answers null while
  // lookupByDoi('10.48550/arxiv.1601.06733') returns the record with 190
  // citations (measured the same day). Stopping at the first empty answer
  // left the fold empty for a work OpenAlex holds.
  const attempts = [
    arxivId ? () => openalexByArxivFn(arxivId) : null,
    doi ? () => openalexByDoiFn(doi) : null,
    // OpenAlex verifies a title match itself before answering.
    title ? () => openalexByTitleFn(title) : null,
  ].filter(Boolean);

  for (const attempt of attempts) {
    if (hit) break;
    try {
      const work = await attempt();
      if (!work) continue;
      hit = {
        title: work.display_name || work.title || null,
        citationCount: work.cited_by_count ?? null,
        venue:
          work.primary_location?.source?.display_name ||
          work.best_oa_location?.source?.display_name ||
          null,
        year: work.publication_year ?? null,
      };
    } catch (err) {
      // One route failing is survivable — try the next, then the fallback.
      console.warn(`[reference-facts] OpenAlex lookup failed: ${err.message}`);
    }
  }

  if (!hit && idExpr) {
    // The fallback may be rate-limited — and if OpenAlex already answered we
    // never get here, so its 429 costs nothing.
    hit = await lookupByIdFn(idExpr);
  }
  if (!hit && !idExpr) {
    hit = await lookupByTitleFn(title);
    // A title search answers something for almost any query, so the answer
    // only counts if it really is the work we asked about.
    if (hit && !titlesMatch(title, hit.title)) return null;
  }
  if (!hit) return null;

  const facts = {
    citations: hit.citationCount ?? null,
    venue: hit.venue || hit.publicationVenue?.name || null,
    year: hit.year ?? null,
  };
  // Nothing usable came back — say so rather than reporting three nulls as an
  // answer, which would mark the reference as "asked and done" for good.
  if (facts.citations === null && !facts.venue && facts.year === null) return null;
  return facts;
}

module.exports = { missingFacts, fetchReferenceFacts };
