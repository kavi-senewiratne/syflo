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
const { callCloudLadder, isRateLimit, isModelUnavailable, isOverloaded } = require('../quota');
const { isTruncatedFinish, isAbortError } = require('../tools');
const { joinContinuation, continuationInstruction, MAX_OVERLAP } = require('../continuation');
const { writeOutcomeInBackground } = require('../outcome');
const { recordUsage } = require('../usage');

// Zeitbudget einer Nebenfrage: sie darf nie in die Warteschlange und nie
// länger dauern, als der Nutzer hinschaut. Die ganze Leiter bekommt ein
// Budget, jeder einzelne Aufruf ein kürzeres.
const BTW_BUDGET_MS = 30000;
const BTW_CALL_MS = 20000;
// Wie oft eine abgebrochene Nebenfrage weitergeschrieben werden darf. Eine
// Nebenfrage ist kurz; wer nach zwei Anläufen immer noch mitten im Satz steht,
// gehört in einen richtigen Chat und nicht in dieses Panel.
const BTW_CONTINUE_ROUNDS = 2;
// Eigenes Budget fürs Weiterschreiben: das erste Budget ist beim Abbruch
// schon angebrochen, und eine halbe Antwort stehen zu lassen wäre teurer als
// die paar Sekunden, die das Zuendeschreiben kostet.
const BTW_CONTINUE_MS = 20000;

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

    /**
     * Writes the rest of an answer that broke off mid-sentence.
     *
     * A cut aside used to arrive looking finished: the panel dropped its
     * spinner, offered "Keep in chat" and "Branch", and the text ended inside
     * a word ("… oder int", user report with picture 2026-08-19). Nothing was
     * wrong with the stream — nobody was reading the provider's finish_reason.
     *
     * The repair is the one the chat answers already use: ask the SAME model
     * to carry on, let it repeat its last words as a seam, and cut the
     * repetition away (continuation.js).
     *
     * The continuation STREAMS like the first round. Only the seam window is
     * held back — MAX_OVERLAP characters, behind which no repetition can be
     * hiding any more; everything after it goes out as it arrives. Collecting
     * the whole continuation first was simpler and read terribly: nine seconds
     * of silence, then 221 characters at once (measured 2026-08-20, "es kommt
     * alles auf einmal").
     *
     * Who writes the rest is NOT pinned to the model that broke off: it was
     * the model whose quota just ran out that got cut in the first place, and
     * asking it again earned exactly one 429 (log 2026-08-20 14:13). The
     * cloud path therefore hands the continuation to the shared ladder.
     *
     * @param {string} answer   what arrived so far
     * @param {string|null} finishReason the provider's verdict on it
     * @param {(msgs: object[], onDelta: (d: string) => void, onGiveUp: () => void) => Promise<{finishReason: string|null}>} runRound
     * @returns {Promise<{text: string, truncated: boolean}>} the answer and whether it is still cut
     */
    async function completeAnswer(answer, finishReason, runRound) {
      let whole = answer;
      let reason = finishReason;
      for (let round = 0; round < BTW_CONTINUE_ROUNDS; round++) {
        if (!whole || !isTruncatedFinish(reason)) break;
        console.warn(
          `[btw] cut off (finish_reason=${reason ?? 'MISSING'}, len=${whole.length}) — writing on`,
        );
        // Held back until the seam is decided; empty again once it is.
        let held = '';
        let seamCut = false;
        // Set when a candidate died AFTER its text was already forwarded. What
        // it wrote cannot be taken back (it is part of the answer now), and a
        // later candidate would continue from the OLD cut point and say the
        // same thing twice — so this round writes nothing more.
        let spoiled = false;
        const cutSeam = () => {
          if (seamCut) return;
          seamCut = true;
          const joined = joinContinuation(whole, held);
          // Only what the join ADDED travels — the reader already has the rest.
          if (joined.length > whole.length) send({ delta: joined.slice(whole.length) });
          whole = joined;
          held = '';
        };
        const forward = (delta) => {
          if (spoiled) return;
          if (seamCut) {
            whole += delta;
            send({ delta });
            return;
          }
          held += delta;
          if (held.length >= MAX_OVERLAP) cutSeam();
        };
        // A candidate that failed before the seam was decided wrote nothing
        // the reader can see: drop what it held and let the next one start
        // clean. Past the seam there is no way back.
        const giveUpOnCandidate = () => {
          if (seamCut) spoiled = true;
          else held = '';
        };
        let next;
        try {
          next = await runRound([
            ...messages,
            { role: 'assistant', content: whole },
            { role: 'user', content: continuationInstruction({ mode: 'seam' }) },
          ], forward, giveUpOnCandidate);
        } catch (err) {
          console.error(`[btw] continuation failed: ${err.message}`);
          giveUpOnCandidate();
          break; // half an answer beats an error message on top of it
        }
        // A continuation shorter than the seam window never triggered the cut.
        if (!spoiled) cutSeam();
        if (spoiled) break;
        reason = next?.finishReason ?? null;
      }
      // What the caller still has to say out loud: this answer is not whole.
      return { text: whole, truncated: isTruncatedFinish(reason) };
    }

    // ── Local path: no failover, in either direction. The privacy guard
    // (mockup-model-flow §11) means a local aside never silently becomes a
    // cloud one, and the ladder below is cloud-only by construction.
    if (activeProvider === 'ollama') {
      // Held outside the try so a failed round can still say WHO failed —
      // and so nothing is logged when there was no client to call at all.
      let local = null;
      try {
        local = getLLMClient(db);
        const { client, model, provider } = local;
        // One round against the local model: streams what it writes and
        // reports how it ended, so a cut answer can be continued below.
        const round = async (msgs, onDelta) => {
          const completion = await client.chat.completions.create({
            model,
            ...noThinkExtras(provider),
            messages: msgs,
            stream: true,
          });
          let text = '';
          let finishReason = null;
          for await (const chunk of completion) {
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              text += delta;
              onDelta(delta);
            }
            const reason = chunk.choices?.[0]?.finish_reason;
            if (reason) finishReason = reason;
          }
          return { text, finishReason };
        };
        const first = await round(messages, (delta) => send({ delta }));
        // An aside is a call like any other (kind 'btw' since 2026-08-11).
        // It used to spend the provider's daily quota without appearing
        // anywhere — one of the reasons the meter said "0/20" while Gemini
        // Flash was exhausted.
        recordUsage(db, { provider, model, kind: 'btw', outcome: 'ok' });
        const whole = await completeAnswer(first.text, first.finishReason, round);
        send({ done: true, provider, model, ...(whole.truncated ? { truncated: true } : {}) });
      } catch (err) {
        if (local) {
          recordUsage(db, {
            provider: local.provider, model: local.model, kind: 'btw', outcome: 'failed',
          });
        }
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
        // A candidate that died after streaming half a sentence: the panel
        // takes its fragment back, so the next candidate's answer does not
        // land underneath a torn-off one.
        onDiscard: () => send({ reset: true }),
        onError: (err, cand) => {
          // Every candidate the ladder burns is a spent call — a 429 counts
          // against the provider's day just like an answer does, and before
          // 2026-08-11 none of these appeared in the meter.
          recordUsage(db, {
            provider: cand.provider, model: cand.model, kind: 'btw',
            outcome: isRateLimit(err) ? 'quota' : 'failed',
          });
          if (!isRateLimit(err) && !isModelUnavailable(err)) lastErr = err;
        },
      });
      if (result) {
        recordUsage(db, {
          provider: result.provider, model: result.model, kind: 'btw', outcome: 'ok',
        });
        // Writing on is a ladder walk of its own: whoever can, finishes the
        // sentence. Pinning it to the model that broke off meant asking the
        // one provider whose quota had just run out — one 429, and the aside
        // kept its 40 characters (log 2026-08-20 14:13). A continuation
        // carries the whole answer so far, so another model can pick it up.
        const whole = await completeAnswer(
          result.raw,
          result.finishReason,
          async (msgs, onDelta, onGiveUp) => {
            const cont = await callCloudLadder(db, {
              activeProvider,
              messages: msgs,
              budgetMs: BTW_CONTINUE_MS,
              callMs: BTW_CALL_MS,
              isCoolingDown: isQuotaCoolingDown,
              markCooldown: markQuotaCooldown,
              label: 'btw-continue',
              onDelta,
              onDiscard: onGiveUp,
              // Writing on is a second call, with a second cost.
              onError: (err, cand) => recordUsage(db, {
                provider: cand.provider, model: cand.model, kind: 'btw',
                outcome: isRateLimit(err) ? 'quota' : 'failed',
              }),
            });
            if (cont) {
              recordUsage(db, {
                provider: cont.provider, model: cont.model, kind: 'btw', outcome: 'ok',
              });
            }
            if (!cont) throw new Error('no model could write on');
            return { finishReason: cont.finishReason };
          },
        );
        send({
          done: true,
          provider: result.provider,
          model: result.model,
          // Sagt die Wahrheit über die Antwort im Panel: sie ist unfertig, und
          // "Im Chat behalten" hieße, ein Bruchstück zu behalten.
          ...(whole.truncated ? { truncated: true } : {}),
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
      // "Request was aborted." is the SDK talking to itself. What happened is
      // that nobody answered inside the aside's 30-second budget — and that is
      // a sentence the panel can say in the user's own language (user report
      // with picture 2026-08-20). The raw message still travels as a fallback
      // for everything that is not a timeout.
      send({
        error: err.message,
        ...(isAbortError(err) ? { reason: 'timeout' } : {}),
      });
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
