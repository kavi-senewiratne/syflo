# Syflo: turn one long chat into a tree of branches

An AI chat app — ChatGPT, Claude, any of them — gives you one long scroll.
Learning something doesn't work like that. You need what you're reading to stay
in view the whole time, and you need somewhere to put the five questions it
raised along the way.

Syflo does those two things.

**You keep one main chat, and open a branch for every side question.** A branch
is a separate chat, hanging off the word or the answer it came from. Ask about
attention heads in a branch and the main chat is untouched — the question has
its own place, and you can still find it next week. The branch is not starting
from nothing, though: it is handed the main chat as background, so you never
have to explain yourself twice. What it is *not* handed is the four other
branches. Each conversation carries only what it needs. This works in any chat,
about anything; no document required.

**And when there is a document, it stays visible.** Start a tree around a PDF or
a YouTube video and it keeps the centre of the window for as long as that tree
exists — because it belongs to the conversation, not to a message. You can see
it, and so can the model: it never scrolls out of memory.

It is open source under MIT, it runs on your own machine, and the install is one
line — but that comes later. First, what those two things look like in practice.

---

## Why I built it

I was reading *Attention Is All You Need*. I asked what a key-value pair was.
The answer mentioned dot-product scaling, so I asked about that. That answer
mentioned why the gradients vanish without it. Twenty messages later I wanted to
go back to my original question about heads, and I couldn't find it.

Worse: the paper was gone. Not deleted — just far enough up the transcript that
the model had stopped seeing it. I re-uploaded the PDF to ask a question I could
have asked in message two.

Two separate things had broken. The **context** — what the model can still see.
And the **organisation** — what I can still find. Every feature below exists to
fix one of those.

---

## 1. Every question gets its own chat

Right-click a word in an answer, select a phrase, or type `/branch <topic>`. You
get a new chat dedicated to that one thing. The conversation you were in stays
exactly as it was. Nothing about this needs a document — a tree can grow out of
a plain question just as well.

Half of the benefit is that the questions now have somewhere to live. A week
later I can still find the one about heads, because it is its own chat and not
message 34 of 90.

The other half is what the model receives. Say my tree looks like this:

```
main chat: the paper
  └── attention
        └── why several heads?      ← I'm typing here
  └── GPU memory
```

When I ask my question in *why several heads?*, Syflo sends the model three
things: the **attention** chat in full, a short summary of the **main chat**,
and the words I branched on. That's it.

The **GPU memory** branch is not sent. It has nothing to do with the question,
so it stays out — even though it is part of the same tree.

Compare that with one long chat, where every message ever sent is re-sent on
every turn and the model has to work out for itself which part matters.

So the deeper you go, the *shorter* the context gets — not longer. A question
five branches down might send a couple of thousand tokens, while the same
conversation as one scroll would be sending forty thousand by then, most of it
about something else. Three things follow from that, and I notice all three
daily: answers come back faster, they wander off topic much less often, and a
free daily allowance lasts far longer than it does in a normal chat app.

That last one is not a small point. Long chats burn through free quotas because
you pay for the whole history on every single message.

You don't have to take my word for what was sent. A panel in the child chat
shows you exactly what it received.

![Selecting a passage: definition, five colours, ask here, or branch](gifs/01-branching.gif)

*Diagram in the HTML version: one long chat sends all six messages every turn;
the tree sends three pieces — the parent in full, the root as a summary, the
words branched on.*

---

## 2. The source stays visible

A source is optional. Plenty of my trees are plain conversations with nothing
attached — a question about an algorithm, a bug I'm thinking through — and they
branch exactly the same way. But when there *is* something to read, this is the
part that changed my day-to-day most.

![A plain chat with no document, branched twice](gifs/02-plain-chat.gif)

In Syflo a source is attached to the **tree**, not to a message. Search for a
paper by name and it arrives from arXiv or OpenAlex. Or drop in a PDF. Or paste
a YouTube link and the transcript becomes the source.

It then sits in the centre pane. Message ninety can still ask it questions. So
can a branch four levels deep. There is no re-upload, because nothing was ever
uploaded to a message.

If the source is longer than the context window, Syflo doesn't cut out the
middle and hope. It searches the source and sends the passages your question is
about. That search runs locally, on your machine, even when the answer comes
from a cloud model.

### Papers

You can read a PDF the way you'd read it on paper. Select a passage, highlight
it in one of five colours, ask about it in the chat you're already in.

The part I use most: when the model quotes the paper, the quote is clickable. It
scrolls the PDF to that exact line and lights it up. You can check, in one
click, whether the model read what it claims to have read. It is a small thing
that changed how much I trust the answers.

![Searching for the paper, importing it, asking it a question](gifs/03-paper.gif)

### YouTube lectures

Paste a link and you get the transcript as the tree's source, plus a structured
overview with clickable timestamps. You can decide what is worth watching before
you watch it, and jump straight there.

After that the transcript behaves like the paper: select a sentence, ask what it
means, branch off it. A two-hour lecture becomes something you can interrogate
instead of something you have to sit through.

*[GIF still to record: pasting a YouTube link, the timestamped overview,
selecting a transcript line and asking about it. YouTube was blocking transcript
requests from this machine on the day the other GIFs were made.]*

---

## The Mushroom Kingdom

Syflo ships with five themes, and the default is Mushroom Kingdom: sky, clouds,
question blocks. There's also a Matrix terminal, Hyrule, and a quiet
ink-on-paper theme for when you need to look like an adult.

They change more than the colours — the thinking indicator, the app icon and the
logo all follow the theme.

