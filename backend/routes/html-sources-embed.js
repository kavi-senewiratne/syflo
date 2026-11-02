/**
 * routes/html-sources-embed.js — tells the frontend where a source is served
 * (its own origin, source-origin.js) and the token its bridge will carry.
 */
const express = require('express');
const { tokenFor } = require('../source-origin');

module.exports = (db) => {
  const router = express.Router();
  const getSource = db.prepare('SELECT id FROM html_sources WHERE id = ?');

  router.get('/:id/embed', (req, res) => {
    const row = getSource.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'HTML source not found' });
    const port = /:(\d+)$/.exec(req.headers.host || '');
    const origin = `http://src-${row.id}.localhost${port ? `:${port[1]}` : ''}`;
    res.json({ url: `${origin}/`, origin, token: tokenFor(row.id) });
  });

  return router;
};
