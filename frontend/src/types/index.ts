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
  | 'local_unreachable';
export const FAIL_REASONS: readonly FailReason[] = [
  'no_key',
  'bad_key',
  'no_vision',
  'network',
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
