/**
 * timeLinks: Zeitmarken einer Video overview werden zu Links auf die Sekunde.
 * Geprüft wird vor allem, WO nicht ersetzt werden darf — dieselbe Falle, die
 * branchLinks am 2026-08-12 in Formeln getappt ist.
 */
import { describe, it, expect } from 'vitest';
import { insertTimeLinks, lastTimeMark, parseChapterHeading, parseTimestamp, youtubeTimeUrl } from '../markdown/timeLinks';

describe('parseTimestamp', () => {
  it('rechnet m:ss und h:mm:ss in Sekunden um', () => {
    expect(parseTimestamp('0:00')).toBe(0);
    expect(parseTimestamp('7:40')).toBe(460);
    expect(parseTimestamp('1:02:33')).toBe(3753);
  });

  it('weist unmögliche Zeiten ab, statt irgendwohin zu verlinken', () => {
    // [99:99] ist keine Zeit — eher ein Zahlenpaar in Klammern.
    expect(parseTimestamp('99:99')).toBeNull();
    expect(parseTimestamp('1:99:00')).toBeNull();
    expect(parseTimestamp('abc')).toBeNull();
  });
});

describe('youtubeTimeUrl', () => {
  it('hängt ganze Sekunden mit Einheit an', () => {
    expect(youtubeTimeUrl('dQw4w9WgXcQ', 460)).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=460s',
    );
  });
});

describe('insertTimeLinks', () => {
  it('verlinkt eine einzelne Marke', () => {
    expect(insertTimeLinks('Der Aufbau [3:15] wird erklärt.')).toBe(
      'Der Aufbau [3:15](t:195) wird erklärt.',
    );
  });

  it('verlinkt eine Spanne als EIN Link auf den Anfang', () => {
    // Der Endzeitpunkt sagt nur, wie lang der Abschnitt ist — springen will
    // man an den Anfang.
    expect(insertTimeLinks('## Aufmerksamkeit [3:15–7:40]')).toBe(
      '## Aufmerksamkeit [3:15–7:40](t:195)',
    );
    expect(insertTimeLinks('[3:15 - 7:40]')).toBe('[3:15 - 7:40](t:195)');
  });

  it('fasst Stunden-Marken', () => {
    expect(insertTimeLinks('[1:02:33]')).toBe('[1:02:33](t:3753)');
  });

  it('lässt Code und Formeln unangetastet', () => {
    expect(insertTimeLinks('`[3:15]` bleibt Text')).toBe('`[3:15]` bleibt Text');
    expect(insertTimeLinks('```\n[3:15]\n```')).toBe('```\n[3:15]\n```');
    expect(insertTimeLinks('$a_{[3:15]}$')).toBe('$a_{[3:15]}$');
    expect(insertTimeLinks('$$\n[3:15]\n$$')).toBe('$$\n[3:15]\n$$');
  });

  it('ist idempotent — ein zweiter Lauf hängt keinen zweiten Link an', () => {
    // Genau das passiert sonst, wenn das Modell die Marke selbst schon als
    // Link schreibt oder die Funktion zweimal läuft.
    const einmal = insertTimeLinks('[3:15]');
    expect(insertTimeLinks(einmal)).toBe(einmal);
  });

  it('rührt einen bestehenden Zweig-Link nicht an', () => {
    const mit = 'Siehe [Aufmerksamkeit](branch:abc) bei [3:15]';
    expect(insertTimeLinks(mit)).toBe('Siehe [Aufmerksamkeit](branch:abc) bei [3:15](t:195)');
  });

  it('lässt Klammerinhalte in Ruhe, die keine Zeit sind', () => {
    expect(insertTimeLinks('[Quelle] und [99:99] und [abc]')).toBe(
      '[Quelle] und [99:99] und [abc]',
    );
  });

  it('verlinkt mehrere Marken in einem Text', () => {
    expect(insertTimeLinks('[0:00] Anfang, [10:30] Mitte')).toBe(
      '[0:00](t:0) Anfang, [10:30](t:630) Mitte',
    );
  });
});

describe('insertTimeLinks – nackte Überschriften-Spannen (Groq gpt-oss-120b, 2026-09-01)', () => {
  // Das Modell schrieb "## 0:04 – 0:34 – Titel": Spanne vorn, ohne eckige
  // Klammern. Ohne diese Behandlung war kein Zeitstempel der Übersicht
  // klickbar.
  it('verlinkt die nackte vordere Spanne einer Überschrift', () => {
    expect(insertTimeLinks('## 0:04 – 0:34 – Einführung und Kontext')).toBe(
      '## [0:04 – 0:34](t:4) – Einführung und Kontext',
    );
  });

  it('verlinkt die nackte Spanne am Ende einer Überschrift', () => {
    expect(insertTimeLinks('## Einführung – 0:04 – 0:34')).toBe(
      '## Einführung – [0:04 – 0:34](t:4)',
    );
  });

  it('ist idempotent — die schon verlinkte Spanne bleibt, wie sie ist', () => {
    const einmal = insertTimeLinks('## 0:04 – 0:34 – Einführung');
    expect(insertTimeLinks(einmal)).toBe(einmal);
  });

  it('verlinkt nackte Marken in Prosa weiterhin NICHT', () => {
    // Die Videolänge steht als nackte Zahl im Prompt und wird gern echot
    // (gemessen 2026-08-30) — Prosa-Marken ohne Klammern bleiben Text.
    expect(insertTimeLinks('Das Video endet bei 47:40.')).toBe('Das Video endet bei 47:40.');
  });

  it('lässt eine Überschrift im Codezaun in Ruhe', () => {
    const zitiert = '```\n## 0:04 – 0:34 – Einführung\n```';
    expect(insertTimeLinks(zitiert)).toBe(zitiert);
  });
});

