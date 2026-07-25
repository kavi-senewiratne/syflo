/**
 * ancestor-context.js
 *
 * Geerbter Gesprächskontext für Branch-Chats (Design-Session 2026-07-20):
 * Ein Kind-Knoten erbt den ganzen Pfad bis zur Wurzel — der direkte
 * Elternchat wörtlich, Großeltern und höher als gecachte Zusammenfassung,
 * dazu die parent_word-Kette als roter Faden. Geschwister-Äste nie.
 *
 * Die Summary pro Chat ist ein reiner Cache (chats.summary), live gehalten
 * über die id der letzten abgedeckten Nachricht (summary_last_message_id):
 * stimmt sie mit der aktuell letzten Nachricht überein, ist der Cache frisch.
 */

const { getLLMClient, noThinkExtras } = require('./llm');

// Ziel-Länge einer Knoten-Zusammenfassung (Prompt-Anweisung, kein Hard-Cap).
const SUMMARY_WORD_TARGET = 120;

// Zeichen-Budget für das wörtliche Eltern-Transkript. Darüber wird derselbe
// Hybrid-Trick rekursiv angewendet: Summary des Chats + wörtlicher Schwanz.
const MAX_PARENT_CHARS = 8000;
const PARENT_VERBATIM_TAIL = 10;

// Letzte Nachricht eines Chats — Grundlage des Staleness-Checks.
function lastMessageId(db, chatId) {
  const row = db
    .prepare(
      'SELECT id FROM messages WHERE chat_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
    )
    .get(chatId);
  return row ? row.id : null;
}

function getTranscript(db, chatId) {
  return db
    .prepare('SELECT role, content FROM messages WHERE chat_id = ? ORDER BY created_at ASC')
    .all(chatId);
}

function renderTranscript(messages) {
  return messages.map((m) => `${m.role}: ${m.content}`).join('\n');
}

// Chats, deren Summary gerade im Hintergrund erneuert wird — verhindert,
// dass jede weitere Nachricht während der Generierung noch eine anstößt.
const summaryRefreshInFlight = new Set();

// Stößt die Erneuerung einer stale Summary im Hintergrund an. Fehler sind
// nie fatal — der stale Cache bleibt dann einfach stehen.
function refreshChatSummaryInBackground(db, chatId) {
  if (summaryRefreshInFlight.has(chatId)) return;
  summaryRefreshInFlight.add(chatId);
  setImmediate(async () => {
    try {
      await ensureChatSummary(db, chatId);
    } catch (_) { /* stale Summary bleibt */ } finally {
      summaryRefreshInFlight.delete(chatId);
    }
  });
}

/**
 * Liefert die aktuelle Zusammenfassung eines Chats — aus dem Cache, wenn
 * seit der letzten Generierung keine Nachricht dazukam, sonst frisch vom
 * konfigurierten Chat-Modell. Leere Chats ergeben null (nichts zusammenzufassen).
 *
 * `allowStale` (latenzkritische Pfade, z. B. Nachricht senden): eine
 * veraltete Summary wird sofort zurückgegeben und im Hintergrund erneuert —
 * kein blockierender LLM-Aufruf vor der eigentlichen Antwort, und der
 * Prompt-Prefix bleibt identisch zum letzten Warm-up (KV-Cache greift).
 */
async function ensureChatSummary(db, chatId, { allowStale = false } = {}) {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  if (!chat) return null;

  const lastId = lastMessageId(db, chatId);
  if (!lastId) return null;
  if (chat.summary && chat.summary_last_message_id === lastId) return chat.summary;

  if (allowStale && chat.summary) {
    refreshChatSummaryInBackground(db, chatId);
    return chat.summary;
  }

  const transcript = renderTranscript(getTranscript(db, chatId));
  const { client, model, provider } = getLLMClient(db);
  const completion = await client.chat.completions.create({
    model,
    ...noThinkExtras(provider),
    messages: [
      {
        role: 'system',
        content:
          'Summarize the following conversation. Respond with ONLY a JSON object ' +
          '(no code fences, no preamble) of this exact shape:\n' +
          '{"gist": "<one sentence capturing the core insight>", ' +
          '"points": ["<key point>", "<key point>", "<key point>"], ' +
          `"summary": "<about ${SUMMARY_WORD_TARGET} words of flowing prose>"}\n` +
          'In "summary", keep key terms, definitions and conclusions verbatim where ' +
          'possible. Use Markdown and inline LaTeX ($...$) inside the strings ' +
          'wherever the conversation does. Write all strings in the language of the ' +
          'conversation you are summarizing (a German conversation gets a German summary).',
      },
      { role: 'user', content: transcript },
    ],
  });

  const raw = (completion.choices[0]?.message?.content || '').trim();
  if (!raw) return null;
  const { summary, display } = parseSummaryResponse(raw);

  db.prepare(
    'UPDATE chats SET summary = ?, summary_display = ?, summary_last_message_id = ? WHERE id = ?'
  ).run(summary, display ? JSON.stringify(display) : null, lastId, chatId);
  return summary;
}

