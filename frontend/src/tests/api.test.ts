/**
 * api.test.ts
 *
 * Unit tests for the frontend API client.
 * Uses fetch mocking to avoid real network calls.
 *
 * The most important tests are for sendMessageStream because it contains
 * custom SSE parsing logic: buffering partial lines across network chunks,
 * calling onDelta for each text piece, and resolving with the final messages.
 * A bug here would break the entire streaming feature.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, TreeHasSourceError } from '../api';
import type { Message } from '../types';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a mock fetch response that returns a simple JSON body. */
function mockJsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

/** Build a mock fetch response whose body is a ReadableStream of SSE events. */
function mockSSEResponse(events: object[]) {
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (index < events.length) {
        // Each event is a complete SSE line ending with a blank line
        const line = `data: ${JSON.stringify(events[index++])}\n\n`;
        controller.enqueue(encoder.encode(line));
      } else {
        controller.close();
      }
    },
  });
  return Promise.resolve({ ok: true, body: stream } as Response);
}

const mockUser: Message = {
  id: 'u1', chat_id: 'c1', role: 'user', content: 'Hello', created_at: '2024-01-01T00:00:00Z',
};
const mockAssistant: Message = {
  id: 'a1', chat_id: 'c1', role: 'assistant', content: 'Hello world', created_at: '2024-01-01T00:00:01Z',
};

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── getTree ────────────────────────────────────────────────────────────────

describe('api.getTree', () => {
  it('fetches the chat tree from GET /api/chats/tree', async () => {
    vi.mocked(fetch).mockReturnValue(mockJsonResponse([{ id: '1', title: 'Chat 1' }]));
    const result = await api.getTree();
    expect(fetch).toHaveBeenCalledWith('/api/chats/tree');
    expect(result).toEqual([{ id: '1', title: 'Chat 1' }]);
  });

  it('throws when the response is not ok', async () => {
    vi.mocked(fetch).mockReturnValue(mockJsonResponse({}, 500));
    await expect(api.getTree()).rejects.toThrow('Failed to fetch tree');
  });
});

// ─── getChat ────────────────────────────────────────────────────────────────

describe('api.getChat', () => {
  it('fetches a single chat by id', async () => {
    const mockChat = { id: 'abc', title: 'My Chat', messages: [], children: [] };
    vi.mocked(fetch).mockReturnValue(mockJsonResponse(mockChat));
    const result = await api.getChat('abc');
    expect(fetch).toHaveBeenCalledWith('/api/chats/abc');
    expect(result.id).toBe('abc');
  });

  it('throws on 404', async () => {
    vi.mocked(fetch).mockReturnValue(mockJsonResponse({ error: 'Not found' }, 404));
    await expect(api.getChat('nonexistent')).rejects.toThrow('Failed to fetch chat');
  });
});

// ─── createChat ─────────────────────────────────────────────────────────────

describe('api.createChat', () => {
  it('sends POST with title', async () => {
    vi.mocked(fetch).mockReturnValue(mockJsonResponse({ id: 'new1', title: 'New Chat' }));
    await api.createChat('New Chat');
    expect(fetch).toHaveBeenCalledWith('/api/chats', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ title: 'New Chat', parent_id: undefined, parent_word: undefined }),
    }));
  });

  it('includes parent_id and parent_word when branching', async () => {
    vi.mocked(fetch).mockReturnValue(mockJsonResponse({ id: 'child1', title: 'Child' }));
    await api.createChat('Child', 'parent1', 'quantum');
    expect(fetch).toHaveBeenCalledWith('/api/chats', expect.objectContaining({
      body: JSON.stringify({ title: 'Child', parent_id: 'parent1', parent_word: 'quantum' }),
    }));
  });
});

// ─── sendFeedback ───────────────────────────────────────────────────────────

