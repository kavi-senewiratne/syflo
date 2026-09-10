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
  capCoverage,
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

  it('ignoriert eine nackte Videolänge in Schluss-Prosa (Groq gpt-oss-120b, 2026-08-30)', () => {
    // Die Fortsetzungs-Anweisung nennt die Videolänge OHNE Klammern
    // ("…the video runs to 3:57:44"), und ein Modell echot sie manchmal in
    // seinem eigenen Schlusssatz zurück. Ohne Klammer-Pflicht läse
    // lastCoveredSeconds das als "bis zum Ende gekommen" — obwohl die
    // letzte ECHTE Kapitelmarke weit davor liegt.
    const stalled =
      OVERVIEW +
      '\n\n--- End of available transcript. The remainder of the video ' +
      '(up to 3:57:44) is not included in the provided transcript, so I ' +
      'cannot continue further.';

    expect(lastCoveredSeconds(stalled)).toBe(16 * 60 + 16);
  });

  it('liest nackte Spannen in Überschriften (Groq gpt-oss-120b, 2026-09-01)', () => {
    // Dasselbe Modell, das am 2026-08-30 noch Klammern schrieb, lieferte am
    // 2026-09-01 "## 0:04 – 0:34 – Titel" — Spanne vorn, keine Klammern.
    // Ohne diese Lesart blieb die Übersicht still bei 9:55 von 47:40 stehen:
    // kein Fortschritt lesbar, kein Auto-Weiterschreiben.
    const bare = [
      '## 0:04 – 0:34 – Einführung und Kontext',
      '**Kernaussage.**',
      '## 9:23 – 9:55 – Entscheidung für Enterprise-Anwendungen',
      '**Kernaussage.**',
    ].join('\n\n');

    expect(lastCoveredSeconds(bare)).toBe(9 * 60 + 55);
  });

  it('liest die nackte Spanne auch am ENDE einer Überschrift', () => {
    expect(lastCoveredSeconds('## Einführung – 0:04 – 0:34')).toBe(34);
  });

  it('ignoriert eine nackte Marke MITTEN in einer Überschrift', () => {
    // Auch eine Überschrift kann die vorgesagte Videolänge echoen — nur eine
    // Spanne am Anfang oder Ende der Überschrift ist eine Kapitelmarke.
    expect(lastCoveredSeconds('## Der Rest bis 3:57:44 fehlt im Transkript')).toBeNull();
  });

  it('ignoriert eine einzelne nackte Marke am Überschriften-Ende („um 10:30")', () => {
    expect(lastCoveredSeconds('## Treffen um 10:30')).toBeNull();
  });
});

