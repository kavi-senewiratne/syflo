/**
 * reference-matcher.js
 *
 * Pairs the reference rows read out of a PDF (pdf-citations.js) with the
 * canonical works OpenAlex lists in the paper's `referenced_works[]`.
 *
 * This is the precision stage. Extraction is allowed to be dirty — a row may
 * drag in a neighbouring author list or a figure caption — because the
 * matcher never searches the open web: it compares each row against the ~40
 * works the paper itself declares it cites. Recognising "Layer normalization"
 * inside a noisy line is a far easier job than finding it among millions.
 */

// Words that carry no identifying weight in a title comparison.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is',
  'it', 'of', 'on', 'or', 'that', 'the', 'to', 'with', 'via', 'using',
]);

/** Lowercased content words of a string, punctuation and stopwords removed. */
function contentWords(text) {
  if (typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * How much of the candidate's title appears in the row: |title ∩ row| /
 * |title|. Deliberately asymmetric — the row is longer than the title (it
 * carries authors, venue, year, plus whatever bled in), so penalising its
 * extra words would punish exactly the noise we chose to tolerate.
 */
function titleCoverage(rowWords, title) {
  const titleWords = new Set(contentWords(title));
  if (titleWords.size === 0) return 0;
  const rowSet = new Set(rowWords);
  let hits = 0;
  for (const w of titleWords) if (rowSet.has(w)) hits++;
  return hits / titleWords.size;
}

/** A work matches a row only if this much of its title is present. */
const MIN_TITLE_COVERAGE = 0.7;

// A printed row often carries an exact identifier of its own, and that beats
// any lookup: OpenAlex knows only 28 of Attention's 40 references — "Layer
// Normalization" is missing from `referenced_works` altogether — yet its row
// prints "arXiv:1607.06450" in plain sight. An identifier makes a reference
// openable in both doors even when nothing resolved it.
//
// Two spellings are common: "arXiv:1607.06450" and the older "CoRR,
// abs/1409.0473". Both are the same id, and missing the second form left
// those rows looking unopenable although their PDF is one URL away (user
// report 2026-08-09).
const ARXIV_ID = /(?:arxiv[:\s]*|\babs\/)((?:\d{4}\.\d{4,5}(?:v\d+)?)|(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?))/i;
const DOI = /\b(10\.\d{4,9}\/[^\s,;)\]]+)/;

/** The exact identifiers a printed row carries, if any. */
function identifiersIn(rawText) {
  const text = typeof rawText === 'string' ? rawText : '';
  const arxiv = text.match(ARXIV_ID);
  const doi = text.match(DOI);
  return {
    arxivId: arxiv ? arxiv[1] : null,
    // Trailing sentence punctuation is not part of a DOI.
    doi: doi ? doi[1].replace(/[.,;]+$/, '').toLowerCase() : null,
  };
}

/**
 * Match reference rows to candidate works.
 *
 * rows:       [{ anchor, rawText }] from extractCitations()
 * candidates: [{ id, title, authors, year, doi }] from openalex.fetchReferences()
 *
 * Returns one entry per row, in row order: `{ anchor, rawText, work }` with
 * `work` null when nothing matched — an unresolved row keeps its printed text
 * and says so in the UI rather than guessing.
 */
function matchReferences(rows, candidates) {
  const list = Array.isArray(rows) ? rows : [];
  const works = Array.isArray(candidates) ? candidates : [];

  // Score every (row, work) pair above the threshold, then assign greedily
  // from the strongest pair down. One printed row is one work: a row that
  // bled its neighbour in scores well on BOTH, and picking per-row would let
  // it steal a work its rightful row needs — that reference would then vanish
  // from the list entirely. Global order fixes it: the cleaner row wins the
  // work, the dirty one falls through to its own second-best.
  const pairs = [];
  list.forEach((row, rowIndex) => {
    const rowWords = contentWords(row.rawText);
    works.forEach((work) => {
      const score = titleCoverage(rowWords, work.title);
      if (score >= MIN_TITLE_COVERAGE) pairs.push({ rowIndex, work, score });
    });
  });
  pairs.sort((a, b) => b.score - a.score);

  const takenRows = new Set();
  const takenWorks = new Set();
  const assigned = new Map();
  for (const { rowIndex, work, score } of pairs) {
    if (takenRows.has(rowIndex) || takenWorks.has(work.id)) continue;
    takenRows.add(rowIndex);
    takenWorks.add(work.id);
    assigned.set(rowIndex, { work, score });
  }

  return list.map((row, rowIndex) => {
    const work = assigned.get(rowIndex)?.work ?? null;
    const printed = identifiersIn(row.rawText);
    return {
      anchor: row.anchor,
      rawText: row.rawText,
      work,
      // The matched work's DOI wins over the printed one — OpenAlex normalizes
      // it — but a row that resolved to nothing still gets its own.
      arxivId: printed.arxivId,
      doi: work?.doi || printed.doi,
    };
  });
}

module.exports = { matchReferences, contentWords, titleCoverage };
