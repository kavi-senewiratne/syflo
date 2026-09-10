/**
 * tests/continuation-seam.test.js
 *
 * Die NAHT zwischen einer gekappten Antwort und ihrer Fortsetzung
 * (design/mockup-truncated-answer.html §01). Erster Lauf in der echten App
 * 2026-08-16: aus "…während die Aktivierungen dem" plus "Arbeitsspeicher…"
 * wurde "demArbeitsspeicher" — das Modell liefert kein führendes Leerzeichen,
 * und ob der Text mitten im WORT oder zwischen zwei Wörtern abbrach, sieht man
 * dem Text nicht an.
 *
 * Deshalb wiederholt die Fortsetzung laut Anweisung ihre ersten Wörter, und
 * die Überlappung wird hier weggeschnitten. Das löst beide Fälle mit einer
 * Regel: das wiederholte Stück legt die Naht offen.
 */

const { joinContinuation, seamSuspect, endsMidSentence } = require('../continuation');

describe('joinContinuation', () => {
  it('schneidet die wiederholten Wörter weg, statt sie doppelt zu zeigen', () => {
    const cut = 'Die Gewichte entsprechen dem kompilierten Binärcode, während die Aktivierungen dem';
    const next = 'die Aktivierungen dem Arbeitsspeicher entsprechen.';

    expect(joinContinuation(cut, next)).toBe(
      'Die Gewichte entsprechen dem kompilierten Binärcode, während die Aktivierungen dem Arbeitsspeicher entsprechen.',
    );
  });

  it('heilt ein mitten im Wort gekapptes Ende', () => {
    expect(joinContinuation('…während die Aktivie', 'Aktivierungen dem Speicher entsprechen.')).toBe(
      '…während die Aktivierungen dem Speicher entsprechen.',
    );
  });

  it('setzt ein Leerzeichen, wenn die Fortsetzung ohne Überlappung anschließt', () => {
    // Der Fall aus der laufenden App: "dem" + "Arbeitsspeicher" ergab
    // "demArbeitsspeicher".
    expect(joinContinuation('die Aktivierungen dem', 'Arbeitsspeicher entsprechen.')).toBe(
      'die Aktivierungen dem Arbeitsspeicher entsprechen.',
    );
  });

  it('lässt eine saubere Naht in Ruhe', () => {
    expect(joinContinuation('Ein Satz endet hier.\n\n', '## Nächster Abschnitt')).toBe(
      'Ein Satz endet hier.\n\n## Nächster Abschnitt',
    );
    expect(joinContinuation('Der Satz geht', ' weiter.')).toBe('Der Satz geht weiter.');
  });

  it('verlangt eine Überlappung von einigem Gewicht — "die" ist Zufall, kein Beleg', () => {
    // Kurze Zufallstreffer dürfen nichts wegschneiden: "e" am Ende und "e" am
    // Anfang bedeuten nichts.
    expect(joinContinuation('Das Ende', 'Eine neue Sache beginnt.')).toBe(
      'Das Ende Eine neue Sache beginnt.',
    );
  });
});

/**
 * Die zweite Art von Fortsetzung (2026-08-18): die Antwort ist NICHT gekappt,
 * sie hörte nur zu früh auf — Flash Lite gliederte 16:16 eines 1:06:31 langen
 * Videos und meldete "fertig". Dort gibt es keine Naht zu finden; gebraucht
 * wird die Leerzeile, ohne die der letzte Satz und die neue "##"-Überschrift
 * zusammenkleben und die Überschrift keine mehr ist.
 */
describe('joinContinuation im Anhänge-Modus', () => {
  it('setzt die Leerzeile zwischen fertigen Satz und neue Überschrift', () => {
    const done = 'Technik wird als ephemere Software verstanden, die sich anpasst.';
    const more = '## Werkzeuge und Grenzen [16:16 - 21:03]';

    expect(joinContinuation(done, more, { mode: 'append' })).toBe(
      'Technik wird als ephemere Software verstanden, die sich anpasst.\n\n## Werkzeuge und Grenzen [16:16 - 21:03]',
    );
  });

  it('verdoppelt einen vorhandenen Absatz nicht', () => {
    expect(joinContinuation('…anpasst.\n\n', '## Werkzeuge', { mode: 'append' })).toBe(
      '…anpasst.\n\n## Werkzeuge',
    );
  });
});

/**
 * Was das Modell beim Weiterschreiben zu hören bekommt.
 *
 * Der Anlass (Nutzer-Report mit Bild 2026-08-18): In den Einstellungen steht
 * „Erkläre am Ende jeder Antwort das mentale Modell". Das Modell hielt sich
 * daran — am Ende jeder RUNDE. Weil Runden in dieselbe Nachricht wachsen,
 * stand „## Mentales Modell" zweimal mitten in einer Übersicht.
 */
