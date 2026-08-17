/**
 * title-match.js
 *
 * Are these two titles the same work? Word overlap in both directions, so
 * neither a subtitle we dropped nor one the hit carries extra can fake a
 * match. Deliberately strict: a wrong paper behind a citation is worse than
 * no paper at all.
 *
 * Lifted out of references.js when the web search grew a second caller
 * (2026-08-10) — the reference lookup and the full-text search must agree on
 * what "the same work" means, or one of them will open the other's reject.
 */

function words(t) {
  return new Set(
    String(t || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((w) => w.length > 2),
  );
}

function titlesMatch(a, b) {
  const A = words(a);
  const B = words(b);
  if (A.size === 0 || B.size === 0) return false;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.max(A.size, B.size) >= 0.7;
}

module.exports = { titlesMatch, words };
