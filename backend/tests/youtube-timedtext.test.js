/**
 * tests/youtube-timedtext.test.js
 *
 * Unit tests for parseTimedText — the parser for YouTube's timedtext caption
 * formats. The transcript fetch goes through the caption track's base_url
 * (ANDROID client) because the WEB get_transcript endpoint 400s and the WEB
 * timedtext URLs return empty bodies without a POT token (live findings,
 * 2026-07-24). Two formats occur in the wild:
 *   - srv3: <timedtext><body><p t="160" d="4080"><s>hi</s><s> there</s></p>
 *   - srv1: <transcript><text start="0.16" dur="4.08">hi there</text>
 */
process.env.OPENAI_API_KEY = 'test-key-for-unit-tests';
const { parseTimedText } = require('../youtube');

describe('parseTimedText', () => {
  it('parses srv3 word-segment XML into {startMs, text} segments', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<timedtext format="3">
<head><wp id="1" ap="6"/><ws id="1"/></head>
<body>
<w t="0" id="1" wp="1" ws="1"/>
<p t="160" d="4080" w="1"><s ac="0">hi</s><s t="160" ac="0"> everyone</s></p>
<p t="90000" d="2000" w="1"><s>so</s><s t="120"> what is an LLM</s></p>
</body>
</timedtext>`;

    expect(parseTimedText(xml)).toEqual([
      { startMs: 160, text: 'hi everyone' },
      { startMs: 90000, text: 'so what is an LLM' },
    ]);
  });

  it('parses srv1 XML and decodes entities', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<transcript>
<text start="0.16" dur="4.08">it&amp;#39;s two files &amp;quot;really&amp;quot;</text>
<text start="90" dur="2">less &amp;lt;tokens&amp;gt;</text>
</transcript>`;

    expect(parseTimedText(xml)).toEqual([
      { startMs: 160, text: "it's two files \"really\"" },
      { startMs: 90000, text: 'less <tokens>' },
    ]);
  });

  it('skips empty paragraphs and returns [] for caption-less XML', () => {
    expect(parseTimedText('<timedtext><body><w t="0"/></body></timedtext>')).toEqual([]);
    expect(parseTimedText('')).toEqual([]);
  });
});
