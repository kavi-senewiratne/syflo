/**
 * api/index.ts
 *
 * Central API client for all communication between the React frontend and the
 * Express backend. Each function maps directly to one backend route.
 *
 * The most important function here is sendMessageStream, which replaced the old
 * sendMessage. Instead of waiting for a complete JSON response, it reads the
 * Server-Sent Events stream from the backend and calls onDelta for every text
 * chunk so the UI can update in real time — exactly like ChatGPT's typing effect.
 */

import type { BranchOrigin, Category, Chat, ChatAncestor, ChatDetail, CreateHighlightPayload, CreateMessageHighlightPayload, FailoverInfo, FailReason, FeedbackKind, Highlight, HighlightColor, HighlightLabelOverrides, LocalAttachment, Message, MessageHighlight, OllamaModelInfo, Paper, PaperCitations, PaperReference, PaperSearchResponse, QuotaReason, Registry, Settings, SettingsUpdate, ToolEvent, TranscriptHighlight, TreeHighlight, UsageSummary, Video, VideoSearchResult, WarmupResult } from '../types';
import { FAIL_REASONS } from '../types';
import { getAppLanguage } from '../appLanguage';

const BASE = '/api';

// Fehler beim Anhängen einer Quelle an einen Tree, der schon eine hat —
// ADR-0005 generalisiert ADR-0002: eine Quelle pro Baum (PDF ODER YouTube
// transcript). Trägt die Root-Chat-ID für den Neuer-Tree-Dialog.
export class TreeHasSourceError extends Error {
  rootChatId: string | null;
  constructor(rootChatId: string | null) {
    super('tree-has-source');
    this.name = 'TreeHasSourceError';
    this.rootChatId = rootChatId;
  }
}

// Fehler eines Antwort-Streams, bei dem das Backend die Frage und einen
// '*Failed*'-Marker bereits persistiert hat. Die UI ersetzt damit ihre
// optimistischen Blasen durch die persistierten Nachrichten (Fehlerzeile
// mit Retry-Button), statt sie stumm zu entfernen.
export class StreamFailedError extends Error {
  userMessage?: Message;
  assistantMessage?: Message;
  // Der Failover hat ALLE Kandidaten-Modelle durchprobiert (ADR-0008) — die
  // Fehlerzeile bietet dann den Notfall-Weg übers lokale Modell an.
  quotaExhausted?: boolean;
  // Earliest cooldown expiry (ISO) — gates the retry button: far ahead means
  // no retry at all, near means a disabled countdown (mockup-quota-states).
  retryAt?: string;
  // Why the ladder is exhausted — picks the precise card copy + actions.
  quotaReason?: QuotaReason;
  // Why the generation failed (mockup-model-flow §05) — picks the honest
  // card. failProvider/failModel name the culprit where relevant.
  failReason?: FailReason;
  failProvider?: string;
  failModel?: string;
  constructor(message: string, userMessage?: Message, assistantMessage?: Message, quotaExhausted?: boolean, retryAt?: string, quotaReason?: QuotaReason, fail?: { failReason?: FailReason; failProvider?: string; failModel?: string }) {
    super(message);
    this.name = 'StreamFailedError';
    this.userMessage = userMessage;
    this.assistantMessage = assistantMessage;
    this.quotaExhausted = quotaExhausted;
    this.retryAt = retryAt;
    this.quotaReason = quotaReason;
    this.failReason = fail?.failReason;
    this.failProvider = fail?.failProvider;
    this.failModel = fail?.failModel;
  }
}

// Validate a raw fail-reason code (SSE field or persisted column) — unknown
// codes fall back to the generic row instead of rendering a wrong card.
function asFailReason(raw: unknown): FailReason | undefined {
  return typeof raw === 'string' && (FAIL_REASONS as readonly string[]).includes(raw)
    ? (raw as FailReason)
    : undefined;
}

// Callbacks eines Antwort-Streams (Senden UND Regenerate teilen sich den
// SSE-Leser). onQueued/onStarted spiegeln die Backend-Warteschlange:
// FIFO über alle Chats, weil Ollama nur einen Slot hat.
interface StreamCallbacks {
  onDelta: (delta: string) => void;
  onToolEvent?: (evt: ToolEvent) => void;
  onThinking?: () => void;
  onReasoning?: (delta: string) => void;
  // Der Job wartet: `ahead` Anfragen laufen/warten vor ihm. `info` (queue
  // transparency, mockup-model-flow §07): the local model that will answer
  // this waiting question and the chat+question being answered RIGHT NOW.
  onQueued?: (
    ahead: number,
    info?: { model?: string; current?: { chatId: string; question: string } },
  ) => void;
  // Der Job ist an der Reihe; die User-Nachricht ist jetzt persistiert —
  // die UI ersetzt damit ihre optimistische Frage (echter Zeitstempel).
  onStarted?: (userMessage: Message) => void;
  // Cloud provider 429 (ADR-0008): the backend waits out Retry-After and
  // visibly retries — the UI shows the countdown.
  onRateLimit?: (info: { retryInSeconds: number; attempt: number; scope?: 'requests' | 'tokens'; model?: string }) => void;
  // The provider's servers are saturated (503) and the backend is retrying
  // the SAME model — the UI shows who is busy and which attempt runs.
  onOverloaded?: (info: { retryInSeconds: number; attempt: number; maxAttempts: number; provider?: string }) => void;
  // The active model hit a limit and another provider with a stored key
  // steps in for this answer — the UI shows a quiet note explaining who
  // the answer comes from.
  onFailover?: (info: FailoverInfo) => void;
}

