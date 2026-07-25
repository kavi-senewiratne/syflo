/**
 * tests/fake-whisper-server.js
 *
 * Minimaler Ersatz für whisper-server in Tests. Spricht genau die Teilmenge
 * der HTTP-Schnittstelle, die whisper.js benutzt:
 *   - GET  /          → 200 (Readiness-Poll)
 *   - POST /inference → JSON { text }, wobei text die empfangenen
 *     Multipart-Felder widerspiegelt, damit Tests prüfen können, was
 *     tatsächlich beim Server ankam (z. B. language=auto, Dateigröße).
 *
 * Aufruf: node fake-whisper-server.js <port>
 */

const http = require('http');

const port = Number(process.argv[2]);

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/inference') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('latin1');
      // Multipart-Felder grob herausfischen — für Test-Assertions reicht das.
      const language = (body.match(/name="language"\r\n\r\n([^\r]+)/) || [])[1] || '';
      const fileBytes = (body.match(/name="file"[\s\S]*?\r\n\r\n([\s\S]*?)\r\n--/) || ['', ''])[1].length;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Der echte whisper-server trennt Segmente mit \n — der Fake auch,
      // damit Tests die Whitespace-Normalisierung absichern.
      res.end(JSON.stringify({ text: ` fake transcript\n language=${language}\n bytes=${fileBytes} ` }));
    });
    return;
  }
  res.writeHead(200);
  res.end('ok');
});

server.listen(port, '127.0.0.1');
