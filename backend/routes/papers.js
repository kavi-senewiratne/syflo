/**
 * routes/papers.js
 *
 * Minimal papers routes, ported from Syflo without the Marker parsing
 * pipeline (PRD non-goal): a paper is just a stored PDF bound to a chat
 * tree. ADR-0002 (generalized by ADR-0005 to one SOURCE per tree): the
 * tree's ROOT chat carries paper_id; uploading from any branch binds to the
 * root, and attaching into a tree that already has a source (PDF or YouTube
 * transcript) is rejected with 'tree-has-source' so the frontend can prompt
 * for a new tree.
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const defaultOpenAlex = require('../openalex');
const defaultArxiv = require('../arxiv');
const defaultSemanticScholar = require('../semantic-scholar');
const { prepareSourceInBackground } = require('../retrieval');
const {
  prepareReferences,
  loadReferences,
  resolveReference,
  ensureFulltext,
  ensureCitationGeometry,
} = require('../references');
const { searchWeb: defaultWebSearch } = require('../web-search');

// ─── URL import helpers (1:1 from Syflo routes/papers.js) ───────────────────

// arXiv /abs/ links are rewritten to the direct /pdf/ URL automatically.
function normalizeUrl(url) {
  const arxivAbs = url.match(/^https?:\/\/(?:www\.)?arxiv\.org\/abs\/([^?#]+?)\/?$/i);
  if (arxivAbs) {
    const id = arxivAbs[1].replace(/\/+$/, '');
    return `https://arxiv.org/pdf/${id}.pdf`;
  }
  return url;
}

// Detects whether an HTML response looks like an academic landing page —
// decides between the granular "publisher blocks" guidance and the friendly
// not-a-paper error after a failed paste-link fetch.
function hasAcademicHtmlSignals(html) {
  if (!html || typeof html !== 'string') return false;
  return (
    /<meta[^>]+name=["']citation_(?:pdf_url|doi|author|title|abstract|journal_title|conference_title)["']/i.test(html) ||
    /<meta[^>]+name=["']dc\.(?:identifier|creator|title)["']/i.test(html) ||
    /doi\.org\/10\.\d{4,}/i.test(html)
  );
}

// URL-shape fallback for the academic-source check (publisher 403s with no
// body): /doi/ paths and direct .pdf links count as paper-intent.
function urlLooksLikePaperIntent(urlString) {
  try {
    const u = new URL(urlString);
    const p = u.pathname.toLowerCase();
    if (p.includes('/doi/')) return true;
    if (/\.pdf(?:$|\?)/.test(p)) return true;
    return false;
  } catch (_) {
    return false;
  }
}

// Pull a PDF URL out of an HTML landing page via <meta name="citation_pdf_url">
// (Google Scholar's de-facto standard, emitted by arXiv abs pages, IEEE,
// Springer, ACM, bioRxiv, OpenReview, Wiley, PubMed Central).
function extractCitationPdfUrl(html, baseUrl) {
  const m =
    html.match(/<meta[^>]+name=["']citation_pdf_url["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']citation_pdf_url["']/i);
  if (!m) return null;
  try {
    return new URL(m[1], baseUrl).href;
  } catch (_) {
    return null;
  }
}

// ─── Search merge helpers (1:1 from Syflo routes/papers.js) ─────────────────

// Pull the SearchResult[] out of a Promise.allSettled outcome from either
// search backend (OpenAlex returns `{ results, rate_limited }`, arXiv either
// returns that same envelope or a bare array). Returns null on rejection.
function extractSearchResultsArray(settled) {
  if (!settled || settled.status !== 'fulfilled') return null;
  const v = settled.value;
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.results)) return v.results;
  return null;
}

// OpenAlex display_names occasionally carry publisher markup ("<i>WMAP</i>")
// and escaped entities ("Wide &amp; Deep") — the modal renders titles as plain
// text, so strip tags and decode entities before merging (also keeps the
// dedup keys comparable with arXiv's plain-text titles).
function stripHtmlFromTitle(title) {
  if (!title || typeof title !== 'string') return title;
  return title
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#?apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeSearchResult(r) {
  if (!r || typeof r !== 'object') return r;
  return { ...r, title: stripHtmlFromTitle(r.title) };
}

// Reduce a search result to a stable comparison key: lowercased, punctuation
// stripped, multi-space collapsed — arXiv occasionally hyphenates/colonifies
// titles differently from journal copies.
function normalizeTitleKey(title) {
  if (!title || typeof title !== 'string') return '';
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Merge OpenAlex hits (primary, richer metadata) with arXiv hits, removing
// duplicates via DOI and normalized title. arXiv-unique hits append after the
// OpenAlex block. When both sides carry the same paper, arXiv's year wins
// (OpenAlex stamps re-indexed preprints with the current year — see the
// project memory on publication_year) and its id fills arxiv_id.
function mergeSearchResults(openalexResults, arxivResults) {
  const merged = [];
  const seenDois = new Set();
  const seenTitles = new Set();
  const titleIndex = new Map();

  const addIfFresh = (r) => {
    if (!r || !r.title) return;
    const doiKey = typeof r.doi === 'string' ? r.doi.toLowerCase() : null;
    const titleKey = normalizeTitleKey(r.title);
    if (doiKey && seenDois.has(doiKey)) return;
    if (titleKey && seenTitles.has(titleKey)) return;
    if (doiKey) seenDois.add(doiKey);
    if (titleKey) {
      seenTitles.add(titleKey);
      titleIndex.set(titleKey, merged.length);
    }
    merged.push(r);
  };

  for (const r of openalexResults) addIfFresh(r);
  for (const r of arxivResults) {
    if (!r || !r.title) continue;
    const titleKey = normalizeTitleKey(r.title);
    if (titleKey && titleIndex.has(titleKey)) {
      const idx = titleIndex.get(titleKey);
      const existing = merged[idx];
      if (r.year && existing.year !== r.year) existing.year = r.year;
      if (r.id && !existing.arxiv_id) existing.arxiv_id = r.id;
      continue;
    }
    addIfFresh(r);
  }
  return merged;
}

module.exports = (db, uploadsDir, options = {}) => {
  const router = express.Router();
  const papersDir = path.join(uploadsDir, 'papers');
  fs.mkdirSync(papersDir, { recursive: true });

  // Search backends + URL fetch, injectable for tests (same pattern as Syflo).
  const openalexSearchFn = options.openalexSearchFn || defaultOpenAlex.searchPapers;
  const arxivSearchFn = options.arxivSearchFn || defaultArxiv.searchPapers;
  const ssSearchFn = options.searchFn || defaultSemanticScholar.searchPapers;
  const urlFetchFn = options.urlFetchFn || fetch;
  // Retrieval preparation (ADR-0006), injectable for tests.
  const extractPdfTextFn = options.extractPdfTextFn || require('../pdf-text').extractPdfText;
  const embedTextsFn = options.embedTextsFn;

  // Reference-link pass (design/mockup-paper-reference-links.html), injectable
  // for tests just like the search backends above.
  const referenceDeps = {
    extractFn: options.extractCitationsFn,
    resolveWorkFn: options.resolveWorkFn,
    fetchReferencesFn: options.fetchReferencesFn,
  };

  // Right after the import: extract + cache the text and chunk/embed long
  // papers in the background — the first question waits for none of this.
  // The reference pass rides along: reading the PDF's citation links and
  // resolving the bibliography takes seconds, and nothing about showing the
  // paper depends on it.
  function preparePaperInBackground(row) {
    prepareSourceInBackground(db, {
      sourceType: 'paper',
      sourceId: row.id,
      embedFn: embedTextsFn,
      loadText: async () => {
        const text = await extractPdfTextFn(row.pdf_path);
        if (text && text.trim()) {
          db.prepare('UPDATE papers SET extracted_text = ? WHERE id = ?').run(text, row.id);
        }
        return text;
      },
    });
    setImmediate(() => {
      prepareReferences(db, row, referenceDeps).catch((err) => {
        console.warn(`[references] pass failed for paper ${row.id}: ${err.message}`);
      });
    });
  }

  const upload = multer({
    storage: multer.diskStorage({
      destination: papersDir,
      filename: (req, file, cb) => {
        const id = randomUUID();
        cb(null, `${id}.pdf`);
        req._paperId = id;
      },
    }),
    limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
    fileFilter: (req, file, cb) => {
      if (file.mimetype !== 'application/pdf') {
        return cb(new Error('Only PDF files are accepted'));
      }
      cb(null, true);
    },
  });

  const getChat = db.prepare('SELECT * FROM chats WHERE id = ?');
  const getPaper = db.prepare('SELECT * FROM papers WHERE id = ?');
  const insertPaper = db.prepare(`
    INSERT INTO papers (id, title, authors_json, uploaded_at, pdf_path, status)
    VALUES (@id, @title, @authors_json, @uploaded_at, @pdf_path, @status)
  `);
  const bindPaperToChat = db.prepare('UPDATE chats SET paper_id = ? WHERE id = ?');
  // Binding a paper names the tree after it — the sidebar entry should read
  // as the paper, not as "New chat" (one PDF per tree, so this fires once).
  const renameChatToPaper = db.prepare('UPDATE chats SET title = ? WHERE id = ?');

  // Walk parent_id up to the tree root. The root carries the tree's paper_id.
  function resolveRoot(chatId) {
    let chat = getChat.get(chatId);
    while (chat && chat.parent_id) chat = getChat.get(chat.parent_id);
    return chat || null;
  }

  function formatPaper(row) {
    return {
      id: row.id,
      title: row.title,
      authors: row.authors_json ? JSON.parse(row.authors_json) : [],
      uploaded_at: row.uploaded_at,
      status: row.status,
      pdf_url: `/api/papers/${row.id}/pdf`,
    };
  }

  // POST /api/papers — upload a PDF (multipart field "pdf") and bind it to
  // the chat tree of `chat_id`. No parsing: the paper is 'ready' immediately.
  router.post('/', upload.single('pdf'), (req, res) => {
    const discardUpload = () => {
      if (req.file) {
        try { fs.unlinkSync(req.file.path); } catch (_) { /* already gone */ }
      }
    };
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF uploaded (field name must be "pdf")' });
    }
    const chatId = (req.body.chat_id || '').toString();
    if (!chatId) {
      discardUpload();
      return res.status(400).json({ error: 'chat_id is required' });
    }
    const root = resolveRoot(chatId);
    if (!root) {
      discardUpload();
      return res.status(404).json({ error: 'Chat not found' });
    }
    // ADR-0005 generalizes ADR-0002: a tree has at most ONE source —
    // PDF or YouTube transcript.
    if (root.paper_id || root.video_id) {
      discardUpload();
      return res.status(409).json({ error: 'tree-has-source', root_chat_id: root.id });
    }

    const row = {
      id: req._paperId,
      title: req.file.originalname.replace(/\.pdf$/i, ''),
      authors_json: null,
      uploaded_at: new Date().toISOString(),
      pdf_path: req.file.path,
      status: 'ready',
    };
    insertPaper.run(row);
    bindPaperToChat.run(row.id, root.id);
    renameChatToPaper.run(row.title, root.id);
    preparePaperInBackground(row);
    return res.status(201).json(formatPaper(row));
  });

  // GET /api/papers/search?q=... — paper search for the "Research paper"
  // modal (1:1 from Syflo). OpenAlex + arXiv in parallel, results merged and
  // deduplicated; Semantic Scholar only when BOTH primary sources fail.
  // Must be registered before GET /:id, otherwise the :id route eats the path.
  //
  // Response shape: { results, rate_limited, retry_after_seconds? }
  router.get('/search', async (req, res, next) => {
    const q = (req.query.q || '').toString().trim();
    if (!q) return res.json({ results: [], rate_limited: false });

    const [oaSettled, arxivSettled] = await Promise.allSettled([
      openalexSearchFn(q, 20),
      arxivSearchFn(q, 20),
    ]);

    const oaList = extractSearchResultsArray(oaSettled);
    const arxivList = extractSearchResultsArray(arxivSettled);

    // Both primary backends failed — try SS as a last-resort fallback so
    // the user gets *something* during a transient OpenAlex+arXiv outage.
    if (oaList === null && arxivList === null) {
      if (oaSettled.status === 'rejected') {
        console.warn('[search] OpenAlex failed:', oaSettled.reason?.message);
      }
      if (arxivSettled.status === 'rejected') {
        console.warn('[search] arXiv failed:', arxivSettled.reason?.message);
      }
      try {
        const out = await ssSearchFn(q, 8);
        if (Array.isArray(out)) {
          return res.json({ results: out.map(sanitizeSearchResult), rate_limited: false });
        }
        if (out && Array.isArray(out.results)) {
          return res.json({ ...out, results: out.results.map(sanitizeSearchResult) });
        }
        return res.json(out);
      } catch (ssErr) {
        return next(ssErr);
      }
    }

    const merged = mergeSearchResults(
      (oaList || []).map(sanitizeSearchResult),
      (arxivList || []).map(sanitizeSearchResult),
    );
    return res.json({ results: merged, rate_limited: false });
  });

  // POST /api/papers/from-url — import a paper by URL and bind it to the
  // chat tree of `chat_id` (Syflo port without Marker: the paper is
  // immediately 'ready'). Body: { url, chat_id, title?, fallback_urls? }.
  //
  // ADR-0002 applies as with upload: if the tree already has a PDF, the
  // route responds with 409 'tree-has-pdf' — checked BEFORE the download so
  // the failure case burns no publisher requests.
  router.post('/from-url', async (req, res) => {
    const { url, title, fallback_urls, chat_id } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url is required' });
    }
    const chatId = (chat_id || '').toString();
    if (!chatId) {
      return res.status(400).json({ error: 'chat_id is required' });
    }
    const root = resolveRoot(chatId);
    if (!root) return res.status(404).json({ error: 'Chat not found' });
    if (root.paper_id || root.video_id) {
      return res.status(409).json({ error: 'tree-has-source', root_chat_id: root.id });
    }

    const normalizedUrl = normalizeUrl(url.trim());
    let parsed;
    try {
      parsed = new URL(normalizedUrl);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('http/https only');
    } catch (_) {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    // Candidate chain: primary URL first, then caller-supplied fallbacks
    // (a SearchResult's pdf_candidates — institutional/preprint mirrors for
    // when the publisher 403s). Malformed entries are silently dropped.
    const candidates = [normalizedUrl];
    if (Array.isArray(fallback_urls)) {
      for (const u of fallback_urls) {
        if (typeof u !== 'string' || !u.trim()) continue;
        const n = normalizeUrl(u.trim());
        if (n === normalizedUrl) continue;
        try {
          const p = new URL(n);
          if (!/^https?:$/.test(p.protocol)) continue;
          candidates.push(n);
        } catch (_) { /* skip malformed entries */ }
      }
    }

    // Browser-like headers — some publishers reject anonymous fetches but
    // accept normal browser traffic.
    const PDF_FETCH_HEADERS = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Syflo/1.0',
      Accept: 'application/pdf,application/octet-stream,*/*;q=0.8',
    };
    async function tryDownload(candidate) {
      let r;
      try {
        r = await urlFetchFn(candidate, { headers: PDF_FETCH_HEADERS });
      } catch (e) {
        return { ok: false, status: 0, error: e.message };
      }
      if (!r.ok) return { ok: false, status: r.status, error: `HTTP ${r.status}` };
      const ct = (r.headers?.get?.('content-type') || '').toLowerCase();
      const looksLikePdf =
        ct.includes('application/pdf') ||
        ct.includes('application/octet-stream') ||
        ct === '' ||
        /\.pdf(\?|$)/i.test(candidate);
      if (!looksLikePdf) {
        // HTML landing page? <meta name="citation_pdf_url"> gives us the real
        // PDF URL to queue as the next candidate; academic meta tags decide
        // between "publisher blocks" guidance and the not-a-paper error.
        let resolvedPdfUrl = null;
        let academicHtml = false;
        if (ct.includes('text/html') && typeof r.text === 'function') {
          try {
            const html = await r.text();
            resolvedPdfUrl = extractCitationPdfUrl(html, candidate);
            academicHtml = hasAcademicHtmlSignals(html);
          } catch (_) { /* falls through to the wrong-content-type error */ }
        }
        return { ok: false, status: r.status, error: `wrong content-type (${ct || 'unknown'})`, contentType: ct, resolvedPdfUrl, academicHtml };
      }
      try {
        const buf = Buffer.from(await r.arrayBuffer());
        return { ok: true, buffer: buf, contentType: ct };
      } catch (e) {
        return { ok: false, status: r.status, error: `read failed: ${e.message}` };
      }
    }

    // Walk the chain until one candidate yields a real PDF; candidates
    // discovered mid-walk via citation_pdf_url get visited in the same pass.
    let chosen = null;
    const attempts = [];
    const seenCandidates = new Set(candidates);
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const out = await tryDownload(candidate);
      attempts.push({ url: candidate, ...out });
      if (out.ok) { chosen = { candidate, buffer: out.buffer }; break; }
      if (out.resolvedPdfUrl && !seenCandidates.has(out.resolvedPdfUrl)) {
        candidates.push(out.resolvedPdfUrl);
        seenCandidates.add(out.resolvedPdfUrl);
      }
    }
    if (!chosen) {
      // No academic signal anywhere (neither response evidence nor URL
      // shape) → the URL was never going to yield a paper.
      const hasAcademicSignal =
        attempts.some(
          (a) => a.academicHtml || (a.resolvedPdfUrl && typeof a.resolvedPdfUrl === 'string'),
        ) || candidates.some(urlLooksLikePaperIntent);
      if (!hasAcademicSignal) {
        // `error` stays the stable machine code (tests + API contracts);
        // `message` is the message the modal shows the user.
        return res.status(422).json({
          error: 'not-a-paper',
          message:
            'This link doesn’t lead to a research paper PDF. Open the paper page in your browser, save the PDF, then attach it via "Upload file".',
        });
      }

      const last = attempts[attempts.length - 1];
      const blocked = attempts.some((a) => a.status === 403 || a.status === 401);
      const wrongType = attempts.some((a) => /wrong content-type/.test(a.error || ''));
      let message;
      if (blocked) {
        message = `Publisher blocks direct download (HTTP ${attempts.find((a) => a.status === 403 || a.status === 401).status}). Open the paper in your browser, save the PDF, then use "Upload file". Tried: ${candidates.join(', ')}`;
      } else if (wrongType && attempts.every((a) => a.status === 200)) {
        message = `Source returned a webpage, not a PDF. For arXiv, paste the /abs/ or /pdf/ link; for other sites, paste the direct PDF URL.`;
      } else {
        message = `Could not fetch a PDF from any candidate URL. Last error: ${last?.error || 'unknown'}. Tried: ${candidates.join(', ')}`;
      }
      const status = blocked ? 502 : (wrongType ? 415 : 502);
      return res.status(status).json({ error: message, attempts });
    }

    // Save the PDF, create the row as 'ready' (no Marker), bind to the root.
    const id = randomUUID();
    const pdfPath = path.join(papersDir, `${id}.pdf`);
    fs.writeFileSync(pdfPath, chosen.buffer);

    const fallback = title || parsed.pathname.split('/').pop() || 'imported.pdf';
    const originalName = fallback.endsWith('.pdf') ? fallback : `${fallback}.pdf`;
    const row = {
      id,
      title: originalName.replace(/\.pdf$/i, ''),
      authors_json: null,
      uploaded_at: new Date().toISOString(),
      pdf_path: pdfPath,
      status: 'ready',
    };
    const tx = db.transaction(() => {
      insertPaper.run(row);
      bindPaperToChat.run(row.id, root.id);
      renameChatToPaper.run(row.title, root.id);
    });
    tx();

    preparePaperInBackground(row);
    return res.status(201).json(formatPaper(row));
  });

  // GET /api/papers/for-chat/:chatId — the paper bound to this chat's tree
  // (resolved via the root), or { paper: null }. Used to restore the
  // three-column view on reload.
  router.get('/for-chat/:chatId', (req, res) => {
    const root = resolveRoot(req.params.chatId);
    if (!root) return res.status(404).json({ error: 'Chat not found' });
    if (!root.paper_id) return res.json({ paper: null });
    const row = getPaper.get(root.paper_id);
    return res.json({ paper: row ? formatPaper(row) : null });
  });

  // GET /api/papers/:id/citations — the reference links of this paper: the
  // bibliography plus one click rect per citation mark. Registered before
  // GET /:id so the :id route doesn't eat the path.
  //
  // `status` tells the view what to do: 'pending' → ask again shortly,
  // 'ready' → paint the underlines, 'none' → this PDF has no citation links
  // (a Word export or a scan) and never will.
  router.get('/:id/citations', (req, res) => {
    const loaded = loadReferences(db, req.params.id);
    if (!loaded) return res.status(404).json({ error: 'Paper not found' });
    // A paper imported before the underline was hung off the text baseline
    // (2026-08-10) has rects but no baselines. Re-measuring them is local work
    // on a PDF we already have, so it happens here instead of asking the reader
    // to import the paper again — and the answer says 'pending' meanwhile, so
    // the view's own polling picks the fresh geometry up without a reload.
    if (ensureCitationGeometry(db, req.params.id, loaded, referenceDeps)) {
      return res.json({ ...loaded, status: 'pending' });
    }
    return res.json(loaded);
  });

  // POST /api/papers/:id/references/:refId/resolve — look ONE reference up on
  // demand, when the reader opens its card.
  //
  // Doing this for the whole bibliography at import time cost 40–93 requests
  // per paper and had OpenAlex rate-limit the machine for minutes (measured
  // 2026-08-09). A reader opens a handful of cards, so the search happens
  // here — once per reference, cached in the row afterwards.
  router.post('/:id/references/:refId/resolve', async (req, res, next) => {
    try {
      const reference = await resolveReference(db, req.params.refId, {
        lookupByTitleFn: options.lookupByTitleFn,
        searchArxivFn: options.searchArxivFn,
        // Second source for the fold's facts — citation count and venue
        // (2026-08-12). Injectable like every other backend here.
        factsOpenalexByTitleFn: options.factsOpenalexByTitleFn,
        factsLookupByIdFn: options.factsLookupByIdFn,
        factsLookupByTitleFn: options.factsLookupByTitleFn,
      });
      if (!reference) return res.status(404).json({ error: 'Reference not found' });
      return res.json({ reference });
    } catch (err) {
      return next(err);
    }
  });

  // POST /api/papers/:id/references/:refId/fulltext — the silent web search
  // (design/mockup-citation-card-standard.html § 04).
  //
  // Two thirds of a paper's references carry no PDF link (96 of 149, measured
  // 2026-08-10) and used to end in "No downloadable PDF available". This asks
  // the local SearXNG for the full text and, if it finds one it is sure of,
  // hands back a reference that opens like any other — no hit list, no choice
  // to make. One request per reference, ever: hit and miss are both cached.
  router.post('/:id/references/:refId/fulltext', async (req, res, next) => {
    try {
      const reference = await ensureFulltext(db, req.params.refId, {
        // Bind db so the reference search reaches Tavily as well; without it
        // this path would keep requiring a running SearXNG (2026-08-21).
        webSearchFn: options.webSearchFn
          || ((query, depth) => defaultWebSearch(query, { db, max: depth })),
      });
      if (!reference) return res.status(404).json({ error: 'Reference not found' });
      return res.json({ reference });
    } catch (err) {
      return next(err);
    }
  });

  // GET /api/papers/:id — paper metadata.
  router.get('/:id', (req, res) => {
    const row = getPaper.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Paper not found' });
    res.json(formatPaper(row));
  });

  // GET /api/papers/:id/pdf — serve the stored PDF (rendered by pdf.js).
  router.get('/:id/pdf', (req, res) => {
    const row = getPaper.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Paper not found' });
    if (!row.pdf_path || !fs.existsSync(row.pdf_path)) {
      return res.status(404).json({ error: 'PDF file missing on disk' });
    }
    res.type('application/pdf').sendFile(path.resolve(row.pdf_path));
  });

  return router;
};

// Helper exports for unit tests (same pattern as in Syflo).
module.exports.mergeSearchResults = mergeSearchResults;
module.exports.normalizeTitleKey = normalizeTitleKey;
module.exports.stripHtmlFromTitle = stripHtmlFromTitle;
module.exports.extractSearchResultsArray = extractSearchResultsArray;
module.exports.normalizeUrl = normalizeUrl;
