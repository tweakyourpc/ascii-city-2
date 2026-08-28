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
  const body = await ok.json();
  assert.deepEqual(body.ac, [{ hex: 'abc' }]);
  assert.equal(body.source, 'adsb.lol', 'the first upstream is preferred');

  globalThis.fetch = async () => new Response('unavailable', { status: 503 });
  const failed = await worker.fetch(new Request(
    'https://example.test/api/aircraft?lat=40.7&lon=-74&radiusKm=30'), {});
  assert.equal(failed.status, 502);
  // Every upstream is named with the status it gave, rather than an empty sky
  // the client would draw as "no aircraft here".
  assert.deepEqual((await failed.json()).tried.map((t) => t.status), [503, 503, 503]);
});

test('worker falls back to another aircraft upstream when the first refuses', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    const value = String(url);
    // adsb.lol and adsb.fi both refuse Cloudflare's shared egress addresses.
    if (value.includes('adsb.lol')) return new Response('no', { status: 403 });
    if (value.includes('adsb.fi')) return new Response('no', { status: 429 });
    return new Response(JSON.stringify({
      // icao, callsign, country, _, _, lon, lat, baro_m, on_ground, vel_ms,
      // track, _, _, geo_m, squawk
      states: [['a1b2c3', 'TEST123 ', 'United States', 0, 0, -74.01, 40.71,
        3048, false, 128.6, 270.5, 0, null, 3100, '1200', false, 0]],
    }));
  };
  const res = await worker.fetch(new Request(
    'https://example.test/api/aircraft?lat=40.7&lon=-74&radiusKm=30'), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.source, 'opensky');
  const [ac] = body.ac;
  assert.equal(ac.hex, 'a1b2c3');
  assert.equal(ac.flight, 'TEST123 ');
  assert.equal(ac.lat, 40.71);
  // SI in, the client's feet and knots out.
  assert.equal(ac.alt_geom, Math.round(3100 * 3.28084));
  assert.equal(ac.alt_baro, Math.round(3048 * 3.28084));
  assert.equal(ac.gs, Math.round(128.6 * 1.94384 * 10) / 10);
  assert.equal(ac.track, 270.5);
});

test('an aircraft on the ground is reported as such, not as a low flight', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => (String(url).includes('opensky')
    ? new Response(JSON.stringify({
      states: [['ground1', 'TAXI', 'US', 0, 0, -74.0, 40.7, null, true, 5, 90,
        0, null, null, null, false, 0]],
    }))
    : new Response('no', { status: 403 }));
  const res = await worker.fetch(new Request(
    'https://example.test/api/aircraft?lat=40.7&lon=-74&radiusKm=30'), {});
  const [ac] = (await res.json()).ac;
  assert.equal(ac.alt_baro, 'ground');
  assert.equal(ac.on_ground, true);
  assert.equal(ac.alt_geom, null, 'a missing altitude stays null, never invented');
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

test('worker identifies itself to the aircraft upstream', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), ua: init?.headers?.['user-agent'] };
    return new Response(JSON.stringify({ ac: [] }));
  };
  const res = await worker.fetch(new Request(
    'https://example.test/api/aircraft?lat=27.3366&lon=-82.5309&radiusKm=30'), {});
  assert.equal(res.status, 200);
  assert.match(seen.url, /api\.adsb\.lol/);
  // adsb.lol answers 403 when no User-Agent is sent, and Workers send none.
  assert.ok(seen.ua, 'a User-Agent must reach the aircraft upstream');
});

test('worker radio asks the directory by position, with no geocoder', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify([{
      stationuuid: '44444444-4444-4444-4444-444444444444', name: 'Close',
      url_resolved: 'https://radio.example/close', geo_lat: 27.34, geo_long: -82.54,
      country: 'US', language: 'English',
    }]));
  };
  const res = await worker.fetch(new Request(
    'https://example.test/api/radio?lat=27.3366&lon=-82.5309'), {});
  const body = await res.json();
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0], /nominatim/);
  assert.match(calls[0], /geo_distance=150000/);
  assert.equal(body.stations[0].name, 'Close');
});
