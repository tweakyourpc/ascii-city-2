import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequestHandler } from '../dev-server.mjs';

test('development server handler exposes the identity contract without binding a port', () => {
  const headers = new Map();
  let body = '';
  const handler = createRequestHandler({
    root: process.cwd(),
    identity: () => ({
      service: 'ascii-city-2-web', version: '2.0.0', pid: 123,
      startedAt: '2026-08-24T00:00:00.000Z', host: '0.0.0.0', port: 43210,
    }),
  });
  handler(
    { url: '/whoami', headers: { host: 'example.test' } },
    { setHeader: (name, value) => headers.set(name, value), end: (value) => { body = value; } },
  );
  assert.equal(headers.get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(body), {
    service: 'ascii-city-2-web', version: '2.0.0', pid: 123,
    startedAt: '2026-08-24T00:00:00.000Z', host: '0.0.0.0', port: 43210,
  });
});
