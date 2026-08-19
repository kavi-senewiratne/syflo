/**
 * tests/overview-progress.test.js
 *
 * Wie weit eine Video-Übersicht wirklich gekommen ist — abgelesen an ihren
 * eigenen Zeitmarken statt am Wort des Anbieters.
 *
 * Der Anlass, am 2026-08-18 in der laufenden App gemessen: Flash Lite beendete
 * eine Übersicht sauber (`finish=stop`) nach 16:16 eines 1:06:31 langen Videos.
 * Kein Abbruch, also kein Signal — der Leser bekam ein Viertel und keinen
 * Hinweis. Die Uhr weiß es besser als das Modell.
 */

const {
  lastCoveredSeconds,
  isShortOfEnd,
  transcriptFrom,
  formatMark,
} = require('../overview-progress');

const OVERVIEW = [
  '## Einführung und KI-Psychose [00:00 - 03:34]',
  '**Kernaussage.**',
  '## Software-Refaktorierung [12:56 - 16:16]',
  '**Kernaussage.**',
].join('\n\n');

describe('lastCoveredSeconds', () => {
  it('liest das ENDE des letzten Abschnitts, nicht dessen Anfang', () => {
    expect(lastCoveredSeconds(OVERVIEW)).toBe(16 * 60 + 16);
  });

  it('versteht Marken jenseits der Stunde', () => {
    expect(lastCoveredSeconds('## Ausblick [1:02:01 - 1:21:52]')).toBe(1 * 3600 + 21 * 60 + 52);
  });

  it('sagt nichts, wenn die Antwort abbrach, bevor die erste Marke stand', () => {
    expect(lastCoveredSeconds('Hier ist die vollständige Gliederung:\n\n### Einleitung')).toBeNull();
  });
});

describe('isShortOfEnd', () => {
  it('erkennt die Übersicht, die nach einem Viertel des Videos aufhört', () => {
    expect(isShortOfEnd(16 * 60 + 16, 3991)).toBe(true);
  });

  it('lässt ein fehlendes Outro in Ruhe', () => {
    // 1:21:52 von 1:21:56 — vier Sekunden Abspann sind keine Runde wert.
    expect(isShortOfEnd(1 * 3600 + 21 * 60 + 52, 4916)).toBe(false);
  });

  it('hat ohne bekannte Videolänge keine Meinung', () => {
    // Eine Behauptung, die einen bezahlten Aufruf auslöst, wird gemessen —
    // nicht geraten.
    expect(isShortOfEnd(60, null)).toBe(false);
  });
});

describe('transcriptFrom', () => {
  const transcript = [
    '[00:00] Hallo zusammen.',
    '[07:30] Jetzt zum Vortraining.',
    '[16:00] Und hier die Feinabstimmung.',
    '[24:10] Zum Schluss die Werkzeuge.',
  ].join('\n\n');

  it('behält den Block, in dem die Antwort stehen blieb, und wirft den Rest davor weg', () => {
    const rest = transcriptFrom(transcript, 16 * 60 + 16);

    expect(rest.text).toBe('[16:00] Und hier die Feinabstimmung.\n\n[24:10] Zum Schluss die Werkzeuge.');
    expect(rest.fromSeconds).toBe(16 * 60);
    expect(rest.droppedChars).toBeGreaterThan(0);
  });

  it('gibt nichts zurück, wenn ohnehin alles stehen bliebe', () => {
    expect(transcriptFrom(transcript, 10)).toBeNull();
    expect(transcriptFrom(transcript, null)).toBeNull();
  });
});

describe('formatMark', () => {
  it('schreibt Marken so, wie die Übersicht sie schreibt', () => {
    expect(formatMark(16 * 60 + 16)).toBe('16:16');
    expect(formatMark(3991)).toBe('1:06:31');
  });
});

/**
 * Die Abschnitte, die der Nutzer in der MITTE fand (Report mit Bild
 * 2026-08-18, zweite Runde): Seine Einstellungen verlangen „am Ende jeder
 * Antwort" ein mentales Modell und einen Coaching-Abschnitt. Das Modell hält
 * sich daran — schon am Ende der ERSTEN Runde, bevor es überhaupt eine
 * Fortsetzungs-Anweisung gibt. Danach hängt die Fortsetzung weitere Kapitel
 * an, und die Schluss-Abschnitte stehen mittendrin.
 *
 * Eine Anweisung an das Modell kann das nicht heilen, weil die Runde, die sie
 * schreibt, die Anweisung nie zu sehen bekommt. Also werden sie beim
 * Weiterschreiben abgeschnitten: Eine Übersicht besteht aus Abschnitten MIT
 * Zeitmarke — was danach kommt, gehört ans wirkliche Ende.
 */
const { trimTrailingClosing } = require('../overview-progress');

describe('trimTrailingClosing', () => {
  const overview = [
    '## Einführung [00:00 - 03:34]',
    '**Kernaussage.**',
    '## Refaktorierung [12:56 - 16:16]',
    '**Kernaussage.**',
  ].join('\n\n');

  it('schneidet die Schluss-Abschnitte hinter dem letzten Kapitel weg', () => {
    const withClosing = `${overview}\n\n---\n\n### Mentales Modell\nDas Denkmuster ist …\n\n### German Coaching\n* **Original:** …`;

    expect(trimTrailingClosing(withClosing)).toBe(overview);
  });

  it('nimmt die Zwischenbemerkung des Modells gleich mit', () => {
    const withNote = `${overview}\n\n*(Hinweis: Das Video ist sehr lang, ich höre hier auf.)*\n\n### Mentales Modell\nDas Denkmuster …`;

    expect(trimTrailingClosing(withNote)).toBe(overview);
  });

  it('lässt eine Übersicht ohne Schluss-Abschnitte unangetastet', () => {
    expect(trimTrailingClosing(overview)).toBe(overview);
  });

  it('fasst den Inhalt eines Kapitels nicht an', () => {
    const withBullets = `${overview}\n\n* **Punkt**: Detail.\n* **Punkt**: Detail.`;

    expect(trimTrailingClosing(withBullets)).toBe(withBullets);
  });
});