describe('lastTimeMark', () => {
  it('liest das Ende der letzten Klammer-Spanne', () => {
    expect(lastTimeMark('## A [0:03 - 5:12]\n\n## B [5:12 - 9:55]')).toBe('9:55');
  });

  it('liest auch die nackte Überschriften-Spanne (Groq gpt-oss-120b, 2026-09-01)', () => {
    expect(lastTimeMark('## 0:04 – 0:34 – Einführung\n\n## 9:23 – 9:55 – Schluss')).toBe('9:55');
  });

  it('zählt eine nackte Marke in Prosa weiter nicht', () => {
    expect(lastTimeMark('Der Rest des Videos, bis 3:57:44, fehlt.')).toBeNull();
  });
});

// ─── Typografische Bindestriche ───────────────────────────────────────────
// Gemessen am 2026-09-02: gpt-oss-120b schrieb "[0:01 ‑ 0:39]" mit U+2011
// (nicht umbrechender Bindestrich) und schmalen geschützten Leerzeichen.
// Auf dem Bildschirm nicht von einem normalen Bindestrich zu unterscheiden —
// es entstand aber KEIN einziges Kapitel.
describe('Bindestrich-Varianten in Kapitelüberschriften', () => {
  const dashes: [string, string][] = [
    ['-', 'Bindestrich'],
    ['‐', 'Trennstrich'],
    ['‑', 'nicht umbrechender Bindestrich'],
    ['–', 'Halbgeviertstrich'],
    ['—', 'Geviertstrich'],
    ['−', 'Minus'],
  ];

  it.each(dashes)('erkennt den Bereich mit %s (%s)', (dash) => {
    const head = parseChapterHeading(`## Einführung [0:01 ${dash} 0:39]`);
    expect(head?.startSeconds).toBe(1);
    expect(head?.endSeconds).toBe(39);
  });

  it('stolpert nicht über schmale geschützte Leerzeichen', () => {
    const head = parseChapterHeading('## Einführung [0:01 ‑ 0:39]');
    expect(head?.startSeconds).toBe(1);
    expect(head?.endSeconds).toBe(39);
  });
});

// Ein Kapitel, dessen Überschrift NUR ein Zeitbereich ist (kein Thementitel):
// `## 10:09 – 13:13`. Ohne eigenen Zweig backtrackte LEADING_HEADING_RE und
// nahm die ENDZEIT als Titel — in der Kapitelleiste stand dann „13:13" als
// Kapitelname (Nutzer-Report 2026-09-06, neu importiertes Steve-Jobs-Video).
describe('reine Zeitbereich-Überschriften (ohne Titel)', () => {
  it('parst „## 10:09 – 13:13" als Bereich mit leerem Titel', () => {
    const head = parseChapterHeading('## 10:09 – 13:13');
    expect(head?.startSeconds).toBe(10 * 60 + 9);
    expect(head?.endSeconds).toBe(13 * 60 + 13);
    expect(head?.title).toBe('');
  });

  it('nimmt die Endzeit NICHT als Titel', () => {
    const head = parseChapterHeading('## 10:09 – 13:13');
    expect(head?.title).not.toBe('13:13');
  });

  it('parst auch mit schmalem geschütztem Leerzeichen und Zeilenumbruch-Leerzeichen', () => {
    const head = parseChapterHeading('## 00:00 – 00:30  ');
    expect(head?.startSeconds).toBe(0);
    expect(head?.endSeconds).toBe(30);
    expect(head?.title).toBe('');
  });

  it('parst einen bracketierten reinen Bereich', () => {
    const head = parseChapterHeading('## [1:00:27 – 1:02:53]');
    expect(head?.startSeconds).toBe(3627);
    expect(head?.endSeconds).toBe(3773);
    expect(head?.title).toBe('');
  });

  it('fasst eine Überschrift mit nur EINER Uhrzeit nicht als Bereich an', () => {
    // Nur eine Marke ohne Trenner → gar kein Kapitel (bestehende Regel), und
    // der range-only-Zweig (zwei Marken nötig) rührt sie nicht an.
    expect(parseChapterHeading('## 12:30 Uhr Mittagessen')).toBeNull();
  });
});
