/**
 * chapters.test.ts
 *
 * Chapters for the video pane (design/mockup-youtube-embed-layout.html § 02,
 * variant C): the sections of a Video overview become a navigable list under
 * the embedded player. The source is the overview message itself — the
 * "##" heading plus its time range, and the bold sentence beneath it as the
 * key point (the shape backend/routes/messages.js asks the model for).
 */

import { describe, it, expect } from 'vitest';
import { parseChapters, activeChapterIndex, pickOverviewMessage, overviewStopsShort } from '../markdown/chapters';
import type { Message } from '../types';

const overview = `## An LLM is two files [0:00 - 7:30]

**A model you can hold in your hand: parameters plus a little code.**

- **parameters.bin**: 140 GB for Llama-2-70B.
- **run.c**: about 500 lines, no internet needed.

## Where the parameters come from [7:30 - 14:14]

**Pre-training compresses the internet, and the compression loses the wording.**

- **Cost**: ~10 TB of text, ~6,000 GPUs, ~12 days, ~$2 M.
`;

describe('parseChapters (video pane, variant C)', () => {
  it('liest Überschrift, Zeitspanne und Kernsatz je Abschnitt', () => {
    const chapters = parseChapters(overview);

    expect(chapters).toHaveLength(2);
    expect(chapters[0]).toMatchObject({
      title: 'An LLM is two files',
      level: 2,
      startSeconds: 0,
      endSeconds: 450,
      keyPoint: 'A model you can hold in your hand: parameters plus a little code.',
    });
    expect(chapters[1].title).toBe('Where the parameters come from');
    expect(chapters[1].startSeconds).toBe(450);
    expect(chapters[1].endSeconds).toBe(854);
  });

  it('markiert den laufenden Abschnitt nach der Spielzeit', () => {
    const chapters = parseChapters(overview);

    expect(activeChapterIndex(chapters, 0)).toBe(0);
    expect(activeChapterIndex(chapters, 449)).toBe(0);
    // Beginnt der erste Abschnitt erst bei 0:02 (im laufenden Chat gemessen,
    // 2026-08-15), ist trotzdem er der laufende — sonst steht die Liste in den
    // ersten Sekunden ohne Marke da.
    expect(activeChapterIndex(parseChapters('## Intro [0:02 - 2:08]'), 0)).toBe(0);
    expect(activeChapterIndex(chapters, 450)).toBe(1);
    // Läuft das Video über den letzten Abschnitt hinaus, bleibt der letzte
    // markiert — sonst verliert die Liste beim Abspann ihre Marke.
    expect(activeChapterIndex(chapters, 3500)).toBe(1);
  });

  it('nimmt nur Überschriften mit Zeitmarke — freie Antworten liefern keine Kapitel', () => {
    expect(parseChapters('## Just a heading\n\nSome prose.')).toEqual([]);
    expect(parseChapters('Kein Markdown, nur ein Satz über [8:58].')).toEqual([]);
    // [99:99] ist keine Zeit (dieselbe Regel wie in timeLinks.ts).
    expect(parseChapters('## Nope [99:99]')).toEqual([]);
  });

  it('nimmt einen Abschnitt ohne Kernsatz mit — nur eben ohne Untertitel', () => {
    const chapters = parseChapters('## Cold open [1:02:33]\n\n- straight into the bullets\n');

    expect(chapters).toHaveLength(1);
    expect(chapters[0].startSeconds).toBe(3753);
    expect(chapters[0].endSeconds).toBeNull();
    expect(chapters[0].keyPoint).toBeNull();
  });
});

const msg = (role: 'user' | 'assistant', content: string, id: string): Message => ({
  id,
  chat_id: 'c1',
  role,
  content,
  created_at: new Date().toISOString(),
});

describe('Unterabschnitte (im laufenden Chat gefunden, 2026-08-15)', () => {
  // Das Modell schreibt neben den "##"-Abschnitten auch "###"-Unterabschnitte.
  // Sie tragen eigene, nützliche Marken — aber der erste teilt oft die
  // Startzeit seines Elternteils (07:48 zweimal in derselben Liste). Ohne
  // Rangfolge sieht ein Klick darauf wie „springt zurück zum Anfang" aus.
  const gemischt = `## 3. Die Zukunft der Datenverarbeitung [7:48 - 13:30]

**Der Rechner wird umgebaut.**

### Die Architektur der Zukunft (2026+) [7:48 - 9:40]

**Das Netz wird der Hauptprozess.**

### Das Prinzip der Überprüfbarkeit [9:40 - 11:24]

**Was sich prüfen lässt, wird automatisiert.**
`;

  it('merkt sich die Ebene der Überschrift', () => {
    const chapters = parseChapters(gemischt);

    expect(chapters.map((c) => c.level)).toEqual([2, 3, 3]);
    expect(chapters.map((c) => c.startSeconds)).toEqual([468, 468, 580]);
  });

  it('markiert den genauesten Abschnitt, in dem die Spielzeit liegt', () => {
    const chapters = parseChapters(gemischt);

    // 7:48 tragen Haupt- UND Unterabschnitt; der Unterabschnitt sagt genauer,
    // wo man ist. Dass ein Klick auf den Hauptabschnitt trotzdem seine eigene
    // Zeile behält, prüft VideoPane.test.tsx.
    expect(activeChapterIndex(chapters, 468)).toBe(1);
    expect(activeChapterIndex(chapters, 500)).toBe(1);
    expect(activeChapterIndex(chapters, 580)).toBe(2);
  });
});

