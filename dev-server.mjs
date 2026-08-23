import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const service = 'ascii-city-2-web';
const version = '2.0.0';
const host = process.env.HOST || '0.0.0.0';
const requestedPort = process.env.PORT ? Number(process.env.PORT) : 0;
let port = requestedPort;
const startedAt = new Date().toISOString();
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
  throw new Error('PORT must be an integer from 1 to 65535, or omitted for an available port');
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = createServer((req, res) => {
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
});

server.listen(requestedPort, host, () => {
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : requestedPort;
  console.log(`ASCII City listening on http://${host}:${port}`);
});
