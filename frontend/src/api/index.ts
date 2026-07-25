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

import type { Chat, ChatAncestor, ChatDetail, CreateHighlightPayload, CreateMessageHighlightPayload, Highlight, HighlightColor, HighlightLabels, LocalAttachment, Message, MessageHighlight, OllamaModelInfo, Paper, PaperSearchResponse, PullProgress, Settings, SettingsUpdate, SystemRecommendation, ToolEvent, TreeHighlight, Video, VideoSearchResult, WarmupResult } from '../types';
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
  constructor(message: string, userMessage?: Message, assistantMessage?: Message) {
    super(message);
    this.name = 'StreamFailedError';
    this.userMessage = userMessage;
    this.assistantMessage = assistantMessage;
  }
}

// Callbacks eines Antwort-Streams (Senden UND Regenerate teilen sich den
// SSE-Leser). onQueued/onStarted spiegeln die Backend-Warteschlange:
// FIFO über alle Chats, weil Ollama nur einen Slot hat.
interface StreamCallbacks {
  onDelta: (delta: string) => void;
  onToolEvent?: (evt: ToolEvent) => void;
  onThinking?: () => void;
  onReasoning?: (delta: string) => void;
  // Der Job wartet: `ahead` Anfragen laufen/warten vor ihm.
  onQueued?: (ahead: number) => void;
  // Der Job ist an der Reihe; die User-Nachricht ist jetzt persistiert —
  // die UI ersetzt damit ihre optimistische Frage (echter Zeitstempel).
  onStarted?: (userMessage: Message) => void;
  // Prefill-ETA des Backends in Sekunden — die UI zeigt einen Countdown-
  // Balken im ThinkingIndicator (design/mockup-prefill-progress.html §01).
  onPrefill?: (seconds: number) => void;
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
      if (data.error) throw new StreamFailedError(data.error, data.userMessage, data.assistantMessage);

      // Warteschlangen-Position — der Job wartet noch auf den Ollama-Slot.
      if (data.queued && cb.onQueued) cb.onQueued(data.queued.ahead);

      // Der Job läuft jetzt; die User-Nachricht ist persistiert.
      if (data.started && cb.onStarted) cb.onStarted(data.userMessage);

      // Prefill-Schätzung — wie lange das Modell die Quelle wohl noch liest.
      if (data.prefill && cb.onPrefill) cb.onPrefill(data.prefill.seconds);

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
  async getChat(id: string): Promise<ChatDetail> {
    const res = await fetch(`${BASE}/chats/${id}`);
    if (!res.ok) throw new Error('Failed to fetch chat');
    return res.json();
  },

  // Fetches the ancestor path (root → … → direct parent) of a branch chat,
  // including the cached summaries the LLM inherits. Empty for root chats.
  async getAncestors(id: string): Promise<ChatAncestor[]> {
    const res = await fetch(`${BASE}/chats/${id}/ancestors`);
    if (!res.ok) throw new Error('Failed to fetch ancestors');
    return res.json();
  },

