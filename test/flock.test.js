/**
 * Live ALPR / "flock" camera layer: coordinate math, normalization, tile
 * selection, LIVE/SIMULATED switching, and graceful failure.
 *
 * All hermetic. The recorded DeFlock camera records below are used as a
 * fixture so the network is never touched; fetchCameras is exercised with an
 * injected fetchImpl that returns them (or rejects), exactly as the browser
 * would through the Worker proxy.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeCamera, fetchCameras, buildUrl, tileKey, tilesForBBox,
  flockColour, distanceKm, FlockLayer,
} from '../src/flock.js';
import { makeProjection } from '../src/world/osm.js';

/* --------------------------- recorded fixture --------------------------- */
// Trimmed from a DeFlock region tile (Flock Safety + Motorola cameras), placed
// near the test world centre so the 30 km radius keeps them.
const SAMPLE = {
  cameras: [
    { id: 95865536, lat: 28.10, lon: -81.20, tags: { direction: '270' } },
    {
      id: 96075555, lat: 28.05, lon: -81.05,
      tags: { direction: '180', manufacturer: 'Motorola Solutions' },
    },
    {
      id: 12345678, lat: 28.00, lon: -81.15,
      tags: { manufacturer: 'Flock Safety', operator: 'Police Dept' },
    },
  ],
};

const TEST_WORKER = 'https://worker.example.test';
const newLayer = () => new FlockLayer({ workerUrl: TEST_WORKER });

function fakeFetch(json, { ok = true, status = 200 } = {}) {
  return async () => ({
    ok,
    status,
    json: async () => json,
  });
}

const geoWorld = () => {
  // A small bbox around the Florida sample cameras so the 30 km radius keeps
  // them when the camera sits at the world centre.
  const bbox = [26.25, -82.15, 29.87, -80.05];
  const proj = makeProjection(bbox);
  return { bbox, proj, width: proj.width, height: proj.height, label: 'Test' };
};

/* --------------------------- normalization ------------------------------ */

test('normalizeCamera keeps a valid record', () => {
  const c = normalizeCamera(SAMPLE.cameras[1]);
  assert.equal(c.id, '96075555');
  assert.equal(c.lat, 28.05);
  assert.equal(c.lon, -81.05);
  assert.equal(c.manufacturer, 'Motorola Solutions');
  assert.equal(c.direction, '180');
});

test('normalizeCamera returns null for missing position or id', () => {
  assert.equal(normalizeCamera(null), null);
  assert.equal(normalizeCamera({ id: 1 }), null, 'no position');
  assert.equal(normalizeCamera({ lat: 1, lon: 2 }), null, 'no id');
  assert.equal(normalizeCamera({ id: 1, lat: 'x', lon: 2 }), null, 'bad lat');
});

/* ----------------------------- fetching ---------------------------------- */

test('fetchCameras normalizes the sample', async () => {
  const list = await fetchCameras(28, -81, 30, {
    fetchImpl: fakeFetch(SAMPLE), workerUrl: TEST_WORKER,
  });
  assert.equal(list.length, 3);
  assert.equal(list[0].id, '95865536');
});

test('fetchCameras rejects on HTTP error', async () => {
  await assert.rejects(
    fetchCameras(28, -81, 30, {
      fetchImpl: fakeFetch(SAMPLE, { ok: false, status: 503 }), workerUrl: TEST_WORKER,
    }),
  );
});

test('fetchCameras rejects when fetch is unavailable', async () => {
  await assert.rejects(fetchCameras(28, -81, 30, {
    fetchImpl: null, workerUrl: TEST_WORKER,
  }));
});

test('buildUrl targets an explicitly configured Worker', () => {
  const u = buildUrl(28.0, -81.5, 25, TEST_WORKER);
  assert.match(u, /\/api\/flock\?lat=28\.0000&lon=-81\.5000&radiusKm=25$/);
});

test('buildUrl sends nowhere when no Worker is configured', () => {
  assert.equal(buildUrl(28.0, -81.5, 25, ''), null);
});

/* --------------------------- coordinate math ----------------------------- */

test('tileKey maps a lat/lon to its 20-degree region', () => {
  assert.equal(tileKey(27.9, -82.1), '20/-100');
  assert.equal(tileKey(39.9, -74.9), '20/-80');
  assert.equal(tileKey(-5, 175), '-20/160');
});

test('tilesForBBox spans multiple tiles when needed', () => {
  // A 30 km radius near a tile boundary can touch two tiles.
  const keys = tilesForBBox(19.9, -100.1, 20.1, -99.9).sort();
  assert.ok(keys.includes('20/-120') || keys.includes('20/-100'));
  assert.ok(keys.length >= 1);
});

