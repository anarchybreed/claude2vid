// Tiny static file server for the input directory. Needed because the example
// HTML loads sibling .jsx files via <script src="..."> + Babel-standalone,
// and that flow breaks under file:// in headless Chromium.
//
// Also exposes a POST /__upload_audio endpoint used by the audio-capture shim
// to send back the rendered WAV. Same-origin (page and endpoint share the
// server's port), so no CORS dance is needed.

import http from 'node:http';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.jsx':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.otf':   'font/otf',
};

export async function startServer(rootDir) {
  const root = path.resolve(rootDir);
  let uploadPath = null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // Audio upload endpoint (POST). Body streams straight to the configured file.
    if (req.method === 'POST' && url.pathname === '/__upload_audio') {
      if (!uploadPath) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('upload path not configured');
        return;
      }
      const out = fssync.createWriteStream(uploadPath);
      let bytes = 0;
      req.on('data', (c) => { bytes += c.length; });
      req.pipe(out);
      out.on('finish', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, bytes, path: uploadPath }));
      });
      out.on('error', (err) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(String(err.message || err));
      });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405); res.end('method not allowed'); return;
    }

    handleStatic(req, res, root, url).catch((err) => {
      res.writeHead(500); res.end(String(err.message || err));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    setUploadPath: (p) => { uploadPath = p; },
    close: () => new Promise(r => server.close(r)),
  };
}

async function handleStatic(req, res, root, url) {
  try {
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const filePath = path.join(root, rel);

    if (!filePath.startsWith(root)) {
      res.writeHead(403); res.end('forbidden'); return;
    }

    const data = await fs.readFile(filePath);
    const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': mime,
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') {
      res.writeHead(404); res.end('not found');
    } else {
      throw err;
    }
  }
}
