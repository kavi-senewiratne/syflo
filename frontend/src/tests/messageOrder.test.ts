import { describe, it, expect } from 'vitest';
import { orderMessages } from '../chat/messageOrder';

describe('orderMessages', () => {
  it('sorts messages chronologically by created_at', () => {
    // Reihenfolge-Bug 2026-07-24: die neuere Frage stand über der älteren.
    const out = orderMessages([
      { id: 'q2', role: 'user', created_at: '2026-07-24T21:40:17.401Z' },
      { id: 'a1', role: 'assistant', created_at: '2026-07-24T21:37:35.866Z' },
      { id: 'q1', role: 'user', created_at: '2026-07-24T21:31:34.920Z' },
    ] as any);
    expect(out.map((m: any) => m.id)).toEqual(['q1', 'a1', 'q2']);
  });

  it('keeps user before assistant when both share a timestamp (stable sort)', () => {
    // Optimistische Paare bekommen denselben client-now-Zeitstempel.
    const out = orderMessages([
      { id: 'u', role: 'user', created_at: '2026-07-24T21:00:00.000Z' },
      { id: 'a', role: 'assistant', created_at: '2026-07-24T21:00:00.000Z' },
    ] as any);
    expect(out.map((m: any) => m.id)).toEqual(['u', 'a']);
  });

  it('does not mutate the input array', () => {
    const input = [
      { id: 'b', role: 'user', created_at: '2026-07-24T21:00:02.000Z' },
      { id: 'a', role: 'user', created_at: '2026-07-24T21:00:01.000Z' },
    ] as any;
    const snapshot = input.map((m: any) => m.id);
    orderMessages(input);
    expect(input.map((m: any) => m.id)).toEqual(snapshot);
  });
});
