export interface Chat {
  id: string;
  title: string;
  parent_id: string | null;
  parent_word: string | null;
  // The same passage with its math restored, for DISPLAY only (branch header,
  // quote chip, mindmap badge — decision 2026-08-02). parent_word stays the
  // verbatim extraction: it is the model's context and the anchor that
  // branch-word links and highlight matching search for. Null → show
  // parent_word.
  parent_word_display?: string | null;
  created_at: string;
  child_count?: number;
  children?: Chat[];
  // Erste Nutzer-Frage, gekürzt — wird in der Mindmap angezeigt, damit man
  // auf einen Blick sieht, worum es im Chat geht.
  preview?: string | null;
  message_count?: number;
  // Answers that actually said something — '*Failed*'/'*Interrupted*' markers
  // excluded. The mindmap only promises an outcome ("Ergebnis folgt …") where
  // an answer exists to derive one from (2026-08-03).
  answer_count?: number;
  // Color of the highlight this branch was opened from — the mindmap node's
  // color bar (decision 2026-08-02,
  // design/mockup-mindmap-node-final.html). Null for branches opened without
  // a highlight and for root chats.
  highlight_color?: HighlightColor | null;
  // 4–8 words on what this chat established — the mindmap node's second line.
  // Written by the title call that runs after the first answer; null until
  // then, and the node shows the title alone.
  outcome?: string | null;
  // ID des an den Tree gebundenen PDFs — nur am Root gesetzt (ADR-0002).
  // Rendert den PDF-Tag am Root-Knoten im Chat tree.
  paper_id?: string | null;
  // ID des an den Tree gebundenen YouTube transcript (ADR-0005) — nur am
  // Root gesetzt. Rendert den YT-Tag am Root-Knoten im Chat tree.
  video_id?: string | null;
  // Branch trace (design/mockup-branch-trace.html, Variante A): Woher im
  // Elternchat dieser Zweig stammt. `/btw` und `/branch` haben keine
  // markierte Passage — ihr Anker ist die letzte Nachricht, die im
  // Elternchat existierte, als der Befehl abging. Der Verlauf des
  // Elternchats zeichnet danach eine Abzweig-Zeile, und die Kopfzeile des
  // Zweigs verlinkt zurück auf genau diese Zeile.
  // Selektions-Zweige haben beide Felder null: ihre farbige Passage ist die
  // bessere Spur (Entscheidung 2026-08-09).
  branch_origin?: BranchOrigin | null;
  branch_anchor_message_id?: string | null;
  // Wann dieser Root-Chat angepinnt wurde (ISO-Zeitstempel), sonst null.
  // Angepinnte Chats verlassen die Datums-Abschnitte und stehen zusammen im
  // Abschnitt „Angepinnt" ganz oben in der Seitenleiste, zuletzt Angepinntes
  // zuerst (design/mockup-pinned-chats.html, Variante A). Nur Roots können
  // angepinnt werden — der Abschnitt listet Bäume.
  pinned_at?: string | null;
  // Which category this root chat is filed into, or null for uncategorised.
  // Points at either level — a subcategory is a category, so filing into
  // "Robotics" and into "Robotics / Teleop data" is the same field
  // (design/mockup-sidebar-categories-v2.html, decided 2026-08-16).
  category_id?: string | null;
}

// A user-made container for root chats in the sidebar, next to the two
// groupings the system imposes (Pinned, and the relative date sections).
// A subcategory is a category with a parent_id — one type, not two, because
// renaming, deleting and collapsing are the same gesture at both levels.
// Nesting stops at two levels; the backend refuses anything deeper.
export interface Category {
  id: string;
  name: string;
  parent_id: string | null;
  position: number;
  // SQLite has no boolean — 0/1, exactly as the row is stored.
  collapsed: number;
  created_at: string;
}

// Woraus ein Zweig ohne Passage entstanden ist. Die Abzweig-Zeile trägt den
// Befehlsnamen selbst — er ist in beiden App-Sprachen gleich, genau wie das
// /btw-Panel (Entscheidung 2026-08-08).
export type BranchOrigin = 'btw' | 'topic';

