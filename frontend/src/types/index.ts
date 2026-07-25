export interface Chat {
  id: string;
  title: string;
  parent_id: string | null;
  parent_word: string | null;
  created_at: string;
  child_count?: number;
  children?: Chat[];
  // Erste Nutzer-Frage, gekürzt — wird in der Mindmap angezeigt, damit man
  // auf einen Blick sieht, worum es im Chat geht.
  preview?: string | null;
  message_count?: number;
  // ID des an den Tree gebundenen PDFs — nur am Root gesetzt (ADR-0002).
  // Rendert den PDF-Tag am Root-Knoten im Chat tree.
  paper_id?: string | null;
  // ID des an den Tree gebundenen YouTube transcript (ADR-0005) — nur am
  // Root gesetzt. Rendert den YT-Tag am Root-Knoten im Chat tree.
  video_id?: string | null;
}

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
  // Prefill-ETA (Sekunden) des Backends — Countdown-Balken im
  // ThinkingIndicator, verschwindet mit dem ersten Token.
  prefillEta?: number;
}

// Antwort des Prefix-Warm-ups. gpu meldet, wie viel des Modells im
// GPU-Speicher liegt — unter 100 % heißt teilweises CPU-Offloading (langsam).
export interface WarmupResult {
  warmed: boolean;
  gpu?: { vramPercent: number };
}

export interface ChatDetail extends Chat {
  messages: Message[];
  children: Chat[];
}

// Ein Knoten auf dem Vorfahren-Pfad (Wurzel → … → direkter Elternchat) des
// aktiven Branches, wie von GET /chats/:id/ancestors geliefert. summary ist
// die gecachte LLM-Zusammenfassung — genau der Text, den das Modell als
// geerbten Kontext bekommt (null, solange noch keine erzeugt wurde).
export interface ChatAncestor {
  id: string;
  title: string;
  parent_word: string | null;
  summary: string | null;
  // Anzeige-Ableitung der Summary fürs Kontext-Banner (Kernaussage +
  // Stichpunkte, mockup-context-banner-variants.html §01). null bei alten
  // Summaries oder wenn der Summarizer kein JSON lieferte → das Banner
  // rendert stattdessen den Summary-Volltext als Markdown.
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

// Global per-color labels. User-renamable via the FloatingPopup's edit mode.
// Stored server-side so they survive reloads.
export type HighlightLabels = Record<HighlightColor, string>;
export const DEFAULT_HIGHLIGHT_LABELS: HighlightLabels = {
  yellow: 'Important',
  green: 'Agree',
  blue: 'Reference',
  pink: 'Question',
  orange: 'Disagree',
};

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

export interface MessageHighlight {
  id: string;
  messageId: string;
  chatId: string;
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
  messageId: string;
  startOffset: number;
  endOffset: number;
  createdAt: string;
  updatedAt: string;
}

export type TreeHighlight = TreePdfHighlight | TreeChatHighlight;

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

export type LLMProvider = 'ollama' | 'openai';

// Settings, wie sie vom Backend zurückkommen. Der API-Key selbst wird
// nie ans Frontend geschickt — nur ein Boolean, ob einer gesetzt ist.
export interface Settings {
  llm_provider: LLMProvider;
  openai_model: string;
  ollama_model: string;
  // 'auto': die Hardware-Empfehlung darf das Modell setzen.
  // 'manual': der Nutzer hat selbst gewählt — Automatik bleibt weg.
  model_source: 'auto' | 'manual';
  openai_api_key_set: boolean;
  // Custom instructions (CONTEXT.md): Nutzer-Freitext für jeden Chat-System-
  // Prompt; abschaltbar, ohne dass der Text verloren geht. Max. 2000 Zeichen.
  custom_instructions: string;
  custom_instructions_enabled: boolean;
}

// Ein lokal installiertes Ollama-Modell, wie es der (vision-gefilterte)
// Backend-Endpoint liefert. `canThink` steuert die Thinking-Zeile im Picker.
export interface OllamaModelInfo {
  name: string;
  size?: number;
  parameter_size?: string;
  canThink?: boolean;
}

// Hardware-Empfehlung des Backends (GET /api/system/recommendation).
export interface SystemRecommendation {
  platform: string;
  totalMemGb: number;
  recommendedModel: string;
}

// Eine Fortschritts-Zeile des Ollama-Downloads (NDJSON-Passthrough).
export interface PullProgress {
  status: string;
  total?: number;
  completed?: number;
}

// Updates an die Settings — alle Felder optional (Partial Update).
// `openai_api_key` ist hier der Klartext-Key, den der User eingibt.
export interface SettingsUpdate {
  llm_provider?: LLMProvider;
  openai_api_key?: string;
  openai_model?: string;
  ollama_model?: string;
  custom_instructions?: string;
  custom_instructions_enabled?: boolean;
}
