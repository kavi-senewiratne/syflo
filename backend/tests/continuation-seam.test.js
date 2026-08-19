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

const { joinContinuation } = require('../continuation');

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
});
