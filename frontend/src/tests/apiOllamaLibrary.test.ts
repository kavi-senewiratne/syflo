/**
 * tests/apiOllamaLibrary.test.ts
 *
 * The API client's side of the local library (grill 2026-10-27): the pull
 * reads the backend's NDJSON progress stream line by line and resolves with
 * the final `ready` line, so the settings card can draw a bar from the
 * progress and know the baked window at the end.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { api } from '../api';

function ndjsonResponse(lines: object[], ok = true, status = 200): Response {
  const text = lines.map(l => JSON.stringify(l) + '\n').join('');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Two chunks, split mid-line, to prove the reader buffers.
      const bytes = new TextEncoder().encode(text);
      const cut = Math.floor(bytes.length / 2);
      controller.enqueue(bytes.slice(0, cut));
      controller.enqueue(bytes.slice(cut));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'Content-Type': ok ? 'application/x-ndjson' : 'application/json' } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('api.pullOllamaModel', () => {
  it('reports every progress line and resolves with the ready line', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(ndjsonResponse([
      { status: 'pulling manifest' },
      { status: 'pulling abc', digest: 'sha256:abc', total: 1000, completed: 500 },
      { status: 'success' },
      { status: 'ready', model: 'qwen3.5:9b', contextLength: 32768 },
    ]));
    const seen: unknown[] = [];

    const result = await api.pullOllamaModel('qwen3.5:9b', p => seen.push(p));

    expect(seen).toContainEqual({ status: 'pulling abc', digest: 'sha256:abc', total: 1000, completed: 500 });
    expect(result).toEqual({ ready: true, contextLength: 32768 });
    expect(fetch).toHaveBeenCalledWith('/api/settings/ollama-pull', expect.objectContaining({ method: 'POST' }));
  });

  it('turns the daemon\'s error line into a failed result with its words', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(ndjsonResponse([
      { status: 'pulling manifest' },
      { error: 'pull model manifest: file does not exist' },
    ]));

    const result = await api.pullOllamaModel('nope:1b', () => {});

    expect(result).toEqual({ ready: false, contextLength: null, error: 'pull model manifest: file does not exist' });
  });

  it('fails in words when Ollama is down (503 from the backend)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Could not reach Ollama at localhost:11434. Is it running?' }), { status: 503 }),
    );

    const result = await api.pullOllamaModel('qwen3.5:9b', () => {});

    expect(result.ready).toBe(false);
    expect(result.error).toMatch(/Could not reach Ollama/);
  });
});

describe('api.getRecommendation / api.deleteOllamaModel', () => {
  it('fetches the recommendation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ollamaReachable: true, recommended: null, alsoFits: [], hardware: {} }), { status: 200 }));
    const rec = await api.getRecommendation();
    expect(rec.ollamaReachable).toBe(true);
    expect(fetch).toHaveBeenCalledWith('/api/system/recommendation');
  });

  it('deletes by name through the settings route', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ removed: 'qwen3.5:9b' }), { status: 200 }));
    await api.deleteOllamaModel('qwen3.5:9b');
    expect(fetch).toHaveBeenCalledWith('/api/settings/ollama-models/qwen3.5%3A9b', expect.objectContaining({ method: 'DELETE' }));
  });
});
