# Security policy

## Supported version

| Version | Supported |
| --- | --- |
| 0.1.x | Yes — fixes land in the next 0.1.x release on npm |
| < 0.1.0 | No |

Syflo is pre-1.0. There is one supported line at a time: the latest `0.1.x`
published to npm. Please reproduce a suspected issue against the newest
version before reporting it.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting instead:

1. Go to <https://github.com/kavi-senewiratne/syflo/security/advisories/new>
   (Security → Advisories → *Report a vulnerability* in the repository).
2. Describe what an attacker can do, and how you got there — the smallest
   set of steps that reproduces it is worth more than a long write-up.
3. Mention the Syflo version, your OS, and which LLM provider was configured
   (that path differs a lot between a cloud provider and local Ollama).

Nothing you send there is public until an advisory is published.

## What to expect

Syflo is a nights-and-weekends project maintained by one person. Realistic,
not aspirational:

- **Acknowledgement:** usually within a week, sometimes two.
- **Assessment:** a first verdict — reproduced or not, and how serious — within
  about two weeks of the acknowledgement.
- **Fix:** anything that lets a third party read chats, stored API keys or
  local files gets priority over everything else in the queue. Lower-severity
  issues are fixed when there is a free evening, and may wait weeks.

If you have heard nothing in three weeks, a nudge on the same advisory thread
is welcome and will not be taken as impatience.

Credit in the advisory and the release notes is the default; say so if you
would rather stay anonymous.

## What is in scope

Syflo is a local-first single-user app: a backend bound to `127.0.0.1`, an
Electron (or browser) frontend on the same machine, and a SQLite database plus
uploads under `~/.syflo`. The interesting attack surface is therefore anything
that lets *something else on the machine or on the network* cross into that:

- Any website, page or LLM-generated link reaching the local backend
  (CORS, DNS rebinding, `Host` spoofing) and reading chats or stored API keys.
- Path traversal or arbitrary writes through uploads, PDF handling or the data
  directory.
- Code execution or arbitrary in-app navigation from model output, an uploaded
  file, a PDF, or a fetched web page.
- Leaking a user-owned provider API key anywhere other than the provider it
  belongs to — into the frontend, into logs, or into a request to a third party.
- Dependency vulnerabilities that are actually reachable from Syflo's code.

## What is out of scope

- Anything requiring an attacker who is already running code as your user.
  Syflo stores API keys in a local SQLite file on purpose; a process with your
  privileges can read them, and that is not a Syflo vulnerability.
- Vulnerabilities in an LLM provider, in Ollama, in Tavily, or in another
  upstream service — report those to the service.
- The model saying something wrong, biased or unsafe. That is a model quality
  issue, not a security issue; use a regular issue for it.
- Missing hardening with no attack behind it (headers, version disclosure)
  reported straight from a scanner. Show what it buys an attacker.
- Denial of service against your own machine.