export interface Attachment {
  id: string;
  alias: string;       // z. B. "@foto1"
  filename: string;
  mimetype: string;
  size: number;
  url: string;         // backend-served URL, z. B. "/uploads/<chat-id>/<id>-<filename>"
}

// Lokale Repräsentation eines Anhangs vor dem Hochladen
// (im Speicher, noch nicht persistiert).
export interface LocalAttachment {
  alias: string;
  file: File;
  previewUrl?: string; // object URL für Bilder-Vorschau
}

export interface SearchSource {
  title: string;
  url: string;
  snippet: string;
}

export interface ToolEvent {
  phase: 'call' | 'result';
  name: string;
  args?: { query?: string };
  result?: { query?: string; results?: SearchSource[]; error?: string } | null;
}

// Inhalt einer Assistant-Nachricht, deren Antwort per Stop-Button abgebrochen
// wurde: der Teiltext wird verworfen, nur diese Markierung bleibt (Nutzer-
// entscheid 2026-07-22). Das Backend (routes/messages.js) schreibt exakt
// denselben String — MessageBubble rendert ihn als graue "Interrupted"-Zeile.
export const INTERRUPTED_MARKER = '*Interrupted*';

// Inhalt einer Assistant-Nachricht, deren Generierung fehlschlug (z. B.
// Ollama-Fehler oder Timeout). Das Backend (routes/messages.js) schreibt
// exakt denselben String — MessageBubble rendert ihn als dezente Fehlerzeile
// mit "Erneut versuchen"-Button (Pendant zu INTERRUPTED_MARKER).
export const FAILED_MARKER = '*Failed*';

export interface Message {
  id: string;
  chat_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  attachments?: Attachment[];
  // Persisted anchor of an "Ask in chat" quote: the highlight the quoted
  // passage was taken from (design/mockup-quote-jump-to-source.html,
  // variant A). The quote text itself lives in `content` as blockquote
  // lines; this makes it clickable, so the bubble can jump back to the
  // passage. Null on plain questions, on messages sent before the feature,
  // and on PDF quotes saved without a color (no highlight row exists then).
  quote_highlight_id?: string | null;
  // Transient (not persisted): sources surfaced from a web_search tool call
  // during the streaming session this message was produced in. Populated by
  // the streaming client; lost on page reload.
  sources?: SearchSource[];
  // Transient (not persisted): wie lange das Modell vor dieser Antwort
  // nachgedacht hat (nur bei think=on) — rendert die "Thought for Xs"-Zeile.
  thoughtForSeconds?: number;
  // Transient (not persisted): die live gestreamte Gedankenkette (nur bei
  // think=on) — rendert das einklappbare Thinking-Panel über der Antwort.
  reasoning?: string;
  // Transient (not persisted): Zahl der Anfragen VOR dieser in der Backend-
  // Warteschlange (Ollama hat einen Slot, Fragen laufen FIFO). Gesetzt auf
  // dem Assistant-Platzhalter, solange der Job wartet — rendert die
  // "Wartet …"-Zeile statt der Denk-Punkte; verschwindet mit dem started-Event.
  queuedAhead?: number;
  // Transient companions to queuedAhead (mockup-model-flow §07): the local
  // model that will answer this waiting question (only local jobs queue) —
  // renders the neutral chip on the queued note — and the chat + question
  // (max 120 chars) the queue is answering RIGHT NOW — turns the waiting
  // text into a jump link when that is another chat.
  queuedModel?: string;
  queuedCurrent?: { chatId: string; question: string };
  // Visible auto-retry after a cloud provider 429 (ADR-0008): the backend
  // waits out Retry-After and tries again — meanwhile the UI shows the
  // countdown line instead of the thinking dots. Disappears with the next
  // token/reasoning chunk.
  // scope/model (mockup-quota-states §10, variant C): WHICH minute limit
  // bit — tokens or requests — and on which model; optional for older events.
  rateLimit?: { retryInSeconds: number; attempt: number; scope?: 'requests' | 'tokens'; model?: string };
  // Transient (not persisted): the provider's own servers are saturated (503
  // "high demand") and the backend is retrying the SAME model
  // (design/mockup-truncated-answer.html §03). Sibling of rateLimit and shown
  // in the same spot — a different cause, not a different kind of waiting.
  overloaded?: { retryInSeconds: number; attempt: number; maxAttempts: number; provider?: string };
  // Transient (not persisted): the active model hit a limit and another
  // provider with a stored key stepped in for THIS answer (the global
  // setting stays unchanged). Renders the quiet failover note that stays
  // with the answer — it explains who the answer comes from.
  failover?: FailoverInfo;
  // Transient (not persisted): this *Failed* marker means the failover ran
  // out of ALL candidate models (ADR-0008). The error row then offers the
  // emergency answer via the local model; a plain error row after reload.
  quotaExhausted?: boolean;
  // Transient companion to quotaExhausted: earliest cooldown expiry (ISO).
  // Far ahead → no retry button, clock line instead; near → retry disabled
  // with a live countdown until it passes (mockup-quota-states §04/§05).
  retryAt?: string;
  // Transient companion to quotaExhausted: WHY the ladder is exhausted —
  // picks the precise card copy and action set (mockup-quota-states v3).
  // daily: upgrade hint, no retry; rate_limit: countdown retry;
  // too_large: switch model / upgrade, never retry (size-dependent).
  quotaReason?: QuotaReason;
  // WHY this *Failed* marker failed (mockup-model-flow §05/§06/§11) — picks
  // the honest card instead of the generic row. Deterministic causes arrive
  // persisted (fail_reason column, mapped by api.getChat); 'network' is
  // detected client-side and never persisted.
  failReason?: FailReason;
  // Companions to failReason where relevant: the provider that failed
  // (no_key/bad_key) and the model that failed (no_vision/local_missing).
  failProvider?: string;
  failModel?: string;
  // Persisted column behind failReason (returned raw by GET /api/chats/:id;
  // api.getChat maps valid values onto failReason).
  fail_reason?: string | null;
  // 1 when the provider ended this answer mid-thought (finish_reason
  // 'length'/'content_filter'/MAX_TOKENS or a missing finish chunk,
  // design/mockup-truncated-answer.html §01). Persisted, because a cut-off
  // answer is indistinguishable from a finished one by its text alone.
  truncated?: number;
  // Persisted at enqueue, still waiting for its answer (mockup-model-flow
  // §10). 1 while queued server-side; a trailing pending question without a
  // live stream renders the "left without an answer" row.
  pending?: number;
}

