# GIF recording framework (2026-09-10 retake, Mushroom Kingdom)

Temporary tooling, like `frontend/vite.rec.config.ts` — delete when the article is final.

Setup for a recording session:
1. Isolated backend serving the built frontend (no vite — the dev server dies
   when its stdin closes and kills recordings mid-stream):
   `cd frontend && npx vite build`
   `cd backend && PORT=3002 SYFLO_DATA_DIR=<tmp>/demo-data SYFLO_FRONTEND_DIR=$PWD/../frontend/dist node server.js`
2. Copy `gemini_api_key`/`groq_api_key` into the demo DB settings; set
   `custom_instructions` to a compact-answers instruction (keeps GIFs short).
3. `npm i playwright && npx playwright install chromium` next to these scripts,
   then `SP=<scratch> node scene01.js` etc. lib.js records 1100x688 webm and
   converts to GIF (10fps, 96 colours, ~1.4x speed, optional cuts for
   provider-cooldown or long streams).

Gotchas that cost retakes: gpt-oss writes U+2011 hyphens (needles must match the
rendered text, pick them from the DOM); the selection popup opens on mouseup
(no right-click since 2026-07-31); Groq answers within seconds but two paper
questions in one minute trip the 8k TPM — pause 65s and cut it out of the gif;
model with vision needed for image scenes (gpt-oss can't); YouTube: ONE import
per day, and the caption-track pick is alphabetical (see article notes).
