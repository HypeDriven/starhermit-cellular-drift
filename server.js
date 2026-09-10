/* Cellular Drift — local HTTP server: serves the distribution and same-origin
 * /api routes (server time, score submission). No external dependencies. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
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
      let tooBig = false;
      req.on('data', (c) => {
        body += c;
        if (body.length > 16384) { tooBig = true; req.destroy(); }
      });
      req.on('end', () => {
        if (tooBig) return;
        try {
          const entry = JSON.parse(body);
          scores.push(entry);
          if (scores.length > 10000) scores = scores.slice(-5000);
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

  // static files (default index.html); normalized and confined to ROOT
  let file = url === '/' ? '/index.html' : url.split('?')[0];
  let rel;
  try {
    rel = decodeURIComponent(file);
  } catch (e) {
    return send(res, 400, 'bad request');
  }
  const fp = path.normalize(path.join(ROOT, rel));
  if (!fp.startsWith(ROOT + path.sep)) return send(res, 403, 'forbidden');
  // dev-only material is never served: tests, tools, node_modules, dotfiles
  const segs = path.relative(ROOT, fp).split(path.sep);
  if (['tests', 'tools', 'node_modules'].includes(segs[0]) || segs.some((s) => s.startsWith('.'))) return send(res, 404, 'not found');
  fs.stat(fp, (statErr, st) => {
    if (statErr || !st.isFile()) return send(res, 404, 'not found');
    // Every asset revalidates on each load (cheap 304s via ETag) so a deploy can
    // never leave a browser or proxy pairing a fresh index.html with stale
    // CSS/JS modules — that combination reproduced as "dark screen, UI cut off".
    const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
    const headers = {
      'cache-control': 'no-cache',
      'etag': etag,
      'last-modified': st.mtime.toUTCString()
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    fs.readFile(fp, (err, data) => {
    if (err) return send(res, 404, 'not found');
    const ext = path.extname(fp).toLowerCase();
    let type = 'application/octet-stream';
    if (ext === '.html') type = 'text/html; charset=utf-8';
    else if (ext === '.js' || ext === '.mjs') type = 'application/javascript; charset=utf-8';
    else if (ext === '.css') type = 'text/css; charset=utf-8';
    else if (ext === '.json') type = 'application/json; charset=utf-8';
    else if (ext === '.svg') type = 'image/svg+xml';
    else if (ext === '.png') type = 'image/png';
    else if (ext === '.webp') type = 'image/webp';
    else if (ext === '.ico') type = 'image/x-icon';
    else if (ext === '.opus') type = 'audio/ogg';
    headers['content-type'] = type;
    res.writeHead(200, headers);
    res.end(data); // Buffer: binary assets (opus/png) must not go through string encoding
    });
  });
});

server.listen(PORT, () => {
  console.log('Cellular Drift server listening on http://localhost:' + server.address().port);
});

export { server };