describe('api.sendFeedback', () => {
  // Web3Forms' free plan rejects server-to-server submissions — the POST
  // must come from the browser itself (ADR-0010, corrected 2026-08-06).
  // The backend only hands over the (non-secret) access key + diagnostics.
  const config = { accessKey: 'test-key', version: '1.0.0', platform: 'darwin', provider: 'gemini' };

  function submittedBody() {
    return JSON.parse(vi.mocked(fetch).mock.calls[1][1]?.body as string);
  }

  it('fetches the Web3Forms config from the backend, then posts directly to Web3Forms', async () => {
    vi.mocked(fetch)
      .mockReturnValueOnce(mockJsonResponse(config))
      .mockReturnValueOnce(mockJsonResponse({ success: true }));

    await api.sendFeedback('bug', 'The highlight picker closes too fast.');

    expect(fetch).toHaveBeenNthCalledWith(1, '/api/feedback/config');
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://api.web3forms.com/submit', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }));
    const body = submittedBody();
    expect(body.access_key).toBe('test-key');
    expect(body.subject).toBe('[bug] Syflo feedback');
    expect(body.message).toContain('The highlight picker closes too fast.');
    expect(body.message).toContain('version: 1.0.0');
    expect(body.replyto).toBeUndefined();
  });

  it('includes the optional email as replyto', async () => {
    vi.mocked(fetch)
      .mockReturnValueOnce(mockJsonResponse(config))
      .mockReturnValueOnce(mockJsonResponse({ success: true }));

    await api.sendFeedback('idea', 'Dark mode for the mind map', 'me@example.com');

    expect(submittedBody().replyto).toBe('me@example.com');
  });

  it('throws when Web3Forms rejects the submission', async () => {
    vi.mocked(fetch)
      .mockReturnValueOnce(mockJsonResponse(config))
      .mockReturnValueOnce(mockJsonResponse({ success: false, message: 'blocked' }));

    await expect(api.sendFeedback('question', 'How does retrieval mode work?')).rejects.toThrow('Failed to send feedback');
  });

  it('throws when no access key is configured', async () => {
    vi.mocked(fetch).mockReturnValueOnce(mockJsonResponse({ ...config, accessKey: null }));

    await expect(api.sendFeedback('bug', 'x')).rejects.toThrow('Failed to send feedback');
  });
});

// ─── sendMessageStream ──────────────────────────────────────────────────────

describe('api.sendMessageStream', () => {
  it('calls onDelta for each streamed text chunk', async () => {
    vi.mocked(fetch).mockReturnValue(mockSSEResponse([
      { delta: 'Hello' },
      { delta: ' world' },
      { done: true, userMessage: mockUser, assistantMessage: mockAssistant },
    ]));

    const deltas: string[] = [];
    await api.sendMessageStream('c1', 'Hi', d => deltas.push(d));

    expect(deltas).toEqual(['Hello', ' world']);
  });

  it('returns userMessage and assistantMessage from the done event', async () => {
    vi.mocked(fetch).mockReturnValue(mockSSEResponse([
      { delta: 'Hi!' },
      { done: true, userMessage: mockUser, assistantMessage: mockAssistant },
    ]));

    const result = await api.sendMessageStream('c1', 'Hello', vi.fn());

    expect(result.userMessage.id).toBe('u1');
    expect(result.assistantMessage.content).toBe('Hello world');
  });

  it('sends POST to the correct URL with the message content', async () => {
    vi.mocked(fetch).mockReturnValue(mockSSEResponse([
      { done: true, userMessage: mockUser, assistantMessage: mockAssistant },
    ]));

    await api.sendMessageStream('chat99', 'Test message', vi.fn());

    expect(fetch).toHaveBeenCalledWith('/api/chats/chat99/messages', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ content: 'Test message', quoteHighlightId: null }),
    }));
  });

  it('throws when the error event is received', async () => {
    vi.mocked(fetch).mockReturnValue(mockSSEResponse([
      { error: 'Ollama is not running' },
    ]));

    await expect(
      api.sendMessageStream('c1', 'Hi', vi.fn())
    ).rejects.toThrow('Ollama is not running');
  });

  it('forwards the think flag and surfaces the thinking status event', async () => {
    vi.mocked(fetch).mockReturnValue(mockSSEResponse([
      { thinking: true },
      { delta: 'Answer' },
      { done: true, userMessage: mockUser, assistantMessage: mockAssistant },
    ]));

    const onThinking = vi.fn();
    await api.sendMessageStream('c1', 'Hard question', vi.fn(), [], undefined, {
      think: true,
      onThinking,
    });

    expect(fetch).toHaveBeenCalledWith('/api/chats/c1/messages', expect.objectContaining({
      body: JSON.stringify({ content: 'Hard question', think: true, quoteHighlightId: null }),
    }));
    expect(onThinking).toHaveBeenCalledTimes(1);
  });

  it('streams reasoning deltas to onReasoning without mixing them into the answer', async () => {
    vi.mocked(fetch).mockReturnValue(mockSSEResponse([
      { thinking: true },
      { reasoning: 'Let me think' },
      { reasoning: ' about this…' },
      { delta: 'Answer' },
      { done: true, userMessage: mockUser, assistantMessage: mockAssistant },
    ]));

    const deltas: string[] = [];
    const reasoning: string[] = [];
    await api.sendMessageStream('c1', 'Hard question', d => deltas.push(d), [], undefined, {
      think: true,
      onReasoning: r => reasoning.push(r),
    });

    expect(reasoning.join('')).toBe('Let me think about this…');
    expect(deltas).toEqual(['Answer']);
  });

  it('handles multiple SSE chunks arriving in one network packet', async () => {
    // Simulate two events packed into a single ReadableStream chunk
    const encoder = new TextEncoder();
    const combined =
      `data: ${JSON.stringify({ delta: 'A' })}\n\n` +
      `data: ${JSON.stringify({ delta: 'B' })}\n\n` +
      `data: ${JSON.stringify({ done: true, userMessage: mockUser, assistantMessage: mockAssistant })}\n\n`;

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(combined));
        controller.close();
      },
    });

    vi.mocked(fetch).mockReturnValue(Promise.resolve({ ok: true, body: stream } as Response));

    const deltas: string[] = [];
    await api.sendMessageStream('c1', 'Hi', d => deltas.push(d));

    expect(deltas).toEqual(['A', 'B']);
  });
});

