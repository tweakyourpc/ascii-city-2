import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../worker/src/index.js';

test('worker exposes its identity contract', async () => {
  const res = await worker.fetch(new Request('https://example.test/whoami'), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.service, 'ascii-city-2-api');
  assert.equal(body.version, '2.0.0');
  assert.equal(body.host, 'example.test');
  assert.equal(body.port, 443);
  assert.ok(body.startedAt);
});

test('worker validates coordinates without contacting upstreams', async () => {
  const air = await worker.fetch(new Request('https://example.test/api/aircraft?lat=x&lon=2'), {});
  assert.equal(air.status, 400);
  const radio = await worker.fetch(new Request('https://example.test/api/radio?lat=91&lon=2'), {});
  assert.equal(radio.status, 400);
});

test('worker handles preflight and unknown paths', async () => {
  const options = await worker.fetch(new Request('https://example.test/api/radio', { method: 'OPTIONS' }), {});
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-origin'), '*');
  const missing = await worker.fetch(new Request('https://example.test/nope'), {});
  assert.equal(missing.status, 404);
});