  // Creates a new chat. parent_id and parent_word are set when branching from
  // a specific word in an existing conversation.
  async createChat(title: string, parent_id?: string, parent_word?: string): Promise<Chat> {
    const res = await fetch(`${BASE}/chats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, parent_id, parent_word }),
    });
    if (!res.ok) throw new Error('Failed to create chat');
    return res.json();
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
    opts?: { think?: boolean; onThinking?: () => void; onReasoning?: (delta: string) => void; onQueued?: (ahead: number) => void; onStarted?: (userMessage: Message) => void; signal?: AbortSignal },
  ): Promise<{ userMessage: Message; assistantMessage: Message }> {
    let res: Response;
    if (attachments.length > 0) {
      const fd = new FormData();
      fd.append('content', content);
      fd.append('aliases', JSON.stringify(attachments.map(a => a.alias)));
      if (opts?.think !== undefined) fd.append('think', String(opts.think));
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
        body: JSON.stringify({ content, think: opts?.think }),
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
    });
  },

  // Retry-Button der Fehlerzeile: erzeugt die Antwort auf die LETZTE
  // User-Frage des Chats neu, ohne die Frage zu duplizieren (das Backend
  // entfernt dabei den persistierten '*Failed*'-Marker). Gleiches
  // SSE-Protokoll wie sendMessageStream — inklusive Warteschlange.
  async regenerateMessage(
    chatId: string,
    onDelta: (delta: string) => void,
    onToolEvent?: (evt: ToolEvent) => void,
    opts?: { think?: boolean; onThinking?: () => void; onReasoning?: (delta: string) => void; onQueued?: (ahead: number) => void; onStarted?: (userMessage: Message) => void; signal?: AbortSignal },
  ): Promise<{ userMessage: Message; assistantMessage: Message }> {
    const res = await fetch(`${BASE}/chats/${chatId}/messages/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ think: opts?.think }),
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
    });
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

  async updateMessageHighlight(mhid: string, color: HighlightColor): Promise<MessageHighlight> {
    const res = await fetch(`${BASE}/message-highlights/${mhid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color }),
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
  async getHighlightLabels(): Promise<HighlightLabels> {
    const res = await fetch(`${BASE}/highlight-labels`);
    if (!res.ok) throw new Error('Failed to fetch labels');
    return res.json();
  },

  // Pass an empty/whitespace label to reset that color to its default. Names
  // longer than 24 chars are truncated server-side.
  async setHighlightLabel(color: HighlightColor, label: string): Promise<{ color: HighlightColor; label: string }> {
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
    if (!res.ok) throw new Error('Failed to explain word');
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

  // Settings: aktiver LLM-Provider, Modelle, ob ein OpenAI-Key gesetzt ist.
  // Der API-Key selbst wird nie zurückgeschickt — nur ein Boolean-Status.
  async getSettings(): Promise<Settings> {
    const res = await fetch(`${BASE}/settings`);
    if (!res.ok) throw new Error('Failed to fetch settings');
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

  // Prefix-Warm-up: lässt das lokale Modell den Chat-Kontext (v. a. den
  // Paper-Volltext) schon einmal einlesen, bevor der Nutzer fragt — und hält
  // es 1 h im Speicher. Fire-and-forget beim Öffnen eines Chats und nach
  // jeder Antwort. Meldet zusätzlich die GPU-Residency des Modells.
  async warmupChat(chatId: string): Promise<WarmupResult> {
    const res = await fetch(`${BASE}/chats/${chatId}/messages/warmup`, { method: 'POST' });
    if (!res.ok) return { warmed: false };
    return res.json().catch(() => ({ warmed: false }));
  },

  // Hardware-Fakten + Modell-Empfehlung für diesen Rechner (die "Leiter").
  async getSystemRecommendation(): Promise<SystemRecommendation> {
    const res = await fetch(`${BASE}/system/recommendation`);
    if (!res.ok) throw new Error('Failed to fetch system recommendation');
    return res.json();
  },

  // Setzt das empfohlene Modell als aktives, wenn model_source 'auto' ist und
  // das Modell installiert ist. Wird beim App-Start aufgerufen (Download-Gate).
  async applyRecommendedModel(): Promise<{ applied: boolean; model: string }> {
    const res = await fetch(`${BASE}/settings/apply-recommended`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to apply recommended model');
    return res.json();
  },

  // Lädt ein Modell über den lokalen Ollama-Daemon herunter und meldet jede
  // Fortschritts-Zeile (Settings-Bibliothek: Fortschrittsbalken).
  async pullOllamaModel(
    model: string,
    onProgress: (p: PullProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await fetch(`${BASE}/settings/ollama-pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to download model');
    }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const p = JSON.parse(line) as PullProgress & { error?: string };
          if (p.error) throw new Error(p.error);
          onProgress(p);
        } catch (err) {
          if (err instanceof SyntaxError) continue; // halbe Zeile — ignorieren
          throw err;
        }
      }
    }
  },

  // Entfernt ein installiertes Ollama-Modell (Settings-Bibliothek).
  async deleteOllamaModel(name: string): Promise<void> {
    const res = await fetch(`${BASE}/settings/ollama-models/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to remove model');
    }
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
};
