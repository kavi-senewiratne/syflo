/**
 * explain.js
 *
 * Provides a simple word/phrase explanation endpoint used by the floating popup.
 * When the user right-clicks a word in any AI response, the frontend calls this
 * route to get a short, plain-language definition and example sentence.
 * Like messages.js, it uses the local Ollama server via the OpenAI-compatible API.
 *
 * KV prefix sharing (2026-07-25): If a chatId is provided, the question is
 * appended to the chat's conversation context (same builder as real messages,
 * warm-up and title generation — incl. tools, otherwise the rendered prefix
 * diverges). Ollama has exactly ONE KV slot for vision models: a standalone
 * prompt previously evicted the expensive paper prefill, and the next real
 * question paid for it all over again (~60 s, measured 2026-07-25).
 * With a shared prefix the explanation itself is a cache hit AND the
 * conversation cache survives. Without chatId/builder: standalone prompt as before.
 *
 * Quota failover (user request 2026-07-28): a definition must not die with
 * the active model's quota. Cloud requests walk the same candidate ladder as
 * the chat (messages.js) — remaining models of the SAME provider first, then
 * other keyed cloud providers — sharing the chat's cooldown memory so known
 * walls are skipped proactively in both directions. Unlike the chat there is
 * no visible countdown: a popup either answers now or moves on. The local
 * provider stays outside the ladder entirely (privacy guard, mockup-model-flow
 * §11 — and a cloud definition never silently becomes a slow local one).
 */

const express = require('express');
const { getLLMClient, getLLMClientFor, getSetting, noThinkExtras } = require('../llm');
const { getRegistry, getModelInfo } = require('../registry');
const { ALL_TOOLS } = require('../tools');
const { callCloudLadder, isRateLimit, isModelUnavailable } = require('../quota');

// Zeitbudget des Popups: eine Definition, die länger braucht, als der Nutzer
// hinschaut, ist keine mehr. Die ganze Leiter bekommt ein Budget, jeder
// einzelne Aufruf ein kürzeres — vorher lief hier gar kein Timeout, ein
// hängender Anbieter blockierte das Popup unbegrenzt.
const EXPLAIN_BUDGET_MS = 20000;
const EXPLAIN_CALL_MS = 10000;

