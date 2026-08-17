/**
 * routes/feedback.js
 *
 * In-app Feedback (sidebar button + /feedback composer command). ADR-0010,
 * corrected 2026-08-06: Web3Forms' free plan rejects server-to-server
 * submissions ("Use our API in client side ... Pro plan is required") — a
 * Node backend calling their API directly gets a 403. The actual POST to
 * Web3Forms therefore happens from the BROWSER (frontend/src/api/index.ts),
 * using the client-safe access key. This route's only job is handing that
 * key (not a secret — Web3Forms' own docs say it's safe in client code, we
 * just keep it in an env var for easy rotation) plus server-side diagnostics
 * (version/OS/provider) to the frontend before it posts.
 */
const os = require('os');
const express = require('express');
const { getSetting } = require('../llm');
const { version } = require('../package.json');

// Shipped default (hybrid feedback, 2026-08-08): Web3Forms access keys are
// client-safe by design — they can do nothing except deliver a form message
// to the maintainer's inbox. Baked in so feedback works out of the box for
// npm installs; the env var stays as override for forks and key rotation.
const DEFAULT_ACCESS_KEY = '5e2c7c2b-93f7-42c0-ad54-c4fdb08b6bf4';
// Degradation target when sending fails (key rotated, quota exhausted,
// offline): the frontend offers this link instead of a dead end.
const ISSUES_URL = 'https://github.com/kavi-senewiratne/syflo/issues';

module.exports = (db) => {
  const router = express.Router();

  // GET /api/feedback/config
  router.get('/config', (req, res) => {
    res.json({
      accessKey: process.env.WEB3FORMS_ACCESS_KEY || DEFAULT_ACCESS_KEY,
      issuesUrl: ISSUES_URL,
      version,
      platform: os.platform(),
      provider: getSetting(db, 'llm_provider'),
    });
  });

  return router;
};
