/**
 * messages.js
 *
 * Nimmt User-Nachrichten an (text + optionale Datei-Anhänge per multipart),
 * speichert die Dateien, baut multimodale Anfragen für llama3.2-vision und
 * streamt die Antwort per SSE zurück.
 *
 * Datei-Handling:
 *   - Bilder (image/*): per data-URL als image_url an das Vision-Modell
 *   - Text-Dateien (text/*, application/json): Inhalt einlesen und in den Prompt einbetten
 *   - Sonstige Dateien: nur Name/Mimetype erwähnen (Modell kann Binär nicht lesen)
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getLLMClient, getSetting, noThinkExtras, extendOllamaKeepAlive, getOllamaGpuResidency } = require('../llm');
const { streamWithTools, ALL_TOOLS } = require('../tools');
const { getTreePaperContext } = require('../pdf-text');
const { getTreeVideoContext, transcriptTruncationNote } = require('../youtube');
const {
  ensureSourceChunks,
  retrieveChunks,
  buildSkeleton,
  RETRIEVE_K,
} = require('../retrieval');
const { buildPerfRecord, formatPerfLine, appendPerfJsonl, isPerfJsonlEnabled } = require('../perf-log');
const {
  buildAncestorContext,
  renderAncestorText,
  applyContextBudget,
  MAX_SYSTEM_CONTEXT_CHARS,
  CONTEXT_WINDOW_TOKENS,
} = require('../ancestor-context');

const MAX_TEXT_FILE_BYTES = 64 * 1024;

module.exports = (db, UPLOADS_DIR, options = {}) => {
  // Injectable for tests: (pdfPath) => Promise<string>.
  const extractPdfTextFn = options.extractPdfTextFn;
  // Injectable for tests: (texts) => Promise<number[][]> (retrieval.js).
  const embedTextsFn = options.embedTextsFn;
  const router = express.Router({ mergeParams: true });

  // Anhänge ins chat-spezifische Verzeichnis legen, damit man pro Chat
  // aufräumen kann und keine Dateinamen-Kollisionen entstehen.
  const storage = multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(UPLOADS_DIR, req.params.chatId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      // Dateiname: <id>-<originalname> — id für Eindeutigkeit, originalname für Lesbarkeit
      const id = crypto.randomUUID();
      // Originalnamen säubern (keine Pfade)
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
      file.attachmentId = id;
      cb(null, `${id}-${safe}`);
    },
  });
  const upload = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB pro Datei
  });

  // Hilfsfunktion: liest eine Datei und gibt sie als data-URL zurück.
  function fileToDataUrl(fullPath, mimetype) {
    const data = fs.readFileSync(fullPath);
    return `data:${mimetype};base64,${data.toString('base64')}`;
  }

  // Hilfsfunktion: liest eine Textdatei (begrenzt auf MAX_TEXT_FILE_BYTES)
  function readTextFile(fullPath) {
    const stat = fs.statSync(fullPath);
    const len = Math.min(stat.size, MAX_TEXT_FILE_BYTES);
    const fd = fs.openSync(fullPath, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    fs.closeSync(fd);
    return buf.toString('utf-8') + (stat.size > len ? '\n[…gekürzt]' : '');
  }

  // Wandelt einen DB-Anhang in den OpenAI-Multimodal-Content-Eintrag.
  // Gibt entweder ein image_url-Objekt zurück, oder null (bei Textdateien wird
  // der Inhalt in den Prompt-Text eingebettet — separat behandelt).
  function attachmentToMultimodalContent(att) {
    if (att.mimetype.startsWith('image/')) {
      return {
        type: 'image_url',
        image_url: { url: fileToDataUrl(att.path, att.mimetype) },
      };
    }
    return null;
  }

  // Baut den Text-Annex für nicht-bildliche Anhänge:
  // - Text-Dateien: kompletter Inhalt
  // - Sonstige: nur Verweis auf Dateiname
  function buildAttachmentTextAnnex(attachments) {
    const parts = [];
    for (const att of attachments) {
      if (att.mimetype.startsWith('image/')) continue;
      const isText = att.mimetype.startsWith('text/') ||
                     att.mimetype === 'application/json' ||
                     /\.(md|txt|csv|log|js|ts|py|html|css|json|yaml|yml)$/i.test(att.filename);
      if (isText) {
        try {
          const content = readTextFile(att.path);
          parts.push(`\n\n[Anhang ${att.alias} — ${att.filename}]\n\`\`\`\n${content}\n\`\`\``);
        } catch (_) {
          parts.push(`\n\n[Anhang ${att.alias} — ${att.filename}, Fehler beim Lesen]`);
        }
      } else {
        parts.push(`\n\n[Anhang ${att.alias} — ${att.filename}, Typ ${att.mimetype} (Binärdatei, kann nicht gelesen werden)]`);
      }
    }
    return parts.join('');
  }

  // Gemessene Prefill-Rate (EMA, tok/s) für die ETA im prefill-SSE-Event.
  // Startwert = M4-Pro-Messung 2026-07-25 (~300 tok/s, qwen3.5:9b); lernt aus
  // jeder kalten Antwort mit (Speicherdruck, Modellwechsel). Bewusst nur eine
  // Schätzung — Ollama exponiert keinen echten Prefill-Fortschritt (#6029).
  let prefillTokPerSec = 300;

  // Baut den textuellen Gesprächskontext eines Chats: System-Prompt (inkl.
  // Paper-Volltext bei gebundenem PDF, ADR-0002, und geerbtem Vorfahren-
  // Kontext bei Branches) plus die Nachrichten-Historie. Wird von der echten
  // Nachricht (dropLastMessage: die aktuelle User-Nachricht kommt multimodal
  // dazu) UND vom Prefix-Warm-up (kompletter Stand) verwendet — beide müssen
  // denselben Prompt-Prefix erzeugen, sonst greift Ollamas KV-Cache nicht.
  async function buildSystemAndHistory(chat, { dropLastMessage }) {
    const contextMessages = [];
    // Regel (5) ist eine Latenz-Maßnahme: auf lokaler Hardware kostet jedes
    // generierte Token ~40 ms — eine 950-Token-Antwort allein ~40 s. Kürze
    // als Default macht Antworten spürbar schneller fertig.
    let systemBase = 'You are a friendly and helpful assistant. Formatting rules: (1) Use proper Markdown for headings — always include a SPACE between the hash characters and the heading text: `# Heading`, `## Subheading`, `### Sub-subheading`. Never write `#Heading` without a space — it will not render as a heading. (2) Do NOT use emojis. Keep prose plain so it reads cleanly. (3) When explaining concepts, always use analogies and real-world comparisons to make things easy to understand. (4) When the user attaches images, examine them carefully and describe what you see when relevant. (5) Be concise by default: answer in a few short paragraphs at most, and expand only when the user explicitly asks for more depth or detail. (6) When the user asks about current or real-time information (news, weather, prices, recent events) or explicitly asks you to search the web, ALWAYS call the web_search tool first and base your answer on its results — never invent real-time information from memory, and never claim the tool is unavailable without having called it. (7) ALWAYS reply in the language of the user\'s most recent message — German message, German reply; English message, English reply. If a message mixes languages, reply in its dominant language. (8) Write EVERY mathematical expression that has an exponent, subscript, fraction, or math symbol as LaTeX inside inline math delimiters $…$ — e.g. $10^{50}$, $w_t$, $\\frac{a}{b}$, $27 \\times 27$. NEVER write a bare caret (^) or underscore (_) for math in plain text (write $10^{50}$, not 10^50), because a bare caret renders as a literal character instead of a superscript. Plain whole numbers without such notation may stay as normal text.';

    // Custom instructions (CONTEXT.md): Nutzer-Freitext aus den Settings —
    // direkt nach den Basisregeln und VOR Paper-/Ancestor-Kontext, damit sie
    // das Budget-Trimming nie erfasst. Die explizite Vorrang-Zeile ist nötig,
    // weil kleine lokale Modelle Regel-Konflikte sonst unvorhersehbar lösen.
    const customInstructions = getSetting(db, 'custom_instructions');
    if (getSetting(db, 'custom_instructions_enabled') === 'true' && customInstructions.trim()) {
      systemBase +=
        '\n\nThe user has set the following custom instructions. Follow them; they take precedence over the style rules above.\n' +
        '--- CUSTOM INSTRUCTIONS START ---\n' +
        customInstructions +
        '\n--- CUSTOM INSTRUCTIONS END ---';
    }

    // Volltext des an den Chat-Tree gebundenen Papers (ADR-0002) in den
    // System-Prompt — ohne ihn kennt das Modell das PDF nicht und halluziniert
    // Zusammenfassungen. Extraktion ist lazy und in papers.extracted_text
    // gecacht; Fehler degradieren still zu "kein Paper-Kontext".
    const paperContext = await getTreePaperContext(db, chat.id, extractPdfTextFn);

    // YouTube transcript des Trees (ADR-0005) — zweite Quellenart. Ein Baum
    // hat höchstens EINE Quelle, daher teilen sich Paper und Video denselben
    // Budget-Slot (paperText) in applyContextBudget.
    const videoContext = getTreeVideoContext(db, chat.id);

    // Geerbter Gesprächskontext (Design 2026-07-20): ganzer Pfad bis zur
    // Wurzel — Eltern wörtlich, Großeltern+ als gecachte Summary, dazu die
    // parent_word-Kette. Summary-Fehler degradieren still zum Kontext ohne
    // die betroffene Summary; der Lazy-Pfad hier ist das Sicherheitsnetz
    // hinter dem Warm-up bei der Branch-Erstellung.
    let ancestor = null;
    if (chat.parent_id) {
      try {
        ancestor = await buildAncestorContext(db, chat.id);
      } catch (_) { /* ohne Ancestor-Kontext weitermachen */ }
    }

    // Die EINE Quelle des Baums, quellenart-neutral (Paper oder Video).
    const source = paperContext
      ? { type: 'paper', id: paperContext.paperId, text: paperContext.text }
      : videoContext
        ? { type: 'video', id: videoContext.videoId, text: videoContext.text }
        : null;

    // Wenn-dann-Regel (ADR-0006): Passt die Quelle in den Platz, der nach
    // dem Vorfahren-Kontext übrig ist, bleibt alles beim Volltext-Prefix
    // (KV-Cache, einmaliges Prefill). Sprengt sie ihn, ersetzt ein stabiles
    // Skeleton den Volltext, und pro Frage kommen die passendsten Chunks
    // HINTER der Historie dazu (retrieval, POST-Handler unten). Schlägt das
    // Chunking/Embedding fehl (z. B. Embedding-Modell nicht installiert),
    // degradiert alles auf die alte Volltext-Kürzung — nichts bricht.
    // Baum-stabile Modus-Entscheidung (Nachtrag 2026-07-25): Volltext vs.
    // Retrieval hängt NUR an der Quelle, nicht am Vorfahren-Kontext. Vorher
    // schrumpfte der Platz im Kind um die Ancestor-Zeichen — dieselbe Quelle,
    // die im Eltern-Chat Volltext war, kippte im Kind in den Retrieval-Modus,
    // und der teure gemeinsame Quell-Präfix (System + Custom Instructions +
    // Quelle) war beim Branchen wertlos: voller Re-Prefill statt Cache-Hit
    // (~60 s, Messung 2026-07-25). Passt die Quelle allein ins Budget,
    // weichen stattdessen die Vorfahren-Summaries (applyContextBudget,
    // Opfer-Reihenfolge am selben Tag gedreht).
    const sourceRoom = MAX_SYSTEM_CONTEXT_CHARS;

    let retrieval = null;
    let sourceTextForPrompt = source ? source.text : null;
    if (source && source.text.length > sourceRoom) {
      try {
        await ensureSourceChunks(db, {
          sourceType: source.type,
          sourceId: source.id,
          text: source.text,
          ...(embedTextsFn ? { embedFn: embedTextsFn } : {}),
        });
        retrieval = { sourceType: source.type, sourceId: source.id };
        sourceTextForPrompt = buildSkeleton(source.text);
      } catch (err) {
        console.warn(
          `[retrieval] Chunking/Embedding für ${source.type} ${source.id} fehlgeschlagen ` +
          `(${err.message}) — Fallback auf Volltext-Kürzung.`
        );
      }
    }

    // Opfer-Reihenfolge, wenn alles zusammen zu groß wird:
    // Paper → Vorfahren-Summaries (älteste zuerst) → nie das Eltern-Transkript.
    const fitted = applyContextBudget(
      {
        paperText: sourceTextForPrompt,
        summaries: ancestor ? ancestor.summaries : [],
        parentTranscript: ancestor ? ancestor.parentTranscript : null,
      },
      MAX_SYSTEM_CONTEXT_CHARS
    );

    if (paperContext && fitted.paperText && retrieval) {
      systemBase +=
        `\n\nA research paper is attached to this conversation: "${paperContext.title}". ` +
        'It is too long for the context window, so below is its SKELETON: the beginning ' +
        '(title/abstract), the section outline, and the end (conclusion). The passages of ' +
        'the paper most relevant to the user\'s current question are provided separately, ' +
        'later in the conversation, in a message marked RELEVANT PAPER EXCERPTS. Base every ' +
        'answer about the paper on this material; if something is not covered by it, say so ' +
        'instead of guessing.\n' +
        '--- PAPER SKELETON START ---\n' +
        fitted.paperText +
        '\n--- PAPER SKELETON END ---';
    } else if (paperContext && fitted.paperText) {
      systemBase +=
        `\n\nA research paper is attached to this conversation: "${paperContext.title}". ` +
        'Its full text is included below. Base every answer about the paper on this text; ' +
        'if something is not covered by it, say so instead of guessing.\n' +
        '--- PAPER TEXT START ---\n' +
        fitted.paperText +
        '\n--- PAPER TEXT END ---';
    } else if (videoContext && fitted.paperText && retrieval) {
      systemBase +=
        `\n\nA YouTube video is attached to this conversation as its source: ` +
        `"${videoContext.title}"${videoContext.channel ? ` by ${videoContext.channel}` : ''}. ` +
        'Its transcript is too long for the context window, so below is its SKELETON: the ' +
        'beginning and the end (with [minute:second] marks). The transcript passages most ' +
        'relevant to the user\'s current question are provided separately, later in the ' +
        'conversation, in a message marked RELEVANT TRANSCRIPT EXCERPTS. Base every answer ' +
        'about the video on this material; if something is not covered by it, say so instead ' +
        'of guessing.\n' +
        '--- TRANSCRIPT SKELETON START ---\n' +
        fitted.paperText +
        '\n--- TRANSCRIPT SKELETON END ---';
    } else if (videoContext && fitted.paperText) {
      // Video overview-Regel (Nutzerentscheid 2026-07-23): Strukturieren
      // heißt ordnen, NICHT kürzen — ohne die explizite Regel fällt das
      // Modell in sein Standardverhalten "zusammenfassen" zurück.
      const note = transcriptTruncationNote(
        fitted.paperText, videoContext.text, videoContext.durationSeconds
      );
      systemBase +=
        `\n\nA YouTube video is attached to this conversation as its source: ` +
        `"${videoContext.title}"${videoContext.channel ? ` by ${videoContext.channel}` : ''}. ` +
        'Its full transcript (with [minute:second] marks) is included below. Base every answer ' +
        'about the video on this transcript; if something is not covered by it, say so instead ' +
        'of guessing. When the user asks you to structure the video, reorganize ALL substantive ' +
        'content into sections with key points and minute marks — do NOT summarize and do not ' +
        'drop content.\n' +
        '--- VIDEO TRANSCRIPT START ---\n' +
        fitted.paperText +
        (note || '') +
        '\n--- VIDEO TRANSCRIPT END ---';
    }

    if (ancestor) {
      const ancestorText = renderAncestorText({
        chain: ancestor.chain,
        summaries: fitted.summaries,
        parentTranscript: fitted.parentTranscript,
      });
      contextMessages.push({
        role: 'system',
        content: `${systemBase} The user is exploring the term "${chat.parent_word}" from a previous conversation. Context:\n\n${ancestorText}`,
      });
    } else {
      contextMessages.push({ role: 'system', content: systemBase });
    }

    // Historie (nur Text — alte Anhänge werden im Kontext nicht erneut hochgeschickt,
    // sonst wird der Prompt zu groß)
    const history = db.prepare(
      'SELECT role, content FROM messages WHERE chat_id = ? ORDER BY created_at ASC, id ASC'
    ).all(chat.id);
    const included = dropLastMessage ? history.slice(0, -1) : history;
    included.forEach(m => contextMessages.push({ role: m.role, content: m.content }));

    // retrieval ≠ null heißt: der POST-Handler holt pro Frage die passenden
    // Chunks und hängt sie HINTER die Historie — der Prefix bis hier bleibt
    // byte-identisch mit dem Warm-up, nur der Auszugs-Block wechselt.
    //
    // Diagnose-Metadaten (perf-log.js): welcher Modus, wie groß die Quelle.
    // sourceTokens ist eine Schätzung aus der Zeichenzahl (dieselbe Ratio wie
    // das Budget); die echte Prompt-Größe steht als promptTokens in der usage.
    const mode = source ? (retrieval ? 'retrieval' : 'fulltext') : 'none';
    const sourceTokens = source ? Math.round(source.text.length / 3.5) : null;
    // Kalt/warm-Proxy: die erste Frage eines Chats trifft (fast) nie einen
    // warmen KV-Cache; ab der zweiten ist der Paper-Prefix i. d. R. warm.
    const cache = included.some((m) => m.role === 'assistant') ? 'warm' : 'cold';

    return { messages: contextMessages, retrieval, meta: { mode, sourceTokens, cache } };
  }

  // Rendert die abgerufenen Chunks zum Auszugs-Block hinter der Historie.
  // Sektions-Header bleiben dran, damit das Modell weiß, WOHER im Dokument
  // ein Auszug stammt.
  function renderExcerpts(hits, sourceType) {
    const label = sourceType === 'video' ? 'TRANSCRIPT' : 'PAPER';
    const body = hits
      .map((h) => (h.heading ? `[Section: ${h.heading}]\n${h.text}` : h.text))
      .join('\n\n---\n\n');
    return (
      `RELEVANT ${label} EXCERPTS — the passages of the attached ` +
      `${sourceType === 'video' ? 'video transcript' : 'paper'} most relevant to the ` +
      'user\'s current question, in document order:\n\n' +
      body
    );
  }

  // Der eine laufende Warm-up (mehr als einen gibt es nie sinnvoll). Ein
  // Warm-up ist reine Vorleistung — er darf NIE eine echte Anfrage blockieren.
  // Auf Ollamas begrenzten Slots hieße das sonst: der Nutzer wartet bis zu
  // ~40 s (Paper-Prefill) in der Warteschlange, bevor seine Frage überhaupt
  // anläuft (gemessen 2026-07-21). Deshalb: neue echte Nachricht ODER neuer
  // Warm-up → laufenden Warm-up sofort abbrechen. Der bereits verarbeitete
  // Prefix bleibt in Ollamas Cache erhalten — abgebrochene Vorarbeit ist
  // also nicht verloren.
  let activeWarmup = null;
  function abortActiveWarmup() {
    if (activeWarmup) activeWarmup.abort();
    activeWarmup = null;
  }

  // POST /api/chats/:chatId/messages/warmup — Prefix-Warm-up: liest den
  // kompletten Chat-Kontext (v. a. den Paper-Volltext) einmal mit einem
  // 1-Token-Aufruf ein, damit Ollamas KV-Cache warm ist, bevor der Nutzer
  // seine Frage abschickt — und pinnt das Modell für 1 h in den Speicher.
  // Fire-and-forget vom Frontend beim Öffnen eines Chats; Fehler sind nie
  // fatal (warmed:false statt 5xx).
  router.post('/warmup', async (req, res) => {
    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });

    // Kein Warm-up, solange echte Fragen laufen oder warten: er würde sich
    // hinter sie einreihen und beim Durchlauf den KV-Prefix des gerade
    // antwortenden Chats verdrängen — genau das machte Chat-Wechsel teuer
    // (cache=cold trotz Warm-up, Befund 2026-07-24).
    if (processingJob || jobQueue.length > 0) {
      return res.json({ warmed: false, reason: 'busy' });
    }

    abortActiveWarmup();
    const warmupAbort = new AbortController();
    activeWarmup = warmupAbort;

    try {
      const { client, model, provider } = getLLMClient(db);
      if (provider !== 'ollama') {
        return res.json({ warmed: false, reason: 'local models only' });
      }
      const { messages: contextMessages } = await buildSystemAndHistory(chat, { dropLastMessage: false });
      try {
        await client.chat.completions.create({
          model,
          messages: contextMessages,
          // Gleiche Tools wie die echte Anfrage — sonst weicht der Prompt-
          // Prefix ab und der Cache greift nicht.
          tools: ALL_TOOLS,
          ...noThinkExtras(provider),
          max_tokens: 1,
        }, { signal: warmupAbort.signal });
      } catch (err) {
        if (!/does not support tools/i.test(err?.message || '')) throw err;
        await client.chat.completions.create({
          model,
          messages: contextMessages,
          ...noThinkExtras(provider),
          max_tokens: 1,
        }, { signal: warmupAbort.signal });
      }
      await extendOllamaKeepAlive(model);
      // GPU-Residency-Check: liegt das Modell nur teilweise im VRAM, ist
      // jede Antwort 10–20× langsamer — das Frontend zeigt dann eine Warnung.
      const gpu = await getOllamaGpuResidency(model);
      if (gpu && gpu.vramPercent < 100) {
        console.warn(
          `[perf] ${model} liegt nur zu ${gpu.vramPercent}% im GPU-Speicher — ` +
          'teilweises CPU-Offloading macht Antworten 10-20x langsamer. ' +
          'Kleineres Modell wählen oder Speicher freigeben.'
        );
      }
      res.json({ warmed: true, ...(gpu ? { gpu } : {}) });
    } catch (err) {
      res.json({ warmed: false, reason: err.message });
    } finally {
      if (activeWarmup === warmupAbort) activeWarmup = null;
    }
  });

  // Inhalt einer Assistant-Nachricht, deren Generierung fehlschlug (z. B.
  // Ollama-Fehler oder Client-Timeout): An der Stelle der Antwort bleibt nur
  // dieser Marker — das Frontend rendert ihn als Fehlerzeile mit Retry-Button.
  // Pendant zu '*Interrupted*'; exakt derselbe String wie FAILED_MARKER in
  // frontend/src/types.
  const FAILED_MARKER = '*Failed*';

  // ─── Sende-Warteschlange ────────────────────────────────────────────────
  // Ollama hat genau EINEN KV-Slot (Vision-Modelle erzwingen parallel:1).
  // Ohne eigene Schlange stauen sich gleichzeitige Fragen in Ollamas
  // interner Warteschlange, wo sie nach 5 Minuten am Header-Timeout des
  // HTTP-Clients sterben (Vorfall 2026-07-24) — und Frage 2 würde
  // beantwortet, ohne Antwort 1 im Kontext zu haben. Deshalb serialisiert
  // das Backend selbst (FIFO, chat-übergreifend): User-Insert, Kontext-
  // Aufbau und Generierung laufen erst, wenn der Job an der Reihe ist — so
  // steht Antwort 1 vor Frage 2 in der DB und in deren Historie. Wartende
  // Clients bekommen queued-Events mit der Zahl der Jobs vor ihnen, der
  // Start ein started-Event mit der jetzt persistierten User-Nachricht.
  const jobQueue = [];
  let processingJob = false;

  function sseWrite(res, payload) {
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) { /* Client weg */ }
  }

  // Streng monotone Zeitstempel innerhalb eines Chats: beim Dequeue können
  // Antwort 1 und die nachrückende Frage 2 in derselben Millisekunde landen —
  // GET und Frontend sortieren nach created_at, gleiche Stempel machten die
  // Reihenfolge zufällig. Liegt der letzte Stempel nicht in der Vergangenheit,
  // wird um 1 ms aufgerundet.
  function monotonicNow(chatId) {
    const now = Date.now();
    const last = db.prepare('SELECT MAX(created_at) AS ts FROM messages WHERE chat_id = ?').get(chatId);
    const lastMs = last && last.ts ? new Date(last.ts).getTime() : -Infinity;
    return new Date(Math.max(now, lastMs + 1)).toISOString();
  }

  function notifyQueuePositions() {
    jobQueue.forEach((job, i) => {
      sseWrite(job.res, { queued: { ahead: i + (processingJob ? 1 : 0) } });
    });
  }

  function enqueueMessageJob(job) {
    jobQueue.push(job);
    const ahead = jobQueue.length - 1 + (processingJob ? 1 : 0);
    if (ahead > 0) sseWrite(job.res, { queued: { ahead } });

    // Ein Close-Handler fürs ganze Job-Leben — auf der RESPONSE, nicht dem
    // Request: req 'close' feuert in Node schon, wenn der Request fertig
    // GELESEN ist (bei SSE also sofort), res 'close' erst, wenn die
    // Verbindung wirklich zugeht; writableEnded unterscheidet das normale
    // Ende (unser res.end()) vom Abbruch durch den Client. Solange der Job
    // wartet, wird er nur aus der Schlange genommen — nichts ist
    // persistiert, die Frage gilt als nie gestellt. Läuft er schon, bricht
    // job.abort die Upstream-Generierung ab (Stop-Button-Semantik).
    job.res.on('close', () => {
      if (job.res.writableEnded) return;
      job.clientClosed = true;
      job.abort?.abort();
      if (!job.running) {
        job.canceled = true;
        const idx = jobQueue.indexOf(job);
        if (idx !== -1) {
          jobQueue.splice(idx, 1);
          notifyQueuePositions();
        }
        try { job.res.end(); } catch (_) { /* schon zu */ }
      }
    });

    void processJobQueue();
  }

  async function processJobQueue() {
    if (processingJob) return;
    processingJob = true;
    try {
      while (jobQueue.length > 0) {
        const job = jobQueue.shift();
        notifyQueuePositions();
        if (job.canceled) continue;
        job.running = true;
        try {
          await runMessageJob(job);
        } catch (err) {
          // Sicherheitsnetz — runMessageJob fängt Generierungsfehler selbst.
          console.error('[messages] Unerwarteter Job-Fehler:', err);
          sseWrite(job.res, { error: err.message });
          try { job.res.end(); } catch (_) { /* schon zu */ }
        }
      }
    } finally {
      processingJob = false;
    }
  }

  // POST /api/chats/:chatId/messages
  // Akzeptiert sowohl JSON (alte Clients) als auch multipart/form-data (mit Dateien).
  // Multipart-Felder: text, aliases (JSON-Array), files (Datei-Inputs).
  // Antwortet sofort mit dem SSE-Stream und reiht den Job in die Schlange ein.
  router.post('/', upload.array('files', 8), (req, res) => {
    // Inhalt aus JSON oder Multipart
    const content = req.body.content || req.body.text || '';
    const aliases = req.body.aliases ? JSON.parse(req.body.aliases) : [];
    if (!content && (!req.files || req.files.length === 0)) {
      return res.status(400).json({ error: 'content or files required' });
    }

    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    enqueueMessageJob({
      req, res, content, aliases,
      files: req.files || [],
      think: String(req.body.think) === 'true',
    });
  });

  // POST /api/chats/:chatId/messages/regenerate — Retry-Button der Fehler-
  // zeile: beantwortet die LETZTE User-Frage neu, ohne sie zu duplizieren.
  // Ein abschließender '*Failed*'-Marker wird entfernt; eine nackte User-
  // Frage ohne Antwort (Altlast der früher stummen Fehler) zählt ebenfalls.
  // 409, wenn die letzte Nachricht eine echte Antwort ist.
  router.post('/regenerate', (req, res) => {
    const chatId = req.params.chatId;
    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });

    const last = db.prepare(
      'SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
    ).get(chatId);
    let userRow = null;
    if (last && last.role === 'user') {
      userRow = last;
    } else if (last && last.role === 'assistant' && last.content.trim() === FAILED_MARKER) {
      db.prepare('DELETE FROM messages WHERE id = ?').run(last.id);
      userRow = db.prepare(
        "SELECT * FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY created_at DESC, id DESC LIMIT 1"
      ).get(chatId);
    }
    if (!userRow) return res.status(409).json({ error: 'nothing to regenerate' });

    const attachments = db.prepare('SELECT * FROM attachments WHERE message_id = ?').all(userRow.id);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    enqueueMessageJob({
      req, res,
      content: userRow.content,
      aliases: [],
      files: [],
      think: String(req.body?.think) === 'true',
      regenerate: { userMsgId: userRow.id, createdAt: userRow.created_at, attachments },
    });
  });

  // Führt EINEN Nachrichten-Job aus — immer seriell, via processJobQueue.
  async function runMessageJob(job) {
    const { req, res, content } = job;
    const chatId = req.params.chatId;

    // Frisch lesen — Titel/Quelle können sich geändert haben, seit der Job
    // eingereiht wurde; gelöschte Chats beenden den Job sauber.
    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    if (!chat) {
      sseWrite(res, { error: 'Chat not found' });
      return void res.end();
    }

    // User-Nachricht speichern — erst beim Dequeue (siehe Warteschlangen-
    // Kommentar oben). Beim Regenerate existiert die Frage bereits.
    let userMsgId;
    let now;
    let attachments = [];
    if (job.regenerate) {
      userMsgId = job.regenerate.userMsgId;
      now = job.regenerate.createdAt;
      attachments = job.regenerate.attachments;
    } else {
      userMsgId = crypto.randomUUID();
      now = monotonicNow(chatId);
      db.prepare(
        'INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(userMsgId, chatId, 'user', content, now);

      // Anhänge speichern (die Dateien liegen seit dem POST auf der Platte)
      for (let i = 0; i < job.files.length; i++) {
        const file = job.files[i];
        const alias = job.aliases[i] || `@datei${i + 1}`;
        const id = file.attachmentId;
        db.prepare(
          `INSERT INTO attachments (id, message_id, chat_id, alias, filename, mimetype, path, size, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, userMsgId, chatId, alias, file.originalname, file.mimetype, file.path, file.size, now);
        attachments.push({
          id, message_id: userMsgId, alias,
          filename: file.originalname, mimetype: file.mimetype, path: file.path, size: file.size,
        });
      }
    }

    // Anhänge mit URLs für Frontend
    const userAttachments = attachments.map(a => ({
      id: a.id, alias: a.alias, filename: a.filename, mimetype: a.mimetype, size: a.size,
      url: `/uploads/${chatId}/${a.id}-${a.filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)}`,
    }));
    const userMessage = {
      id: userMsgId, chat_id: chatId, role: 'user', content, created_at: now,
      attachments: userAttachments,
    };

    // started-Event: der Job ist an der Reihe. Die UI ersetzt damit ihre
    // optimistische Frage durch die persistierte (echter Zeitstempel →
    // richtige chronologische Sortierung) und wechselt von "wartet" zu den
    // Denk-Punkten.
    sseWrite(res, { started: true, userMessage });

    // Kontext aufbauen — System-Prompt (+ Paper + Vorfahren) + Historie.
    // Letzte (aktuelle) User-Nachricht weglassen — die fügen wir multimodal hinzu.
    const { messages: contextMessages, retrieval, meta } = await buildSystemAndHistory(chat, {
      dropLastMessage: true,
    });

    // Retrieval-Modus (ADR-0006): die zur Frage passendsten Chunks der
    // langen Quelle als eigener Block hinter der Historie. Fehler sind nie
    // fatal — das Skeleton im System-Prompt trägt die Antwort dann allein.
    let chunkCount = null;
    let excerptChars = 0;
    if (retrieval && content) {
      try {
        const hits = await retrieveChunks(db, {
          sourceType: retrieval.sourceType,
          sourceId: retrieval.sourceId,
          query: content,
          k: RETRIEVE_K,
          ...(embedTextsFn ? { embedFn: embedTextsFn } : {}),
        });
        chunkCount = hits.length;
        if (hits.length > 0) {
          const excerptBlock = renderExcerpts(hits, retrieval.sourceType);
          excerptChars = excerptBlock.length;
          contextMessages.push({ role: 'system', content: excerptBlock });
        }
      } catch (err) {
        console.warn(`[retrieval] Chunk-Abruf fehlgeschlagen (${err.message}) — Antwort ohne Auszüge.`);
      }
    }

    // Aktuelle User-Nachricht: multimodal mit Bildern. Text-Annexe anderer
    // Dateien folgen als eigene System-Message HINTER der Frage — dasselbe
    // Muster wie die Retrieval-Excerpts (Umbau 2026-07-25). Vorher steckte
    // der Annex in der User-Message selbst; die Historie rendert alte
    // Nachrichten aber ohne Annex (persistiert wird nur `content`), also
    // wich der Prompt der NÄCHSTEN Runde genau ab der Anhang-Nachricht ab:
    // KV-Cache tot, bei 64-KB-Anhängen bis zu ~18k Tokens Re-Prefill pro
    // Folgefrage. Jetzt bleibt die User-Message byte-identisch mit ihrer
    // späteren Historien-Form; nur der Annex-Block ist einmalig. (Bilder
    // müssen in der User-Message bleiben — bekannter Rest-Cache-Bruch.)
    const imageContents = attachments.map(attachmentToMultimodalContent).filter(Boolean);
    const textAnnex = buildAttachmentTextAnnex(attachments);

    if (imageContents.length > 0) {
      contextMessages.push({
        role: 'user',
        content: [{ type: 'text', text: content }, ...imageContents],
      });
    } else {
      contextMessages.push({ role: 'user', content });
    }
    if (textAnnex) {
      contextMessages.push({
        role: 'system',
        content:
          'ATTACHED FILES — contents of the files the user attached to their current message:' +
          textAnnex,
      });
    }

    // Echte Fragen haben Vorfahrt: einen eventuell laufenden Warm-up sofort
    // abbrechen, damit dieser Job nicht hinter ihm in Ollamas Warteschlange
    // hängt. (Die SSE-Header sind seit dem POST gesetzt.)
    abortActiveWarmup();

    try {
      const { client, model, provider } = getLLMClient(db);

      // Denken ist standardmäßig AUS (Antworten starten sofort). Nur wenn der
      // Client explizit think=true schickt, darf das Modell seine Gedanken-
      // kette laufen lassen. Ollama /v1 übersetzt reasoning_effort 'none'
      // in think=false; die Gedanken streamen als eigene reasoning-Events
      // an die UI (einklappbares Panel), aber nie in Antwort-Text oder DB.
      const thinkOn = job.think;
      const extras = thinkOn ? {} : noThinkExtras(provider);

      // Stop-Button: Wenn der Client die Verbindung schließt, brechen wir die
      // Upstream-Anfrage ab — Ollama/OpenAI hören sofort auf zu generieren.
      // Der close-Handler hängt seit dem Einreihen am Request
      // (enqueueMessageJob) und ruft job.abort; war der Client beim Job-Start
      // schon weg, wird sofort abgebrochen.
      // Ehrliche Warte-Schätzung fürs Frontend (ThinkingIndicator-Balken,
      // design/mockup-prefill-progress.html §01): voraussichtlich neu zu
      // rechnende Tokens ÷ gemessene Rate. Kalt = kompletter Prompt; warm im
      // Retrieval-Modus = frischer Auszugs-Block + letzte Runde; warm im
      // Volltext-Modus bleibt unter der Schwelle (kein Event). Nur Ollama —
      // Cloud-TTFTs liegen ohnehin unter der Anzeigeschwelle.
      if (provider === 'ollama') {
        const promptChars = contextMessages.reduce((n, m) => n + (typeof m.content === 'string'
          ? m.content.length
          : m.content.reduce((k, p) => k + (p.type === 'text' ? p.text.length : 0), 0)), 0);
        const uncachedTokensEst = meta.cache === 'cold'
          ? Math.round(promptChars / 3.5)
          : retrieval ? Math.round(excerptChars / 3.5) + 400 : 200;
        const etaSeconds = Math.round(uncachedTokensEst / prefillTokPerSec);
        if (etaSeconds >= 4) sseWrite(res, { prefill: { seconds: etaSeconds } });
      }

      const upstreamAbort = new AbortController();
      job.abort = upstreamAbort;
      if (job.clientClosed) upstreamAbort.abort();

      // Tool-Use-Loop: das LLM darf eigenständig web_search aufrufen. Beim
      // Tool-Call streamen wir spezielle SSE-Events ans Frontend, damit es
      // "Searching the web…" anzeigen und die Quellen unter der Antwort
      // auflisten kann.
      const fullContent = await streamWithTools({
        client,
        model,
        messages: contextMessages,
        extras,
        signal: upstreamAbort.signal,
        onText: (delta) => {
          res.write(`data: ${JSON.stringify({ delta })}\n\n`);
        },
        onToolEvent: (evt) => {
          res.write(`data: ${JSON.stringify({ tool: evt })}\n\n`);
        },
        onThinking: () => {
          res.write(`data: ${JSON.stringify({ thinking: true })}\n\n`);
        },
        onReasoning: (delta) => {
          res.write(`data: ${JSON.stringify({ reasoning: delta })}\n\n`);
        },
        onPerf: (perf) => {
          // Eine [perf]-Zeile pro Antwort: die Basis für jede Latenz-Diagnose
          // (Prefill vs. Decode). Angereichert um Modus, Cache-Zustand und
          // Quellengröße — die drei Haupttreiber der Wartezeit. Reine Metriken,
          // NIE Gesprächsinhalte (Garantie in perf-log.js), nichts in der DB.
          const record = buildPerfRecord({
            now: new Date().toISOString(),
            chatId: req.params.chatId,
            model,
            mode: meta.mode,
            cache: meta.cache,
            sourceTokens: meta.sourceTokens,
            chunkCount,
            promptTokens: perf.promptTokens,
            ttftMs: perf.ttftMs,
            completionTokens: perf.completionTokens,
            tokensPerSecond: perf.tokensPerSecond,
            totalMs: perf.totalMs,
          });
          console.log(formatPerfLine(record));
          // Auswertbare Historie nur auf ausdrücklichen Wunsch (SYFLO_PERF_LOG):
          // eine JSON-Zeile pro Antwort in logs/perf.jsonl, per `jq` filterbar.
          if (isPerfJsonlEnabled()) appendPerfJsonl(record);
          // Prefill-Rate (EMA) nur aus kalten Antworten lernen — warme haben
          // winzige echte Prefills bei großem promptTokens und würden die
          // Rate absurd nach oben ziehen.
          if (provider === 'ollama' && meta.cache === 'cold' && perf.promptTokens > 2000 && perf.ttftMs > 1500) {
            const measured = perf.promptTokens / (perf.ttftMs / 1000);
            prefillTokPerSec = Math.min(2000, Math.max(50, 0.6 * prefillTokPerSec + 0.4 * measured));
          }
          // Prompt nahe am Kontextfenster heißt Context-Shifting: Ollama
          // wirft vorne Tokens weg, der Prefix ändert sich bei jeder Anfrage
          // und der KV-Cache greift nie — genau das soll das abgeleitete
          // Zeichen-Budget verhindern. Diese Warnung ist das Sicherheitsnetz.
          if (provider === 'ollama' && perf.promptTokens && perf.promptTokens > CONTEXT_WINDOW_TOKENS * 0.9) {
            console.warn(
              `[perf] Prompt (${perf.promptTokens} Tokens) ist nahe am Kontextfenster ` +
              `(${CONTEXT_WINDOW_TOKENS}) — Context-Shifting droht, KV-Cache wird unwirksam.`
            );
          }
          res.write(`data: ${JSON.stringify({ perf })}\n\n`);
        },
      });

      // Nach jeder Antwort die Modell-TTL wieder auf 1 h ziehen — sonst fällt
      // sie auf Ollamas 5-Minuten-Default zurück und der Paper-Cache stirbt.
      if (provider === 'ollama') extendOllamaKeepAlive(model);

      // Stop-Button (Nutzerentscheid 2026-07-22): die halb generierte Antwort
      // wird NICHT gespeichert — an ihrer Stelle steht nur der Marker, den
      // das Frontend als graue "Interrupted"-Zeile rendert (gleicher String
      // wie INTERRUPTED_MARKER in frontend/src/types).
      const aborted = upstreamAbort.signal.aborted;
      const assistantContent = aborted ? '*Interrupted*' : fullContent;

      const assistantMsgId = crypto.randomUUID();
      const assistantNow = monotonicNow(chatId);
      db.prepare(
        'INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(assistantMsgId, req.params.chatId, 'assistant', assistantContent, assistantNow);

      // Titel-Generierung wie bisher — nach einem Abbruch überspringen (der
      // Client ist weg, und ein weiterer LLM-Aufruf wäre nur Wartezeit für
      // die nächste echte Frage).
      const msgCount = db.prepare(
        'SELECT COUNT(*) as count FROM messages WHERE chat_id = ?'
      ).get(req.params.chatId);

      // Bäume mit gebundener Quelle sind nach ihr benannt (Papers seit
      // Slice 03, Videos ADR-0005) — der Root behält diesen Namen, statt
      // sich von der Titel-Generierung überschreiben zu lassen.
      const hasSourceName = Boolean(chat.paper_id || chat.video_id);
      if (!aborted && !hasSourceName && (chat.title === 'New Chat' || msgCount.count <= 2)) {
        // Hard caps so the sidebar list and mindmap stay readable even if the
        // LLM ignores the word-limit instruction (some smaller models do).
        const MAX_TITLE_WORDS = 4;
        const MAX_TITLE_CHARS = 40;

        // Fallback: first few words of the user's message, in case the LLM call fails.
        let newTitle = (content || 'Chat')
          .trim()
          .split(/\s+/)
          .slice(0, MAX_TITLE_WORDS)
          .join(' ');

        try {
          const { client: titleClient, model: titleModel, provider: titleProvider } = getLLMClient(db);
          const titleInstruction = {
            role: 'user',
            content:
              'Generate a 2 to 4 word title for this chat. ' +
              'Write the title in the language of the conversation (a German chat gets a German title). ' +
              'Output ONLY the title — no quotes, no punctuation, no markdown, no labels, no extra commentary. ' +
              'Examples: React hooks tutorial / Bicycle repair guide / Berlin trip planning / Linear algebra basics.',
          };
          // Ollama hat genau EINEN KV-Cache-Slot (Vision-Modelle erzwingen
          // Parallel:1). Ein Standalone-Titel-Prompt würde den teuren
          // Paper-Prefix verdrängen — die nächste Frage zahlt dann den
          // vollen Prefill erneut (~40 s gemessen, 2026-07-21). Deshalb:
          // dieselbe Prompt-Basis wie das Gespräch (inkl. tools, sonst
          // weicht der gerenderte Prefix ab) + Titel-Frage hinten dran —
          // Cache-Treffer statt Verdrängung. Cloud-Provider behalten den
          // billigen Mini-Prompt (dort zählt jedes Input-Token, nicht der
          // lokale Cache).
          const titleMessages = titleProvider === 'ollama'
            ? [...contextMessages, { role: 'assistant', content: fullContent }, titleInstruction]
            : [titleInstruction, { role: 'user', content: content || 'New chat' }];
          let titleCompletion;
          try {
            titleCompletion = await titleClient.chat.completions.create({
              model: titleModel,
              // Für einen 4-Wort-Titel darf kein Denk-Modell minutenlang grübeln.
              ...noThinkExtras(titleProvider),
              messages: titleMessages,
              ...(titleProvider === 'ollama' ? { tools: ALL_TOOLS } : {}),
            });
          } catch (err) {
            if (!/does not support tools/i.test(err?.message || '')) throw err;
            titleCompletion = await titleClient.chat.completions.create({
              model: titleModel,
              ...noThinkExtras(titleProvider),
              messages: titleMessages,
            });
          }
          const raw = titleCompletion.choices[0]?.message?.content || '';
          if (raw.trim()) newTitle = raw.trim();
        } catch (_) { /* Fallback genügt */ }

        // Sanitize whatever the LLM returned: strip wrapping quotes/backticks,
        // strip trailing punctuation, drop any line breaks the model added, and
        // enforce the word + character caps.
        newTitle = newTitle
          .replace(/[\r\n]+/g, ' ')
          .replace(/^["'`*_]+|["'`*_.!?,;:]+$/g, '')
          .trim()
          .split(/\s+/)
          .slice(0, MAX_TITLE_WORDS)
          .join(' ');
        if (newTitle.length > MAX_TITLE_CHARS) {
          newTitle = newTitle.slice(0, MAX_TITLE_CHARS - 1).trimEnd() + '…';
        }
        if (!newTitle) newTitle = 'New Chat';

        db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(newTitle, req.params.chatId);
      }

      const assistantMessage = {
        id: assistantMsgId, chat_id: req.params.chatId, role: 'assistant', content: assistantContent, created_at: assistantNow,
        attachments: [],
      };

      res.write(`data: ${JSON.stringify({ done: true, userMessage, assistantMessage })}\n\n`);
      res.end();
    } catch (err) {
      // Fehler nie mehr stumm (Vorfall 2026-07-24: Antworten verschwanden
      // ohne Log und ohne Spur in der DB): loggen, einen '*Failed*'-Marker
      // an Stelle der Antwort persistieren und dem Client beide persistierten
      // Nachrichten mitgeben — die UI zeigt die Fehlerzeile mit Retry.
      console.error(`[messages] Antwort in Chat ${chatId} fehlgeschlagen: ${err.message}`);
      let assistantMessage = null;
      try {
        const failedId = crypto.randomUUID();
        const failedNow = monotonicNow(chatId);
        db.prepare(
          'INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
        ).run(failedId, chatId, 'assistant', FAILED_MARKER, failedNow);
        assistantMessage = {
          id: failedId, chat_id: chatId, role: 'assistant', content: FAILED_MARKER,
          created_at: failedNow, attachments: [],
        };
      } catch (_) { /* DB-Fehler: wenigstens das error-Event geht raus */ }
      sseWrite(res, { error: err.message, userMessage, assistantMessage });
      res.end();
    }
  }

  // Der Kontext-Builder wird an /api/explain weitergereicht (server.js):
  // Wort-Erklärungen teilen so denselben Prompt-Präfix wie das Gespräch —
  // Cache-Treffer statt Verdrängung des einzigen KV-Slots (2026-07-25).
  router.buildSystemAndHistory = buildSystemAndHistory;
  return router;
};
