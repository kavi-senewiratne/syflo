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
const { overviewSectionTarget } = require('../overview-progress');

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