// Cause of a quotaExhausted error (SSE `quotaReason`, ADR-0008).
// 'billing' (cost tiers 2026-07-30): a zero-limit 429 — the model has no
// free quota at all; it never resets, only billing unlocks it.
export type QuotaReason = 'daily' | 'rate_limit' | 'too_large' | 'billing';

// The three Feedback dialog chips (ADR-0010) — prefixed onto the email
// subject server-side.
export type FeedbackKind = 'bug' | 'idea' | 'question';

// Cause of a *Failed* marker (SSE `failReason` / persisted `fail_reason`,
// mockup-model-flow §05/§11). 'network' is client-side only.
export type FailReason =
  | 'no_key'
  | 'bad_key'
  | 'no_vision'
  | 'network'
  | 'local_missing'
  | 'local_unreachable'
  // The provider's servers were saturated for every retry (503, §03 of
  // mockup-truncated-answer). Unlike a quota, repeating really can work.
  | 'overloaded';
export const FAIL_REASONS: readonly FailReason[] = [
  'no_key',
  'bad_key',
  'no_vision',
  'network',
  'overloaded',
  'local_missing',
  'local_unreachable',
] as const;

// Another model stepping in on a single answer (SSE `failover` event).
// Limits are per model, so from === to (a sibling model of the same
// provider) is the common case; other providers come after. `from`/`to`
// are provider ids, `fromModel`/`model` are model names — unknown ids and
// names render raw.
export interface FailoverInfo {
  from: string;
  fromModel: string;
  to: string;
  model: string;
  reason: 'daily' | 'rate_limit' | 'too_large' | 'cooldown' | 'no_vision' | 'model_unavailable';
}

