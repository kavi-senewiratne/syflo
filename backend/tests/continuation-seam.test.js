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
