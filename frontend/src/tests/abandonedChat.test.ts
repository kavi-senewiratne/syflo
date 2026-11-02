/**
 * abandonedChat.test.ts
 *
 * The Abandoned chat definition (CONTEXT.md): a root chat with no messages, no
 * branches, no source, not pinned. It must stay identical to
 * backend/cleanup.js — an HTML source counts as a source exactly like a paper
 * or a video, otherwise leaving the freshly imported lecture would delete it.
 */

import { describe, it, expect } from 'vitest';
import { isAbandonedChat } from '../chat/abandoned';

const empty = { parent_id: null, messages: [], children: [], pinned_at: null };
const none = { paper: null, video: null, html: null, streaming: false };

describe('isAbandonedChat', () => {
  it('is true for an empty root chat with no source', () => {
    expect(isAbandonedChat(empty, none)).toBe(true);
  });

  it.each([
    ['a PDF', { paper: { id: 'p' } }],
    ['a YouTube transcript', { video: { id: 'v' } }],
    ['an HTML source', { html: { id: 'h' } }],
    ['a running stream', { streaming: true }],
  ])('is false while the tree has %s', (_name, over) => {
    expect(isAbandonedChat(empty, { ...none, ...over } as never)).toBe(false);
  });

  it.each([
    ['a message', { messages: [{ id: 'm' }] }],
    ['a branch', { children: [{ id: 'c' }] }],
    ['a parent (it is a branch)', { parent_id: 'p' }],
    ['a pin', { pinned_at: '2026-09-29T10:00:00Z' }],
  ])('is false with %s', (_name, over) => {
    expect(isAbandonedChat({ ...empty, ...over } as never, none)).toBe(false);
  });
});