describe('continuationInstruction', () => {
  const { continuationInstruction } = require('../continuation');

  it('verbietet die Schluss-Abschnitte, solange die Antwort weiterläuft', () => {
    const text = continuationInstruction({ mode: 'seam', untilMark: '1:06:31' });

    expect(text).toMatch(/NOT finished/);
    expect(text).toMatch(/1:06:31/);
  });

  it('nennt beim Früh-Stopp die Stelle und das Videoende', () => {
    const text = continuationInstruction({ mode: 'append', fromMark: '16:16', untilMark: '1:06:31' });

    expect(text).toMatch(/stops at 16:16/);
    expect(text).toMatch(/runs to 1:06:31/);
    expect(text).not.toMatch(/cut off mid-sentence/);
  });

  it('bleibt bei der Naht-Anweisung, wenn wirklich abgeschnitten wurde', () => {
    expect(continuationInstruction({ mode: 'seam' })).toMatch(/cut off mid-sentence/);
  });

  // Sprach-Drift-Fix (Nutzer-Report 2026-09-05): eine deutsche Video overview
  // über einem englischen Transkript kippte mittendrin ins Englische, weil die
  // Anweisung nur „same language" sagte. Jetzt wird die Sprache benannt.
  it('nennt die Sprache ausdrücklich, wenn sie bekannt ist (append)', () => {
    const de = continuationInstruction({ mode: 'append', language: 'de' });
    expect(de).toMatch(/in German/);
    expect(de).not.toMatch(/same format and language/);

    const en = continuationInstruction({ mode: 'append', language: 'en' });
    expect(en).toMatch(/in English/);
  });

  it('nennt die Sprache ausdrücklich, wenn sie bekannt ist (seam)', () => {
    const de = continuationInstruction({ mode: 'seam', language: 'de' });
    expect(de).toMatch(/Keep the same format, in German,/);
  });

  it('fällt ohne Sprachangabe auf „same language" zurück (abwärtskompatibel)', () => {
    expect(continuationInstruction({ mode: 'seam' })).toMatch(/same format and language/);
    expect(continuationInstruction({ mode: 'append' })).toMatch(/same format and language/);
  });
});

describe('detectLanguage', () => {
  const { detectLanguage } = require('../continuation');

  it('erkennt Deutsch an Umlauten und Funktionswörtern', () => {
    expect(detectLanguage('## 0:00 – 0:31\n**Der Einstieg: Karpathy stellt seinen Werdegang vor.**')).toBe('de');
  });

  it('erkennt Englisch', () => {
    expect(detectLanguage('Prompt engineering allows language models to break down complex problems into steps.')).toBe('en');
  });

  it('folgt dem deutschen ANFANG, nicht englischen Fachbegriffen darin', () => {
    // Der reale Fall: deutscher Overview-Text mit englischen Termini —
    // die deutsche Bindesprache muss überwiegen.
    const text = 'Der Daten-Engine-Zyklus bei Tesla: Sammeln, Trainieren, Deployen und Überwachen der Netzwerke.';
    expect(detectLanguage(text)).toBe('de');
  });

  it('gibt null zurück, wenn es kein Signal gibt', () => {
    expect(detectLanguage('')).toBeNull();
    expect(detectLanguage(null)).toBeNull();
    expect(detectLanguage('12:34 56:78 —— ##')).toBeNull();
  });
});

/**
 * The seam the join CANNOT verify (live incident 2026-09-07): the answer broke
 * off at "* Nur " and the continuation opened with "der
 * Normalverteilungsannahme erfüllt ist" — no repeated words, a jump past the
 * middle of the answer. Blind concatenation produced a garbled sentence with a
 * silent gap. `seamSuspect` is the detector; what to do about it (retry once,
 * then append flagged) lives in routes/messages.js.
 */
describe('seamSuspect', () => {
  it('flags the live incident: mid-sentence cut, no repetition, no leading space', () => {
    const cut = '* Einige sind etwas kleiner (1,75 m) oder etwas größer (1,85 m).\n* Nur ';
    const next = 'der Normalverteilungsannahme erfüllt ist, dann gelten die bekannten Verteilungen';
    expect(seamSuspect(cut, next)).toBe(true);
  });

  it('trusts a continuation that repeats its last words — the instructed seam', () => {
    expect(seamSuspect('…während die Aktivierungen dem', 'die Aktivierungen dem Arbeitsspeicher')).toBe(false);
  });

  it('trusts a continuation that opens with a space or line break', () => {
    // A leading space is itself evidence of a deliberate mid-sentence
    // continuation (measured 2026-08-16) — those joins were fine.
    expect(seamSuspect('Die Gewichte entsprechen dem', ' Binärcode der Anwendung.')).toBe(false);
    expect(seamSuspect('Ein Absatz endet mit dem', '\nNächste Zeile')).toBe(false);
  });

  it('trusts any join after a finished sentence', () => {
    expect(seamSuspect('Der Satz ist zu Ende.', 'Ein neuer Gedanke beginnt.')).toBe(false);
    expect(seamSuspect('Der Satz ist zu Ende.**', 'Ein neuer Gedanke beginnt.')).toBe(false);
  });

  it('never flags empty halves', () => {
    expect(seamSuspect('', 'Text')).toBe(false);
    expect(seamSuspect('Text', '')).toBe(false);
  });
});

describe('endsMidSentence', () => {
  it('reads a trailing word, comma or dash as an open sentence', () => {
    expect(endsMidSentence('erstens')).toBe(true);
    expect(endsMidSentence('erstens, ')).toBe(true);
    expect(endsMidSentence('erstens –')).toBe(true);
  });

  it('reads sentence-final punctuation as closed, markdown tails ignored', () => {
    expect(endsMidSentence('Fertig.')).toBe(false);
    expect(endsMidSentence('Fertig!**\n\n')).toBe(false);
    expect(endsMidSentence('Wirklich?')).toBe(false);
    expect(endsMidSentence('')).toBe(false);
  });
});