// ─── explainWord ────────────────────────────────────────────────────────────

describe('api.explainWord', () => {
  it('sends POST with word, context and the App language (Grill 2026-07-24)', async () => {
    localStorage.removeItem('syflo.appLanguage');
    vi.mocked(fetch).mockReturnValue(mockJsonResponse({ explanation: 'A quantum is...' }));
    const result = await api.explainWord('quantum', 'physics lesson');
    expect(fetch).toHaveBeenCalledWith('/api/explain', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ word: 'quantum', context: 'physics lesson', language: 'en' }),
    }));
    expect(result.explanation).toBe('A quantum is...');
  });

  it('sends language=de when the App language is German', async () => {
    localStorage.setItem('syflo.appLanguage', 'de');
    vi.mocked(fetch).mockReturnValue(mockJsonResponse({ explanation: 'Ein Quant ist…' }));
    await api.explainWord('quantum', 'physics lesson');
    expect(vi.mocked(fetch).mock.calls[0][1]?.body).toBe(
      JSON.stringify({ word: 'quantum', context: 'physics lesson', language: 'de' }),
    );
    localStorage.removeItem('syflo.appLanguage');
  });
});

// ─── deleteChat ─────────────────────────────────────────────────────────────

describe('api.deleteChat', () => {
  it('sends DELETE to the correct URL', async () => {
    vi.mocked(fetch).mockReturnValue(mockJsonResponse({ success: true }));
    await api.deleteChat('chat42');
    expect(fetch).toHaveBeenCalledWith('/api/chats/chat42', { method: 'DELETE' });
  });
});

// ─── uploadPaper / getTreePaper (Slice 03) ──────────────────────────────────

describe('api.uploadPaper', () => {
  const pdf = new File(['%PDF-1.4'], 'lease.pdf', { type: 'application/pdf' });

  it('POSTs the PDF as multipart form data with the chat_id', async () => {
    const paper = { id: 'p1', title: 'lease', authors: [], uploaded_at: 'x', status: 'ready', pdf_url: '/api/papers/p1/pdf' };
    vi.mocked(fetch).mockReturnValue(mockJsonResponse(paper, 201));

    const result = await api.uploadPaper('c1', pdf);

    expect(fetch).toHaveBeenCalledWith('/api/papers', expect.objectContaining({ method: 'POST' }));
    const body = vi.mocked(fetch).mock.calls[0][1]?.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('chat_id')).toBe('c1');
    // jsdom klont Dateien beim FormData.append — Identität ist nicht garantiert,
    // also Name/Typ vergleichen statt toBe.
    const sent = body.get('pdf') as File;
    expect(sent.name).toBe('lease.pdf');
    expect(sent.type).toBe('application/pdf');
    expect(result).toEqual(paper);
  });

  it('wirft TreeHasSourceError mit root_chat_id bei 409 (ADR-0002/0005)', async () => {
    vi.mocked(fetch).mockReturnValue(mockJsonResponse({ error: 'tree-has-source', root_chat_id: 'root9' }, 409));
    const err = await api.uploadPaper('c1', pdf).catch(e => e);
    expect(err).toBeInstanceOf(TreeHasSourceError);
    expect((err as TreeHasSourceError).rootChatId).toBe('root9');
  });

  it('throws a plain error on other failures', async () => {
    vi.mocked(fetch).mockReturnValue(mockJsonResponse({}, 500));
    await expect(api.uploadPaper('c1', pdf)).rejects.toThrow('Failed to upload PDF');
  });
});

