/**
 * reference-parse.js
 *
 * Reads a bibliography row the way a person does: authors, then title, then
 * where and when it appeared.
 *
 * OpenAlex lists only about 70 % of a paper's references, and a row it does
 * not know used to reach the card as one long printed line — a wall of text
 * where every other card shows a title and a single meta line (user report
 * 2026-08-09). Bibliographies follow a handful of shapes, so parsing the row
 * fills the same layout without inventing anything: every field is either
 * read off the line or left null.
 */

// Periods that do NOT end a segment: initials ("M.-T. Luong"), and the
// abbreviations bibliographies are full of.
const ABBREVIATIONS = new Set([
  // NB: "al" is deliberately absent — "Wu et al. Google's NMT system." ends
  // the author block exactly there, which is the whole point of the period.
  'jr', 'sr', 'dr', 'prof', 'inc', 'ltd', 'vol', 'no', 'pp', 'p',
  'eds', 'ed', 'proc', 'conf', 'trans', 'univ', 'dept', 'st', 'approx',
]);

/**
 * Split a row into sentence-like segments. A period ends a segment unless it
 * follows a single capital (an initial) or a known abbreviation.
 */
function segments(text) {
  const out = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    current += text[i];
    // A question or exclamation mark ends a segment unconditionally: a title
    // may well be a question ("Can active memory replace attention?"), and
    // nothing in a bibliography abbreviates with them. Unlike a period, the
    // mark stays — it belongs to the title.
    if (text[i] === '?' || text[i] === '!') {
      if (/\s/.test(text[i + 1] ?? ' ')) {
        out.push(current.trim());
        current = '';
      }
      continue;
    }
    if (text[i] !== '.') continue;
    if (!/\s/.test(text[i + 1] ?? ' ')) continue;
    // An initial: a single capital letter directly before the period, whether
    // it stands alone ("H.") or closes a hyphenated pair ("M.-T.").
    if (/(?:^|\P{L})\p{Lu}\.$/u.test(current)) continue;
    const lastWord = (current.match(/([^\s]+)\.$/) || [])[1] || '';
    const bare = lastWord.replace(/\.$/, '').replace(/^\P{L}+/u, '');
    if (ABBREVIATIONS.has(bare.toLowerCase())) continue;
    out.push(current.trim());
    current = '';
  }
  if (current.trim()) out.push(current.trim());
  return out.map((s) => s.replace(/\.$/, '').trim()).filter(Boolean);
}

// Latin-1 ranges (À-Þ) miss "Łukasz", "Čech", "Şahin" — every bibliography
// has such names. Unicode property escapes cover all of them.
const UPPER = '\\p{Lu}';
const LOWER = '\\p{Ll}';
const NAME_PART = new RegExp(`^${UPPER}[^\\s]*(\\s+${UPPER}[^\\s]*)*$`, 'u');
// "Sepp Hochreiter", "S. Hochreiter", "J.-P. Müller": two or more parts, each
// starting with a capital. Requiring lowercase right after that first capital
// dropped every single-author row written with initials (found 2026-08-09).
const SINGLE_NAME = new RegExp(`^(?:${UPPER}[\\p{L}.'’-]*\\s+)+${UPPER}[\\p{L}'’-]+$`, 'u');

/** Does this segment read like a list of people rather than a title? */
function looksLikeAuthors(segment) {
  if (!segment) return false;
  // "A, B, and C" / "A and B" / "A et al." / a single "Firstname Lastname".
  if (/\bet al\b/i.test(segment)) return true;
  if (/,|\band\b|&/.test(segment)) {
    // A title can carry commas too, so require capitalised name-shaped parts.
    const parts = segment.split(/,|\band\b|&/).map((p) => p.trim()).filter(Boolean);
    const nameish = parts.filter((p) => NAME_PART.test(p));
    return nameish.length >= Math.max(1, Math.ceil(parts.length * 0.6));
  }
  return SINGLE_NAME.test(segment);
}

