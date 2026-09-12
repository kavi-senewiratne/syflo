#!/usr/bin/env python3
"""Render article.md -> index.html (run: python3 render.py).

Tailored to this one article, not a general Markdown engine: headings,
paragraphs, one ordered list, fenced code, hr, images followed by a
"*Figure N: ...*" caption line, and the context-tree diagram, which is
replaced by an inline SVG so it recolours in dark mode.
Temporary tooling, same convention as rec/ — delete when the article is final.
"""
import html
import re
import sys
from pathlib import Path

HERE = Path(__file__).parent
BYLINE_DATE = 'September 2026'

HEAD = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title}</title>
<style>
  :root {{
    --paper: #fdfdfb;
    --ink: #1c1c1a;
    --muted: #6b6b66;
    --accent: #2563eb;
    --rule: #e6e4de;
    --slot-bg: #f4f3ef;
    --mono: ui-monospace, "SF Mono", Menlo, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }}
  @media (prefers-color-scheme: dark) {{
    :root {{
      --paper: #191917;
      --ink: #e8e6e1;
      --muted: #9a9891;
      --accent: #8faaff;
      --rule: #33322e;
      --slot-bg: #22211e;
    }}
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0;
    background: var(--paper);
    color: var(--ink);
    font-family: Charter, Georgia, "Times New Roman", serif;
    font-size: 1.125rem;
    line-height: 1.65;
  }}
  .page {{ max-width: 44rem; margin: 0 auto; padding: 4rem 1.25rem 6rem; }}

  h1 {{ font-size: 2.3rem; line-height: 1.15; margin: 0 0 1.2rem; letter-spacing: -.01em; }}
  .byline {{
    font-family: var(--sans); font-size: .85rem; color: var(--muted);
    border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule);
    padding: .6rem 0; margin: 1.6rem 0 2.6rem;
    display: flex; gap: 1rem; flex-wrap: wrap;
  }}
  .byline a {{ color: var(--accent); text-decoration: none; }}

  h2 {{ font-size: 1.5rem; margin: 3.2rem 0 .9rem; line-height: 1.25; }}
  h3 {{ font-size: 1.15rem; margin: 2.2rem 0 .6rem; font-family: var(--sans); }}
  p {{ margin: 0 0 1.1rem; }}
  a {{ color: var(--accent); }}
  strong {{ font-weight: 600; }}
  ul, ol {{ padding-left: 1.2rem; }}
  li {{ margin-bottom: .4rem; }}

  code {{
    font-family: var(--mono); font-size: .85em;
    background: var(--slot-bg); padding: .1em .35em; border-radius: 4px;
  }}
  pre {{
    font-family: var(--mono); font-size: .82rem; line-height: 1.55;
    background: var(--slot-bg); border: 1px solid var(--rule);
    border-radius: 10px; padding: 1rem 1.1rem; overflow-x: auto;
    margin: 1.4rem 0;
  }}
  pre code {{ background: none; padding: 0; font-size: inherit; }}

  figure {{ margin: 1.8rem 0 2.4rem; }}
  figure img {{
    width: 100%; display: block;
    border-radius: 10px; border: 1px solid var(--rule);
  }}
  figcaption {{
    font-family: var(--sans); font-size: .85rem; color: var(--muted);
    margin-top: .6rem; line-height: 1.5;
  }}
  /* "Figure 1" stays in the caption grey — no black, no bold. */
  figcaption .fignum {{ font-weight: inherit; color: inherit; }}
  .diagram {{ overflow-x: auto; }}
  .diagram svg {{ display: block; margin: 0 auto; max-width: 100%; height: auto; }}

  hr {{ border: none; border-top: 1px solid var(--rule); margin: 3rem 0; }}
  .closing {{ color: var(--muted); font-style: italic; }}
</style>
</head>
<body>
<div class="page">

  <h1>{title}</h1>
  <div class="byline">
    <span>Kavi Senewiratne</span>
    <span>{date}</span>
    <span><a href="https://github.com/kavi-senewiratne/syflo">Syflo on GitHub</a></span>
    <span>MIT</span>
  </div>
