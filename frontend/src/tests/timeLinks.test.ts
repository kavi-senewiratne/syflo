/**
 * timeLinks: Zeitmarken einer Video overview werden zu Links auf die Sekunde.
 * Geprüft wird vor allem, WO nicht ersetzt werden darf — dieselbe Falle, die
 * branchLinks am 2026-08-12 in Formeln getappt ist.
 */
import { describe, it, expect } from 'vitest';
import { insertTimeLinks, parseTimestamp, youtubeTimeUrl } from '../markdown/timeLinks';

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
