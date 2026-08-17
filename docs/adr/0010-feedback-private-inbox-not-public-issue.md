# Feedback goes to a private email inbox, not an automatic public GitHub issue

Status: accepted (2026-08-01)

Syflo is going open source (ADR-0009 era decisions, `docs/issues/08`) with GitHub
Issues as the public bug tracker. The obvious design for an in-app "Feedback"
button is therefore "auto-file a GitHub issue" — but the backend binds to
`127.0.0.1` only (no public server to host attachments), the GitHub REST API
has no endpoint to attach an image to an issue body, and any user's screenshot
could contain private chat or source content that the **Local provider**
promise says never leaves the device. Auto-posting that publicly, without a
review step, would break that promise for anyone who forgets what's in frame.

## Decision

- Feedback is submitted as **text only** (no image/video attachments) via
  Web3Forms' client-safe `access_key`, emailing straight to `syfloapp@gmail.com`.
  No secret credential lives in the (open-source) client code.
- The two entry points — a pinned sidebar button and a `/feedback` composer
  command — open the same dialog: a **kind** chip (Bug / Idea / Question,
  prefixed onto the email subject), a text field, and an optional reply-to
  email field.
- Nothing is posted to GitHub automatically. The maintainer reads the inbox
  and manually opens a public issue when warranted — the dialog says this
  explicitly so submitters don't assume otherwise.
- Every submission automatically appends Syflo version, OS, and active
  provider below the user's text, regardless of kind — cheap diagnostic
  metadata, not chat content, so it doesn't touch the privacy promise above.

## Considered options

- **Auto-create a public GitHub issue** (needs a GitHub token client-side —
  a real secret in an MIT repo — and has no attachment story); rejected.
- **Formspree/Web3Forms with attachments** — both gate file uploads behind a
  paid plan on free tier; dropped attachments entirely instead of paying,
  since text-only kept the feature server-less and free.
- **Self-hosted relay server** (e.g. on the planned `syflo.dev`) holding a
  real email-API secret — would allow attachments later, but is real
  infrastructure for a nights-and-weekends single-maintainer project; deferred.

## Consequences

- No image/video attachments in v1 — if that's later needed, either pay for
  a Pro tier (Web3Forms free plan attachments are capped at 5 MB anyway) or
  stand up the relay server option above.
- Web3Forms free tier caps at 250 submissions/month; revisit if the project
  outgrows that.

## Amendment 2026-08-06: the POST must come from the browser, not the backend

Verified against the real Web3Forms API (not caught by any mock): a Node
backend calling `api.web3forms.com/submit` server-to-server gets HTTP 403 —
"Use our API in client side or contact support ... Pro plan is required."
Their free plan only accepts submissions that originate from a browser.

`routes/feedback.js` is no longer a submit proxy. It now only serves
`GET /api/feedback/config` — the access key (still non-secret) plus the
version/OS/provider diagnostics — and `frontend/src/api/index.ts` posts
directly to Web3Forms from the browser with that config. Same inbox, same
diagnostics, same no-attachments scope; only the network hop moved.

## Amendment 2026-08-08: default key ships in code; GitHub issues as fallback

An env-only key would silently disable feedback for every npm install (no
`.env` ships with the package) — defeating the feature's whole point for an
open-source release. Since Web3Forms access keys are client-safe by design
(they can do nothing but deliver a message to the maintainer's inbox), a
default key is now baked into `routes/feedback.js`; `WEB3FORMS_ACCESS_KEY`
remains as override for forks and for rotation.

The failure path degrades instead of dead-ending: the config hands out
`issuesUrl`, and a failed send (key rotated, 250/month quota exhausted,
offline) shows "Open a GitHub issue instead" next to the error — with a
hardcoded frontend fallback URL so the link works even when the backend is
unreachable. A honeypot field was considered and skipped: it only stops
form-crawling bots, not someone who scrapes the public key and posts their
own payloads — for that, rotation is the answer.