"""

FOOT = """
</div>
</body>
</html>
"""

# The context-tree image is replaced by this inline SVG (currentColor follows
# the page theme, so it works in dark mode where the .svg file cannot).
DIAGRAM_SVG = """    <svg viewBox="0 0 660 300" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="12.5">
      <text x="140" y="22" text-anchor="middle" font-weight="600" fill="currentColor">ChatGPT, Claude — one long chat</text>
      <text x="140" y="40" text-anchor="middle" fill="#8a8a85">every message, every turn</text>
      <g>
        <rect x="72" y="56" width="136" height="24" rx="6" fill="#d94a3d" opacity="0.26"/>
        <rect x="72" y="86" width="136" height="24" rx="6" fill="#d94a3d" opacity="0.26"/>
        <rect x="72" y="116" width="136" height="24" rx="6" fill="#d94a3d" opacity="0.26"/>
        <rect x="72" y="146" width="136" height="24" rx="6" fill="#d94a3d" opacity="0.26"/>
        <rect x="72" y="176" width="136" height="24" rx="6" fill="#d94a3d" opacity="0.26"/>
        <rect x="72" y="206" width="136" height="24" rx="6" fill="#d94a3d" opacity="0.26"/>
        <text x="140" y="72" text-anchor="middle" fill="currentColor">the paper</text>
        <text x="140" y="102" text-anchor="middle" fill="currentColor">attention</text>
        <text x="140" y="132" text-anchor="middle" fill="currentColor">GPU memory</text>
        <text x="140" y="162" text-anchor="middle" fill="currentColor">positional encodings</text>
        <text x="140" y="192" text-anchor="middle" fill="currentColor">back to attention?</text>
        <text x="140" y="222" text-anchor="middle" fill="currentColor">why several heads?</text>
      </g>
      <text x="140" y="262" text-anchor="middle" fill="#d94a3d" font-weight="600">all six are sent, every time</text>

      <line x1="330" y1="28" x2="330" y2="272" stroke="#bbb" stroke-dasharray="4 4"/>

      <text x="500" y="22" text-anchor="middle" font-weight="600" fill="currentColor">Syflo — a tree of branches</text>
      <text x="500" y="40" text-anchor="middle" fill="#8a8a85">only the path back to the root</text>
      <g stroke="#9a9a95" fill="none">
        <path d="M500 88 V 112 M420 112 H 580 M420 112 V 138 M580 112 V 138"/>
        <path d="M420 164 V 190 M420 190 H 420 M420 190 V 196"/>
      </g>
      <rect x="440" y="58" width="120" height="30" rx="6" fill="#2f9e44" opacity="0.28"/>
      <text x="500" y="77" text-anchor="middle" fill="currentColor">the paper</text>
      <text x="500" y="103" text-anchor="middle" font-size="10.5" fill="#2f9e44">sent as a summary</text>

      <rect x="362" y="138" width="116" height="26" rx="6" fill="#2f9e44" opacity="0.28"/>
      <text x="420" y="155" text-anchor="middle" fill="currentColor">attention</text>
      <text x="420" y="178" text-anchor="middle" font-size="10.5" fill="#2f9e44">sent in full</text>

      <rect x="522" y="138" width="116" height="26" rx="6" fill="#adb5bd" opacity="0.28"/>
      <text x="580" y="155" text-anchor="middle" fill="#8a8a85">GPU memory</text>
      <text x="580" y="178" text-anchor="middle" font-size="10.5" fill="#8a8a85">not sent</text>

      <rect x="358" y="196" width="124" height="30" rx="6" fill="#2f9e44" opacity="0.45"/>
      <text x="420" y="215" text-anchor="middle" fill="currentColor" font-weight="600">why several heads?</text>
      <text x="500" y="262" text-anchor="middle" fill="#2f9e44" font-weight="600">three pieces, not six</text>
    </svg>"""

# Alt texts for the figures. The markdown alt is the fallback; entries here
# override it where the html has carried a richer description.
ALT_OVERRIDES = {
    'gifs/01-branching.gif': "Selecting a passage in an answer; a popup shows a one-line definition, five highlight colours, 'Ask in chat' and 'Open as new chat'. The passage becomes its own chat, which answers a follow-up.",
    'gifs/02-plain-chat.gif': 'A chat with no document at all: a question about LoRA, then two branches — one opened from a phrase in the answer, one typed with /branch. Inside the branch, the centre pane shows the parent conversation.',
    'gifs/03-paper.gif': "Searching for 'attention is all you need', importing the arXiv result, the PDF taking the centre pane, then asking it a question.",
    'gifs/04-youtube.gif': "Importing a video, the transcript arriving as the tree's source, then the timestamped overview writing itself chapter by chapter.",
    'gifs/05-themes.gif': 'The same tree in Mushroom Kingdom, Simply Blue, Hyrule and Matrix.',
    'gifs/06-highlights.gif': 'Highlighting a passage in the PDF, then a sentence in a chat answer, then the highlights drawer listing both and jumping back to one.',
    'gifs/07-branch-links.gif': 'An answer with coloured branch links; clicking one opens that child chat.',
    'gifs/08-mindmap.gif': 'A nine-node mind map of a reading session; clicking a node opens that chat under the map.',
    'gifs/09-keyboard.gif': 'Walking the tree with arrow keys, opening a chat with Enter, then typing straight into the composer.',
    'gifs/10-btw-branch.gif': 'Typing /btw and getting an answer in a side panel, then /branch on a typed topic opening a new chat.',
    'gifs/11-mentions.gif': 'A diagram and a results table attached to the composer, renamed to @architecture and @results, then both mentioned inside one question.',
    'gifs/12-model-picker.gif': 'The model picker: models grouped by what is usable now, with free badges and daily quota bars, and the local Ollama section below.',
    'gifs/13-local-model.gif': 'Settings showing every provider side by side, switching to the local Ollama provider; the composer now answers with the local model.',
    'gifs/14-pdf-select.gif': 'Selecting a sentence in the attention paper; it arrives as a quote above the question, and the answer cites the paper.',
    'gifs/15-definition.gif': 'Double-clicking a word in an answer; the popup shows a one-line definition and is closed again.',
}


def inline(text):
    """Inline markdown -> html for this article's constructs."""
    text = html.escape(text, quote=False)
    text = re.sub(r'&lt;(https?://[^&]+)&gt;', lambda m: f'<a href="{m.group(1)}">{re.sub(r"^https?://", "", m.group(1))}</a>', text)
    text = re.sub(r'`([^`]+)`', r'<code>\1</code>', text)
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2">\1</a>', text)
    text = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', text)
    text = re.sub(r'\*([^*]+)\*', r'<em>\1</em>', text)
    return text


