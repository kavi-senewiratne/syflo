/**
 * tests/thinkingFeed.test.ts
 *
 * Der Zitate-/Tipp-Feed des ThinkingIndicator (Grill 2026-07-22):
 * 50/50-Münzwurf pro Zeile, aktiver Zitat-Pool von 50 mit Ausmusterung
 * nach 3 Anzeigen, Zustand in localStorage.
 */

import { describe, it, expect } from 'vitest';
import { createThinkingFeed, type Quote } from '../components/ChatArea/thinkingFeed';

const memStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
};

const mkQuotes = (n: number): Quote[] =>
  Array.from({ length: n }, (_, i) => ({ text: `quote ${i}`, cite: `author ${i}` }));

describe('thinking feed', () => {
  it('flips a coin per line: below 0.5 shows a tip, above shows a quote', () => {
    let coin = 0.1;
    const feed = createThinkingFeed({
      tips: ['tip a', 'tip b'],
      quotes: mkQuotes(3),
      storage: memStorage(),
      random: () => coin,
    });

    expect(feed.next().kind).toBe('tip');

    coin = 0.9;
    expect(feed.next().kind).toBe('quote');
  });

  it('draws quotes only from a small active pool, not the whole set', () => {
    // Skriptete Zufallswerte: 0.99er für den Shuffle (≈ Identität), danach
    // Paare aus Münzwurf (≥0.5 → Zitat) und Pool-Pick.
    const values = [0.99, 0.99, 0.99, 0.99];
    for (let i = 0; i < 12; i++) values.push(0.9, [0.0, 0.5, 0.99][i % 3]);
    let call = 0;
    const feed = createThinkingFeed({
      tips: ['tip'],
      quotes: mkQuotes(5),
      poolSize: 2,
      showsPerQuote: 99,
      storage: memStorage(),
      random: () => values[Math.min(call++, values.length - 1)],
    });

    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) seen.add(feed.next().text);

    // Nur die 2 Pool-Zitate erscheinen — nie alle 5.
    expect(seen.size).toBeLessThanOrEqual(2);
  });

  it('shows every quote exactly `showsPerQuote` times before the cycle restarts', () => {
    // Immer 0.9: Münzwurf → Zitat, Pool-Pick → letzter Eintrag.
    const feed = createThinkingFeed({
      tips: ['tip'],
      quotes: mkQuotes(5),
      poolSize: 2,
      showsPerQuote: 2,
      storage: memStorage(),
      random: () => 0.9,
    });

    const counts = new Map<string, number>();
    // Genau ein voller Zyklus: 5 Zitate × 2 Anzeigen.
    for (let i = 0; i < 10; i++) {
      const line = feed.next();
      counts.set(line.text, (counts.get(line.text) ?? 0) + 1);
    }

    expect(counts.size).toBe(5);
    for (const n of counts.values()) expect(n).toBe(2);
  });

  it('persists its progress: a new feed on the same storage continues the cycle', () => {
    const storage = memStorage();
    const deps = {
      tips: ['tip'],
      quotes: mkQuotes(5),
      poolSize: 2,
      showsPerQuote: 2,
      storage,
      random: () => 0.9,
    };

    const counts = new Map<string, number>();
    const track = (line: { text: string }) =>
      counts.set(line.text, (counts.get(line.text) ?? 0) + 1);

    const feed1 = createThinkingFeed(deps);
    for (let i = 0; i < 4; i++) track(feed1.next());

    // Neue Instanz (z. B. App-Neustart) — derselbe Zyklus läuft weiter.
    const feed2 = createThinkingFeed(deps);
    for (let i = 0; i < 6; i++) track(feed2.next());

    expect(counts.size).toBe(5);
    for (const n of counts.values()) expect(n).toBe(2);
  });

  it('starts a fresh cycle after every quote has been retired', () => {
    const feed = createThinkingFeed({
      tips: ['tip'],
      quotes: mkQuotes(2),
      poolSize: 2,
      showsPerQuote: 1,
      storage: memStorage(),
      random: () => 0.9,
    });

    const counts = new Map<string, number>();
    // Zwei volle Zyklen à 2 Anzeigen.
    for (let i = 0; i < 4; i++) {
      const line = feed.next();
      counts.set(line.text, (counts.get(line.text) ?? 0) + 1);
    }

    expect(counts.size).toBe(2);
    for (const n of counts.values()) expect(n).toBe(2);
  });

  it('falls back to tips while no quotes are loaded yet', () => {
    const feed = createThinkingFeed({
      tips: ['tip a', 'tip b'],
      quotes: [],
      storage: memStorage(),
      random: () => 0.9, // Münzwurf will ein Zitat — es gibt aber keins.
    });

    expect(feed.next()).toEqual({ kind: 'tip', text: 'tip a' });
    expect(feed.next()).toEqual({ kind: 'tip', text: 'tip b' });
  });

  it('accepts lazily loaded quotes via setQuotes', () => {
    const feed = createThinkingFeed({
      tips: ['tip'],
      quotes: [],
      storage: memStorage(),
      random: () => 0.9,
    });
    expect(feed.next().kind).toBe('tip');

    feed.setQuotes(mkQuotes(3));
    expect(feed.next().kind).toBe('quote');
  });

  it('never shows the same quote twice in a row', () => {
    const feed = createThinkingFeed({
      tips: ['tip'],
      quotes: mkQuotes(3),
      poolSize: 3,
      showsPerQuote: 99,
      storage: memStorage(),
      random: () => 0.9, // konstanter Pick würde naiv immer dasselbe Zitat treffen
    });

    const lines = Array.from({ length: 6 }, () => feed.next());
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i].text).not.toBe(lines[i - 1].text);
    }
  });
});