describe('Überschrift eine Ebene zu hoch (Flash Lite, 2026-08-20)', () => {
  // Die Regel verlangt "##". Ein Modell, das seine Abschnitte mit "#" öffnet,
  // hat sie trotzdem geliefert — die Liste dafür ganz wegzuwerfen, kostet den
  // Leser alles wegen eines Rautezeichens.
  const eineRaute = `# Einleitung und Motivation [0:00 - 3:34]

**Karpathy rechnet die Rückwärtsrechnung von Hand.**

# Der erste Rückwärtsschritt [3:34 - 9:10]

**Der Verlust wird nach den Logits abgeleitet.**
`;

  it('nimmt "#"-Abschnitte als Kapitel an', () => {
    const chapters = parseChapters(eineRaute);

    expect(chapters.map((c) => c.startSeconds)).toEqual([0, 214]);
    expect(chapters.map((c) => c.level)).toEqual([1, 1]);
    expect(chapters[0].keyPoint).toBe('Karpathy rechnet die Rückwärtsrechnung von Hand.');
  });

  it('verlangt weiter eine Zeitmarke — sie unterscheidet Kapitel von Prosa', () => {
    expect(parseChapters('# Einleitung und Motivation\n\n**Ohne Marke.**\n')).toEqual([]);
  });
});

// ─── Welche NACHRICHT die Übersicht ist ────────────────────────────────────
// Für die drei Zustände der Pane (mockup-truncated-answer §02) reicht der
// Text nicht: sie muss wissen, ob DIESE Nachricht abgebrochen ist und welche
// ID das Weiterschreiben meint.

describe('pickOverviewMessage', () => {
  it('gibt die Nachricht zurück, nicht nur ihren Text', () => {
    const cut = { ...msg('assistant', overview, 'm2'), truncated: 1 };
    const messages = [msg('user', 'Gliedere das ganze Video…', 'm1'), cut];

    const picked = pickOverviewMessage(messages);

    expect(picked?.id).toBe('m2');
    expect(picked?.truncated).toBe(1);
  });

});

// ─── Offsets der Kapitel im Übersichtstext ─────────────────────────────────
// Nutzerwunsch 2026-08-16: Kapitel sollen farbig markierbar sein. Der Anker
// dafür sind Zeichen-Offsets in die Übersicht — also muss jedes Kapitel
// wissen, wo sein Titel und seine Kernaussage im Text stehen.

describe('parseChapters – Offsets', () => {
  const source = `## Was ist das? [0:03 - 5:12]

**Netze werden herangezüchtet.**

- Ein Punkt.
`;

  it('nennt für Titel und Kernaussage ihren Platz im Übersichtstext', () => {
    const [c] = parseChapters(source);

    expect(source.slice(c.titleOffset, c.titleOffset + c.title.length)).toBe(c.title);
    expect(source.slice(c.keyPointOffset!, c.keyPointOffset! + c.keyPoint!.length)).toBe(c.keyPoint);
  });

  it('lässt den Platz der Kernaussage leer, wenn es keine gibt', () => {
    const [c] = parseChapters('## Nur ein Titel [0:03]\n\n- Direkt ein Punkt.\n');
    expect(c.keyPoint).toBeNull();
    expect(c.keyPointOffset).toBeNull();
  });
});

/**
 * Die zweite Frage an eine Übersicht (2026-08-18): Nicht „wurde sie
 * abgeschnitten?", sondern „ist sie am Videoende angekommen?". Flash Lite
 * meldete `finish=stop` nach 16:16 eines 1:06:31 langen Videos — sauber
 * beendet und trotzdem ein Viertel.
 */
describe('overviewStopsShort', () => {
  it('erkennt die Übersicht, die nach einem Viertel des Videos aufhört', () => {
    const overview = '## Einführung [00:00 - 03:34]\n\n## Refaktorierung [12:56 - 16:16]';

    expect(overviewStopsShort(overview, 3991)).toBe(true);
  });

  it('lässt vier Sekunden Abspann in Ruhe', () => {
    expect(overviewStopsShort('## Ausblick [1:12:30 - 1:21:52]', 4916)).toBe(false);
  });

  it('hat ohne Videolänge und ohne Marke keine Meinung', () => {
    expect(overviewStopsShort('## Einführung [00:00 - 03:34]', null)).toBe(false);
    expect(overviewStopsShort('Hier ist die Gliederung:', 3991)).toBe(false);
  });
});