/** "A, B, and C" → ["A", "B", "C"]; "Wu et al." stays whole. */
function splitAuthors(segment) {
  if (/\bet al\b/i.test(segment)) {
    // segments() strips the closing period; "et al" reads wrong without it.
    return [segment.replace(/\s+/g, ' ').replace(/\bet al$/i, 'et al.').trim()];
  }
  return segment
    .split(/,\s*(?:and\s+)?|\s+and\s+|\s*&\s*/)
    .map((a) => a.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// Acronyms bibliographies routinely print in lowercase ("rnn encoder-decoder",
// "a cnn for..."). Title casing them letter-by-letter produced "Rnn", which
// reads as a typo (user report 2026-08-09). Only genuinely unambiguous ones
// belong here — anything that is also an English word would do more harm than
// good.
const ACRONYMS = new Map(
  [
    'RNN', 'CNN', 'LSTM', 'GRU', 'MLP', 'GAN', 'VAE', 'SVM', 'KNN',
    'NLP', 'NMT', 'ASR', 'OCR', 'POS', 'NER', 'QA', 'IR',
    'BERT', 'GPT', 'LLM', 'VLM', 'MoE', 'RL', 'RLHF', 'SGD', 'ADAM',
    'GPU', 'TPU', 'CPU', 'API', 'PDF', 'HTML', 'JSON', 'SQL',
    'BLEU', 'ROUGE', 'MNIST', 'ImageNet', 'COCO', 'GLUE', 'SQuAD',
    'AI', 'ML', 'DL', 'CV', 'HMM', 'CRF', 'PCA', 'EM', 'MCMC',
  ].map((a) => [a.toLowerCase(), a]),
);

// Words that stay lowercase inside a title — unless they open or close it,
// or follow a colon. The standard set: articles, coordinating conjunctions
// and short prepositions.
const SMALL_WORDS = new Set([
  'a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'yet', 'so',
  'as', 'at', 'by', 'in', 'of', 'on', 'to', 'up', 'via', 'per',
]);

/**
 * Raise a sentence-case title to title case.
 *
 * Bibliographies print "A decomposable attention model"; OpenAlex stores "A
 * Decomposable Attention Model". Side by side in one list of cards the two
 * shapes looked inconsistent (user report 2026-08-09), so a parsed title is
 * raised to match its resolved neighbours.
 *
 * A word that already carries a capital anywhere is left ALONE — that is how
 * "NMT", "GPT-4", "Xception" and "ImageNet" survive: those capitals are
 * information, and lowercasing them to re-capitalise would destroy it.
 */
function toTitleCase(title) {
  if (typeof title !== 'string' || !title.trim()) return title;
  const words = title.split(/(\s+)/);
  const lastIndex = words.reduce((last, w, i) => (w.trim() ? i : last), 0);
  let startOfClause = true;

  return words
    .map((word, i) => {
      if (!word.trim()) return word;
      const isLast = i === lastIndex;
      // Any capital beyond the first letter means the word is an acronym or a
      // brand — keep it exactly as printed.
      if (/[A-Z]/.test(word.slice(1))) {
        startOfClause = /[:;?!]$/.test(word);
        return word;
      }
      const bare = word.replace(/[^\p{L}'’-]/gu, '').toLowerCase();
      // "rnn" → "RNN", not "Rnn". Punctuation around it is preserved.
      const acronym = ACRONYMS.get(bare);
      if (acronym) {
        startOfClause = /[:;?!]$/.test(word);
        return word.replace(new RegExp(bare, 'i'), acronym);
      }
      const small = SMALL_WORDS.has(bare);
      const capitalise = startOfClause || isLast || !small;
      // A colon starts a new clause, where even a small word is capitalised.
      startOfClause = /[:;?!]$/.test(word);
      if (!capitalise) return word.toLowerCase();
      // Both halves of a hyphenated word: "short-term" → "Short-Term".
      return word
        .toLowerCase()
        // An apostrophe is NOT a word start: "google's" must not become
        // "Google'S".
        .replace(/(^|[-–—(\[«"])(\p{Ll})/gu, (_, before, letter) => before + letter.toUpperCase());
    })
    .join('');
}

/**
 * Parse one printed bibliography row.
 *
 * Returns `{ authors, title, venue, year }`, each field null/empty when the
 * row does not show it. Nothing is inferred: a fragment that survived
 * extraction ("Springer, 2016. 1") yields a year and nothing else, which is
 * a better answer than a title invented from half a sentence.
 */
function parseReferenceRow(rawText) {
  const empty = { authors: [], title: null, venue: null, year: null };
  if (typeof rawText !== 'string' || !rawText.trim()) return empty;

  // The label is navigation, not content.
  const body = rawText.replace(/^\s*(?:\[\d{1,3}\]|\(\d{1,3}\)|\d{1,3}\.)\s+/, '').trim();
  const parts = segments(body);
  if (parts.length === 0) return empty;

  // The year is the last plausible one anywhere in the row — a publication
  // year sits at the end, while a title may contain another number. An arXiv
  // id is blanked first: "arXiv:2011.02920" is November 2020, and reading
  // "2011" out of it put a wrong year on the card (seen in the running app
  // 2026-09-12 — a fragment row whose only "year" was the id).
  const yearSource = body.replace(/\barxiv\s*[:.]?\s*\d{4}\.\d{4,5}(?:v\d+)?\b/gi, ' ');
  const years = yearSource.match(/\b(19|20)\d{2}\b/g) || [];
  const year = years.length ? Number(years[years.length - 1]) : null;

  // Shape 1: "authors. title. rest…" — by far the most common. Annual
  // Reviews prints "authors. YEAR. title. venue" instead, and how that
  // tokenises depends on the LAST author's initials (seen on Safe Learning
  // in Robotics, 2026-09-12): after a single initial ("Allgöwer F. 2019.")
  // the year stays glued to the author segment, after a double one
  // ("Schoellig AP. 2020.") it becomes its own segment — which then landed
  // in the title slot, and the real title in the venue slot.
  const BARE_YEAR = /^(19|20)\d{2}[a-z]?$/;
  if (parts.length >= 2 && looksLikeAuthors(parts[0])) {
    const titleAt = BARE_YEAR.test(parts[1]) && parts.length >= 3 ? 2 : 1;
    parts[0] = parts[0].replace(/[.\s]+(19|20)\d{2}[a-z]?$/, '');
    const titleSeg = parts[titleAt] ?? null;
    const rest = parts.slice(titleAt + 1);
    // The venue is the segment after the title, minus its trailing volume,
    // pages and year — "Neural Computation, 9(8):1735–1780, 1997" is a venue
    // with bookkeeping attached.
    let venue = rest.length ? rest[0] : null;
    if (venue) {
      venue = venue
        .replace(/^In\s+/i, '')
        // Everything a venue drags along: page ranges, volumes, issues, an
        // arXiv id. "…Processing Systems, pages 3104–3112" is a venue with
        // bookkeeping stuck to it (user report 2026-08-09).
        .split(/,\s*(?=\d|pages?\b|pp\.|vol\.|volume\b|no\.|issue\b|abs\/)/i)[0]
        .replace(/\s*\(\d{4}\)\s*$/, '')
        .replace(/[,;:\s]+$/, '')
        .trim();
      // An arXiv id is an identifier, not a place of publication.
      if (/^arxiv/i.test(venue) || /^\d/.test(venue)) venue = null;
      // A venue is a name, so it gets the same treatment as a title —
      // "Neural computation" beside "Long Short-Term Memory" looked
      // half-finished (verified in the running app 2026-08-09).
      if (venue) venue = toTitleCase(venue);
    }
    return {
      authors: splitAuthors(parts[0]),
      title: titleSeg ? toTitleCase(titleSeg) : null,
      venue: venue || null,
      year,
    };
  }

  // Shape 2: no recognisable author block. Rather than promote a random
  // segment to "title", report only what is certain.
  return { ...empty, year };
}

module.exports = { parseReferenceRow, toTitleCase, segments, looksLikeAuthors, splitAuthors };
