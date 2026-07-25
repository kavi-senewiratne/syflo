require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { createDb } = require('./database');

// Same SYFLO_DATA_DIR convention as database.js: in the Electron bundle this
// points to a writable per-user location; in dev (no env var) we fall back to
// the project's uploads/ folder so existing data keeps working.
const DATA_DIR = process.env.SYFLO_DATA_DIR || path.join(__dirname, '..');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function createApp(db, options = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Hochgeladene Dateien für das Frontend bereitstellen
  // (Bilder/Dokumente in alten Nachrichten anzeigen)
  app.use('/uploads', express.static(UPLOADS_DIR));

  app.use('/api/chats', require('./routes/chats')(db));
  // options.messages: z. B. { extractPdfTextFn } — injizierbar für Tests.
  const messagesRouter = require('./routes/messages')(db, UPLOADS_DIR, options.messages);
  app.use('/api/chats/:chatId/messages', messagesRouter);
  // explain teilt den Gesprächskontext-Builder des Chats (KV-Prefix-Sharing,
  // 2026-07-25): eine Wort-Erklärung trifft so Ollamas Cache, statt den
  // einzigen KV-Slot mit einem Standalone-Prompt zu verdrängen.
  app.use('/api/explain', require('./routes/explain')(db, {
    buildSystemAndHistory: messagesRouter.buildSystemAndHistory,
  }));
  // options.papers: z. B. { extractPdfTextFn, embedTextsFn } — injizierbar für Tests.
  app.use('/api/papers', require('./routes/papers')(db, UPLOADS_DIR, options.papers));
  // options.youtube: { searchVideosFn, fetchTranscriptFn } — injizierbar für Tests.
  app.use('/api/youtube', require('./routes/youtube')(db, options.youtube));
  // Highlights + Labels: Pfade wie /api/papers/:id/highlights und
  // /api/highlight-labels leben in einem Router, daher Mount auf /api.
  app.use('/api', require('./routes/highlights')(db));
  // Chat-Text-Highlights: /api/chats/:id/message-highlights und
  // /api/message-highlights/:id teilen sich einen Router → Mount auf /api.
  app.use('/api', require('./routes/message-highlights')(db));
  // Baum-weite Highlight-Übersicht für den Highlights-Drawer:
  // /api/chats/:id/tree-highlights → Mount auf /api.
  app.use('/api', require('./routes/tree-highlights')(db));
  app.use('/api/settings', require('./routes/settings')(db, { system: options.system }));
  // options.transcribe: { manager } — injizierbar für Tests (Fake-Whisper).
  app.use('/api/transcribe', require('./routes/transcribe')(options.transcribe));
  app.use('/api/search', require('./routes/search')());
  // options.system: { totalmem, platform } — injizierbar für Tests.
  app.use('/api/system', require('./routes/system')(options.system));

  // Gepackte Desktop-App (Electron): das gebaute Frontend same-origin
  // ausliefern, damit die relativen /api-Aufrufe ohne Proxy funktionieren.
  // Nach den API-Routen gemountet, damit /api und /uploads Vorrang behalten.
  const frontendDir = options.frontendDir ?? process.env.SYFLO_FRONTEND_DIR;
  if (frontendDir) {
    app.use(express.static(frontendDir));
    // SPA-Fallback: unbekannte Nicht-API-Pfade bekommen die index.html
    app.get(/^\/(?!api\/|uploads\/).*/, (req, res) => {
      res.sendFile(path.join(frontendDir, 'index.html'));
    });
  }

  app.use((err, req, res, next) => {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  });

  return app;
}

if (require.main === module) {
  const db = createDb();
  const app = createApp(db);
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`Syflo backend running on http://localhost:${PORT}`);
  });
}

module.exports = { createApp };