// Prefix warm-up response (fire-and-forget — the UI no longer inspects it;
// the GPU warning was removed with the ADR-0008 amendment).
export interface WarmupResult {
  warmed: boolean;
}

export interface ChatDetail extends Chat {
  messages: Message[];
  children: Chat[];
}

// Ein Knoten auf dem Vorfahren-Pfad (Wurzel → … → direkter Elternchat) des
// aktiven Branches, wie von GET /chats/:id/ancestors geliefert. summary ist
// die gecachte LLM-Zusammenfassung — genau der Text, den das Modell als
// geerbten Kontext bekommt (null, solange noch keine erzeugt wurde).
//
// Seit 2026-08-01 rendert das Frontend diese Kette NICHT mehr (das Banner
// unter dem Chat-Header ist entfallen); Typ und api.getAncestors bleiben als
// Abbild des weiterhin bestehenden Endpoints stehen.
export interface ChatAncestor {
  id: string;
  title: string;
  parent_word: string | null;
  // The same passage with its math restored, for DISPLAY only (branch header,
  // quote chip, mindmap badge — decision 2026-08-02). parent_word stays the
  // verbatim extraction: it is the model's context and the anchor that
  // branch-word links and highlight matching search for. Null → show
  // parent_word.
  parent_word_display?: string | null;
  summary: string | null;
  // Anzeige-Ableitung der Summary (Kernaussage + Stichpunkte), die das
  // Backend mitliefert. null bei alten Summaries oder wenn der Summarizer
  // kein JSON lieferte.
  display: { gist: string; points: string[] } | null;
}

// Ein an einen Chat tree gebundenes PDF (ADR-0002: max. eins pro Tree).
// Minimaler Syflo-Port ohne Parsing — status ist praktisch immer 'ready'.
export interface Paper {
  id: string;
  title: string | null;
  authors: string[];
  uploaded_at: string;
  status: 'parsing' | 'ready' | 'failed';
  pdf_url: string;
}

// ─── Reference links (design/mockup-paper-reference-links.html) ─────────────

// A CITATION is the mark in the running text ("[13]", "(Vaswani et al.,
// 2017)"); a REFERENCE is the row it points at in the bibliography. The PDF's
// own link annotations give one citation per cited work, so "[38, 24, 15]" is
// three separate click targets.

export interface PaperReference {
  id: string;
  // The PDF's internal anchor name, e.g. "cite.hochreiter1997".
  anchor: string;
  // The printed label, e.g. "[24]" — null in an author-year bibliography.
  label: string | null;
  // The row exactly as typeset. Shown when nothing resolved it.
  rawText: string;
  openalexId: string | null;
  title: string | null;
  authors: string[];
  year: number | null;
  citations: number | null;
  doi: string | null;
  arxivId: string | null;
  // Where the PDF can be downloaded from, or null — this is what decides
  // whether the "Open in Syflo" door appears at all.
  pdfUrl: string | null;
  // Read off the printed row (reference-parse.js). Fills the same card layout
  // when nothing resolved the reference, so an unknown work still shows a
  // title and one meta line instead of a wall of text.
  // Where the RESOLVED record says the work appeared — spelled out, unlike
  // the abbreviation the printed row carries (2026-08-12).
  venue?: string | null;
  parsedTitle: string | null;
  parsedAuthors: string[];
  parsedVenue: string | null;
  parsedYear: number | null;
  // The host the silent web search found the full text on, when the paper
  // itself linked none (design/mockup-citation-card-standard.html § 04). It is
  // the ONE thing the card admits about the search — everything else about it
  // is meant to be invisible.
  fulltextHost?: string | null;
  // Set when the search backend itself failed. Not the same as "no PDF
  // exists": SearXNG being down says nothing about the paper.
  fulltextSearchFailed?: boolean;
  // When it is worth asking again, ISO — set only when the failure was a
  // rate limit, which time alone repairs. The card counts it down.
  fulltextRetryAt?: string | null;
}