/**
 * Zerlegt die Summarizer-Antwort in { summary, display }.
 * summary = Fließtext für den geerbten Prompt (unverändert dessen Rolle),
 * display = {gist, points[]} für das Kontext-Banner. Kleine lokale Modelle
 * liefern nicht zuverlässig JSON — jeder Parse-Fehler degradiert sanft:
 * die ganze Rohantwort wird zur Summary, display bleibt null.
 */
function parseSummaryResponse(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(raw.slice(start, end + 1));
      const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
      const gist = typeof obj.gist === 'string' ? obj.gist.trim() : '';
      const points = Array.isArray(obj.points)
        ? obj.points.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim())
        : [];
      if (summary) return { summary, display: gist ? { gist, points } : null };
    } catch (_) {
      /* kein JSON — Rohtext als Summary */
    }
  }
  return { summary: raw, display: null };
}

/**
 * Vorfahren-Pfad eines Chats: [Wurzel, …, direkter Elternchat].
 * Leer für Root-Chats.
 */
function getAncestorPath(db, chatId) {
  const getChat = db.prepare('SELECT * FROM chats WHERE id = ?');
  const path = [];
  let chat = getChat.get(chatId);
  while (chat && chat.parent_id) {
    chat = getChat.get(chat.parent_id);
    if (chat) path.unshift(chat);
  }
  return path;
}

/**
 * Baut den geerbten Gesprächskontext für einen Branch-Chat:
 *   - parent_word-Kette (Wurzel-Titel → word → … → aktuelles Branch-Wort)
 *   - Großeltern und höher: gecachte Zusammenfassungen (Wurzel zuerst)
 *   - direkter Elternchat: wörtliches Transkript
 * Gibt null für Root-Chats zurück. `text` ist der fertige Prompt-Block.
 */
async function buildAncestorContext(db, chatId, opts = {}) {
  const maxParentChars = opts.maxParentChars ?? MAX_PARENT_CHARS;
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  if (!chat || !chat.parent_id) return null;

  const ancestorPath = getAncestorPath(db, chatId);
  const parent = ancestorPath[ancestorPath.length - 1];
  const olderAncestors = ancestorPath.slice(0, -1);

  // Kette: Wurzel-Titel, dann pro Ebene das Wort, aus dem sie entstand.
  const chainParts = [
    ancestorPath[0].title,
    ...ancestorPath.slice(1).map((c) => c.parent_word || c.title),
  ];
  if (chat.parent_word) chainParts.push(chat.parent_word);
  const chain = chainParts.join(' → ');

  // allowStale: der Nachrichtenpfad darf nie auf Summary-Generierung warten —
  // veraltete Summaries werden genutzt und im Hintergrund erneuert.
  const summaries = [];
  for (const ancestor of olderAncestors) {
    const summary = await ensureChatSummary(db, ancestor.id, { allowStale: true });
    if (summary) summaries.push({ id: ancestor.id, title: ancestor.title, summary });
  }

  // Elternchat wörtlich — außer er sprengt das Budget: dann Summary des
  // Chats als Ersatz für den älteren Teil + die letzten Nachrichten wörtlich.
  const parentMessages = getTranscript(db, parent.id);
  let parentTranscript = renderTranscript(parentMessages);
  if (parentTranscript.length > maxParentChars) {
    const parentSummary = await ensureChatSummary(db, parent.id, { allowStale: true });
    const tail = renderTranscript(parentMessages.slice(-PARENT_VERBATIM_TAIL));
    parentTranscript =
      `[Summary of the earlier part of this conversation]\n${parentSummary || '(none)'}\n\n` +
      `[Most recent messages, verbatim]\n${tail}`;
  }

  const result = { chain, summaries, parentTranscript, parent };
  return { ...result, text: renderAncestorText(result) };
}

/**
 * Rendert die Kontext-Teile (ggf. nach applyContextBudget) zum Prompt-Block.
 */
function renderAncestorText({ chain, summaries, parentTranscript }) {
  const parts = [`Path through the conversation tree: ${chain}`];
  if (summaries.length > 0) {
    parts.push(
      'Earlier conversations on this path, summarized (oldest first):\n' +
        summaries.map((s) => `- "${s.title}": ${s.summary}`).join('\n')
    );
  }
  if (parentTranscript) {
    parts.push(`The parent conversation, verbatim:\n${parentTranscript}`);
  }
  return parts.join('\n\n');
}

