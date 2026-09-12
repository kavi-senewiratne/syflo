/**
 * tests/overview-section-target.test.js
 *
 * How many sections the Video overview should have (user decision 2026-09-04).
 *
 * Neither pure rate nor pure share survives both ends of the range: "one
 * section per 5–10 minutes" leaves a ten-minute video with one or two, and "a
 * section every 5 %" asks that same video for twenty of thirty seconds each —
 * which is the per-minute chopping the rule exists to stop. So the number is
 * computed from the running time, floored and capped, and written into the
 * prompt as a number the model does not have to derive.
 */
const { overviewSectionTarget, overviewWindowTarget } = require('../overview-progress');

describe('overviewSectionTarget', () => {
  it('does not leave a short video with one or two sections', () => {
    expect(overviewSectionTarget(600)).toBe(4);    // 10:00
    expect(overviewSectionTarget(1367)).toBe(4);   // 22:47 — Chris Olah
  });

  it('follows the running time in the middle of the range', () => {
    expect(overviewSectionTarget(3600)).toBe(9);   // 1:00:00
    expect(overviewSectionTarget(6924)).toBe(16);  // 1:55:24 — makemore 4
  });

  it('caps a long talk instead of asking for sixty headings', () => {
    expect(overviewSectionTarget(13357)).toBe(25); // 3:42:37 — the user's talk
    expect(overviewSectionTarget(60 * 60 * 8)).toBe(25);
  });

  it('says nothing when the duration is unknown', () => {
    expect(overviewSectionTarget(null)).toBeNull();
    expect(overviewSectionTarget(undefined)).toBeNull();
    expect(overviewSectionTarget(0)).toBeNull();
  });
});

/**
 * Pro-rating the target to the window a round actually sees (user report
 * 2026-09-10): the 2:35:26 Bengio talk arrived as 18 half-minute sections for
 * its first 9:37 because Groq's budget cut the transcript there and the model
 * spent the global target on the sliver it saw.
 */
describe('overviewWindowTarget', () => {
  const BENGIO = 9326; // 2:35:26 — total target 22

  it('gives a budget-cut first round its share, not the whole target', () => {
    // Groq's 10 500-char cap ended the transcript at 9:37.
    expect(overviewWindowTarget(BENGIO, 0, 577)).toBe(1);
  });

  it('leaves a continuation that sees the whole rest most of the target', () => {
    expect(overviewWindowTarget(BENGIO, 577, null)).toBe(21);
  });

  it('pro-rates a continuation whose rest is cut again', () => {
    // resumes at 9:37, cut again at 20:00 — 623 s of 9 326.
    expect(overviewWindowTarget(BENGIO, 577, 1200)).toBe(1);
  });

  it('never asks a round for zero sections', () => {
    expect(overviewWindowTarget(600, 0, 60)).toBe(1); // 10 % of a 10-min video
  });

  it('stays silent when the round sees the whole video', () => {
    expect(overviewWindowTarget(BENGIO, 0, null)).toBeNull();
    expect(overviewWindowTarget(BENGIO, null, null)).toBeNull();
    expect(overviewWindowTarget(BENGIO, 0, BENGIO)).toBeNull();
  });

  it('stays silent when the duration is unknown or the window is empty', () => {
    expect(overviewWindowTarget(null, 0, 577)).toBeNull();
    expect(overviewWindowTarget(BENGIO, 577, 577)).toBeNull();
    expect(overviewWindowTarget(BENGIO, 600, 577)).toBeNull();
  });
});