export interface PaperCitation {
  referenceId: string | null;
  anchor: string;
  pageNumber: number;
  // PDF user space [x0, y0, x1, y1], origin bottom-left. The view converts it
  // to viewport coordinates at its current zoom.
  rect: [number, number, number, number];
  // The line the mark's glyphs sit on, in the same space. The rect is the
  // PDF's LINK BOX, and how far its bottom edge sits below the text differs
  // per paper — so the underline hangs off this instead (pdf-citations.js).
  // null on geometry stored before it was measured; the view then falls back
  // to the rect and the backend re-measures in the background.
  baseline: number | null;
}

// 'pending' → the background pass is still running, ask again shortly.
// 'ready'   → paint the underlines.
// 'none'    → this PDF carries no citation links and never will (a Word
//             export or a scan). Nothing to show, nothing to announce.
export type ReferencesStatus = 'pending' | 'ready' | 'none';

export interface PaperCitations {
  status: ReferencesStatus;
  references: PaperReference[];
  citations: PaperCitation[];
}

// ─── Highlights (Syflo-Port, Slices 04–06) ──────────────────────────────────

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'orange';
export const HIGHLIGHT_COLORS: readonly HighlightColor[] = [
  'yellow',
  'green',
  'blue',
  'pink',
  'orange',
] as const;

// Fixed product hex values of the five colors (mockup constants). Used where
// a color has to be applied as an inline style (e.g. the composer quote bar).
export const HIGHLIGHT_HEX: Record<HighlightColor, string> = {
  yellow: '#FEF08A',
  green: '#BBF7D0',
  blue: '#BFDBFE',
  pink: '#FBCFE8',
  orange: '#FED7AA',
};

// Global per-color labels, as every consumer sees them: one name per color.
export type HighlightLabels = Record<HighlightColor, string>;

// What the SERVER stores: only the names the user typed in the FloatingPopup's
// edit mode. A color the user never renamed is null, and its name then comes
// from strings.ts in the active App language (user request 2026-08-06) — the
// defaults are UI copy, not data, so they must not sit in the database.
// useLabels merges the two into HighlightLabels.
export type HighlightLabelOverrides = Record<HighlightColor, string | null>;

// One rectangle in *unscaled* (zoom=1) page-local coordinates. All four
// values are normalized by the capture zoom and multiplied by the live zoom
// at render time — the fix for Syflo's only-position-normalized zoom bug.
export interface HighlightRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Highlight {
  id: string;
  paperId: string;
  color: HighlightColor;
  text: string;
  pageNumber: number;
  rects: HighlightRect[];
  // Optional anchor context (~30 chars of text either side of the quote).
  // Reserved for future re-anchoring when a PDF's underlying text reflows.
  prefix?: string | null;
  suffix?: string | null;
  quoteHash?: string | null;
  chatId: string | null;
  createdAt: string;
  updatedAt: string;
}

// Payload accepted by POST /api/papers/:id/highlights. Mirrors the backend
// validation; required fields here mean "the request will 400 without them".
export interface CreateHighlightPayload {
  color: HighlightColor;
  text: string;
  pageNumber: number;
  rects: HighlightRect[];
  prefix?: string | null;
  suffix?: string | null;
  quoteHash?: string | null;
  chatId?: string | null;
}

// ─── Chat-Text-Highlights (mockup-chat-highlights-ask-in-chat.html) ─────────
// Gleiche fünf Farben und globale Labels wie PDF-Highlights, aber anderer
// Anker: message_id + Zeichen-Offsets in den gerenderten Klartext der Bubble
// (textContent) — reflow-sicher, keine Geometrie.

/**
 * A colored mark inside a video's TRANSCRIPT
 * (design/mockup-transcript-selection.html, variant A, 2026-08-16). Anchored
 * to the video plus character offsets into its transcript text — and carrying
 * the second of the block it starts in, which is what lets the way back land
 * on the sentence AND the moment.
 */
export interface TranscriptHighlight {
  id: string;
  videoId: string;
  childChatId: string | null;
  startOffset: number;
  endOffset: number;
  text: string;
  startSeconds: number | null;
  /** Which text the offsets point into (chapters became colorable 2026-08-16). */
  source?: 'transcript' | 'chapter';
  color: HighlightColor;
  createdAt: string;
  updatedAt: string;
}