def render(md):
    lines = md.split('\n')
    out = []
    title = 'Syflo'
    i = 0
    # blocks: join wrapped lines into paragraphs first
    blocks = []
    buf = []
    in_code = False
    for line in lines:
        if line.startswith('```'):
            if in_code:
                buf.append(line)
                blocks.append('\n'.join(buf)); buf = []
                in_code = False
            else:
                if buf: blocks.append('\n'.join(buf)); buf = []
                buf = [line]
                in_code = True
            continue
        if in_code:
            buf.append(line)
            continue
        if line.strip() == '':
            if buf: blocks.append('\n'.join(buf)); buf = []
        else:
            buf.append(line)
    if buf: blocks.append('\n'.join(buf))

    pending_image = None  # (src, alt) waiting for its Figure caption

    def flush_image(caption_html=None):
        nonlocal pending_image
        if not pending_image:
            return
        src, alt = pending_image
        pending_image = None
        alt = ALT_OVERRIDES.get(src, alt)
        if src.endswith('context-tree.svg'):
            out.append('  <figure class="diagram">')
            out.append(DIAGRAM_SVG)
        else:
            out.append('  <figure>')
            out.append(f'    <img src="{src}" alt="{html.escape(alt)}" loading="lazy">')
        if caption_html:
            out.append(f'    <figcaption>{caption_html}</figcaption>')
        out.append('  </figure>')
        out.append('')

    n_blocks = len(blocks)
    for bi, b in enumerate(blocks):
        flat = ' '.join(l.strip() for l in b.split('\n')).strip()
        if b.startswith('```'):
            flush_image()
            body = '\n'.join(b.split('\n')[1:-1])
            out.append(f'<pre><code>{html.escape(body)}</code></pre>')
            out.append('')
        elif flat == '---':
            flush_image()
            out.append('  <hr>')
            out.append('')
        elif b.startswith('# '):
            title = flat[2:]
        elif b.startswith('## '):
            flush_image()
            out.append(f'  <h2>{inline(flat[3:])}</h2>')
            out.append('')
        elif b.startswith('### '):
            flush_image()
            out.append(f'  <h3>{inline(flat[4:])}</h3>')
            out.append('')
        elif re.match(r'^\d+\.\s', b):
            flush_image()
            out.append('  <ol>')
            for item in re.split(r'\n(?=\d+\.\s)', b):
                item_flat = ' '.join(l.strip() for l in item.split('\n'))
                item_flat = re.sub(r'^\d+\.\s+', '', item_flat)
                out.append(f'    <li>{inline(item_flat)}</li>')
            out.append('  </ol>')
            out.append('')
        elif re.match(r'^!\[', flat):
            flush_image()
            m = re.match(r'^!\[(.*)\]\((.*)\)$', flat)
            pending_image = (m.group(2).strip(), m.group(1))
        elif re.match(r'^\*Figure \d+:', flat) and pending_image:
            m = re.match(r'^\*Figure (\d+): (.*)\*$', flat)
            cap = f'<span class="fignum">Figure {m.group(1)}:</span> {inline(m.group(2))}'
            flush_image(cap)
        else:
            flush_image()
            if bi == n_blocks - 1 and flat.startswith('*') and flat.endswith('*'):
                out.append(f'  <p class="closing">{inline(flat[1:-1])}</p>')
            else:
                out.append(f'  <p>{inline(flat)}</p>')
            out.append('')
    flush_image()
    return HEAD.format(title=title, date=BYLINE_DATE) + '\n'.join(out).rstrip() + FOOT


if __name__ == '__main__':
    md = (HERE / 'article.md').read_text()
    (HERE / 'index.html').write_text(render(md))
    print('index.html rendered from article.md')
