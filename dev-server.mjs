import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const service = 'ascii-city-2-web';
const version = '2.0.0';
const host = '0.0.0.0';
const port = Number(process.env.PORT);
const startedAt = new Date().toISOString();
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must come from portbroker before starting the server');
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/whoami') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ service, version, pid: process.pid, startedAt, host, port }));
    return;
  }
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.(\/|\\|$))+/, '');
  const file = join(process.cwd(), rel === '/' ? 'index.html' : rel);
  try {
    if (!statSync(file).isFile()) throw new Error('not a file');
    res.setHeader('content-type', types[extname(file)] || 'application/octet-stream');
    res.setHeader('cache-control', 'no-store');
    createReadStream(file).pipe(res);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
}).listen(port, host, () => console.log(`ASCII City listening on ${host}:${port}`));