export interface MessageHighlight {
  id: string;
  messageId: string;
  chatId: string;
  // The chat branched FROM this highlight (mirrors Highlight.chatId on the
  // PDF side) — distinct from `chatId` above, which is the chat the
  // highlighted message already lives in.
  childChatId: string | null;
  startOffset: number;
  endOffset: number;
  text: string;
  color: HighlightColor;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMessageHighlightPayload {
  messageId: string;
  color: HighlightColor;
  text: string;
  startOffset: number;
  endOffset: number;
  childChatId?: string;
}

// ─── Baum-weite Highlight-Übersicht (mockup-highlights-overview.html) ───────
// Vereinte Sicht für den Highlights-Drawer: PDF- und Chat-Highlights des
// ganzen Chat-Baums, vom Backend bereits in Dokumentreihenfolge geliefert
// (PDF nach Seite, dann Chats in Baum-Reihenfolge).

export interface TreePdfHighlight {
  kind: 'pdf';
  id: string;
  color: HighlightColor;
  text: string;
  paperId: string;
  pageNumber: number;
  rects: HighlightRect[];
  chatId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TreeChatHighlight {
  kind: 'chat';
  id: string;
  color: HighlightColor;
  text: string;
  chatId: string;
  chatTitle: string;
  childChatId: string | null;
  messageId: string;
  startOffset: number;
  endOffset: number;
  createdAt: string;
  updatedAt: string;
}

// A mark in the tree's VIDEO — its transcript or its chapters. The third kind
// in the drawer since 2026-08-16 (user report: "die pinken stehen nicht in
// Highlights"). `startSeconds` is why the jump can land on the moment too.
export interface TreeVideoHighlight {
  kind: 'transcript' | 'chapter';
  id: string;
  color: HighlightColor;
  text: string;
  videoId: string;
  startOffset: number;
  endOffset: number;
  startSeconds: number | null;
  childChatId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type TreeHighlight = TreePdfHighlight | TreeChatHighlight | TreeVideoHighlight;

// Eine Auswahl in einer Chat-Nachricht (vor dem Speichern) — von
// MessageBubble beim Rechtsklick erfasst, von App an Popup/Composer gereicht.
export interface ChatSelection {
  messageId: string;
  chatId: string;
  text: string;
  startOffset: number;
  endOffset: number;
}

// Zitat-Block im Composer ("Ask in chat"). color null = keine Farbe gewählt
// (neutraler grauer Balken laut Mockup).
export interface ComposerQuote {
  text: string;
  sourceLabel: string;
  color: HighlightColor | null;
  // The highlight this quote was taken from — travels with the message so
  // the sent quote stays clickable (mockup-quote-jump-to-source.html).
  // Null when no highlight exists for the selection (PDF selection without
  // a color pick).
  highlightId: string | null;
}

// Ein Ziel für `/branch` (design/mockup-branch-command.html §02, Variante C):
// ein Chat des aktuellen Baums, unter dem der getippte Zweig entstehen kann.
// `depth` ist nur die Einrückung im Picker — die Wurzel steht auf 0.
export interface BranchTarget {
  id: string;
  title: string;
  depth: number;
}

// Eine Nebenfrage (`/btw`, design/mockup-btw-composer-fold.html). Lebt NUR im
// Speicher, pro Chat höchstens eine — sie erreicht die Datenbank nie, deshalb
// hat sie auch keine id. `model` wird nur gesetzt, wenn NICHT das Modell des
// Chats geantwortet hat (Kontingent erschöpft → Leiter), und ist genau dann
// die eine graue Zeile unter der Antwort.
export interface Aside {
  question: string;
  answer: string;
  streaming: boolean;
  model?: { was: string; answered: string; fromProvider?: string; toProvider?: string } | null;
  error?: string | null;
  // Benannte Fehlerlage, wenn das Backend eine kennt. 'timeout' = niemand hat
  // im Zeitbudget geantwortet; das Panel sagt dann seinen eigenen Satz statt
  // der SDK-Meldung (Nutzer-Report 2026-08-20).
  errorReason?: 'timeout' | null;
  // Die Antwort blieb unfertig: das Modell brach ab, und auch die Leiter
  // konnte sie nicht zu Ende schreiben (Nutzer-Report 2026-08-20). Das Panel
  // sagt es mit demselben Satz wie der Chat, statt ein Bruchstück als fertige
  // Antwort auszugeben.
  truncated?: boolean;
}

// Ein Treffer der Paper-Suche (GET /api/papers/search) — gemergte Form aus
// OpenAlex und arXiv (Slice 07). pdf_candidates ist die komplette
// Mirror-Kette für den Import-Fallback, wenn der Publisher die primäre
// URL blockt.
export interface SearchResult {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  citations: number;
  open_access_pdf_url: string | null;
  abstract: string | null;
  doi?: string | null;
  pdf_candidates?: string[];
  arxiv_id?: string;
}

export interface PaperSearchResponse {
  results: SearchResult[];
  rate_limited: boolean;
  retry_after_seconds?: number;
}

// ─── YouTube transcript (ADR-0005) ──────────────────────────────────────────

// Ein an einen Chat tree gebundenes YouTube transcript — die zweite
// Quellenart neben dem Paper (eine Quelle pro Baum). transcript (mit groben
// Minutenmarken) liefert nur GET /api/youtube/for-chat mit.
export interface Video {
  id: string;
  youtube_id: string;
  title: string;
  channel: string;
  duration_seconds: number | null;
  language: string | null;
  url: string;
  transcript?: string;
}

// Ein Treffer der Video-Suche (GET /api/youtube/search, lokale SearXNG-
// YouTube-Engine). duration kommt vorformatiert ("59:47") oder fehlt.
// published ist YouTubes relative Datumsangabe ("9 months ago"), per
// InnerTube beigemischt — fehlt, wenn die Anreicherung fehlschlägt.
export interface VideoSearchResult {
  youtube_id: string;
  title: string;
  channel: string;
  duration: string | null;
  published: string | null;
  thumbnail_url: string | null;
  url: string;
}

export interface WordPopup {
  word: string;
  context: string;
  x: number;
  y: number;
}

// ADR-0008: the chat provider set grows from {ollama, openai} to five —
// every cloud provider runs under the user's OWN key (BYO key).
export type LLMProvider = 'ollama' | 'gemini' | 'groq' | 'openai' | 'anthropic';
export type CloudProvider = Exclude<LLMProvider, 'ollama'>;
// Display order of the cloud providers (settings cards, registry access).
export const CLOUD_PROVIDERS: readonly CloudProvider[] = [
  'gemini',
  'groq',
  'openai',
  'anthropic',
] as const;

// Settings as returned by the backend. The API keys themselves are never
// sent to the frontend — only one boolean per provider saying whether one
// is stored.
export interface Settings {
  llm_provider: LLMProvider;
  ollama_model: string;
  // Per cloud provider: chosen model + whether a key is stored.
  gemini_model: string;
  groq_model: string;
  openai_model: string;
  anthropic_model: string;
  gemini_api_key_set: boolean;
  groq_api_key_set: boolean;
  openai_api_key_set: boolean;
  anthropic_api_key_set: boolean;
  // Custom instructions (CONTEXT.md): Nutzer-Freitext für jeden Chat-System-
  // Prompt; abschaltbar, ohne dass der Text verloren geht. Max. 2000 Zeichen.
  custom_instructions: string;
  custom_instructions_enabled: boolean;
}

// ─── Model registry (ADR-0008) ───────────────────────────────────────────────
// Curated model shortlists + capabilities/prices per provider. Served by the
// backend (GET /api/settings/registry), which delivers a remote JSON with a
// bundled fallback — visible through the asOf date.

export interface RegistryModel {
  name: string;
  label: string;
  // Text-only models (vision: false) are selectable but labeled — the
  // backend rejects image attachments with a hint (never dropped silently).
  vision: boolean;
  canThink: boolean;
  contextWindowTokens: number;
  // Budget cap: protects free-tier quotas despite huge context windows.
  budgetCapTokens: number;
  free: boolean;
  pricing: { inputPerMTok: number; outputPerMTok: number } | null;
  freeQuota?: {
    requestsPerMinute?: number;
    requestsPerDay?: number;
    tokensPerDay?: number;
  };
}

export interface RegistryProvider {
  label?: string;
  kind: 'cloud' | 'local';
  baseURL?: string | null;
  // Where the user creates their key — the guide CTAs link here.
  keyUrl?: string;
  // Where the user upgrades to a paid plan — the quota card's
  // "Limit erhöhen" button links here (mockup-quota-states v3).
  billingUrl?: string | null;
  free?: boolean;
  defaultModel?: string;
  models: RegistryModel[];
}

export interface Registry {
  asOf: string;
  providers: Record<LLMProvider, RegistryProvider>;
}

// ─── Usage/cost summary (ADR-0008) ───────────────────────────────────────────
// Local token log × price table — costs are an ESTIMATE and labeled as such
// in the UI; free tiers show a quota counter instead.

export interface UsageProviderSummary {
  requests: number;
  requestsToday: number;
  promptTokens: number;
  completionTokens: number;
  estimatedUsd: number;
}

export interface UsageSummary {
  month: string;
  pricesAsOf: string;
  providers: Partial<Record<LLMProvider, UsageProviderSummary>>;
  // Per-model request counters since UTC midnight (cost tiers 2026-07-30),
  // keyed 'provider/model' — feeds the quota meters in picker and settings.
  modelsToday: Record<string, number>;
}

// Ein lokal installiertes Ollama-Modell, wie es der (vision-gefilterte)
// Backend-Endpoint liefert. `canThink` steuert die Thinking-Zeile im Picker.
export interface OllamaModelInfo {
  name: string;
  size?: number;
  parameter_size?: string;
  canThink?: boolean;
}

// Settings updates — all fields optional (partial update).
// `<provider>_api_key` is the plaintext key the user types; the backend
// validates it (400 on an invalid key), an empty string clears it.
export interface SettingsUpdate {
  llm_provider?: LLMProvider;
  ollama_model?: string;
  gemini_model?: string;
  groq_model?: string;
  openai_model?: string;
  anthropic_model?: string;
  gemini_api_key?: string;
  groq_api_key?: string;
  openai_api_key?: string;
  anthropic_api_key?: string;
  custom_instructions?: string;
  custom_instructions_enabled?: boolean;
}

// ─── Vision gate at attach time (mockup-onboarding-flow §04, V1+V2) ─────────
//
// The image check moved from send time to ATTACH time (decision 2026-08-15):
// the user learns before typing that the active model cannot read the image,
// so nothing is lost. App.tsx computes this from the registry and hands it to
// the composer; the composer only renders.

export interface VisionSwitchTarget {
  provider: LLMProvider;
  model: string;
  label: string;
}

// One row of "these could read images" — V2, when nothing configured can.
export interface VisionSetupOption {
  kind: 'cloud' | 'local';
  provider: LLMProvider;
  model: string;
  label: string;
  // Cloud rows carry their free daily quota, local rows their download size.
  requestsPerDay?: number;
  size?: string;
}

export interface VisionGate {
  // false → the ACTIVE model is text-only and an image is attached.
  activeReadsImages: boolean;
  // Label of the ACTIVE model, for the warning chip. Lives here rather than
  // as a separate prop so it can never disagree with activeReadsImages.
  activeLabel: string;
  // V1: a configured model that reads images. null → V2 applies.
  switchTarget: VisionSwitchTarget | null;
  // V2: vision models the user could set up (empty when switchTarget exists).
  setupOptions: VisionSetupOption[];
}

// ─── Free provider still to set up (mockup-onboarding-flow §07, G2+G3) ──────
//
// A cloud provider with a free tier and NO key yet. G3 lists these in the
// picker's "to set up" group; G2 offers the first one on the daily-limit card.

export interface FreeProviderOffer {
  provider: LLMProvider;
  label: string;
  // Pre-formatted quota line in the app language, e.g. "300.000 Token am Tag".
  quota: string;
  // Groq's free models are text-only — the offer must say so.
  readsImages: boolean;
}