/**
 * Opfer-Reihenfolge, wenn der Gesamtkontext das Budget sprengt:
 * zuerst Vorfahren-Summaries von der Wurzel her (älteste zuerst) fallen
 * lassen, erst dann den Quelltext kürzen (Anfang behalten), notfalls ganz
 * streichen. Das wörtliche Eltern-Transkript wird nie angetastet — die
 * unmittelbare Gesprächsnähe ist beim Vertiefen das Wertvollste.
 *
 * Reihenfolge gedreht am 2026-07-25 (vorher: Quelle zuerst): Die Quelle ist
 * der teuerste Prompt-Teil und im ganzen Baum byte-identisch geteilt — jede
 * Kürzung im Kind macht den KV-Cache des Eltern-Prefills wertlos (gemessen:
 * voller Re-Prefill ~60 s). Summaries sind klein und stehen ohnehin HINTER
 * der Quelle im Prompt; sie zu opfern erhält den gemeinsamen Präfix.
 */
function applyContextBudget({ paperText, summaries, parentTranscript }, maxTotalChars) {
  const parentLen = parentTranscript ? parentTranscript.length : 0;
  let trimmedSummaries = [...summaries];
  let trimmedPaper = paperText;

  const paperLen = () => (trimmedPaper ? trimmedPaper.length : 0);
  const summariesLen = () => trimmedSummaries.reduce((n, s) => n + s.summary.length, 0);

  // 1. Summaries älteste zuerst opfern, bis alles zusammen passt.
  while (trimmedSummaries.length > 0 && paperLen() + parentLen + summariesLen() > maxTotalChars) {
    trimmedSummaries.shift();
  }

  // 2. Reicht das nicht: Quelle auf den Rest-Platz kürzen (Anfang behalten —
  //    dort stehen Titel/Abstract), notfalls ganz streichen.
  if (trimmedPaper) {
    const room = maxTotalChars - parentLen - summariesLen();
    if (trimmedPaper.length > room) {
      trimmedPaper = room > 0 ? trimmedPaper.slice(0, room) : null;
    }
  }

  return { paperText: trimmedPaper, summaries: trimmedSummaries, parentTranscript };
}

/**
 * Warm-up beim Anlegen einer Abzweigung: erzeugt/erneuert die Summaries der
 * ganzen Vorfahren-Kette des neuen Chats im Hintergrund, damit sie bei der
 * ersten Frage schon im Cache liegen. Fehler einzelner Summaries werden
 * geschluckt — der Lazy-Pfad in buildAncestorContext bleibt das Sicherheitsnetz.
 */
async function warmUpAncestorSummaries(db, chatId) {
  for (const ancestor of getAncestorPath(db, chatId)) {
    try {
      await ensureChatSummary(db, ancestor.id);
    } catch (_) { /* nächster Vorfahre */ }
  }
}

// Ollamas Kontextfenster in Tokens — muss zu dem Wert passen, den
// start.command exportiert (OLLAMA_CONTEXT_LENGTH). Läuft das Backend aus
// derselben Shell, erbt es die Variable; der Fallback ist derselbe Wert.
const CONTEXT_WINDOW_TOKENS = parseInt(process.env.OLLAMA_CONTEXT_LENGTH || '', 10) || 16384;

// Reserve im Fenster für alles außerhalb des System-Kontexts: Basis-System-
// Prompt, Tool-Definitionen, Nachrichten-Historie und die Antwort selbst.
const RESERVED_TOKENS = 5_000;

// Konservative Schätzung für wissenschaftlichen Text (Formeln, Zitate und
// Fachwörter tokenisieren schlechter als die üblichen ~4 Zeichen/Token).
const CHARS_PER_TOKEN = 3.5;

// Gesamt-Budget für die variablen Kontext-Blöcke (Paper + Summaries +
// Eltern-Transkript) im System-Prompt — abgeleitet aus dem Fenster statt
// fest verdrahtet: ein Budget über dem Fenster hieße stilles Context-
// Shifting bei Ollama, und damit einen KV-Cache, der nie greift.
const MAX_SYSTEM_CONTEXT_CHARS = Math.floor(
  (CONTEXT_WINDOW_TOKENS - RESERVED_TOKENS) * CHARS_PER_TOKEN
);

module.exports = {
  ensureChatSummary,
  parseSummaryResponse,
  buildAncestorContext,
  renderAncestorText,
  applyContextBudget,
  warmUpAncestorSummaries,
  getAncestorPath,
  MAX_SYSTEM_CONTEXT_CHARS,
  CONTEXT_WINDOW_TOKENS,
  RESERVED_TOKENS,
  CHARS_PER_TOKEN,
};