describe('api.getTreePaper', () => {
  it('returns the paper bound to the chat tree', async () => {
    const paper = { id: 'p1', title: 'lease', authors: [], uploaded_at: 'x', status: 'ready', pdf_url: '/api/papers/p1/pdf' };
    vi.mocked(fetch).mockReturnValue(mockJsonResponse({ paper }));
    const result = await api.getTreePaper('c1');
    expect(fetch).toHaveBeenCalledWith('/api/papers/for-chat/c1');
    expect(result).toEqual(paper);
  });

  it('returns null when the tree has no PDF', async () => {
    vi.mocked(fetch).mockReturnValue(mockJsonResponse({ paper: null }));
    expect(await api.getTreePaper('c1')).toBeNull();
  });
});

// ─── searchPapers / importPaperFromUrl (Slice 07) ───────────────────────────

describe('api.searchPapers', () => {
  it('fetches merged results from GET /api/papers/search', async () => {
    const body = { results: [{ id: 'W1', title: 'A' }], rate_limited: false };
    vi.mocked(fetch).mockReturnValue(mockJsonResponse(body));
    const result = await api.searchPapers('attention is all');
    expect(fetch).toHaveBeenCalledWith('/api/papers/search?q=attention%20is%20all');
    expect(result).toEqual(body);
  });
});

describe('api.importPaperFromUrl', () => {
  it('POSTs url, title, fallbacks and chat_id', async () => {
    const paper = { id: 'p1', title: 'A', authors: [], uploaded_at: 'x', status: 'ready', pdf_url: '/api/papers/p1/pdf' };
    vi.mocked(fetch).mockReturnValue(mockJsonResponse(paper, 201));
    const result = await api.importPaperFromUrl('c1', 'https://arxiv.org/pdf/1.pdf', 'A', ['https://mirror/1.pdf']);
    expect(fetch).toHaveBeenCalledWith('/api/papers/from-url', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        url: 'https://arxiv.org/pdf/1.pdf',
        title: 'A',
        fallback_urls: ['https://mirror/1.pdf'],
        chat_id: 'c1',
      }),
    }));
    expect(result).toEqual(paper);
  });

  it('wirft TreeHasSourceError bei 409 (ADR-0002/0005)', async () => {
    vi.mocked(fetch).mockReturnValue(mockJsonResponse({ error: 'tree-has-source', root_chat_id: 'root1' }, 409));
    const err = await api.importPaperFromUrl('c1', 'https://arxiv.org/pdf/1.pdf').catch(e => e);
    expect(err).toBeInstanceOf(TreeHasSourceError);
    expect((err as TreeHasSourceError).rootChatId).toBe('root1');
  });

  it('reicht die Backend-Fehlermeldung durch (z. B. Publisher-Block)', async () => {
    vi.mocked(fetch).mockReturnValue(mockJsonResponse({ error: 'Publisher blocks direct download (HTTP 403).' }, 502));
    await expect(api.importPaperFromUrl('c1', 'https://x/y.pdf')).rejects.toThrow(/Publisher blocks/);
  });
});

// ─── YouTube transcript (ADR-0005) ──────────────────────────────────────────

describe('api.searchYouTube', () => {
  it('fetches video results from GET /api/youtube/search', async () => {
    const body = { results: [{ youtube_id: 'zjkBMFhNj_g', title: 'Intro to LLMs', channel: 'Karpathy', duration: '59:47', published: '2 years ago', thumbnail_url: null, url: 'https://www.youtube.com/watch?v=zjkBMFhNj_g' }] };
    vi.mocked(fetch).mockReturnValue(mockJsonResponse(body));
    const result = await api.searchYouTube('karpathy llm');
    expect(fetch).toHaveBeenCalledWith('/api/youtube/search?q=karpathy%20llm');
    expect(result).toEqual(body.results);
  });
});

