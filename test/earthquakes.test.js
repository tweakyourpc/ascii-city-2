/**
 * Live earthquakes layer: normalization, filtering, LIVE/SIMULATED switching,
 * and graceful failure.
 *
 * All hermetic. The recorded USGS GeoJSON below is used as a fixture so the
 * network is never touched; fetchQuakes is exercised with an injected
 * fetchImpl that returns it (or rejects), exactly as the browser would.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeQuake, fetchQuakes, buildUrl, magGlyph, distanceKm,
  QuakeLayer,
} from '../src/earthquakes.js';
import { makeProjection } from '../src/world/osm.js';

/* --------------------------- recorded fixture --------------------------- */
// Trimmed from the USGS 2.5_day GeoJSON feed.
const SAMPLE = {
  features: [
    {
      type: 'Feature',
      id: 'us7000abc1',
      properties: {
        mag: 4.8, place: '12 km N of Town, Country', time: 1787200555000,
        felt: 42,
      },
      geometry: { type: 'Point', coordinates: [-82.5, 27.96, 10.0] },
    },
    {
      type: 'Feature',
      id: 'us7000abc2',
      properties: {
        mag: 2.1, place: 'Far away', time: 1787200555000,
      },
      geometry: { type: 'Point', coordinates: [-82.5, 27.96, 5.0] },
    },
    {
      type: 'Feature',
      id: 'us7000abc3',
      properties: { mag: 5.5, place: 'Nearby big', time: 1787200555000 },
      geometry: { type: 'Point', coordinates: [-82.51, 27.97, 8.0] },
    },
  ],
};

function fakeFetch(json, { ok = true, status = 200 } = {}) {
  return async () => ({
    ok,
    status,
    json: async () => json,
  });
}

const geoWorld = () => {
  // Centred on the Florida sample coordinates so the 300 km radius keeps them.
  const bbox = [27.86, -82.52, 27.98, -82.48];
  const proj = makeProjection(bbox);
  return { bbox, proj, width: proj.width, height: proj.height, label: 'Test' };
};

/* --------------------------- normalization ------------------------------ */

test('normalizeQuake keeps a valid feature', () => {
  const q = normalizeQuake(SAMPLE.features[0]);
  assert.equal(q.id, 'us7000abc1');
  assert.equal(q.mag, 4.8);
  assert.equal(q.place, '12 km N of Town, Country');
  assert.equal(q.lat, 27.96);
  assert.equal(q.lon, -82.5);
  assert.equal(q.depthKm, 10.0);
  assert.equal(q.felt, 42);
});

test('normalizeQuake returns null for missing geometry or magnitude', () => {
  assert.equal(normalizeQuake(null), null);
  assert.equal(normalizeQuake({ properties: { mag: 3 }, geometry: null }), null);
  assert.equal(normalizeQuake({
    properties: {}, geometry: { type: 'Point', coordinates: [-1, 2] },
  }), null, 'no magnitude');
  assert.equal(normalizeQuake({
    properties: { mag: 3 }, geometry: { type: 'Point', coordinates: [undefined, 2] },
  }), null, 'no finite lat/lon');
});

/* ----------------------------- fetching ---------------------------------- */

test('fetchQuakes normalizes and filters by min magnitude', async () => {
  const list = await fetchQuakes(300, { fetchImpl: fakeFetch(SAMPLE) });
  // The M2.1 micro-tremor is dropped by QUAKE_MIN_MAG (2.5); two remain.
  assert.equal(list.length, 2);
  const ids = list.map((q) => q.id).sort();
  assert.deepEqual(ids, ['us7000abc1', 'us7000abc3']);
});

test('fetchQuakes rejects on HTTP error', async () => {
  await assert.rejects(
    fetchQuakes(300, { fetchImpl: fakeFetch(SAMPLE, { ok: false, status: 503 }) }),
  );
});

test('fetchQuakes rejects when fetch is unavailable', async () => {
  await assert.rejects(fetchQuakes(300, { fetchImpl: null }));
});

test('buildUrl targets the USGS 2.5_day feed', () => {
  assert.match(buildUrl(), /earthquake\.usgs\.gov\/earthquakes\/feed\/v1\.0\/summary\/2\.5_day\.geojson$/);
});

/* --------------------------- coordinate math ----------------------------- */

