/**
 * explain.js
 *
 * Provides a simple word/phrase explanation endpoint used by the floating popup.
 * When the user right-clicks a word in any AI response, the frontend calls this
 * route to get a short, plain-language definition and example sentence.
 * Like messages.js, it uses the local Ollama server via the OpenAI-compatible API.
 *
 * KV-Prefix-Sharing (2026-07-25): Kommt eine chatId mit, wird die Frage an den
 * Gesprächskontext des Chats angehängt (derselbe Builder wie echte Nachrichten,
 * Warm-up und Titel-Generierung — inkl. tools, sonst weicht der gerenderte
 * Prefix ab). Ollama hat bei Vision-Modellen genau EINEN KV-Slot: ein
 * Standalone-Prompt verdrängte vorher den teuren Paper-Prefill, und die
 * nächste echte Frage zahlte ihn komplett neu (~60 s, Messung 2026-07-25).
 * Mit geteiltem Präfix ist die Erklärung selbst ein Cache-Treffer UND der
 * Gesprächs-Cache überlebt. Ohne chatId/Builder: Standalone-Prompt wie bisher.
 */

const express = require('express');
const { getLLMClient, noThinkExtras } = require('../llm');
const { ALL_TOOLS } = require('../tools');

module.exports = (db, { buildSystemAndHistory } = {}) => {
  // router is created inside the factory so each call gets a fresh instance.
  // If defined at module level, multiple createApp() calls (e.g. in tests)
  // would stack handlers on the same router, causing the first handler's
  // closure to handle all requests regardless of the current mock.
  const router = express.Router();

  // Zielsprachen-Anweisung (Grill 2026-07-24): Explain erklärt in der Sprache
  // des Lesers (App language), nicht in der Sprache des Wortes — wie ein
  // Englisch-Deutsch-Wörterbuch. Unbekannte Werte fallen auf das bisherige
  // implizite Verhalten zurück (das Modell wählt selbst).
  const LANGUAGE_INSTRUCTION = {
    de: ' Answer in German, regardless of the language of the word itself and regardless of the conversation language.',
    en: ' Answer in English, regardless of the language of the word itself and regardless of the conversation language.',
  };

  // Stilregeln für die Definition — im Kontext-Pfad Teil der User-Message
  // (die letzte Nachricht übersteuert die Chat-Formatregeln), im Standalone-
  // Pfad wie bisher der System-Prompt.
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

    try {
      const { client, model, provider } = getLLMClient(db);

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

      // Kontext-Pfad nur bei Ollama (dort zählt der lokale Cache; Cloud-
      // Provider behalten den billigen Mini-Prompt, wie die Titel-Generierung).
      let completion = null;
      if (provider === 'ollama' && chatId && buildSystemAndHistory) {
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
            try {
              completion = await client.chat.completions.create({
                model,
                ...noThinkExtras(provider),
                messages: contextMessages,
                // Dieselben tools wie das Gespräch — sonst rendert das Chat-
                // Template einen anderen Präfix und der Cache greift nicht.
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
            // Hat das Modell statt einer Definition einen Tool-Aufruf oder
            // nichts geliefert, greift unten der Standalone-Pfad.
            if (!completion.choices[0]?.message?.content?.trim()) completion = null;
          } catch (_) {
            completion = null; // Kontextaufbau fehlgeschlagen → Standalone
          }
        }
      }

      if (!completion) {
        completion = await client.chat.completions.create({
          model,
          ...noThinkExtras(provider),
          messages: standaloneMessages,
        });
      }

      // Return just the explanation text — the frontend handles displaying it.
      res.json({ explanation: completion.choices[0].message.content });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