module.exports = (db, { buildSystemAndHistory, isQuotaCoolingDown, markQuotaCooldown } = {}) => {
  // router is created inside the factory so each call gets a fresh instance.
  // If defined at module level, multiple createApp() calls (e.g. in tests)
  // would stack handlers on the same router, causing the first handler's
  // closure to handle all requests regardless of the current mock.
  const router = express.Router();

  // Target-language instruction (grill 2026-07-24): Explain explains in the
  // reader's language (App language), not in the language of the word — like
  // an English-German dictionary. Unknown values fall back to the previous
  // implicit behavior (the model chooses itself).
  const LANGUAGE_INSTRUCTION = {
    de: ' Answer in German, regardless of the language of the word itself and regardless of the conversation language.',
    en: ' Answer in English, regardless of the language of the word itself and regardless of the conversation language.',
  };

  // Style rules for the definition — in the context path part of the user
  // message (the last message overrides the chat formatting rules), in the
  // standalone path the system prompt as before.
  const STYLE_RULES =
    'Give only a brief plain-prose definition (1-2 sentences) of the given word or phrase. ' +
    'Do not include example sentences. Do not use any markdown formatting: no asterisks, ' +
    'no bold, no italics, no headings, no bullet lists, no quotation marks around the word ' +
    'itself. Return plain text only.';

  // POST /api/explain
  // Accepts a word, optional surrounding context, an optional target language
  // ('en' | 'de', the frontend's App language) and an optional chatId (for
  // prefix sharing); returns a short explanation.
  router.post('/', async (req, res) => {
    const { word, context, language, chatId } = req.body;
    if (!word) return res.status(400).json({ error: 'word is required' });

    const define = context
      ? `Define "${word}" as used in: "${context}"`
      : `Define "${word}"`;
    const languageRule = LANGUAGE_INSTRUCTION[language] || '';

    const standaloneMessages = [
      {
        role: 'system',
        content: 'You are a concise dictionary. ' + STYLE_RULES + languageRule,
      },
      { role: 'user', content: define },
    ];

    const askStandalone = async (client, model, provider) => {
      const completion = await client.chat.completions.create({
        model,
        ...noThinkExtras(provider),
        messages: standaloneMessages,
      });
      return completion.choices[0].message.content;
    };

    const activeProvider = getSetting(db, 'llm_provider');

    // ── Local path: unchanged, and deliberately without failover — the
    // privacy guard works in both directions (never local → cloud), and the
    // KV-cache context path below only exists for Ollama anyway.
    if (activeProvider === 'ollama') {
      try {
        const { client, model, provider } = getLLMClient(db);

        // Context path only for Ollama (there the local cache matters; cloud
        // providers keep the cheap mini prompt, like title generation).
        let content = null;
        if (chatId && buildSystemAndHistory) {
          const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
          if (chat) {
            try {
              const built = await buildSystemAndHistory(chat, { dropLastMessage: false });
              const contextMessages = [
                ...built.messages,
                {
                  role: 'user',
                  content:
                    'For this one message, act as a concise dictionary and ignore the ' +
                    'conversation formatting rules. ' + define + '. ' + STYLE_RULES + languageRule,
                },
              ];
              let completion;
              try {
                completion = await client.chat.completions.create({
                  model,
                  ...noThinkExtras(provider),
                  messages: contextMessages,
                  // The same tools as the conversation — otherwise the chat
                  // template renders a different prefix and the cache misses.
                  tools: ALL_TOOLS,
                });
              } catch (err) {
                if (!/does not support tools/i.test(err?.message || '')) throw err;
                completion = await client.chat.completions.create({
                  model,
                  ...noThinkExtras(provider),
                  messages: contextMessages,
                });
              }
              // If the model returned a tool call or nothing instead of a
              // definition, the standalone path below takes over.
              content = completion.choices[0]?.message?.content?.trim() || null;
            } catch (_) {
              content = null; // context build failed → standalone
            }
          }
        }

        if (!content) content = await askStandalone(client, model, provider);
        return res.json({ explanation: content });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── Cloud path: the SHARED candidate ladder (../quota.js), the same one
    // the answer, the passage title and the outcome line walk. It used to be a
    // private loop here that only survived 429s and retired models: every
    // other 400 ended the definition on the spot. That is how a model which
    // rejects the no-thinking flag ("400 `reasoning_effort` is not supported
    // with this model") put its raw error into the popup instead of a
    // definition (user report 2026-08-06) — the ladder retries such a model
    // once WITHOUT the flag and otherwise moves on to the next candidate.
    try {
      // The popup shows whatever comes back. A CONFIGURATION error is worth
      // more than a summary — "Incorrect API key" tells the user what to fix —
      // while an exhausted ladder is better summarized than named model by
      // model, which is why only the non-quota case is carried out.
      let lastErr = null;
      const result = await callCloudLadder(db, {
        activeProvider,
        messages: standaloneMessages,
        budgetMs: EXPLAIN_BUDGET_MS,
        callMs: EXPLAIN_CALL_MS,
        isCoolingDown: isQuotaCoolingDown,
        markCooldown: markQuotaCooldown,
        label: 'explain',
        // Quota-Fehler NICHT übernehmen: dafür gibt es die Zusammenfassung
        // unten, die auch den Ausweg über das lokale Modell nennt.
        onError: (err) => { if (!isRateLimit(err) && !isModelUnavailable(err)) lastErr = err; },
      });
      if (result) return res.json({ explanation: result.raw });

      // Nothing delivered: every candidate was rate-limited, retired, gated,
      // out of time — or the key is simply wrong.
      throw lastErr ?? new Error(
        'No configured cloud model could answer right now — try again in a moment or switch to the local model.'
      );
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
