// `npm test` runs Jest TWICE: once for everything except the pdf.js suites,
// then once for those two alone (see the `test` script in package.json).
//
// pdf-text.test.js and pdf-citations.test.js load real pdf.js through Node's
// ESM loader, and inside Jest's --experimental-vm-modules sandbox that import
// comes back as a different module instance whenever unrelated suites are
// loading beside it: "Provided module is not an instance of Module", roughly
// two runs in five, always taking every pdf.js test in that worker down as a
// group. Run alone, the same suites are green run after run. Nothing is
// skipped — the split only keeps the real pdf.js import away from the rest.
module.exports = {
  testEnvironment: 'node',
  // The Windows CI runners take 5-13x the wall clock of a dev machine for
  // the SQLite-backed Supertest suites (66 s for a suite that runs in 5 s
  // locally, first real matrix runs 2026-09-13) — Jest's 5 s default then
  // fails hooks and tests one by one, each timeout cascading into EBUSY /
  // UNIQUE-constraint noise from the half-torn-down database. 30 s is a
  // budget, not a target: nothing here polls, so green stays as fast as the
  // machine allows.
  testTimeout: 30000,
  transformIgnorePatterns: [
    'node_modules/(?!(openai)/)',
  ],
  transform: {
    '^.+\\.js$': ['babel-jest', { presets: [['@babel/preset-env', { targets: { node: 'current' } }]] }],
  },
};
