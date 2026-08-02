/**
 * routes/feedback.js
 *
 * In-app Feedback (sidebar button + /feedback composer command). Thin proxy
 * to Web3Forms, same shape as routes/search.js for SearXNG — ADR-0010:
 * private inbox, never an automatic public GitHub issue. Diagnostic metadata
 * (version/OS/provider) is attached server-side so the client never has to
 * supply it.
 */
const os = require('os');
const express = require('express');
const { getSetting } = require('../llm');
const { version } = require('../package.json');

const KINDS = new Set(['bug', 'idea', 'question']);
const WEB3FORMS_URL = 'https://api.web3forms.com/submit';

async function defaultSendFn(payload) {
  const r = await fetch(WEB3FORMS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_key: process.env.WEB3FORMS_ACCESS_KEY,
      subject: `[${payload.kind}] Syflo feedback`,
      from_name: 'Syflo Feedback',
      replyto: payload.email || undefined,
      message: `${payload.text}\n\n---\nversion: ${payload.version}\nplatform: ${payload.platform}\nprovider: ${payload.provider}`,
    }),
  });
  if (!r.ok) {
    throw new Error(`Web3Forms responded with HTTP ${r.status}`);
  }
}

module.exports = (db, options = {}) => {
  const router = express.Router();
  const sendFn = options.sendFn || defaultSendFn;

  // POST /api/feedback  body: { kind: 'bug'|'idea'|'question', text: string, email?: string }
  router.post('/', async (req, res) => {
    const kind = req.body?.kind;
    const text = (req.body?.text || '').trim();
    if (!KINDS.has(kind) || !text) {
      return res.status(400).json({ error: `Body must include "text" and a "kind" of ${[...KINDS].join('/')}` });
    }
    const email = req.body?.email || undefined;

    try {
      await sendFn({
        kind,
        text,
        email,
        version,
        platform: os.platform(),
        provider: getSetting(db, 'llm_provider'),
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: err.message || 'Failed to send feedback' });
    }
  });

  return router;
};
