/**
 * tests/continuation-condense.test.js
 *
 * A continuation carries the answer so far in CONDENSED form.
 *
 * Measured 2026-09-04 in the running app: a Video overview that had grown to
 * 36 422 characters made Groq answer `413 Request too large … Limit 8000,
 * Requested 14696`. The source budget was already at its floor (10 500 chars
 * for a model metered at 8 000 tokens per minute) — the history alone was
 * over the line, so every further round failed no matter how the cap was set.
 *
 * What the next round needs is the seam it writes on from and the headings it
 * must not repeat. Everything between is text the reader already has.
 */
const { condenseWrittenAnswer } = require('../continuation');

const long = (n) => 'Der Sprecher erklärt das noch einmal in anderen Worten. '.repeat(n);

describe('condenseWrittenAnswer', () => {
  it('leaves a short answer completely alone', () => {
    const short = '## Einführung [0:00 - 5:00]\n\n**Kernaussage.**\n\n- **Punkt**: Detail.';
    expect(condenseWrittenAnswer(short)).toBe(short);
  });

  it('keeps every heading and the end verbatim, and drops the middle', () => {
    const content =
      '## Einführung [0:00 - 5:00]\n\n' + long(200) +
      '\n\n## Mitte [5:00 - 12:00]\n\n' + long(200) +
      '\n\n## Schluss [12:00 - 20:00]\n\nund dann sagte er, dass die Aktivie';
    const out = condenseWrittenAnswer(content);

    expect(out.length).toBeLessThan(content.length / 2);
    // The seam — the very last characters — must survive byte-exact.
    expect(out.endsWith('und dann sagte er, dass die Aktivie')).toBe(true);
    // Every section already written is still named, so none is written twice.
    expect(out).toContain('## Einführung [0:00 - 5:00]');
    expect(out).toContain('## Mitte [5:00 - 12:00]');
    expect(out).toContain('## Schluss [12:00 - 20:00]');
    // And the model is told why the middle is missing.
    expect(out).toContain('never write any of them again');
  });

  it('says so when there are no headings yet', () => {
    const out = condenseWrittenAnswer(long(300));
    expect(out).toContain('(no headings yet)');
  });

  it('survives null and undefined', () => {
    expect(condenseWrittenAnswer(null)).toBe('');
    expect(condenseWrittenAnswer(undefined)).toBe('');
  });
});
