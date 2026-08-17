/**
 * tests/wordSnap.test.ts
 *
 * Chrome places the caret at the nearest character boundary of the pressed
 * glyph, so pressing past the middle of a word's first letter starts the
 * selection AFTER it (live repro 2026-08-06: "legacy waypoint stack" reached
 * the popup as "egacy waypoint stack"). snapRangeToWords grows both
 * boundaries out to the enclosing word.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { snapRangeToWords, snapLiveSelectionToWords } from '../selection/wordSnap';

function paragraph(html: string): HTMLElement {
  const p = document.createElement('p');
  p.innerHTML = html;
  document.body.appendChild(p);
  return p;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('snapRangeToWords', () => {
  it('grows a start that cuts a word back to the word start', () => {
    const p = paragraph('the legacy waypoint stack — done');
    const text = p.firstChild as Text;
    const range = document.createRange();
    // Chrome's snap: start one character INTO "legacy".
    range.setStart(text, text.data.indexOf('legacy') + 1);
    range.setEnd(text, text.data.indexOf('stack') + 5);
    expect(snapRangeToWords(range).toString()).toBe('legacy waypoint stack');
  });

  it('grows an end that cuts a word out to the word end', () => {
    const p = paragraph('numeric IK and joint-space interpolation');
    const text = p.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, text.data.indexOf('IK') + 1); // stops inside "IK"
    expect(snapRangeToWords(range).toString()).toBe('numeric IK');
  });

  it('leaves boundaries that already sit on word edges untouched', () => {
    const p = paragraph('one conditioned learned grasp model');
    const text = p.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 4);
    range.setEnd(text, 4 + 'conditioned'.length);
    expect(snapRangeToWords(range).toString()).toBe('conditioned');
  });

  it('does not grow across whitespace or punctuation', () => {
    const p = paragraph('RF-DETR (sidecar service) over 6 classes');
    const text = p.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, text.data.indexOf('(sidecar'));
    range.setEnd(text, text.data.indexOf('service)') + 'service'.length);
    // A boundary next to "(" / ")" is already a word edge — nothing moves.
    expect(snapRangeToWords(range).toString()).toBe('(sidecar service');
  });

  it('treats digits, underscores and umlauts as word characters', () => {
    const p = paragraph('über_92 Punktewolken');
    const text = p.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 2); // inside "über_92"
    range.setEnd(text, text.data.indexOf('Punktewolken') + 6); // inside the word
    expect(snapRangeToWords(range).toString()).toBe('über_92 Punktewolken');
  });

  it('snaps a boundary that lies inside an inline element', () => {
    const p = paragraph('uses the <strong>4 actual</strong> waypoints');
    const strong = p.querySelector('strong')!;
    const text = strong.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 3); // inside "actual"
    range.setEnd(text, text.data.length);
    expect(snapRangeToWords(range).toString()).toBe('actual');
  });

  it('returns a copy — the original range keeps its boundaries', () => {
    const p = paragraph('legacy waypoint stack');
    const text = p.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 1);
    range.setEnd(text, 6);
    snapRangeToWords(range);
    expect(range.startOffset).toBe(1);
    expect(range.toString()).toBe('egacy');
  });

  it('leaves a collapsed range alone — that is a caret, not a selection', () => {
    const p = paragraph('legacy waypoint');
    const text = p.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 3);
    range.setEnd(text, 3);
    const snapped = snapRangeToWords(range);
    expect(snapped.collapsed).toBe(true);
    expect(snapped.startOffset).toBe(3);
  });
});

describe('snapLiveSelectionToWords', () => {
  it('writes the grown range back so the visible selection matches the popup', () => {
    const p = paragraph('the legacy waypoint stack');
    const text = p.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, text.data.indexOf('legacy') + 1);
    range.setEnd(text, text.data.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const snapped = snapLiveSelectionToWords();

    expect(snapped?.toString()).toBe('legacy waypoint stack');
    expect(window.getSelection()?.toString()).toBe('legacy waypoint stack');
  });

  it('returns null when nothing is selected', () => {
    window.getSelection()?.removeAllRanges();
    expect(snapLiveSelectionToWords()).toBeNull();
  });
});
