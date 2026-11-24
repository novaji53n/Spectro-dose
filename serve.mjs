import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8765);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method Not Allowed');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname);
  } catch {
    send(res, 400, 'Bad Request');
    return;
  }

  if (pathname === '/' || pathname === '') pathname = '/index.html';

  const filePath = path.resolve(ROOT, `.${pathname}`);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    send(res, 403, 'Forbidden');
    return;
  }

  let info;
  try {
    info = await stat(filePath);
  } catch {
    send(res, 404, 'Not Found');
    return;
  }

  if (!info.isFile()) {
    send(res, 404, 'Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': info.size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = createReadStream(filePath);
  stream.on('error', () => {
    res.destroy();
  });
  stream.pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`Spectro Dose Reader: http://${HOST}:${PORT}/`);
  console.log('เปิดด้วย Chrome หรือ Edge (Web Serial ใช้ได้เฉพาะ Chrome/Edge)');
  console.log('Ctrl+C เพื่อหยุดเซิร์ฟเวอร์');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`พอร์ต ${PORT} ถูกใช้งานอยู่ — ตั้งค่าใหม่ด้วย: $env:PORT=8790; node serve.mjs`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