describe('api.importYouTubeVideo', () => {
  it('POSTs chat_id and youtube_id and returns the bound video', async () => {
    const video = { id: 'v1', youtube_id: 'zjkBMFhNj_g', title: 'Intro to LLMs', channel: 'Karpathy', duration_seconds: 3587, language: 'en', url: 'https://www.youtube.com/watch?v=zjkBMFhNj_g' };
    vi.mocked(fetch).mockReturnValue(mockJsonResponse(video, 201));
    const result = await api.importYouTubeVideo('c1', 'zjkBMFhNj_g');
    expect(fetch).toHaveBeenCalledWith('/api/youtube/import', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ chat_id: 'c1', youtube_id: 'zjkBMFhNj_g' }),
    }));
    expect(result).toEqual(video);
  });

  it('wirft TreeHasSourceError bei 409 (eine Quelle pro Baum, ADR-0005)', async () => {
    vi.mocked(fetch).mockReturnValue(mockJsonResponse({ error: 'tree-has-source', root_chat_id: 'root2' }, 409));
    const err = await api.importYouTubeVideo('c1', 'zjkBMFhNj_g').catch(e => e);
    expect(err).toBeInstanceOf(TreeHasSourceError);
    expect((err as TreeHasSourceError).rootChatId).toBe('root2');
  });

  it('reicht die no-transcript-Meldung des Backends durch', async () => {
    vi.mocked(fetch).mockReturnValue(mockJsonResponse({ error: 'no-transcript', message: 'YouTube offers no captions for this video — not even auto-generated ones. Pick a different video.' }, 422));
    await expect(api.importYouTubeVideo('c1', 'zjkBMFhNj_g')).rejects.toThrow(/no captions/i);
  });
});

describe('api.getTreeVideo', () => {
  it('returns the video (incl. transcript) bound to the chat tree', async () => {
    const video = { id: 'v1', youtube_id: 'zjkBMFhNj_g', title: 'Intro to LLMs', channel: 'Karpathy', duration_seconds: 3587, language: 'en', url: 'https://www.youtube.com/watch?v=zjkBMFhNj_g', transcript: '[00:00] Hi everyone.' };
    vi.mocked(fetch).mockReturnValue(mockJsonResponse({ video }));
    const result = await api.getTreeVideo('c1');
    expect(fetch).toHaveBeenCalledWith('/api/youtube/for-chat/c1');
    expect(result).toEqual(video);
  });

  it('returns null when the tree has no video', async () => {
    vi.mocked(fetch).mockReturnValue(mockJsonResponse({ video: null }));
    expect(await api.getTreeVideo('c1')).toBeNull();
  });
});

// ─── /btw side question (design/mockup-btw-composer-fold.html) ──────────────

describe('api.askAside', () => {
  it('streams the answer and reports which model answered', async () => {
    const deltas: string[] = [];
    global.fetch = vi.fn(() =>
      mockSSEResponse([
        { delta: 'A logit ' },
        { delta: 'is a raw score.' },
        { done: true, provider: 'groq', model: 'llama-3.3-70b', switchedFrom: 'gemini-2.5-flash', switchedFromProvider: 'gemini' },
      ]),
    ) as unknown as typeof fetch;

    const result = await api.askAside('c1', 'what does logit mean again?', (d) => deltas.push(d));

    expect(deltas.join('')).toBe('A logit is a raw score.');
    expect(result.answer).toBe('A logit is a raw score.');
    // Beide Seiten des Wechsels — die Notiz im Panel wählt danach zwischen
    // "Modell → Modell" und "Anbieter → Anbieter", genau wie im Chat.
    expect(result.model).toEqual({
      was: 'gemini-2.5-flash', answered: 'llama-3.3-70b',
      fromProvider: 'gemini', toProvider: 'groq',
    });
  });

  it('leaves model unset when the chat’s own model answered', async () => {
    global.fetch = vi.fn(() =>
      mockSSEResponse([{ delta: 'ok' }, { done: true, provider: 'ollama', model: 'qwen3.5:9b' }]),
    ) as unknown as typeof fetch;

    const result = await api.askAside('c1', 'q', () => {});
    expect(result.model).toBeNull();
  });
});