test('distanceKm is roughly correct for a known separation', () => {
  const d = distanceKm(40.0, -73.0, 41.0, -73.0);
  assert.ok(Math.abs(d - 110.54) < 1, `d ${d}`);
});

test('magGlyph scales with magnitude', () => {
  assert.equal(magGlyph(1.0), '·');
  assert.equal(magGlyph(3.0), '◦');
  assert.equal(magGlyph(4.5), '◉');
  assert.equal(magGlyph(6.0), '◆');
  assert.equal(magGlyph(null), '·');
});

/* --------------------------- layer lifecycle ----------------------------- */

test('QuakeLayer is inactive without a geographic world', () => {
  const layer = new QuakeLayer();
  layer.setWorld({ bbox: null, proj: null });
  assert.equal(layer.active, false);
  layer.update(1, { x: 0, y: 0, angle: 0 }, true);
  assert.equal(layer.records.size, 0);
});

test('QuakeLayer polls and stores quakes when live', async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(SAMPLE);
  try {
    const layer = new QuakeLayer();
    layer.setWorld(geoWorld());
    layer.acc = 1e9;
    layer.update(0.001, { x: 0, y: 0, angle: 0 }, true, { addEventListener() {} });
    await new Promise((r) => setTimeout(r, 10));
    // The M2.1 is below QUAKE_MIN_MAG, so only the two larger remain.
    assert.equal(layer.records.size, 2, 'two quakes stored');
    assert.ok(layer.hasQuakes);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('QuakeLayer withdraws under simulated time', () => {
  const layer = new QuakeLayer();
  layer.setWorld(geoWorld());
  layer.records.set('a', { id: 'a', mag: 4, lat: 0, lon: 0, time: Date.now() });
  layer.update(0.001, { x: 0, y: 0, angle: 0 }, false);
  assert.equal(layer.records.size, 0, 'no quakes under SIM time');
});

test('QuakeLayer toggle clears records when disabled', () => {
  const layer = new QuakeLayer();
  layer.setWorld(geoWorld());
  layer.records.set('a', { id: 'a', mag: 4, lat: 0, lon: 0, time: Date.now() });
  layer.toggle();
  assert.equal(layer.enabled, false);
  assert.equal(layer.records.size, 0);
});

test('QuakeLayer rebind changes projection without resetting records', () => {
  const layer = new QuakeLayer();
  const first = geoWorld();
  const second = geoWorld();
  layer.setWorld(first);
  const record = { id: 'keep', mag: 4, lat: 0, lon: 0, time: Date.now() };
  layer.records.set('keep', record);
  layer.acc = 1234;
  layer.rebindWorld(second);
  assert.equal(layer.world, second);
  assert.equal(layer.records.get('keep'), record);
  assert.equal(layer.acc, 1234);
});

test('QuakeLayer draw writes a glyph for a visible quake', () => {
  const world = geoWorld();
  const layer = new QuakeLayer();
  layer.setWorld(world);
  const cam = {
    x: world.proj.width / 2, y: world.proj.height / 2,
    angle: Math.PI / 2, z: 1.65, proj: 85, hz: 20,
    rowOf(z, d) { return this.hz + (this.z - z) * 50 / d; },
  };
  const q = {
    id: 'vis1', mag: 5.0, lat: world.proj.lat0 + 0.001, lon: world.proj.lon0,
    depthKm: 8, time: Date.now(), place: 'Nearby',
  };
  layer.records.set(q.id, q);

  const written = [];
  const screen = {
    cols: 120, rows: 40,
    depth: new Float32Array(120 * 40).fill(1e9),
    set(x, y, ch) { written.push({ x, y, ch }); },
  };
  layer.draw(screen, cam, { depth: () => '#fff' });
  const text = written.map((v) => v.ch).join('');
  assert.match(text, /[·◦◉◆]/, 'a quake glyph was drawn');
});

test('QuakeLayer status reflects LIVE and OFF states', () => {
  const layer = new QuakeLayer();
  assert.equal(layer.statusOf(false, true), 'N/A', 'no world yet');
  layer.setWorld(geoWorld());
  layer.enabled = false;
  assert.equal(layer.statusOf(false, true), 'OFF');
  layer.enabled = true;
  assert.equal(layer.statusOf(false, true), 'SEARCHING', 'world, live, not yet polled');
  layer.enabled = false;
});