test('distanceKm is roughly correct for a known separation', () => {
  const d = distanceKm(40.0, -73.0, 41.0, -73.0);
  assert.ok(Math.abs(d - 110.54) < 1, `d ${d}`);
});

test('flockColour encodes manufacturer', () => {
  assert.deepEqual(flockColour('Flock Safety'), [255, 176, 64]);
  assert.deepEqual(flockColour('Motorola Solutions'), [120, 180, 255]);
  assert.deepEqual(flockColour(null), [180, 200, 190]);
});

/* --------------------------- layer lifecycle ----------------------------- */

test('FlockLayer is inactive without a geographic world', () => {
  const layer = newLayer();
  layer.setWorld({ bbox: null, proj: null });
  assert.equal(layer.active, false);
  layer.update(1, { x: 0, y: 0, angle: 0 }, true);
  assert.equal(layer.records.size, 0);
});

test('FlockLayer is inactive without a configured Worker', () => {
  const layer = new FlockLayer({ workerUrl: '' });
  layer.setWorld(geoWorld());
  assert.equal(layer.active, false);
  assert.match(layer.statusOf(null, false, true), /SETUP REQUIRED/);
});

test('FlockLayer polls and stores cameras when live', async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(SAMPLE);
  try {
    const layer = newLayer();
    const world = geoWorld();
    layer.setWorld(world);
    layer.acc = 1e9;
    const cam = { x: world.proj.width / 2, y: world.proj.height / 2, angle: 0 };
    layer.update(0.001, cam, true, { addEventListener() {} });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(layer.records.size, 3, 'three cameras stored');
    assert.ok(layer.hasCameras);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('FlockLayer withdraws under simulated time', () => {
  const layer = newLayer();
  layer.setWorld(geoWorld());
  layer.records.set('a', { id: 'a', lat: 0, lon: 0 });
  layer.update(0.001, { x: 0, y: 0, angle: 0 }, false);
  assert.equal(layer.records.size, 0, 'no cameras under SIM time');
});

test('FlockLayer toggle clears records when disabled', () => {
  const layer = newLayer();
  layer.setWorld(geoWorld());
  layer.records.set('a', { id: 'a', lat: 0, lon: 0 });
  layer.toggle();
  assert.equal(layer.enabled, false);
  assert.equal(layer.records.size, 0);
});

test('FlockLayer rebind changes projection without resetting records', () => {
  const layer = newLayer();
  const first = geoWorld();
  const second = geoWorld();
  layer.setWorld(first);
  const record = { id: 'keep', lat: 0, lon: 0 };
  layer.records.set('keep', record);
  layer.acc = 1234;
  layer.rebindWorld(second);
  assert.equal(layer.world, second);
  assert.equal(layer.records.get('keep'), record);
  assert.equal(layer.acc, 1234);
});

test('FlockLayer draw writes a glyph for a visible camera', () => {
  const world = geoWorld();
  const layer = newLayer();
  layer.setWorld(world);
  const cam = {
    x: world.proj.width / 2, y: world.proj.height / 2,
    angle: Math.PI / 2, z: 1.65, proj: 85, hz: 20,
    rowOf(z, d) { return this.hz + (this.z - z) * 50 / d; },
  };
  const c = {
    id: 'vis1', lat: world.proj.lat0 + 0.001, lon: world.proj.lon0,
    manufacturer: 'Flock Safety', direction: '90',
  };
  layer.records.set(c.id, c);

  const written = [];
  const screen = {
    cols: 120, rows: 40,
    depth: new Float32Array(120 * 40).fill(1e9),
    set(x, y, ch) { written.push({ x, y, ch }); },
  };
  layer.draw(screen, cam, { depth: () => '#fff' });
  const text = written.map((v) => v.ch).join('');
  assert.match(text, /▣/, 'a camera glyph was drawn');
});

test('FlockLayer status reflects LIVE and OFF states', () => {
  const layer = newLayer();
  assert.equal(layer.statusOf(null, false, true), 'N/A', 'no world yet');
  const world = geoWorld();
  const cam = { x: world.width / 2, y: world.height / 2 };
  layer.setWorld(world);
  layer.enabled = false;
  assert.equal(layer.statusOf(cam, false, true), 'OFF');
  layer.enabled = true;
  assert.equal(layer.statusOf(cam, false, true), 'SEARCHING', 'world, live, not yet polled');
});

test('FlockLayer reports the nearest loaded camera without throwing', () => {
  const layer = newLayer();
  const world = geoWorld();
  const cam = { x: world.width / 2, y: world.height / 2 };
  layer.setWorld(world);
  layer.records.set('near', {
    id: 'near', lat: world.proj.lat0 + 0.001, lon: world.proj.lon0,
    manufacturer: 'Flock Safety',
  });
  layer.hasPolled = true;
  assert.match(layer.statusOf(cam, false, true), /^LIVE · 1 · nearest /);
});