// Liest die SSE-Antwort eines Nachrichten-Endpoints inkrementell und
// verteilt die Events auf die Callbacks. Läuft bis zum done-Event.
async function readMessageStream(
  res: Response,
  cb: StreamCallbacks,
): Promise<{ userMessage: Message; assistantMessage: Message }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    // Decode the binary chunk and append it to a buffer, because a single
    // network packet may contain partial SSE lines.
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');

    // Keep the last (possibly incomplete) line in the buffer for next iteration.
    buffer = lines.pop() || '';

    // Process each complete SSE line.
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = JSON.parse(line.slice(6));
      if (data.error) throw new StreamFailedError(data.error, data.userMessage, data.assistantMessage, data.quotaExhausted === true, typeof data.retryAt === 'string' ? data.retryAt : undefined, ['daily', 'rate_limit', 'too_large'].includes(data.quotaReason) ? data.quotaReason as QuotaReason : undefined, {
        failReason: asFailReason(data.failReason),
        failProvider: typeof data.failProvider === 'string' ? data.failProvider : undefined,
        failModel: typeof data.failModel === 'string' ? data.failModel : undefined,
      });

      // Warteschlangen-Position — der Job wartet noch auf den Ollama-Slot.
      if (data.queued && cb.onQueued) {
        cb.onQueued(data.queued.ahead, {
          model: typeof data.queued.model === 'string' ? data.queued.model : undefined,
          current:
            data.queued.current &&
            typeof data.queued.current.chatId === 'string' &&
            typeof data.queued.current.question === 'string'
              ? { chatId: data.queued.current.chatId, question: data.queued.current.question }
              : undefined,
        });
      }

      // Der Job läuft jetzt; die User-Nachricht ist persistiert.
      if (data.started && cb.onStarted) cb.onStarted(data.userMessage);

      // Cloud provider rate limit — visible auto-retry (ADR-0008).
      if (data.rateLimit && cb.onRateLimit) cb.onRateLimit(data.rateLimit);

      // The provider is overloaded — visible retry on the same model.
      if (data.overloaded && cb.onOverloaded) cb.onOverloaded(data.overloaded);

      // Another provider steps in for this answer (limit on the active one).
      if (data.failover && cb.onFailover) cb.onFailover(data.failover as FailoverInfo);

      // A text delta — pass it to the callback so the UI can append it.
      if (data.delta) cb.onDelta(data.delta);

      // Das Modell hat seine Denk-Phase begonnen (nur bei think=true) —
      // die UI zeigt dafür die Tipp-/Zitat-Rotation unter den Punkten.
      if (data.thinking && cb.onThinking) cb.onThinking();

      // Ein Gedanken-Chunk der laufenden Denk-Phase — streamt live ins
      // einklappbare Thinking-Panel.
      if (data.reasoning && cb.onReasoning) cb.onReasoning(data.reasoning);

      // A tool event — the model called a tool (e.g. web_search). The UI
      // uses this for the "Searching…" indicator and the sources list.
      if (data.tool && cb.onToolEvent) cb.onToolEvent(data.tool as ToolEvent);

      // The final event — streaming is complete, return the persisted messages.
      if (data.done) return { userMessage: data.userMessage, assistantMessage: data.assistantMessage };
    }
  }

  throw new Error('Stream ended without completion');
}