This is not a serious feature. Reading a reinforcement-learning paper about
Super Mario inside the Mushroom Kingdom theme made me happier than it should
have, and I left it in.

![Cycling through the themes on one tree](gifs/05-themes.gif)

---

## Try it

```bash
npm install -g syflo
syflo
```

Node 20+ is the only hard requirement. On first start, add a provider key in
Settings.

**You should not have to pay for this.** Syflo works with Gemini, Groq, OpenAI,
Anthropic and local Ollama models, and you pick which one answers each message.
Gemini and Groq both hand out free keys with a daily allowance, and for a normal
evening of reading that allowance has been enough for me — I have never paid for
a Syflo session. When you do run out, Syflo says so plainly and shows you when
the limit resets, instead of failing with a red error. The model picker also
labels which models are free and which cost money, so a paid one is never one
misclick away.

If you want no provider at all, point Syflo at a local
[Ollama](https://ollama.com) model. Then nothing leaves your machine, and there
is nothing to pay for by definition.

The key is yours in every case. Syflo ships without one, never proxies your
traffic, and keeps everything in `~/.syflo`.

**Repository:** <https://github.com/kavi-senewiratne/syflo>

Honest expectations: this is a nights-and-weekends project by one person. It is
useful to me daily and it is not a product. There is no roadmap, no release
cadence, and the SQLite schema still moves. Issues and pull requests are
welcome; a promise that your idea gets built is not.

---

## The smaller things

None of these are a reason to install Syflo. They are the reasons it stays
pleasant once you have.

### Reading and marking up

The cheapest gesture in the app: right-click a word in an answer, or select a
phrase, and a one-line definition appears where you are looking. No new chat, no
message in the transcript — you read it and close it again. It is what I use
twenty times an evening, and it is often enough on its own; the branch is there
for when it isn't.

![Selecting a word and reading its definition](gifs/15-definition.gif)

Highlights in five labelled colours work in the PDF, in the transcript **and**
in the chat. A drawer lists every mark in the tree; click one to jump back to
it, wherever it lives.

![Highlighting in the PDF and in a chat, then the drawer](gifs/06-highlights.gif)

Words you have branched on turn into coloured links inside the original answer,
so you can always get back to a side chat from the sentence that started it.

![Coloured branch links inside an answer](gifs/07-branch-links.gif)

The same gesture works straight from the source. Select any passage in the PDF
and you get two choices: ask about it **in the chat you are already in** — the
passage arrives as a quote above your question — or **open it as its own
branch**, which starts a chat that already knows which sentence it came from.

![Selecting a passage in the paper and asking about it](gifs/14-pdf-select.gif)

### The mind map

The whole tree can be drawn as a map: top-down, root on top, one row per depth,
with the trunk in reserved lanes so the lines never cross.

It is not a poster. Every node is a chat — click one and you land in it, with
the conversation right below the map. Panning, zooming and dragging nodes work
as you'd expect. This is how I come back to a tree a week later, and it is the
only view where the shape of a reading session is visible at all.

![The mind map of a nine-node tree](gifs/08-mindmap.gif)

### Moving around

The whole app is reachable from the keyboard — tree, highlights, composer — and
there is no modal "navigation mode" to enter or forget. Chats can be pinned to
the top of the sidebar. When a side conversation splits off, a trace line in the
parent chat shows you where.

![Keyboard-only navigation](gifs/09-keyboard.gif)

### Asking

`/btw` asks a throwaway side question without cluttering the chat.
`/branch <topic>` starts a branch on something the model never said.

![/btw answering beside the chat, then /branch on a typed topic](gifs/10-btw-branch.gif)

Attachments get an `@alias`. Rename a screenshot to `@results` and mention it
mid-sentence, with autocomplete — *"does the diagram in @architecture match the
numbers in @results?"*

![Two attachments renamed and mentioned in one question](gifs/11-mentions.gif)

There is also web search (Tavily, your key) and custom instructions you set once
in Settings.

### Models

Gemini, Groq, OpenAI, Anthropic, or local Ollama. Your key, your choice,
switchable mid-conversation from the composer. A privacy guard tells you whether
the next message is about to leave the machine, and the picker shows cost tiers
so a free model is never one misclick away from a paid one. Each provider comes
with a step-by-step guide inside the app for getting its key.

![The model picker with cost tiers and remaining quota](gifs/12-model-picker.gif)

### Running it fully offline

The local route is not an afterthought. Point Syflo at
[Ollama](https://ollama.com) and every part of the app that touches a model runs
on your machine: the answers, the search over long papers, the dictation.
Nothing leaves the laptop, and there is no key and no bill.

Picking a local model is usually the hard part, so Syflo does it for you. It
reads your RAM and VRAM and recommends one of three vision models — small,
medium or large — sized for the machine you actually have. You can download it
from Settings without touching a terminal. A manual choice always wins over the
recommendation.

Honest limitation: a small local model is noticeably weaker than Gemini at
reading a dense paper. I use local models when I don't want a document to leave
the machine, and cloud models when I want the best answer. Syflo is built so
that choice is one click, per message.

![Switching the provider to local Ollama in Settings](gifs/13-local-model.gif)

Failures are handled honestly. A rate limit shows a real countdown from the
provider, not a guess. A truncated answer can be continued. A failed one can be
retried without losing the thread.

*[No GIF: a daily quota cannot be exhausted on demand. Worth a screenshot from
real use instead.]*

---

*Syflo is maintained by one person in the evenings. There is no roadmap. But it
is open, and it is what I use every day.*
