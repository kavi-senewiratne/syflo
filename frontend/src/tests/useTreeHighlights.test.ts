/**
 * useTreeHighlights.test.ts
 *
 * Baum-weite Highlight-Liste für den Highlights-Drawer
 * (design/mockup-highlights-overview.html, Variante A):
 * - lädt die vereinte Liste über api.listTreeHighlights
 * - invalidateTreeHighlights() lädt neu, damit Drawer nach jedem
 *   Anlegen/Umfärben/Löschen synchron bleibt (Grill-Entscheidung 9)
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '../api';
import {
  useTreeHighlights,
  invalidateTreeHighlights,
  _resetTreeHighlightsCacheForTests,
} from '../hooks/useTreeHighlights';
import { useChatHighlights } from '../hooks/useChatHighlights';
import { useHighlights } from '../hooks/useHighlights';
import type { TreeHighlight } from '../types';

vi.mock('../api', () => ({
  api: {
    listTreeHighlights: vi.fn(),
    listHighlights: vi.fn(),
    listMessageHighlights: vi.fn(),
    createMessageHighlight: vi.fn(),
    deleteHighlight: vi.fn(),
  },
}));

const pdfItem: TreeHighlight = {
  kind: 'pdf',
  id: 'h-1',
  color: 'yellow',
  text: 'CB-MCTS',
  paperId: 'paper-1',
  pageNumber: 3,
  rects: [{ left: 10, top: 20, width: 100, height: 14 }],
  chatId: null,
  createdAt: '2026-07-16T00:00:00.000Z',
  updatedAt: '2026-07-16T00:00:00.000Z',
};

const chatItem: TreeHighlight = {
  kind: 'chat',
  id: 'mh-1',
  color: 'orange',
  text: 'annealed',
  chatId: 'branch-1',
  chatTitle: 'entropy bonus',
  childChatId: null,
  messageId: 'msg-1',
  startOffset: 22,
  endOffset: 30,
  createdAt: '2026-07-19T00:00:00.000Z',
  updatedAt: '2026-07-19T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetTreeHighlightsCacheForTests();
});

describe('useTreeHighlights', () => {
  it('lädt die Baum-Liste für eine Chat-ID', async () => {
    vi.mocked(api.listTreeHighlights).mockResolvedValue([pdfItem, chatItem]);

    const { result } = renderHook(() => useTreeHighlights('root'));
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.listTreeHighlights).toHaveBeenCalledWith('root');
    expect(result.current.items).toEqual([pdfItem, chatItem]);
    expect(result.current.error).toBeNull();
  });

  it('lädt nach invalidateTreeHighlights() neu — Drawer bleibt synchron', async () => {
    vi.mocked(api.listTreeHighlights).mockResolvedValue([pdfItem]);
    const { result } = renderHook(() => useTreeHighlights('root'));
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    // Eine Mutation anderswo (z. B. neues Highlight im PDF) invalidiert.
    vi.mocked(api.listTreeHighlights).mockResolvedValue([pdfItem, chatItem]);
    act(() => invalidateTreeHighlights());

    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(api.listTreeHighlights).toHaveBeenCalledTimes(2);
  });

  it('tut ohne Chat-ID nichts — kein Fetch, leere Liste', async () => {
    const { result } = renderHook(() => useTreeHighlights(null));
    expect(result.current.loading).toBe(false);
    expect(result.current.items).toEqual([]);
    expect(api.listTreeHighlights).not.toHaveBeenCalled();
  });

  it('lädt neu, wenn über useChatHighlights ein Highlight entsteht', async () => {
    vi.mocked(api.listTreeHighlights).mockResolvedValue([]);
    vi.mocked(api.listMessageHighlights).mockResolvedValue([]);
    vi.mocked(api.createMessageHighlight).mockResolvedValue({
      id: 'mh-1', messageId: 'msg-1', chatId: 'branch-1', childChatId: null,
      startOffset: 22, endOffset: 30, text: 'annealed', color: 'orange',
      createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z',
    });

    const tree = renderHook(() => useTreeHighlights('root'));
    await waitFor(() => expect(tree.result.current.loading).toBe(false));
    const chat = renderHook(() => useChatHighlights('branch-1'));
    await waitFor(() => expect(chat.result.current.loading).toBe(false));

    vi.mocked(api.listTreeHighlights).mockResolvedValue([chatItem]);
    await act(async () => {
      await chat.result.current.create({
        messageId: 'msg-1', color: 'orange', text: 'annealed', startOffset: 22, endOffset: 30,
      });
    });

    await waitFor(() => expect(tree.result.current.items).toEqual([chatItem]));
  });

  it('lädt neu, wenn über useHighlights ein PDF-Highlight gelöscht wird', async () => {
    vi.mocked(api.listTreeHighlights).mockResolvedValue([pdfItem]);
    vi.mocked(api.listHighlights).mockResolvedValue([
      {
        id: 'h-1', paperId: 'paper-1', color: 'yellow', text: 'CB-MCTS',
        pageNumber: 3, rects: [{ left: 10, top: 20, width: 100, height: 14 }],
        chatId: null, createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z',
      },
    ]);
    vi.mocked(api.deleteHighlight).mockResolvedValue(undefined);

    const tree = renderHook(() => useTreeHighlights('root'));
    await waitFor(() => expect(tree.result.current.items).toHaveLength(1));
    const pdf = renderHook(() => useHighlights('paper-1'));
    await waitFor(() => expect(pdf.result.current.loading).toBe(false));

    vi.mocked(api.listTreeHighlights).mockResolvedValue([]);
    await act(async () => {
      await pdf.result.current.remove('h-1');
    });

    await waitFor(() => expect(tree.result.current.items).toEqual([]));
  });
});