describe('capCoverage', () => {
  // Gemessen am 2026-09-02 (Neel Nanda, 3:57:44 = 14 264 s): Das Transkript
  // war bei 1:41:43 (6 103 s) abgeschnitten, der Kürzungshinweis nannte die
  // volle Videolänge, und das Modell schloss mit "[1:41:43 - 3:57:44]" ab —
  // ein Kapitel von 2 h 16 min über Material, das es nie gesehen hat.
  const CUT = 6103;
  const DURATION = 14264;

  it('deckelt die abgeschriebene Videolänge auf das, was das Modell sehen konnte', () => {
    expect(capCoverage(DURATION, CUT)).toBe(CUT);
    // …und erst dadurch wird der Rest wieder als fehlend erkannt.
    expect(isShortOfEnd(DURATION, DURATION)).toBe(false);
    expect(isShortOfEnd(capCoverage(DURATION, CUT), DURATION)).toBe(true);
  });

  it('lässt eine ehrliche Marke unter der Schnittstelle unangetastet', () => {
    expect(capCoverage(5000, CUT)).toBe(5000);
  });

  it('deckelt nichts, wenn nichts abgeschnitten wurde', () => {
    expect(capCoverage(DURATION, null)).toBe(DURATION);
    expect(capCoverage(DURATION, undefined)).toBe(DURATION);
  });

  it('reicht "keine Marke" unverändert durch', () => {
    expect(capCoverage(null, CUT)).toBe(null);
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

  it('lässt sich von einer echoten Videolänge in Schluss-Prosa nicht täuschen', () => {
    // Vorher: lastCoveredSeconds las die nackte "3:57:44" aus dem Schlusssatz
    // als erreichtes Ende, isShortOfEnd(14264, 14264) wurde false, und
    // POST /continue gab 409 "nothing to continue" zurück — bei einem 4-Std.-
    // Video, dessen Übersicht bei Minute 16 stehen geblieben war.
    const stalled =
      OVERVIEW +
      '\n\n--- End of available transcript. The remainder of the video ' +
      '(up to 3:57:44) is not included in the provided transcript, so I ' +
      'cannot continue further.';

    expect(isShortOfEnd(lastCoveredSeconds(stalled), 14264)).toBe(true);
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

  // Nutzerbericht mit Bild 2026-09-04: Jede Runde endete mit dieser Zeile,
  // und weil die Runden zu EINER Antwort zusammenwachsen, stand am Ende eine
  // Reihe davon zwischen den Kapiteln.
  it('schneidet auch die Transkript-Schlusszeile ohne "Hinweis:" weg', () => {
    const withEnd = `${overview}\n\n*Ende des verfügbaren Transkripts bei [36:30].*`;
    expect(trimTrailingClosing(withEnd)).toBe(overview);

    const otherWording = `${overview}\n\nEnde des transkribierten Abschnitts bei [27:05].`;
    expect(trimTrailingClosing(otherWording)).toBe(overview);

    const english = `${overview}\n\n*The available transcript ends at [36:30].*`;
    expect(trimTrailingClosing(english)).toBe(overview);
  });

  it('lässt einen Stichpunkt stehen, der das Transkript erwähnt', () => {
    const bullet = `${overview}\n\n- **Quelle**: Er verweist auf das Transkript des Vortrags.`;
    expect(trimTrailingClosing(bullet)).toBe(bullet);
  });

  it('lässt eine Übersicht ohne Schluss-Abschnitte unangetastet', () => {
    expect(trimTrailingClosing(overview)).toBe(overview);
  });

  it('fasst den Inhalt eines Kapitels nicht an', () => {
    const withBullets = `${overview}\n\n* **Punkt**: Detail.\n* **Punkt**: Detail.`;

    expect(trimTrailingClosing(withBullets)).toBe(withBullets);
  });

  it('erkennt auch Kapitel mit nackter Spanne vorn (Groq gpt-oss-120b, 2026-09-01)', () => {
    const bare = [
      '## 0:04 – 0:34 – Einführung',
      '**Kernaussage.**',
      '## 9:23 – 9:55 – Entscheidung',
      '**Kernaussage.**',
    ].join('\n\n');
    const withClosing = `${bare}\n\n*(Hinweis: Ich höre hier auf.)*\n\n### Mentales Modell\nDas Denkmuster …`;

    expect(trimTrailingClosing(withClosing)).toBe(bare);
  });
});

// ─── Die Transkript-Schlusszeile erreicht den Leser nie ─────────────────────
// Nutzerbericht 2026-09-04, zweimal: erst „Ende des verfügbaren Transkripts
// bei [36:30]", und nachdem der Prompt es verboten hatte, erneut „…bei 15:54"
// — auf einem Transkript, das in Wahrheit bis 30:44 reichte. Eine Prompt-Regel
// ist eine Bitte; das hier ist die Garantie.
const { stripRoundSignOff } = require('../overview-progress');

describe('stripRoundSignOff', () => {
  const overview = [
    '## Einführung [00:00 - 03:34]',
    '**Kernaussage.**',
    '## Refaktorierung [12:56 - 15:54]',
    '**Kernaussage.**',
  ].join('\n\n');

  it('entfernt die Schlusszeile in ihren verschiedenen Formulierungen', () => {
    expect(stripRoundSignOff(`${overview}\n\n*Ende des verfügbaren Transkripts bei 15:54.*`)).toBe(overview);
    expect(stripRoundSignOff(`${overview}\n\nEnde des transkribierten Abschnitts bei [27:05].`)).toBe(overview);
    expect(stripRoundSignOff(`${overview}\n\n*The available transcript ends at 15:54.*`)).toBe(overview);
  });

  it('lässt einen Stichpunkt stehen, der das Transkript erwähnt', () => {
    const withBullet = `${overview}\n\n- **Super-Variante:** (Erwähnt, aber Detail nicht im Transkript enthalten).`;
    expect(stripRoundSignOff(withBullet)).toBe(withBullet);
  });

  it('lässt die Schluss-Abschnitte einer fertigen Übersicht in Ruhe', () => {
    const withClosing = `${overview}\n\n### Mentales Modell\nDas Denkmuster …`;
    expect(stripRoundSignOff(withClosing)).toBe(withClosing);
  });

  // Dritte Formulierung, 2026-09-04 — und diese hatte der Prompt selbst
  // verlangt ("say which minute you reached").
  it('entfernt auch die Fortschritts-Notiz in eckigen Klammern', () => {
    const withNote = `${overview}\n\n[Ich habe Minute 40:39 erreicht und setze im nächsten Schritt ab hier fort.]`;
    expect(stripRoundSignOff(withNote)).toBe(overview);
  });

  it('entfernt eine kursive Fortschritts-Notiz ohne Transkript-Wort', () => {
    const withNote = `${overview}\n\n*Fortsetzung folgt im nächsten Schritt.*`;
    expect(stripRoundSignOff(withNote)).toBe(overview);
  });

  it('lässt einen normalen Schlusssatz stehen', () => {
    const prose = `${overview}\n\nDamit ist der erste Teil des Vortrags abgedeckt.`;
    expect(stripRoundSignOff(prose)).toBe(prose);
  });

  it('lässt eine Übersicht ohne die Zeile unangetastet', () => {
    expect(stripRoundSignOff(overview)).toBe(overview);
    expect(stripRoundSignOff('')).toBe('');
  });
});

// ─── Die fette Kernaussage wird zu Ende gefettet ────────────────────────────
// Nutzerbericht mit Bild 2026-09-04: Das Modell öffnet die Kernaussage mit **
// und vergisst das Schließen — Markdown zeigt dann die Sternchen als Text.
const { closeUnbalancedBold } = require('../overview-progress');

describe('closeUnbalancedBold', () => {
  it('schließt die offene Kernaussage am Zeilenende', () => {
    const broken = '## Fine-Tuning [33:26 - 41:10]\n\n**NVIDIA stellt mit Cosmos eine offene Plattform bereit';
    expect(closeUnbalancedBold(broken)).toBe(
      '## Fine-Tuning [33:26 - 41:10]\n\n**NVIDIA stellt mit Cosmos eine offene Plattform bereit**'
    );
  });

  it('lässt eine korrekt gefettete Zeile in Ruhe', () => {
    const fine = '**Die Kernaussage steht ganz in Sternchen.**';
    expect(closeUnbalancedBold(fine)).toBe(fine);
  });

  it('fasst Stichpunkte mit fettem Kopf nicht an', () => {
    const bullet = '- **Cosmos**: offene Plattform für physische KI.';
    expect(closeUnbalancedBold(bullet)).toBe(bullet);
  });

  it('greift nur bei Zeilen, die MIT ** beginnen', () => {
    const mid = 'Er nennt **Cosmos als Beispiel und redet weiter';
    expect(closeUnbalancedBold(mid)).toBe(mid);
  });

  it('kommt mit leerem Text klar', () => {
    expect(closeUnbalancedBold('')).toBe('');
    expect(closeUnbalancedBold(null)).toBe(null);
  });
});

// Ein Meta-Kommentar, der VOR der ersten Überschrift einer Runde steht (eine
// Entschuldigung, das Transkript sei gekappt, ein „ich ergänze jetzt die
// Abschnitte"), landet nach dem Zusammenfügen mitten in der Übersicht zwischen
// zwei Kapiteln (Nutzer-Report 2026-09-06, Steve-Jobs-Video, Schnitt bei 19:48).
const { stripLeadingNarration } = require('../overview-progress');

describe('stripLeadingNarration', () => {
  const round = [
    '## 10:25 – 11:26',
    '**Das Logo als Prestigeprojekt.**',
    '- Detail eins.',
    '## 11:26 – 12:30',
    '**Der Cube als perfekte Form.**',
  ].join('\n\n');

  it('entfernt die Entschuldigung vor der ersten Überschrift', () => {
    const withPreamble =
      'Die Fortsetzung ist leider nicht möglich: Das Transkript liegt nur bis [19:48] vor.\n\n' +
      'Ich ergänze die vorhandenen Abschnitte hier im geforderten Format:\n\n' +
      round;
    expect(stripLeadingNarration(withPreamble)).toBe(round);
  });

  it('lässt eine Runde, die sauber mit einer Überschrift beginnt, in Ruhe', () => {
    expect(stripLeadingNarration(round)).toBe(round);
  });

  it('rührt einen Naht-Text ohne Überschrift NICHT an (seam-Fortsetzung)', () => {
    // Eine seam-Runde beginnt mitten im Satz — kein „##" davor. Nichts strippen.
    const seam = 'die Aktivierungen dem Arbeitsspeicher entsprechen, und das Modell rechnet weiter.';
    expect(stripLeadingNarration(seam)).toBe(seam);
  });

  it('rührt nichts an, wenn vor der Überschrift ein Stichpunkt steht', () => {
    // Ein Bullet vor der ersten Überschrift ist Inhalt, keine Narration —
    // konservativ nichts entfernen.
    const withBullet = '- ein hängengebliebener Stichpunkt\n\n' + round;
    expect(stripLeadingNarration(withBullet)).toBe(withBullet);
  });

  it('kommt mit leerem Text klar', () => {
    expect(stripLeadingNarration('')).toBe('');
    expect(stripLeadingNarration(null)).toBe(null);
  });
});
