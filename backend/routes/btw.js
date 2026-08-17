/**
 * btw.js
 *
 * POST /api/btw — the throwaway side question
 * (design/mockup-btw-composer-fold.html).
 *
 * The user types `/btw <question>` in the composer and gets an answer that
 * appears in a panel above the input, never in the transcript. The defining
 * property of this route is therefore what it does NOT do: it writes nothing.
 * No message row, no chat row, no title generation, no mindmap node — the
 * answer streams out and lives only in the browser's memory until the user
 * types the next character.
 *
 * Streaming (not a single JSON body like routes/explain.js): an aside can be
 * long — the mockup caps its panel at 40 % of the pane and scrolls inside —
 * and staring at a spinner for fifteen seconds is exactly the friction the
 * feature exists to avoid.
 */

const crypto = require('crypto');
const express = require('express');
const { getLLMClient, getSetting, noThinkExtras } = require('../llm');
const { callCloudLadder, isRateLimit, isModelUnavailable } = require('../quota');
const { writeOutcomeInBackground } = require('../outcome');

// Zeitbudget einer Nebenfrage: sie darf nie in die Warteschlange und nie
// länger dauern, als der Nutzer hinschaut. Die ganze Leiter bekommt ein
// Budget, jeder einzelne Aufruf ein kürzeres.
const BTW_BUDGET_MS = 30000;
const BTW_CALL_MS = 20000;

module.exports = (db, { buildSystemAndHistory, isQuotaCoolingDown, markQuotaCooldown } = {}) => {
  const router = express.Router();

  // Style rule for the aside, appended to the question itself so it overrides
  // the conversation's formatting rules for this one turn — the same trick
  // routes/explain.js uses for its dictionary voice.
  const STYLE_RULE =
    ' (Answer this as a brief aside: come straight to the point, no preamble, ' +
    'no restating of the question.)';

  /**
   * The conversation so far plus the aside. Reading the thread is what makes
   * "what does this mean?" answerable without the user repeating themselves;
   * the aside is appended as the last user turn and goes nowhere else.
   * Without a chat (or if the build fails) the question stands alone.
   */
  async function buildMessages(chatId, question) {
    const asked = { role: 'user', content: question + STYLE_RULE };
    if (!chatId || !buildSystemAndHistory) return [asked];
    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    if (!chat) return [asked];
    try {
      const built = await buildSystemAndHistory(chat, { dropLastMessage: false });
      return [...built.messages, asked];
    } catch (_) {
      return [asked];
    }
  }

  router.post('/', async (req, res) => {
    const { chatId, question } = req.body;
    if (!question) return res.status(400).json({ error: 'question is required' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const send = (payload) => {
      try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) { /* client gone */ }
    };

    const messages = await buildMessages(chatId, question);
    const activeProvider = getSetting(db, 'llm_provider');

    // ── Local path: no failover, in either direction. The privacy guard
    // (mockup-model-flow §11) means a local aside never silently becomes a
    // cloud one, and the ladder below is cloud-only by construction.
    if (activeProvider === 'ollama') {
      try {
        const { client, model, provider } = getLLMClient(db);
        const stream = await client.chat.completions.create({
          model,
          ...noThinkExtras(provider),
          messages,
          stream: true,
        });
        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) send({ delta });
        }
        send({ done: true, provider, model });
      } catch (err) {
        send({ error: err.message });
      }
      return res.end();
    }

    // ── Cloud path: the shared candidate ladder, walked WITHOUT asking. An
    // exhausted model is not worth a decision for a side question (user
    // decision 2026-08-08) — the user sees a spinner, then an answer, and one
    // gray line naming who stepped in. `switchedFrom` is therefore only sent
    // when the answer did NOT come from the chat's own model; in the normal
    // case the panel shows no model line at all.
    //
    // An aside is never queued either: if the answer arrives two minutes
    // later it has missed its moment, hence the short budget.
    const ownModel = getSetting(db, `${activeProvider}_model`);
    try {
      let lastErr = null;
      const result = await callCloudLadder(db, {
        activeProvider,
        messages,
        budgetMs: BTW_BUDGET_MS,
        callMs: BTW_CALL_MS,
        isCoolingDown: isQuotaCoolingDown,
        markCooldown: markQuotaCooldown,
        label: 'btw',
        onDelta: (delta) => send({ delta }),
        onError: (err) => { if (!isRateLimit(err) && !isModelUnavailable(err)) lastErr = err; },
      });
      if (result) {
        send({
          done: true,
          provider: result.provider,
          model: result.model,
          // Die UI zeigt dieselbe Notiz wie über einer Chat-Antwort und
          // braucht dafür beide Seiten des Wechsels: gleicher Anbieter →
          // Modellnamen, anderer Anbieter → Anbieternamen + Modell.
          ...(result.model !== ownModel
            ? { switchedFrom: ownModel, switchedFromProvider: activeProvider }
            : {}),
        });
      } else {
        throw lastErr ?? new Error('No model could answer right now.');
      }
    } catch (err) {
      send({ error: err.message });
    }
    res.end();
  });

  /**
   * POST /api/btw/keep — the one path where an aside becomes permanent
   * (mockup §03). Both panel buttons end here:
   *
   * - "Keep in chat" sends question + answer, and the pair lands at the END of
   *   the thread as two ordinary messages. Not at the position where it was
   *   asked: inserting mid-thread would rewrite message order for a chat that
   *   may already have branches hanging off it.
   * - "Make a branch" creates the branch first (the existing chats route) and
   *   sends only the answer, because the question already lives in the branch
   *   header as its parent quote — repeating it as a user bubble would say the
   *   same thing twice.
   *
   * Kept messages carry no mark of having been an aside. Once kept, an aside
   * is an ordinary message in every way — branchable, highlightable, part of
   * the context a child chat inherits.
   */
  router.post('/keep', (req, res) => {
    const { chatId, question, answer } = req.body;
    if (!answer) return res.status(400).json({ error: 'answer is required' });
    const chat = db.prepare('SELECT id FROM chats WHERE id = ?').get(chatId);
    if (!chat) return res.status(404).json({ error: 'chat not found' });

    // Ids are generated here, exactly as routes/messages.js does — the column
    // has no default, and without one the rows land with id NULL. That is not
    // a silent flaw: React then renders two children with the same key and the
    // kept messages never show up (caught in the running app 2026-08-08).
    const insert = db.prepare(
      'INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    const ids = [];
    const write = db.transaction(() => {
      const now = Date.now();
      if (question) {
        const id = crypto.randomUUID();
        insert.run(id, chatId, 'user', question, new Date(now).toISOString());
        ids.push(id);
      }
      // One millisecond later than the question so any ordering by timestamp
      // keeps the pair in reading order.
      const id = crypto.randomUUID();
      insert.run(id, chatId, 'assistant', answer, new Date(now + 1).toISOString());
      ids.push(id);
    });
    write();

    const byId = db.prepare('SELECT * FROM messages WHERE id = ?');
    res.json({ messages: ids.map((id) => byId.get(id)) });

    // "Make a branch": the answer just written IS the branch's first answer,
    // and it never travelled through POST /messages — so nothing has asked for
    // the mindmap's outcome line yet. Without this the node kept its
    // "Ergebnis folgt …" placeholder until the user happened to ask something
    // else there (live report 2026-08-08). Background work: the client already
    // has its response.
    writeOutcomeInBackground(db, chatId, answer, { isQuotaCoolingDown, markQuotaCooldown });
  });

  return router;
};
