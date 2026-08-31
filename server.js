/* Cellular Drift — local HTTP server: serves the distribution and same-origin
 * /api routes (server time, score submission). No external dependencies. */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

let scores = []; // { contentId, score, objectiveMet, invalid, durationMs, sessionId }

function send(res, code, body, type) {
  res.writeHead(code, { 'content-type': type || 'text/plain' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = req.url;
  if (url === '/api/v1/time') {
    return send(res, 200, JSON.stringify({ now: Date.now() }), 'application/json');
  }
  if (url.startsWith('/api/v1/scores')) {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const entry = JSON.parse(body);
          scores.push(entry);
          send(res, 200, 'ok');
        } catch (e) {
          send(res, 400, 'bad request');
        }
      });
    } else if (url.includes('content=')) {
      const cid = decodeURIComponent(url.split('content=')[1]);
      const rows = scores.filter((s) => s.contentId === cid);
      send(res, 200, JSON.stringify(rows), 'application/json');
    } else {
      send(res, 200, JSON.stringify(scores), 'application/json');
    }
    return;
  }

  // static files (default index.html)
  let file = url === '/' ? '/index.html' : url.split('?')[0];
  const fp = path.join(ROOT, file);
  fs.readFile(fp, (err, data) => {
    if (err) return send(res, 404, 'not found');
    const ext = path.extname(file).toLowerCase();
    let type = 'application/octet-stream';
    if (ext === '.html') type = 'text/html; charset=utf-8';
    else if (ext === '.js' || ext === '.mjs') type = 'application/javascript; charset=utf-8';
    else if (ext === '.css') type = 'text/css; charset=utf-8';
    else if (ext === '.json') type = 'application/json; charset=utf-8';
    else if (ext === '.opus') type = 'audio/ogg';
    send(res, 200, data.toString('binary'), type);
  });
});

server.listen(PORT, () => {
  console.log('Cellular Drift server listening on http://localhost:' + PORT);
});

module.exports = { server };
