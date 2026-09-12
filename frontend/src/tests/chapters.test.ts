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
import { insertTimeLinks } from '../markdown/timeLinks';
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

  it('erkennt die Kernaussage auch mit fett gedrucktem Label statt Ganzzeilen-Fett (Groq gpt-oss-120b, 2026-08-30)', () => {
    const chapters = parseChapters(
      '## Introduction [0:01 – 0:39]\n' +
      '**Kernaussage:** Die äußere, freundliche Fassade verbirgt ein komplexes Innenleben.\n\n' +
      '- **Meme:** ChatGPT wird als Shoggoth dargestellt.\n',
    );

    expect(chapters).toHaveLength(1);
    expect(chapters[0].keyPoint).toBe('Die äußere, freundliche Fassade verbirgt ein komplexes Innenleben');
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

describe('Zeitspanne vorn und ohne Klammern (Groq gpt-oss-120b, 2026-09-01)', () => {
  // Dasselbe Modell, das am 2026-08-30 noch "## Titel [0:01 – 0:39]" schrieb,
  // lieferte am 2026-09-01 "## 0:04 – 0:34 – Titel": Spanne vorn, keine
  // eckigen Klammern. Alle Kapitel gingen verloren, und weil auch keine
  // Fortschritts-Marke lesbar war, blieb die Übersicht still bei 9:55 von
  // 47:40 stehen — das Auto-Weiterschreiben sprang nie an.
  const vorn = `## 0:04 – 0:34 – Einführung und Kontext
**Der Sprecher stellt Anthropic vor und hebt dessen Entwicklung hervor.**
- **Bibliothek:** Einstieg mit persönlicher Note.

## 9:23 – 9:55 – Entscheidung für Enterprise-Anwendungen
**Anthropic wählte bewusst den Unternehmens-Markt.**
- **Strategische Frage:** (Antwort im Video unvollständig, endet bei 9:55).
`;

  it('liest Kapitel, deren Zeitspanne vorn und ohne Klammern steht', () => {
    const chapters = parseChapters(vorn);

    expect(chapters).toHaveLength(2);
    expect(chapters[0]).toMatchObject({
      title: 'Einführung und Kontext',
      startSeconds: 4,
      endSeconds: 34,
      keyPoint: 'Der Sprecher stellt Anthropic vor und hebt dessen Entwicklung hervor.',
    });
    expect(chapters[1].title).toBe('Entscheidung für Enterprise-Anwendungen');
    expect(chapters[1].startSeconds).toBe(563);
    expect(chapters[1].endSeconds).toBe(595);
  });

  it('Offsets zeigen weiter auf den Titel im Originaltext', () => {
    const [c] = parseChapters(vorn);
    expect(vorn.slice(c.titleOffset, c.titleOffset + c.title.length)).toBe(c.title);
  });

  it('overviewStopsShort sieht daran, dass 9:55 von 47:40 erreicht sind', () => {
    expect(overviewStopsShort(vorn, 2860)).toBe(true);
  });

  // Gemessen am 2026-09-02 (Neel Nanda, 3:57:44): Das Transkript endete bei
  // 1:41:43, der Kürzungshinweis nannte die volle Länge, und das Modell schrieb
  // "## Superposition and Polysemanticity [1:41:43 - 3:57:44]". Ohne Deckel las
  // sich die Übersicht als fertig — bei 43 % des Videos.
  it('glaubt einer Schluss-Marke nicht, die über das gesehene Transkript hinausgeht', () => {
    const gefaelscht = '## Superposition and Polysemanticity [1:41:43 - 3:57:44]\n\n**Ende.**';
    expect(overviewStopsShort(gefaelscht, 14264)).toBe(false);
    expect(overviewStopsShort(gefaelscht, 14264, 6103)).toBe(true);
  });

  it('deckelt nichts, wenn das Transkript ungekürzt war', () => {
    const ehrlich = '## Schluss [3:50:00 - 3:57:40]\n\n**Ende.**';
    expect(overviewStopsShort(ehrlich, 14264, null)).toBe(false);
  });

  it('liest die Kapitel auch aus dem bereits verlinkten Text', () => {
    const linked = insertTimeLinks(vorn);
    const chapters = parseChapters(linked);
    expect(chapters).toHaveLength(2);
    expect(chapters[0].startSeconds).toBe(4);
    expect(chapters[0].title).toBe('Einführung und Kontext');
  });

  it('nimmt eine nackte Spanne auch am ENDE der Überschrift', () => {
    const chapters = parseChapters('## Einführung – 0:04 – 0:34\n\n**Satz.**\n');
    expect(chapters).toHaveLength(1);
    expect(chapters[0]).toMatchObject({ title: 'Einführung', startSeconds: 4, endSeconds: 34 });
  });

  it('nimmt eine Spanne in runden Klammern', () => {
    const chapters = parseChapters('## Einführung (0:04 – 0:34)\n');
    expect(chapters).toHaveLength(1);
    expect(chapters[0]).toMatchObject({ title: 'Einführung', startSeconds: 4, endSeconds: 34 });
  });

  it('eine nackte Marke MITTEN in der Überschrift bleibt Prosa (echote Videolänge)', () => {
    // Dieselbe Vorsicht wie in backend/overview-progress.js (2026-08-30): die
    // Videolänge wird dem Modell als nackte Zahl vorgesagt, und ein Echo davon
    // darf nicht als "bis dahin gekommen" zählen.
    expect(parseChapters('## Restliches Video bis 47:40 nicht enthalten\n')).toEqual([]);
  });

  it('eine einzelne nackte Marke am Ende ist kein Kapitel („um 10:30")', () => {
    expect(parseChapters('## Treffen um 10:30\n')).toEqual([]);
  });
});

describe('Zeitmarke allein auf der Folgezeile (Gemini Flash Lite, 2026-09-12)', () => {
  // Hassabis-Vortrag: alle zehn Kapitel trugen ihre Spanne in einer EIGENEN
  // Zeile unter der Überschrift. Kein Kapitel parste, die Video-Pane blieb
  // leer — obwohl die Übersicht im Chat tadellos aussah.
  const folgezeile = `## Eine Reise zur Künstlichen Intelligenz
[0:02 - 5:48]
**Demis Hassabis blickt auf seine akademischen Wurzeln in Cambridge zurück.**
* **Rückkehr nach Cambridge:** Hassabis beschreibt seine emotionale Rückkehr.

## Die Mission von DeepMind

[5:48 - 9:22]

**Intelligenz lösen, um alles andere zu lösen.**
`;

  it('paart die Überschrift mit der Marke aus der Folgezeile', () => {
    const chapters = parseChapters(folgezeile);

    expect(chapters).toHaveLength(2);
    expect(chapters[0]).toMatchObject({
      title: 'Eine Reise zur Künstlichen Intelligenz',
      level: 2,
      startSeconds: 2,
      endSeconds: 348,
      keyPoint: 'Demis Hassabis blickt auf seine akademischen Wurzeln in Cambridge zurück.',
    });
    // Leerzeilen zwischen Überschrift, Marke und Kernsatz sind erlaubt.
    expect(chapters[1]).toMatchObject({
      title: 'Die Mission von DeepMind',
      startSeconds: 348,
      endSeconds: 562,
      keyPoint: 'Intelligenz lösen, um alles andere zu lösen.',
    });
  });

  it('Offsets zeigen weiter auf Titel und Kernsatz im Originaltext', () => {
    const [c] = parseChapters(folgezeile);
    expect(folgezeile.slice(c.titleOffset, c.titleOffset + c.title.length)).toBe(c.title);
    expect(folgezeile.slice(c.keyPointOffset!, c.keyPointOffset! + c.keyPoint!.length)).toBe(c.keyPoint);
  });

  it('liest die Kapitel auch aus dem bereits verlinkten Text', () => {
    const chapters = parseChapters(insertTimeLinks(folgezeile));
    expect(chapters).toHaveLength(2);
    expect(chapters[0].startSeconds).toBe(2);
  });

  it('eine nackte Spanne auf der Folgezeile zählt — zwei Marken mit Strich sind eindeutig', () => {
    const chapters = parseChapters('## Einführung\n0:04 – 0:34\n\n**Satz.**\n');
    expect(chapters).toHaveLength(1);
    expect(chapters[0]).toMatchObject({ title: 'Einführung', startSeconds: 4, endSeconds: 34 });
  });

  it('eine einzelne NACKTE Marke auf der Folgezeile bleibt Prosa (echote Videolänge)', () => {
    expect(parseChapters('## Restliches Video\n47:40\n')).toEqual([]);
  });

  it('eine Überschrift, deren Folgezeile Prosa ist, bleibt kein Kapitel', () => {
    expect(parseChapters('## Zusammenfassung\n\nEin Satz über [8:58] mitten im Text.\n')).toEqual([]);
  });

  it('overviewStopsShort liest die Folgezeilen-Marken als Fortschritt', () => {
    // 5:48 von 61 Minuten → klar zu kurz; die Marke steht nur in Folgezeilen.
    expect(overviewStopsShort('## Reise\n[0:02 - 5:48]\n', 3666)).toBe(true);
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
