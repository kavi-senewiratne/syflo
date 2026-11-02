/**
 * htmlSourceApi.test.ts
 *
 * The HTML source client (ADR-0013): upload, from-url import, freeze retry,
 * embed lookup and the quote-anchor highlights. fetch is mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, TreeHasSourceError, HtmlNoReadableTextError } from '../api';

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

const source = {
  id: 'h1',
  title: 'Lernpfad',
  uploaded_at: '2026-09-29T10:00:00Z',
  sections: [{ level: 1, heading: 'Einfuehrung' }],
  unfrozen: [{ url: 'https://cdn.example/mathjax.js', kind: 'script', reason: 'no-internet' }],
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HTML source client', () => {
  it('uploads the file as multipart {chat_id, html}', async () => {
    vi.mocked(fetch).mockReturnValueOnce(jsonResponse(source, 201));
    const file = new File(['<html></html>'], 'a.html', { type: 'text/html' });
    const got = await api.uploadHtmlSource('c1', file);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('/api/html-sources');
    expect((init as RequestInit).method).toBe('POST');
    const fd = (init as RequestInit).body as FormData;
    expect(fd.get('chat_id')).toBe('c1');
    expect((fd.get('html') as File).name).toBe('a.html');
    expect(got.unfrozen).toHaveLength(1);
  });

  it('turns a 409 into TreeHasSourceError with the root chat id', async () => {
    vi.mocked(fetch).mockReturnValueOnce(jsonResponse({ error: 'tree-has-source', root_chat_id: 'r1' }, 409));
    const file = new File(['x'], 'a.html');
    await expect(api.uploadHtmlSource('c1', file)).rejects.toMatchObject({
      name: 'TreeHasSourceError',
      rootChatId: 'r1',
    });
    expect(TreeHasSourceError).toBeDefined();
  });

  it('defaults a missing unfrozen list to empty', async () => {
    vi.mocked(fetch).mockReturnValueOnce(jsonResponse({ ...source, unfrozen: undefined }, 201));
    const got = await api.uploadHtmlSource('c1', new File(['x'], 'a.html'));
    expect(got.unfrozen).toEqual([]);
  });

  it('imports a URL and maps 422 no-readable-text to its own error', async () => {
    vi.mocked(fetch).mockReturnValueOnce(jsonResponse({ error: 'no-readable-text' }, 422));
    await expect(api.importHtmlFromUrl('c1', 'https://example.org/login')).rejects.toBeInstanceOf(
      HtmlNoReadableTextError,
    );
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('/api/html-sources/from-url');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      chat_id: 'c1',
      url: 'https://example.org/login',
    });
  });

  it('passes other import errors through as messages', async () => {
    vi.mocked(fetch).mockReturnValueOnce(jsonResponse({ error: 'Could not reach the page' }, 502));
    await expect(api.importHtmlFromUrl('c1', 'https://x.test')).rejects.toThrow('Could not reach the page');
  });

  it('retries freezing with POST /:id/freeze', async () => {
    vi.mocked(fetch).mockReturnValueOnce(jsonResponse({ ...source, unfrozen: [] }));
    const got = await api.retryHtmlFreeze('h1');
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/html-sources/h1/freeze');
    expect(got.unfrozen).toEqual([]);
  });

  it('reads the embed descriptor', async () => {
    vi.mocked(fetch).mockReturnValueOnce(jsonResponse({ url: 'http://src-h1.localhost:3001/', origin: 'http://src-h1.localhost:3001', token: 't' }));
    const embed = await api.getHtmlEmbed('h1');
    expect(embed.origin).toBe('http://src-h1.localhost:3001');
  });

  it('creates a highlight with a quote anchor and reads either key style back', async () => {
    vi.mocked(fetch).mockReturnValueOnce(
      jsonResponse({ id: 'k1', htmlSourceId: 'h1', chatId: null, color: 'pink', anchor: { exact: 'a', prefix: '', suffix: '' }, section: '1.2', createdAt: 'x', updatedAt: 'y' }, 201),
    );
    const got = await api.createHtmlHighlight('h1', { color: 'pink', anchor: { exact: 'a', prefix: '', suffix: '' }, section: '1.2' });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.htmlSourceId).toBe('h1');
    expect(got).toMatchObject({ id: 'k1', htmlSourceId: 'h1', chatId: null, color: 'pink' });
  });

  it('lists, recolors and deletes highlights', async () => {
    vi.mocked(fetch)
      .mockReturnValueOnce(jsonResponse([{ id: 'k1', html_source_id: 'h1', chat_id: 'c9', color: 'blue', anchor: { exact: 'a', prefix: '', suffix: '' }, section: null, created_at: 'x' }]))
      .mockReturnValueOnce(jsonResponse({ id: 'k1', htmlSourceId: 'h1', chatId: 'c9', color: 'green', anchor: { exact: 'a', prefix: '', suffix: '' }, section: null }))
      .mockReturnValueOnce(Promise.resolve({ ok: true, status: 204 } as Response));
    const list = await api.listHtmlHighlights('h1');
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/html-highlights?html_source_id=h1');
    expect(list[0]).toMatchObject({ htmlSourceId: 'h1', chatId: 'c9' });
    const updated = await api.updateHtmlHighlight('k1', { color: 'green' });
    expect(updated?.color).toBe('green');
    await api.deleteHtmlHighlight('k1');
    expect(vi.mocked(fetch).mock.calls[2][1]).toMatchObject({ method: 'DELETE' });
  });
});