export const api = {
  // Fetches the full chat tree (all chats with their children nested).
  // Used to populate the sidebar.
  async getTree(): Promise<Chat[]> {
    const res = await fetch(`${BASE}/chats/tree`);
    if (!res.ok) throw new Error('Failed to fetch tree');
    return res.json();
  },

  // Fetches a single chat including all its messages and direct child chats.
  // Persisted fail_reason columns (mockup-model-flow §06) are mapped onto
  // failReason so the deterministic cards survive reloads.
  async getChat(id: string): Promise<ChatDetail> {
    const res = await fetch(`${BASE}/chats/${id}`);
    if (!res.ok) throw new Error('Failed to fetch chat');
    const chat: ChatDetail = await res.json();
    return {
      ...chat,
      messages: (chat.messages ?? []).map((m) => {
        const persisted = asFailReason(m.fail_reason);
        const withFail = persisted ? { ...m, failReason: persisted } : m;
        // The search wish outlives the stream it arrived in (columns added
        // 2026-08-25): without this the card only existed until the next chat
        // switch, and a stale answer looked current again.
        return m.search_wish_error
          ? {
              ...withFail,
              searchWish: { query: m.search_wish_query ?? '', error: m.search_wish_error },
            }
          : withFail;
      }),
    };
  },

  // Fetches the ancestor path (root → … → direct parent) of a branch chat,
  // including the cached summaries the LLM inherits. Empty for root chats.
  async getAncestors(id: string): Promise<ChatAncestor[]> {
    const res = await fetch(`${BASE}/chats/${id}/ancestors`);
    if (!res.ok) throw new Error('Failed to fetch ancestors');
    return res.json();
  },

  // Snapshot of models currently in quota cooldown (mockup-quota-states
  // §06) — the model picker dims them and shows a reset badge. `until` is
  // an ISO timestamp; only future expiries are reported.
  async getQuotaCooldowns(): Promise<{ provider: string; model: string; until: string; kind?: string }[]> {
    const res = await fetch(`${BASE}/quota-cooldowns`);
    if (!res.ok) throw new Error('Failed to fetch quota cooldowns');
    const data = await res.json();
    return data.cooldowns ?? [];
  },

  // Creates a new chat. parent_id and parent_word are set when branching from
  // a specific word in an existing conversation. parent_context carries the
  // text-layer lines around a PDF selection (only for PDF-selection branches):
  // PDF extraction flattens math notation, so the branch prompt needs the
  // surroundings to make the selected term interpretable.
  async createChat(
    title: string, parent_id?: string, parent_word?: string, parent_context?: string,
    parent_word_display?: string,
    // branch_origin marks the two commands that branch WITHOUT a passage
    // (mockup-branch-trace.html): the server then remembers where in the
    // parent transcript the fork happened, and the parent draws a line there.
    // Selection branches leave it unset — their coloured passage is the trace.
    branch_origin?: BranchOrigin,
  ): Promise<Chat> {
    const res = await fetch(`${BASE}/chats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title, parent_id, parent_word, parent_context, parent_word_display, branch_origin,
      }),
    });
    if (!res.ok) throw new Error('Failed to create chat');
    return res.json();
  },

  // Titles a selected passage BEFORE the branch chat exists, so the tree
  // never shows the raw passage first. Crucial for formulas marked in a PDF:
  // the text layer flattens them, and only the model writes them back as
  // LaTeX (user requirement 2026-08-02). Returns null whenever the title
  // isn't available (no key, Ollama, quota, network) — the caller then falls
  // back to the passage itself.
  async passageTitle(
    passage: string, signal?: AbortSignal,
  ): Promise<{ title: string | null; quote: string | null }> {
    const empty = { title: null, quote: null };
    const res = await fetch(`${BASE}/chats/passage-title`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passage }),
      signal,
    });
    if (!res.ok) return empty;
    const data = await res.json();
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
    return { title: str(data.title), quote: str(data.quote) };
  },

  // /btw — die Nebenfrage (design/mockup-btw-composer-fold.html). Streamt wie
  // eine Antwort, persistiert aber nichts: das Ergebnis lebt nur im Speicher
  // des Browsers. `model` ist NUR gesetzt, wenn nicht das Modell des Chats
  // geantwortet hat — genau dann zeigt das Panel seine eine graue Zeile.
  async askAside(
    chatId: string,
    question: string,
    onDelta: (delta: string) => void,
    signal?: AbortSignal,
    // Der Server nimmt zurück, was ein mitten in der Antwort gestorbenes
    // Modell schon geschrieben hat — sonst schreibt das nächste seine Antwort
    // unter eine abgerissene (Nutzer-Report 2026-08-19).
    onReset?: () => void,
  ): Promise<{
    answer: string;
    model: { was: string; answered: string; fromProvider?: string; toProvider?: string } | null;
    // Niemand konnte die Antwort zu Ende schreiben — das Panel sagt es dann.
    truncated: boolean;
  }> {
    const res = await fetch(`${BASE}/btw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, question }),
      signal,
    });
    if (!res.ok) throw new Error('Side question failed');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';
    let model: { was: string; answered: string; fromProvider?: string; toProvider?: string } | null = null;
    let truncated = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = JSON.parse(line.slice(6));
        if (data.error) {
          // Die benannte Lage reist am Fehler mit — das Panel wählt danach
          // seinen eigenen Satz (Nutzer-Report 2026-08-20).
          throw Object.assign(new Error(data.error), { reason: data.reason });
        }
        if (data.reset) {
          answer = '';
          onReset?.();
        }
        if (data.delta) {
          answer += data.delta;
          onDelta(data.delta);
        }
        if (data.done && data.truncated) truncated = true;
        if (data.done && typeof data.switchedFrom === 'string') {
          model = {
            was: data.switchedFrom,
            answered: data.model,
            fromProvider: data.switchedFromProvider,
            toProvider: data.provider,
          };
        }
      }
    }
    return { answer, model, truncated };
  },

  // Macht eine Nebenfrage dauerhaft (mockup-btw-composer-fold.html §03).
  // MIT question: "Im Chat behalten" — Frage und Antwort landen als zwei
  // gewöhnliche Nachrichten am Ende des Threads. OHNE question: der frisch
  // erzeugte Zweig bekommt nur die Antwort, denn die Frage steht dort schon
  // als Zitat in der Kopfzeile.
  async keepAside(chatId: string, answer: string, question?: string): Promise<Message[]> {
    const res = await fetch(`${BASE}/btw/keep`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, answer, question }),
    });
    if (!res.ok) throw new Error('Could not keep the side question');
    const data = await res.json();
    return data.messages as Message[];
  },

  // Sends a user message (mit optionalen Datei-Anhängen) und streamt die AI-Antwort.
  // onDelta wird mit jedem Text-Chunk aufgerufen, der vom Server ankommt.
  // Wenn Anhänge dabei sind, wird multipart/form-data verwendet — sonst JSON.
  async sendMessageStream(
    chatId: string,
    content: string,
    onDelta: (delta: string) => void,
    attachments: LocalAttachment[] = [],
    // Called whenever the model invokes a tool (e.g. web_search) during the
    // streaming response. The UI uses this to show "Searching the web for X…"
    // and then a sources list once results come back.
    onToolEvent?: (evt: ToolEvent) => void,
    // think: lässt ein Denk-Modell seine Gedankenkette laufen (Standard aus).
    // onThinking: einmaliges Status-Signal, sobald das Modell denkt.
    // onReasoning: jeder Gedanken-Chunk live — fürs einklappbare
    // Thinking-Panel über der Antwort. signal: bricht den Stream ab
    // (Stop-Button). onQueued/onStarted: Warteschlangen-Status des Backends
    // (FIFO — Ollama hat einen Slot).
    // quoteHighlightId: Anker eines "Ask in chat"-Zitats — die persistierte
    // Nachricht merkt sich damit, aus welchem Highlight das Zitat stammt, und
    // bleibt in der Bubble anklickbar (mockup-quote-jump-to-source.html).
    // overview: diese Frage ist die Video overview (structurePrompt). Das
    // Backend schaltet dafür den Retrieval-Modus ab — die Gliederung braucht
    // das ganze Transkript der Reihe nach, nicht die zur Frage passenden
    // Ausschnitte (Nutzerentscheid 2026-08-20).
    // searchNudge: Save-&-retry der Schlüssel-Karte — die Query, die das
    // Modell nachschlagen wollte. Das Backend hängt daraus eine Anweisung an
    // die neu gesendete Frage ("call the web_search tool"), sonst kopiert das
    // Modell seine eigene Absage aus der Historie statt zu suchen.
    opts?: { think?: boolean; overview?: boolean; quoteHighlightId?: string | null; searchNudge?: string | null; onThinking?: () => void; onReasoning?: (delta: string) => void; onQueued?: (ahead: number, info?: { model?: string; current?: { chatId: string; question: string } }) => void; onStarted?: (userMessage: Message) => void; onRateLimit?: (info: { retryInSeconds: number; attempt: number }) => void; onOverloaded?: (info: { retryInSeconds: number; attempt: number; maxAttempts: number; provider?: string }) => void; onFailover?: (info: FailoverInfo) => void; signal?: AbortSignal },
  ): Promise<{ userMessage: Message; assistantMessage: Message }> {
    let res: Response;
    if (attachments.length > 0) {
      const fd = new FormData();
      fd.append('content', content);
      fd.append('aliases', JSON.stringify(attachments.map(a => a.alias)));
      if (opts?.think !== undefined) fd.append('think', String(opts.think));
      if (opts?.overview) fd.append('overview', 'true');
      if (opts?.quoteHighlightId) fd.append('quoteHighlightId', opts.quoteHighlightId);
      attachments.forEach(a => fd.append('files', a.file, a.file.name));
      res = await fetch(`${BASE}/chats/${chatId}/messages`, {
        method: 'POST',
        body: fd, // KEIN explicit Content-Type — Browser setzt es mit Boundary
        signal: opts?.signal,
      });
    } else {
      res = await fetch(`${BASE}/chats/${chatId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, think: opts?.think, overview: opts?.overview ?? false, quoteHighlightId: opts?.quoteHighlightId ?? null, searchNudge: opts?.searchNudge ?? null }),
        signal: opts?.signal,
      });
    }

    if (!res.ok) throw new Error('Failed to send message');

    // Read the SSE response body incrementally (shared reader).
    return readMessageStream(res, {
      onDelta,
      onToolEvent,
      onThinking: opts?.onThinking,
      onReasoning: opts?.onReasoning,
      onQueued: opts?.onQueued,
      onStarted: opts?.onStarted,
      onRateLimit: opts?.onRateLimit,
      onOverloaded: opts?.onOverloaded,
      onFailover: opts?.onFailover,
    });
  },

  // Retry-Button der Fehlerzeile: erzeugt die Antwort neu, ohne die Frage
  // zu duplizieren (das Backend entfernt dabei den persistierten
  // '*Failed*'-Marker). `messageId` ist die id des geklickten Markers —
  // der Retry beantwortet damit SEINE Frage und die neue Antwort übernimmt
  // die Position des Markers (anchored retry); ohne messageId gilt das
  // alte Verhalten (letzte Frage). Gleiches SSE-Protokoll wie
  // sendMessageStream — inklusive Warteschlange.
  async regenerateMessage(
    chatId: string,
    messageId: string | undefined,
    onDelta: (delta: string) => void,
    onToolEvent?: (evt: ToolEvent) => void,
    // provider: 'ollama' = Notfall-Fallback — DIESE eine Antwort läuft übers
    // lokale Modell, die Einstellungen bleiben unberührt (ADR-0008).
    opts?: { think?: boolean; provider?: 'ollama'; onThinking?: () => void; onReasoning?: (delta: string) => void; onQueued?: (ahead: number, info?: { model?: string; current?: { chatId: string; question: string } }) => void; onStarted?: (userMessage: Message) => void; onRateLimit?: (info: { retryInSeconds: number; attempt: number }) => void; onOverloaded?: (info: { retryInSeconds: number; attempt: number; maxAttempts: number; provider?: string }) => void; onFailover?: (info: FailoverInfo) => void; signal?: AbortSignal },
  ): Promise<{ userMessage: Message; assistantMessage: Message }> {
    const res = await fetch(`${BASE}/chats/${chatId}/messages/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        think: opts?.think,
        ...(messageId ? { messageId } : {}),
        ...(opts?.provider ? { provider: opts.provider } : {}),
      }),
      signal: opts?.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to regenerate message');
    }
    return readMessageStream(res, {
      onDelta,
      onToolEvent,
      onThinking: opts?.onThinking,
      onReasoning: opts?.onReasoning,
      onQueued: opts?.onQueued,
      onStarted: opts?.onStarted,
      onRateLimit: opts?.onRateLimit,
      onOverloaded: opts?.onOverloaded,
      onFailover: opts?.onFailover,
    });
  },

  // Continue an answer the provider cut short (mockup-truncated-answer §01).
  // Unlike regenerate, the text stays and the continuation GROWS the same
  // message — the deltas arriving here are appended, not a fresh answer.
  async continueMessage(
    chatId: string,
    messageId: string,
    onDelta: (delta: string) => void,
    // seamRetry: the immediate second attempt after the server discarded a
    // round whose seam it could not verify (mockup-truncated-answer §04) —
    // that round is appended even with a dubious seam, flagged seam_suspect.
    opts?: { think?: boolean; seamRetry?: boolean; onThinking?: () => void; onReasoning?: (delta: string) => void; onQueued?: (ahead: number, info?: { model?: string; current?: { chatId: string; question: string } }) => void; onRateLimit?: (info: { retryInSeconds: number; attempt: number }) => void; onOverloaded?: (info: { retryInSeconds: number; attempt: number; maxAttempts: number; provider?: string }) => void; onFailover?: (info: FailoverInfo) => void; signal?: AbortSignal },
  ): Promise<{ userMessage: Message; assistantMessage: Message }> {
    const res = await fetch(`${BASE}/chats/${chatId}/messages/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId, think: opts?.think, ...(opts?.seamRetry ? { seamRetry: true } : {}) }),
      signal: opts?.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.error || 'Failed to continue message');
      // 409 means the server looked and found nothing to write on: the answer
      // is WHOLE. Marked so the caller can tell it apart from a round that
      // really failed — those two deserve opposite reactions, and treating
      // this one as a failure put the "answer breaks off mid-sentence" card
      // under a finished 27-chapter overview (measured 2026-09-03).
      if (res.status === 409) (err as Error & { alreadyComplete?: boolean }).alreadyComplete = true;
      throw err;
    }
    return readMessageStream(res, {
      onDelta,
      onThinking: opts?.onThinking,
      onReasoning: opts?.onReasoning,
      onQueued: opts?.onQueued,
      onRateLimit: opts?.onRateLimit,
      onOverloaded: opts?.onOverloaded,
      onFailover: opts?.onFailover,
    });
  },

  // Explicit cancel of a QUEUED question (mockup-model-flow §10): deletes
  // the pending row persisted at enqueue — "counts as never asked". Only
  // pending rows are deletable; the backend 409s for everything else.
  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    const res = await fetch(`${BASE}/chats/${chatId}/messages/${messageId}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to delete message');
    }
  },

  // Lädt ein PDF hoch und bindet es an den Chat tree von chatId (ans Root).
  // Wirft TreeHasSourceError, wenn der Tree schon eine Quelle hat (ADR-0005).
  async uploadPaper(chatId: string, file: File): Promise<Paper> {
    const fd = new FormData();
    fd.append('chat_id', chatId);
    fd.append('pdf', file, file.name);
    const res = await fetch(`${BASE}/papers`, { method: 'POST', body: fd });
    if (res.status === 409) {
      const body = await res.json().catch(() => ({}));
      throw new TreeHasSourceError(body.root_chat_id ?? null);
    }
    if (!res.ok) throw new Error('Failed to upload PDF');
    return res.json();
  },

  // Das an den Tree dieses Chats gebundene Paper (oder null) — stellt die
  // Drei-Spalten-Ansicht nach einem Reload wieder her.
  async getTreePaper(chatId: string): Promise<Paper | null> {
    const res = await fetch(`${BASE}/papers/for-chat/${chatId}`);
    if (!res.ok) throw new Error('Failed to fetch tree paper');
    const body = await res.json();
    return body.paper ?? null;
  },

  // Reference links: die Bibliografie eines Papers plus je ein Klick-Rechteck
  // pro Zitatmarke. Läuft im Hintergrund nach dem Import — bei `pending`
  // fragt die Ansicht kurz darauf erneut, bei `none` nie wieder.
  async getPaperCitations(paperId: string): Promise<PaperCitations> {
    const res = await fetch(`${BASE}/papers/${paperId}/citations`);
    if (!res.ok) throw new Error('Failed to fetch citations');
    const body = await res.json();
    return {
      status: body.status,
      references: body.references ?? [],
      // Das Backend liefert `page`; im Frontend heißt es überall pageNumber
      // (wie bei Highlight).
      citations: (body.citations ?? []).map((c: { referenceId: string | null; anchor: string; page: number; rect: [number, number, number, number]; baseline?: number | null }) => ({
        referenceId: c.referenceId,
        anchor: c.anchor,
        pageNumber: c.page,
        rect: c.rect,
        baseline: c.baseline ?? null,
      })),
    };
  },

  // Eine einzelne Referenz nachschlagen — genau dann, wenn der Leser ihre
  // Karte öffnet. Beim Import für die ganze Bibliografie zu suchen kostete
  // 40–93 Anfragen pro Paper und brachte OpenAlex dazu, uns minutenlang zu
  // drosseln (gemessen 2026-08-09).
  async resolveReference(paperId: string, referenceId: string): Promise<PaperReference | null> {
    const res = await fetch(`${BASE}/papers/${paperId}/references/${referenceId}/resolve`, {
      method: 'POST',
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body.reference ?? null;
  },

  // Ask the web for a full text this paper never linked — the silent search
  // (design/mockup-citation-card-standard.html § 04). Answers with the same
  // reference shape, `pdfUrl` filled in when something trustworthy was found.
  async ensureFulltext(paperId: string, referenceId: string): Promise<PaperReference | null> {
    const res = await fetch(`${BASE}/papers/${paperId}/references/${referenceId}/fulltext`, {
      method: 'POST',
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body.reference ?? null;
  },

  // Paper-Suche (Slice 07): OpenAlex + arXiv gemergt, SS-Fallback im Backend.
  async searchPapers(q: string): Promise<PaperSearchResponse> {
    const res = await fetch(`${BASE}/papers/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error('Search failed');
    return res.json();
  },

  // Importiert ein Paper per URL und bindet es an den Tree von chatId.
  // Wirft TreeHasSourceError bei 409 (ADR-0002/0005) — gleiche Semantik wie uploadPaper.
  async importPaperFromUrl(
    chatId: string,
    url: string,
    title?: string,
    fallbackUrls?: string[],
  ): Promise<Paper> {
    const res = await fetch(`${BASE}/papers/from-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, title, fallback_urls: fallbackUrls, chat_id: chatId }),
    });
    if (res.status === 409) {
      const body = await res.json().catch(() => ({}));
      throw new TreeHasSourceError(body.root_chat_id ?? null);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      // `message` ist die menschenlesbare Meldung des Backends; `error` ist
      // je nach Fehlerfall Maschinen-Code oder bereits ausformulierter Text.
      throw new Error(body.message || body.error || 'Failed to import paper');
    }
    return res.json();
  },

  // ─── YouTube transcript (ADR-0005) ─────────────────────────────────────────

  // Video-Suche fürs "YouTube Transcript"-Modal (lokale SearXNG-Instanz).
  async searchYouTube(q: string): Promise<VideoSearchResult[]> {
    const res = await fetch(`${BASE}/youtube/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Video search failed');
    }
    const body = await res.json();
    return body.results ?? [];
  },

  // Holt das Transkript des Videos und bindet es als Quelle an den Tree von
  // chatId. Wirft TreeHasSourceError bei 409 (eine Quelle pro Baum) und
  // reicht sonst die Backend-Meldung durch (z. B. no-transcript).
  async importYouTubeVideo(chatId: string, youtubeId: string): Promise<Video> {
    const res = await fetch(`${BASE}/youtube/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, youtube_id: youtubeId }),
    });
    if (res.status === 409) {
      const body = await res.json().catch(() => ({}));
      throw new TreeHasSourceError(body.root_chat_id ?? null);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || body.error || 'Failed to import video');
    }
    return res.json();
  },

  // Das an den Tree dieses Chats gebundene Video inkl. Transkript (oder
  // null) — stellt Quellen-Banner und Transkript-Drawer nach Reload wieder her.
  async getTreeVideo(chatId: string): Promise<Video | null> {
    const res = await fetch(`${BASE}/youtube/for-chat/${chatId}`);
    if (!res.ok) throw new Error('Failed to fetch tree video');
    const body = await res.json();
    return body.video ?? null;
  },

  // ─── Highlights + Labels (Syflo-Port, Slices 04–06) ───────────────────────

  async listHighlights(paperId: string): Promise<Highlight[]> {
    const res = await fetch(`${BASE}/papers/${paperId}/highlights`);
    if (!res.ok) throw new Error('Failed to fetch highlights');
    return res.json();
  },

  async createHighlight(paperId: string, payload: CreateHighlightPayload): Promise<Highlight> {
    const res = await fetch(`${BASE}/papers/${paperId}/highlights`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to create highlight');
    }
    return res.json();
  },

  async updateHighlight(
    hid: string,
    patch: { color?: HighlightColor; chatId?: string | null },
  ): Promise<Highlight> {
    const res = await fetch(`${BASE}/highlights/${hid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to update highlight');
    }
    return res.json();
  },

  async deleteHighlight(hid: string): Promise<void> {
    const res = await fetch(`${BASE}/highlights/${hid}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) throw new Error('Failed to delete highlight');
  },

  // ─── Chat-Text-Highlights (message-anchored, offsets statt Rects) ─────────

  // ── Transcript marks (mockup-transcript-selection.html) ────────────────
  // Anchored to the VIDEO, not to a chat: the transcript belongs to the tree's
  // source, so every branch of the tree sees the same marks.
  async listTranscriptHighlights(videoId: string): Promise<TranscriptHighlight[]> {
    const res = await fetch(`${BASE}/videos/${videoId}/transcript-highlights`);
    if (!res.ok) throw new Error('Failed to fetch transcript highlights');
    return res.json();
  },

  async createTranscriptHighlight(
    videoId: string,
    payload: {
      color: HighlightColor;
      text: string;
      startOffset: number;
      endOffset: number;
      startSeconds: number | null;
      // Which text the offsets point into — the raw transcript or the Video
      // overview the chapter list is rendered from.
      source?: 'transcript' | 'chapter';
      childChatId?: string;
    },
  ): Promise<TranscriptHighlight> {
    const res = await fetch(`${BASE}/videos/${videoId}/transcript-highlights`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to create transcript highlight');
    }
    return res.json();
  },

  async updateTranscriptHighlight(
    id: string,
    patch: { color?: HighlightColor; childChatId?: string | null },
  ): Promise<TranscriptHighlight> {
    const res = await fetch(`${BASE}/transcript-highlights/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error('Failed to update transcript highlight');
    return res.json();
  },

  async deleteTranscriptHighlight(id: string): Promise<void> {
    const res = await fetch(`${BASE}/transcript-highlights/${id}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) throw new Error('Failed to delete transcript highlight');
  },

  async listMessageHighlights(chatId: string): Promise<MessageHighlight[]> {
    const res = await fetch(`${BASE}/chats/${chatId}/message-highlights`);
    if (!res.ok) throw new Error('Failed to fetch message highlights');
    return res.json();
  },

  async createMessageHighlight(
    chatId: string,
    payload: CreateMessageHighlightPayload,
  ): Promise<MessageHighlight> {
    const res = await fetch(`${BASE}/chats/${chatId}/message-highlights`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to create message highlight');
    }
    return res.json();
  },

  async updateMessageHighlight(
    mhid: string,
    patch: { color?: HighlightColor; childChatId?: string | null },
  ): Promise<MessageHighlight> {
    const res = await fetch(`${BASE}/message-highlights/${mhid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to update message highlight');
    }
    return res.json();
  },

  async deleteMessageHighlight(mhid: string): Promise<void> {
    const res = await fetch(`${BASE}/message-highlights/${mhid}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) throw new Error('Failed to delete message highlight');
  },

  // Baum-weite Highlight-Übersicht für den Highlights-Drawer. Nimmt jede
  // Chat-ID des Baums; das Backend löst selbst zum Root auf und liefert die
  // vereinte Liste bereits in Dokumentreihenfolge.
  async listTreeHighlights(chatId: string): Promise<TreeHighlight[]> {
    const res = await fetch(`${BASE}/chats/${chatId}/tree-highlights`);
    if (!res.ok) throw new Error('Failed to fetch tree highlights');
    return res.json();
  },

  // Global per-color labels. Shared across all trees; renaming a color
  // propagates immediately to every open popup via useLabels.
  // Returns only the user's own names; a color that was never renamed comes
  // back as null and gets its name from strings.ts (App language).
  async getHighlightLabels(): Promise<HighlightLabelOverrides> {
    const res = await fetch(`${BASE}/highlight-labels`);
    if (!res.ok) throw new Error('Failed to fetch labels');
    return res.json();
  },

  // Pass an empty/whitespace label to drop the override, so the color falls
  // back to its language default (the response then carries label: null).
  // Names longer than 24 chars are truncated server-side.
  async setHighlightLabel(color: HighlightColor, label: string): Promise<{ color: HighlightColor; label: string | null }> {
    const res = await fetch(`${BASE}/highlight-labels/${color}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to update label');
    }
    return res.json();
  },

  // Fetches a short explanation for a word, used by the floating popup.
  // Explain erklärt in der Sprache des Lesers (App language, Grill
  // 2026-07-24) — nicht in der Sprache des Wortes.
  // chatId (optional, 2026-07-25): Damit hängt das Backend die Frage an den
  // Gesprächskontext an (KV-Prefix-Sharing) — die Erklärung trifft Ollamas
  // Cache, statt den einzigen KV-Slot mit einem Standalone-Prompt zu
  // verdrängen (danach kostete die nächste echte Frage ~60 s Prefill).
  async explainWord(word: string, context: string, chatId?: string): Promise<{ explanation: string }> {
    const res = await fetch(`${BASE}/explain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ word, context, language: getAppLanguage(), ...(chatId ? { chatId } : {}) }),
    });
    if (!res.ok) {
      // Surface the backend's reason (e.g. "every cloud model is
      // rate-limited") instead of a generic failure — the popup shows it.
      const body = await res.json().catch(() => null);
      throw new Error(body?.error || 'Failed to explain word');
    }
    return res.json();
  },

  // Deletes a chat and all its children (handled recursively on the backend).
  async deleteChat(id: string): Promise<void> {
    const res = await fetch(`${BASE}/chats/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Failed to delete chat (HTTP ${res.status})`);
    }
  },

  // Renames a chat (updates only its title).
  async renameChat(id: string, title: string): Promise<Chat> {
    const res = await fetch(`${BASE}/chats/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) throw new Error('Failed to rename chat');
    return res.json();
  },

  // Pins or unpins a root chat. The backend stamps pinned_at itself — the
  // sidebar's Pinned section orders itself most-recently-pinned first
  // (design/mockup-pinned-chats.html, variant A).
  async setChatPinned(id: string, pinned: boolean): Promise<Chat> {
    const res = await fetch(`${BASE}/chats/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Failed to pin chat (HTTP ${res.status})`);
    }
    return res.json();
  },

  // ---- Sidebar categories -------------------------------------------------
  // User-made containers for root chats, one nesting level deep
  // (design/mockup-sidebar-categories-v2.html). A subcategory is a category
  // with a parent_id, so it renames, collapses and deletes with the same calls.

  async getCategories(): Promise<Category[]> {
    const res = await fetch(`${BASE}/categories`);
    if (!res.ok) throw new Error('Failed to load categories');
    return res.json();
  },

  async createCategory(name: string, parentId: string | null = null): Promise<Category> {
    const res = await fetch(`${BASE}/categories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parent_id: parentId }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Failed to create category (HTTP ${res.status})`);
    }
    return res.json();
  },

  async updateCategory(id: string, patch: { name?: string; collapsed?: boolean }): Promise<Category> {
    const res = await fetch(`${BASE}/categories/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Failed to update category (HTTP ${res.status})`);
    }
    return res.json();
  },

  // Deletes the container, never its contents: the chats fall back into their
  // date sections, and subcategories go with their parent.
  async deleteCategory(id: string): Promise<void> {
    const res = await fetch(`${BASE}/categories/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete category');
  },

  // Files a root chat into a category, or out of one with null.
  async setChatCategory(id: string, categoryId: string | null): Promise<Chat> {
    const res = await fetch(`${BASE}/chats/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category_id: categoryId }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Failed to file chat (HTTP ${res.status})`);
    }
    return res.json();
  },

  // Settings: aktiver LLM-Provider, Modelle, ob ein OpenAI-Key gesetzt ist.
  // Der API-Key selbst wird nie zurückgeschickt — nur ein Boolean-Status.
  async getSettings(): Promise<Settings> {
    const res = await fetch(`${BASE}/settings`);
    if (!res.ok) throw new Error('Failed to fetch settings');
    return res.json();
  },

  // Model registry (ADR-0008): curated shortlists, capabilities, prices and
  // key URLs per provider — remote JSON with a bundled fallback.
  async getRegistry(): Promise<Registry> {
    const res = await fetch(`${BASE}/settings/registry`);
    if (!res.ok) throw new Error('Failed to fetch model registry');
    return res.json();
  },

  // Usage/cost summary of the current month (ADR-0008): local token log ×
  // price table — costs are an estimate.
  async getUsageSummary(): Promise<UsageSummary> {
    const res = await fetch(`${BASE}/usage/summary`);
    if (!res.ok) throw new Error('Failed to fetch usage summary');
    return res.json();
  },

  // Lists vision-capable models currently pulled in the user's local Ollama
  // installation (the backend filters; `canThink` flags reasoning models).
  // Returns an empty array if Ollama isn't reachable so the UI can fall back
  // gracefully without surfacing an error.
  async getOllamaModels(): Promise<OllamaModelInfo[]> {
    try {
      const res = await fetch(`${BASE}/settings/ollama-models`);
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data.models) ? data.models : [];
    } catch {
      return [];
    }
  },

  // Same endpoint, but keeps the distinction the flat list drops
  // (mockup-model-flow §02): a 200 with zero models means "Ollama runs but
  // has no vision-capable model" — different copy from "not reachable".
  async getOllamaStatus(): Promise<{ reachable: boolean; models: OllamaModelInfo[] }> {
    try {
      const res = await fetch(`${BASE}/settings/ollama-models`);
      if (!res.ok) return { reachable: false, models: [] };
      const data = await res.json();
      return { reachable: true, models: Array.isArray(data.models) ? data.models : [] };
    } catch {
      return { reachable: false, models: [] };
    }
  },

  // Prefix-Warm-up: lässt das lokale Modell den Chat-Kontext (v. a. den
  // Paper-Volltext) schon einmal einlesen, bevor der Nutzer fragt — und hält
  // es 1 h im Speicher. Fire-and-forget beim Öffnen eines Chats und nach
  // jeder Antwort.
  async warmupChat(chatId: string): Promise<WarmupResult> {
    const res = await fetch(`${BASE}/chats/${chatId}/messages/warmup`, { method: 'POST' });
    if (!res.ok) return { warmed: false };
    return res.json().catch(() => ({ warmed: false }));
  },

  // Partielles Update. Felder, die nicht im Objekt sind, bleiben unverändert.
  // Für openai_api_key: leerer String löscht den gespeicherten Key.
  async updateSettings(patch: SettingsUpdate): Promise<Settings> {
    const res = await fetch(`${BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to update settings');
    }
    return res.json();
  },

  // Sidebar button + /feedback composer command (ADR-0010, corrected
  // 2026-08-06): Web3Forms' free plan rejects server-to-server submissions,
  // so the POST goes straight from the browser to Web3Forms — the backend
  // only hands over its (non-secret) client-safe access key + diagnostics
  // (version/OS/provider). email is the optional reply-to the user may enter.
  // Never an automatic public GitHub issue.
  // Degradation target for the feedback dialog (hybrid feedback, 2026-08-08):
  // when Web3Forms fails, the UI offers the issue tracker instead. The
  // constant fallback keeps the link alive even with the backend unreachable.
  async getFeedbackIssuesUrl(): Promise<string> {
    const FALLBACK = 'https://github.com/kavi-senewiratne/syflo/issues';
    try {
      const res = await fetch(`${BASE}/feedback/config`);
      if (!res.ok) return FALLBACK;
      const config = await res.json();
      return config.issuesUrl || FALLBACK;
    } catch {
      return FALLBACK;
    }
  },

  async sendFeedback(kind: FeedbackKind, text: string, email?: string): Promise<void> {
    const configRes = await fetch(`${BASE}/feedback/config`);
    if (!configRes.ok) throw new Error('Failed to send feedback');
    const config = await configRes.json();
    if (!config.accessKey) throw new Error('Failed to send feedback');

    const message = `${text}\n\n---\nversion: ${config.version}\nplatform: ${config.platform}\nprovider: ${config.provider}`;
    const res = await fetch('https://api.web3forms.com/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_key: config.accessKey,
        subject: `[${kind}] Syflo feedback`,
        from_name: 'Syflo Feedback',
        replyto: email || undefined,
        message,
      }),
    });
    if (!res.ok) throw new Error('Failed to send feedback');
    const body = await res.json().catch(() => ({ success: false }));
    if (!body.success) throw new Error('Failed to send feedback');
  },
};
