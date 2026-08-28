/**
 * tests/fake-whisper-server.js
 *
 * Minimal stand-in for whisper-server in tests. Speaks exactly the subset
 * of the HTTP interface that whisper.js uses:
 *   - GET  /          → 200 (readiness poll)
 *   - POST /inference → JSON { text, language, duration }, where text
 *     reflects the received multipart fields so tests can verify what
 *     actually arrived at the server (e.g. language=auto, file size).
 *     `language` is what the real server reports back as DETECTED — the
 *     request asks for 'auto', the answer names a concrete language.
 *
 * Invocation: node fake-whisper-server.js <port>
 */

const http = require('http');

const port = Number(process.argv[2]);

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/inference') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('latin1');
      // Roughly fish out the multipart fields — good enough for test assertions.
      const language = (body.match(/name="language"\r\n\r\n([^\r]+)/) || [])[1] || '';
      const fileBytes = (body.match(/name="file"[\s\S]*?\r\n\r\n([\s\S]*?)\r\n--/) || ['', ''])[1].length;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // The real whisper-server separates segments with \n — so does the
      // fake, so tests can lock in the whitespace normalization.
      res.end(JSON.stringify({
        text: ` fake transcript\n language=${language}\n bytes=${fileBytes} `,
        language: 'german',
        duration: 1.9,
      }));
    });
    return;
  }
  res.writeHead(200);
  res.end('ok');
});

server.listen(port, '127.0.0.1');
