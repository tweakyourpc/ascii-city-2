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

test('worker proxies successful aircraft payloads and reports upstream failure', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({ ac: [{ hex: 'abc' }] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  const ok = await worker.fetch(new Request(
    'https://example.test/api/aircraft?lat=40.7&lon=-74&radiusKm=30'), {});
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ac: [{ hex: 'abc' }] });

  globalThis.fetch = async () => new Response('unavailable', { status: 503 });
  const failed = await worker.fetch(new Request(
    'https://example.test/api/aircraft?lat=40.7&lon=-74&radiusKm=30'), {});
  assert.equal(failed.status, 502);
  assert.equal((await failed.json()).upstreamStatus, 503);
});

test('worker discovers and sorts nearby HTTPS radio stations', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes('nominatim')) {
      return new Response(JSON.stringify({ address: { country_code: 'us', state: 'New York' } }));
    }
    return new Response(JSON.stringify([
      {
        stationuuid: '11111111-1111-1111-1111-111111111111', name: 'Far',
        url_resolved: 'https://radio.example/far', geo_lat: 41, geo_long: -74,
        country: 'US', language: 'English',
      },
      {
        stationuuid: '22222222-2222-2222-2222-222222222222', name: 'Near',
        url_resolved: 'https://radio.example/near', geo_lat: 40.71, geo_long: -74,
        country: 'US', language: 'English',
      },
    ]));
  };
  const res = await worker.fetch(new Request(
    'https://example.test/api/radio?lat=40.7&lon=-74'), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.stations.length, 2);
  assert.equal(body.stations[0].name, 'Near');
  assert.ok(body.stations[0].distanceKm < body.stations[1].distanceKm);
});

test('worker never presents a distant station as local radio', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    if (String(url).includes('nominatim')) {
      return new Response(JSON.stringify({ address: { country_code: 'us', state: 'Florida' } }));
    }
    return new Response(JSON.stringify([{
      stationuuid: '33333333-3333-3333-3333-333333333333', name: 'Miami only',
      url_resolved: 'https://radio.example/miami', geo_lat: 25.7824, geo_long: -80.1923,
      country: 'US', language: 'Spanish',
    }]));
  };
  const res = await worker.fetch(new Request(
    'https://example.test/api/radio?lat=27.3366&lon=-82.5309'), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.stations, []);
  assert.equal(body.radiusKm, 150);
});
