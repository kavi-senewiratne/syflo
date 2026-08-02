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
const { isRateLimit, isDailyQuota, isModelUnavailable, msUntilUtcMidnight } = require('../quota');

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

  // Same candidate order as the chat's pickFallback (messages.js): the
  // selected model of each provider first, providers starting with the
  // active one, cloud-with-key only. No vision gate — definitions are text.
  const cloudCandidates = (activeProvider) => {
    const reg = getRegistry(db);
    const order = [activeProvider, ...Object.keys(reg.providers).filter((n) => n !== activeProvider)];
    const candidates = [];
    for (const name of order) {
      const p = reg.providers[name];
      if (!p || p.kind !== 'cloud') continue;
      if (!getSetting(db, `${name}_api_key`)) continue;
      const selected = getSetting(db, `${name}_model`);
      const models = [selected, ...p.models.map((m) => m.name).filter((n) => n !== selected)];
      for (const m of models) {
        if (!m) continue;
        // Ladder parity with the chat (cost tiers 2026-07-30): paid-only
        // models are never fallback material — only the active provider's
        // deliberate selection may be one.
        const isActiveSelection = name === activeProvider && m === selected;
        if (!isActiveSelection && getModelInfo(db, name, m).free === false) continue;
        candidates.push({ provider: name, model: m });
      }
    }
    return candidates;
  };

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

    // ── Cloud path: candidate ladder with shared cooldown memory.
    try {
      const cooling = isQuotaCoolingDown || (() => false);
      const all = cloudCandidates(activeProvider);
      // Proactive skip of known-exhausted models — unless everything is
      // cooling down (then try anyway; maybe the quota reset early).
      let candidates = all.filter((c) => !cooling(c.provider, c.model));
      if (candidates.length === 0) candidates = all;

      let lastErr = null;
      for (const cand of candidates) {
        const { client } = getLLMClientFor(db, cand.provider);
        try {
          const content = await askStandalone(client, cand.model, cand.provider);
          return res.json({ explanation: content });
        } catch (err) {
          const unavailable = isModelUnavailable(err);
          if (!isRateLimit(err) && !unavailable) throw err;
          // Same cooldown classification as the chat, into the SAME memory.
          if (markQuotaCooldown) {
            if (unavailable) markQuotaCooldown(cand.provider, cand.model, 24 * 60 * 60 * 1000, 'retired');
            else if (isDailyQuota(err)) markQuotaCooldown(cand.provider, cand.model, msUntilUtcMidnight(), 'daily');
            else markQuotaCooldown(cand.provider, cand.model, 90_000, 'minute');
          }
          lastErr = err;
        }
      }

      // Every candidate was rate-limited or retired.
      const err = new Error(
        'Every configured cloud model is rate-limited right now — try again in a moment or switch to the local model.'
      );
      err.cause = lastErr;
      throw err;
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
