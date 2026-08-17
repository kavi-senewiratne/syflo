import { describe, it, expect } from 'vitest';
import { insertBranchLinks } from '../markdown/branchLinks';

const V = { word: 'V', chatId: 'a40a9fd4-93b5-4826-8d47-9851de7636c3' };

describe('insertBranchLinks', () => {
  it('links a word in prose', () => {
    expect(insertBranchLinks('Das Vokabular V ist groß.', [V])).toBe(
      `Das Vokabular [V](branch:${V.chatId}) ist groß.`,
    );
  });

  it('never writes link syntax INSIDE a formula (user screenshot 2026-08-12)', () => {
    // Der Kern des Bugs: `$[V](branch:…)$` ließ KaTeX die Link-Syntax setzen.
    const out = insertBranchLinks('ein Vokabular $V$ von $100.000$ Wörtern', [V]);
    expect(out).not.toContain('$[V]');
    expect(out).toContain(`[$V$](branch:${V.chatId})`);
  });

  it('links a formula whose body IS the word, as a whole span', () => {
    expect(insertBranchLinks('Größe $V$ hier', [V])).toBe(
      `Größe [$V$](branch:${V.chatId}) hier`,
    );
  });

  it('leaves formulas that merely CONTAIN the word untouched', () => {
    expect(insertBranchLinks('die Matrix $|V| \\times m$ hier', [V])).toBe(
      'die Matrix $|V| \\times m$ hier',
    );
  });

  it('handles the raw Gemini delimiters, too (runs before normalizeMathDelimiters)', () => {
    expect(insertBranchLinks('ein \\(V\\) und \\(x + V\\)', [V])).toBe(
      `ein [\\(V\\)](branch:${V.chatId}) und \\(x + V\\)`,
    );
  });

  it('never links inside code fences or inline code', () => {
    const md = 'Text V\n\n```js\nconst V = 1;\n```\n\nund `V` inline';
    const out = insertBranchLinks(md, [V]);
    expect(out).toContain('const V = 1;');
    expect(out).toContain('`V` inline');
    expect(out).toContain(`Text [V](branch:${V.chatId})`);
  });

  it('never matches inside a link it has already written', () => {
    // "branch" als Wort würde sonst im eingefügten `](branch:…)` zuschlagen,
    // "a" und "4" in der Chat-ID.
    const words = [V, { word: 'branch', chatId: 'other-id' }];
    const out = insertBranchLinks('Das Vokabular V.', words);
    expect(out).toBe(`Das Vokabular [V](branch:${V.chatId}).`);
  });

  it('does not nest one branch word inside another word’s link text', () => {
    const words = [
      { word: 'word feature vectors', chatId: 'long-id' },
      { word: 'vectors', chatId: 'short-id' },
    ];
    const out = insertBranchLinks('lernt word feature vectors gemeinsam', words);
    expect(out).toBe('lernt [word feature vectors](branch:long-id) gemeinsam');
  });

  it('links words that start or end with punctuation (\\b would fail there)', () => {
    const words = [{ word: 'non-parametric density estimation,', chatId: 'p-id' }];
    const out = insertBranchLinks('via non-parametric density estimation, etwa', words);
    expect(out).toBe('via [non-parametric density estimation,](branch:p-id) etwa');
  });

  it('matches case-insensitively but keeps the text as written', () => {
    const words = [{ word: 'perplexität', chatId: 'p-id' }];
    expect(insertBranchLinks('Die Perplexität sinkt.', words)).toBe(
      'Die [Perplexität](branch:p-id) sinkt.',
    );
  });

  it('returns the content untouched without branch words', () => {
    expect(insertBranchLinks('nichts zu tun', [])).toBe('nichts zu tun');
  });

  // ─── occurrence: nur EINE Stelle verlinken (Nutzerentscheid 2026-08-13,
  // design/mockup-simply-blue-fixes.html §04, Variante A) ───────────────────
  describe('occurrence', () => {
    const LA = (occurrence?: number) => [{ word: 'Leaky Abstraction', chatId: 'la-id', occurrence }];
    const three = 'Als „Leaky Abstraction“ gilt: eine Leaky Abstraction lügt. Wer leaky abstraction kennt …';

    it('links every occurrence when no occurrence is given (unchanged path)', () => {
      const out = insertBranchLinks(three, LA());
      expect(out.match(/\(branch:la-id\)/g)).toHaveLength(3);
    });

    it('links only the requested occurrence', () => {
      const out = insertBranchLinks(three, LA(1));
      expect(out.match(/\(branch:la-id\)/g)).toHaveLength(1);
      expect(out).toContain('eine [Leaky Abstraction](branch:la-id) lügt');
      expect(out).toContain('Als „Leaky Abstraction“ gilt');
    });

    it('counts across paragraphs and keeps the written casing', () => {
      const out = insertBranchLinks(three, LA(2));
      expect(out).toContain('Wer [leaky abstraction](branch:la-id) kennt');
    });

    it('counts only OPEN text — a hit inside code is not an occurrence', () => {
      const md = 'siehe `Leaky Abstraction` im Log, eine Leaky Abstraction lügt';
      const out = insertBranchLinks(md, LA(0));
      expect(out).toContain('`Leaky Abstraction`');
      expect(out).toContain('eine [Leaky Abstraction](branch:la-id) lügt');
    });

    it('links nothing when the message has fewer occurrences than asked for', () => {
      // Kann beim Streamen passieren: die Stelle ist noch nicht geschrieben.
      expect(insertBranchLinks('nur eine Leaky Abstraction', LA(4))).toBe(
        'nur eine Leaky Abstraction',
      );
    });

    it('links nothing for a negative occurrence (noch nicht gemessen)', () => {
      expect(insertBranchLinks(three, LA(-1))).toBe(three);
    });

    it('leaves other branch words on the all-occurrences rule', () => {
      const words = [
        { word: 'Leaky Abstraction', chatId: 'la-id', occurrence: 0 },
        { word: 'Tensorebene', chatId: 't-id' },
      ];
      const out = insertBranchLinks(
        'Leaky Abstraction: auf Tensorebene, immer auf Tensorebene. Leaky Abstraction bleibt.',
        words,
      );
      expect(out.match(/\(branch:la-id\)/g)).toHaveLength(1);
      expect(out.match(/\(branch:t-id\)/g)).toHaveLength(2);
    });

    it('counts and links PROSE only — a formula span is neither', () => {
      // Mit occurrence zählt nur offener Text, weil der Zähler im DOM
      // (chat/markedOccurrence.ts) Formeln ebenso überspringt. Formel-Zweige
      // laufen deshalb weiter über den Alle-Vorkommen-Pfad (occurrence
      // undefined) — sonst würden die beiden Zähler auseinanderlaufen.
      const out = insertBranchLinks('erst $V$, dann V in Prosa', [
        { word: 'V', chatId: 'v-id', occurrence: 0 },
      ]);
      expect(out).toBe('erst $V$, dann [V](branch:v-id) in Prosa');
    });
  });
});
