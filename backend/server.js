require('dotenv').config();
const express = require('express');
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
  // No CORS layer on purpose: every legitimate client is same-origin (Vite
  // proxies /api in dev, Electron loads the backend origin directly), so
  // browsers must NOT be granted cross-origin access to chats and settings.
  app.use(express.json());

  // DNS-rebinding guard: a malicious site can point its own hostname at
  // 127.0.0.1 and bypass same-origin checks — the Host header is the tell.
  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
  app.use((req, res, next) => {
    const hostname = (req.headers.host || '').replace(/:\d+$/, '');
    if (!LOCAL_HOSTS.has(hostname)) {
      return res.status(403).json({ error: 'forbidden host' });
    }
    next();
  });

  // Serve uploaded files for the frontend
  // (display images/documents in old messages). Forced download headers:
  // an uploaded HTML file must never execute same-origin with the app
  // (<img> rendering is unaffected by Content-Disposition).
  app.use('/uploads', express.static(UPLOADS_DIR, {
    setHeaders: (res) => {
      res.setHeader('Content-Disposition', 'attachment');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  }));

  // options.messages: e.g. { extractPdfTextFn } — injectable for tests.
  // Built BEFORE the chats router: the passage-title endpoint there shares
  // this router's quota memory, so an exhausted provider is skipped and a
  // fresh wall is remembered for the picker badges (2026-08-02).
  const messagesRouter = require('./routes/messages')(db, UPLOADS_DIR, options.messages);
  app.use('/api/chats', require('./routes/chats')(db, {
    isQuotaCoolingDown: messagesRouter.isQuotaCoolingDown,
    markQuotaCooldown: messagesRouter.markQuotaCooldown,
  }));
  app.use('/api/chats/:chatId/messages', messagesRouter);
  // Sidebar categories — user-made containers for root chats, one nesting
  // level deep (design/mockup-sidebar-categories-v2.html).
  app.use('/api/categories', require('./routes/categories')(db));
  // Quota-cooldown snapshot for the model-picker badges (mockup-quota-states
  // §06). The map lives in the messages router — the only place quotas are
  // learned — so this is just a read-through.
  app.get('/api/quota-cooldowns', (req, res) => {
    res.json({ cooldowns: messagesRouter.getQuotaCooldowns() });
  });
  // explain shares the chat's conversation-context builder (KV prefix
  // sharing, 2026-07-25): a word explanation thus hits Ollama's cache
  // instead of evicting the single KV slot with a standalone prompt.
  // It also shares the chat's quota memory (2026-07-28): a definition that
  // hits a limit fails over along the same candidate ladder, and known
  // walls are skipped by both routes.
  // /btw shares the chat's context builder for the same reason explain does —
  // an aside that cannot see the conversation cannot answer "what does this
  // mean?". The traffic is one-way: the conversation never sees the aside.
  app.use('/api/btw', require('./routes/btw')(db, {
    buildSystemAndHistory: messagesRouter.buildSystemAndHistory,
    isQuotaCoolingDown: messagesRouter.isQuotaCoolingDown,
    markQuotaCooldown: messagesRouter.markQuotaCooldown,
  }));
  app.use('/api/explain', require('./routes/explain')(db, {
    buildSystemAndHistory: messagesRouter.buildSystemAndHistory,
    isQuotaCoolingDown: messagesRouter.isQuotaCoolingDown,
    markQuotaCooldown: messagesRouter.markQuotaCooldown,
  }));
  // options.papers: e.g. { extractPdfTextFn, embedTextsFn } — injectable for tests.
  app.use('/api/papers', require('./routes/papers')(db, UPLOADS_DIR, options.papers));
  // options.youtube: { searchVideosFn, fetchTranscriptFn } — injectable for tests.
  app.use('/api/youtube', require('./routes/youtube')(db, options.youtube));
  // Highlights + labels: paths like /api/papers/:id/highlights and
  // /api/highlight-labels live in one router, hence mounted on /api.
  app.use('/api', require('./routes/highlights')(db));
  // Chat text highlights: /api/chats/:id/message-highlights and
  // /api/message-highlights/:id share one router → mounted on /api.
  app.use('/api', require('./routes/message-highlights')(db));
  // Colored marks in a video transcript — the third highlight anchor
  // (design/mockup-transcript-selection.html, 2026-08-16).
  app.use('/api', require('./routes/transcript-highlights')(db));
  // Tree-wide highlight overview for the highlights drawer:
  // /api/chats/:id/tree-highlights → mounted on /api.
  app.use('/api', require('./routes/tree-highlights')(db));
  app.use('/api/settings', require('./routes/settings')(db, {
    // Provider switches release waiting local questions whose provider is
    // now cloud (mockup-model-flow §07).
    onLLMSettingsChanged: () => messagesRouter.reevaluateQueue(),
  }));
  // options.transcribe: { manager } — injectable for tests (fake whisper).
  app.use('/api/transcribe', require('./routes/transcribe')(options.transcribe));
  app.use('/api/search', require('./routes/search')());
  // options.system: { totalmem, platform } — injectable for tests.
  app.use('/api/usage', require('./routes/usage')(db));
  // Hands the frontend the Web3Forms access key + diagnostics — the actual
  // POST to Web3Forms happens client-side (their free plan blocks server calls).
  app.use('/api/feedback', require('./routes/feedback')(db));

  // Packaged desktop app (Electron): serve the built frontend same-origin
  // so the relative /api calls work without a proxy.
  // Mounted after the API routes so /api and /uploads keep precedence.
  const frontendDir = options.frontendDir ?? process.env.SYFLO_FRONTEND_DIR;
  if (frontendDir) {
    app.use(express.static(frontendDir));
    // SPA fallback: unknown non-API paths get the index.html
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
  // Loopback only: Syflo is a single-user local app — other devices on the
  // network must not reach chats, uploads, or stored keys.
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Syflo backend running on http://localhost:${PORT}`);
  });
}

module.exports = { createApp };
