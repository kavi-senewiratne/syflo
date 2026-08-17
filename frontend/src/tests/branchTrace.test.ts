import { describe, it, expect } from 'vitest';
import { groupBranchTraces } from '../chat/branchTrace';
import type { BranchOrigin, Chat } from '../types';

/**
 * Which branches leave a line in the parent transcript, and where the line
 * goes (design/mockup-branch-trace.html, variant A).
 */

const branch = (
  id: string,
  origin: BranchOrigin | null,
  anchor: string | null,
  created_at = '2026-08-09T10:00:00Z',
): Chat => ({
  id,
  title: `Titel ${id}`,
  parent_id: 'parent',
  parent_word: origin === 'topic' ? null : 'irgendeine Passage',
  created_at,
  branch_origin: origin,
  branch_anchor_message_id: anchor,
});

describe('groupBranchTraces', () => {
  it('puts a /btw branch under the message it was opened after', () => {
    const { byMessageId, leading } = groupBranchTraces(
      [branch('kv', 'btw', 'm2')],
      ['m1', 'm2'],
    );

    expect(leading).toEqual([]);
    expect(byMessageId.get('m2')).toEqual([
      { chatId: 'kv', origin: 'btw', title: 'Titel kv', created_at: '2026-08-09T10:00:00Z' },
    ]);
  });

  it('ignores selection branches — their coloured passage is the trace', () => {
    const { byMessageId, leading } = groupBranchTraces(
      [branch('passage', null, 'm2')],
      ['m1', 'm2'],
    );

    expect(leading).toEqual([]);
    expect(byMessageId.size).toBe(0);
  });

  it('keeps several branches at one anchor in fork order', () => {
    const traces = groupBranchTraces(
      [
        branch('later', 'topic', 'm1', '2026-08-09T12:00:00Z'),
        branch('earlier', 'btw', 'm1', '2026-08-09T09:00:00Z'),
      ],
      ['m1'],
    );

    expect(traces.byMessageId.get('m1')?.map((e) => e.chatId)).toEqual(['earlier', 'later']);
  });

  it('floats a branch opened in an empty chat to the top', () => {
    const { leading, byMessageId } = groupBranchTraces([branch('topic', 'topic', null)], ['m1']);

    expect(leading.map((e) => e.chatId)).toEqual(['topic']);
    expect(byMessageId.size).toBe(0);
  });

  it('floats a branch whose anchor message is gone to the top as well', () => {
    const { leading } = groupBranchTraces([branch('kv', 'btw', 'deleted-message')], ['m1', 'm2']);

    expect(leading.map((e) => e.chatId)).toEqual(['kv']);
  });

  it('survives a chat without children', () => {
    expect(groupBranchTraces(undefined, ['m1'])).toEqual({
      leading: [],
      byMessageId: new Map(),
    });
  });
});
