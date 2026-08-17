import { describe, it, expect } from 'vitest';
import { branchSourceJump } from '../chat/branchSource';
import type { Highlight, MessageHighlight } from '../types';

const pdfHighlight = (id: string, chatId: string | null): Highlight => ({
  id,
  paperId: 'paper-1',
  color: 'pink',
  text: 'we scale the dot products',
  pageNumber: 4,
  rects: [],
  chatId,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
});

const chatHighlight = (id: string, childChatId: string | null): MessageHighlight => ({
  id,
  messageId: 'm1',
  chatId: 'root',
  childChatId,
  startOffset: 0,
  endOffset: 11,
  text: 'eight heads',
  color: 'yellow',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
});

describe('branchSourceJump', () => {
  it('points at the PDF highlight a branch was opened from', () => {
    const jump = branchSourceJump('branch', {
      pdfHighlights: [pdfHighlight('h1', 'other'), pdfHighlight('h2', 'branch')],
      parentHighlights: [],
    });
    expect(jump).toEqual({ kind: 'pdf', highlightId: 'h2' });
  });

  it('points at the chat-text highlight when there is no PDF one', () => {
    const jump = branchSourceJump('branch', {
      pdfHighlights: [],
      parentHighlights: [chatHighlight('mh1', 'branch')],
    });
    expect(jump).toEqual({
      kind: 'chat',
      chatId: 'root',
      messageId: 'm1',
      startOffset: 0,
      endOffset: 11,
      color: 'yellow',
      highlightId: 'mh1',
    });
  });

  it('prefers the PDF highlight when a branch has both', () => {
    const jump = branchSourceJump('branch', {
      pdfHighlights: [pdfHighlight('h2', 'branch')],
      parentHighlights: [chatHighlight('mh1', 'branch')],
    });
    expect(jump).toMatchObject({ kind: 'pdf' });
  });

  it('returns null for a branch opened without a highlight', () => {
    // "Open as new chat" without a colour has no source to jump to — the
    // click then only switches chats, as before (mockup-mindmap-lens-final
    // §03).
    expect(branchSourceJump('branch', { pdfHighlights: [], parentHighlights: [] })).toBeNull();
  });
});
