 /**
 * Live aircraft layer: coordinate conversion, normalization, interpolation,
 * LIVE/SIMULATED switching, and graceful failure.
 *
 * All hermetic. The recorded adsb.lol response below is used as a fixture so
 * the network is never touched; fetchAircraft is exercised with an injected
 * fetchImpl that returns it (or rejects), exactly as the browser would.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeAc, fetchAircraft, buildUrl, isLiveTime, headingArrow,
  distanceKm, wind, AircraftLayer,
} from '../src/aircraft.js';
import { makeProjection } from '../src/world/osm.js';

/* --------------------------- recorded fixture --------------------------- */
// Captured from api.adsb.lol/v2/point (Sarasota, FL area), trimmed to two ac.
const SAMPLE = {
  ac: [
    {
      hex: 'A7A04C', type: 'adsb_icao', flight: 'SKQ91   ', r: 'N5904A', t: 'PC12',
      alt_baro: 1600, alt_geom: 1750, gs: 231.2, track: 337.09,
      baro_rate: -1024, squawk: '4524', emergency: 'none', category: 'A1',
      lat: 27.867599, lon: -82.523078, seen_pos: 0.477, messages: 35836, seen: 0.3,
    },
    {
      hex: 'A0C581', type: 'adsb_icao', flight: 'LBQ865  ', r: 'N149QD', t: 'PC12',
      alt_baro: 'ground', mag_heading: 247.50, true_heading: 317.81,
      squawk: '1200', emergency: 'none', category: 'A1',
      lat: 28.011944, lon: -82.347402, seen_pos: 8.544, messages: 90, seen: 8.5,
    },
  ],
  msg: 'No error', now: 1787200555001, total: 2,
};

/* --------------------------- normalization ------------------------------ */

test('normalizeAc keeps a valid airborne record', () => {
  const a = normalizeAc(SAMPLE.ac[0]);
  assert.equal(a.icao, 'a7a04c');
  assert.equal(a.callsign, 'SKQ91');
  assert.equal(a.type, 'PC12');
  assert.equal(a.lat, 27.867599);
  assert.equal(a.lon, -82.523078);
  assert.ok(Math.abs(a.altM - 533.4) < 0.2);
  assert.equal(a.gsKt, 231.2);
  assert.equal(a.trackDeg, 337.09);
  assert.equal(a.onGround, false);
});

test('normalizeAc drops surface traffic (alt_baro: "ground")', () => {
  const a = normalizeAc(SAMPLE.ac[1]);
  assert.equal(a, null, 'ground aircraft must be excluded');
});

test('normalizeAc returns null for missing position', () => {
  assert.equal(normalizeAc({ hex: 'abc', alt_geom: 1000 }), null);
  assert.equal(normalizeAc(null), null);
  assert.equal(normalizeAc({ lat: 1, lon: 2 }), null, 'no altitude');
});

test('normalizeAc tolerates missing optional fields', () => {
  const a = normalizeAc({ hex: 'deadbe', lat: 40, lon: -73, alt_geom: 3000 });
  assert.equal(a.icao, 'deadbe');
  assert.equal(a.callsign, null);
  assert.equal(a.gsKt, null);
  assert.equal(a.trackDeg, null);
  assert.equal(a.onGround, false);
});

/* ----------------------------- fetching ---------------------------------- */

function fakeFetch(json, { ok = true, status = 200 } = {}) {
  return async () => ({
    ok,
    status,
    json: async () => json,
  });
}

test('fetchAircraft normalizes and filters the sample', async () => {
  const list = await fetchAircraft(27.96, -82.5, 30, { fetchImpl: fakeFetch(SAMPLE) });
  // Only the airborne one survives; the ground one is dropped.
  assert.equal(list.length, 1);
  assert.equal(list[0].icao, 'a7a04c');
});

test('fetchAircraft rejects on HTTP error', async () => {
  await assert.rejects(
    fetchAircraft(27.96, -82.5, 30, { fetchImpl: fakeFetch(SAMPLE, { ok: false, status: 503 }) }),
  );
});

test('fetchAircraft rejects when fetch is unavailable', async () => {
  await assert.rejects(fetchAircraft(27.96, -82.5, 30, { fetchImpl: null }));
});

test('fetchAircraft tolerates a malformed ac array', async () => {
  const list = await fetchAircraft(27.96, -82.5, 30, {
    fetchImpl: fakeFetch({ ac: [null, { hex: 'x' }, SAMPLE.ac[0]] }),
  });
  assert.equal(list.length, 1);
});

test('buildUrl targets the project API proxy', () => {
  const u = buildUrl(27.964, -82.5, 25);
  assert.match(u, /\/api\/aircraft\?lat=27\.9640&lon=-82\.5000&radiusKm=25$/);
});

/* --------------------------- coordinate math ----------------------------- */

test('projection round-trips lat/lon through x/y inverses', () => {
  const bbox = [40.7466, -73.9900, 40.7576, -73.9750];
  const p = makeProjection(bbox);
  const lat = 40.75;
  const lon = -73.98;
  const x = p.x(lon);
  const y = p.y(lat);
  assert.ok(Math.abs(p.lon(x) - lon) < 1e-6, 'lon inverse');
  assert.ok(Math.abs(p.lat(y) - lat) < 1e-6, 'lat inverse');
});

test('bearingTo-style wind helper wraps correctly', () => {
  assert.equal(wind(0), 'N');
  assert.equal(wind(90), 'E');
  assert.equal(wind(359), 'N');
});

test('distanceKm is roughly correct for a known separation', () => {
  // 1 degree of latitude ~= 110.54 km.
  const d = distanceKm(40.0, -73.0, 41.0, -73.0);
  assert.ok(Math.abs(d - 110.54) < 1, `d ${d}`);
});

test('headingArrow points away when track matches camera', () => {
  // Camera angle 0 (looking east, +x). An aircraft on heading 90 (east) is
  // moving away from the camera's forward, i.e. "up" the screen.
  assert.equal(headingArrow(90, 0), '↖');
  assert.equal(headingArrow(null, 0), '?');
});

/* --------------------------- interpolation ------------------------------- */

test('AircraftLayer interpolates between two observations', () => {
  const layer = new AircraftLayer();
  const rec = {
    prev: { lat: 0, lon: 0, altM: 1000, gsKt: 200, trackDeg: 90,
            icao: 'a', callsign: 'X', type: null, squawk: null,
            originCountry: null, vertRate: null, onGround: false },
    obs: { lat: 1, lon: 2, altM: 2000, gsKt: 200, trackDeg: 90,
           icao: 'a', callsign: 'X', type: null, squawk: null,
           originCountry: null, vertRate: null, onGround: false },
    tPrev: 1000,
    tObs: 2000,
  };
  const mid = layer.positionOf(rec, 2500);
  assert.ok(Math.abs(mid.lat - 0.5) < 1e-9);
  assert.ok(Math.abs(mid.lon - 1) < 1e-9);
  assert.ok(Math.abs(mid.altM - 1500) < 1e-9);
  // Clamped at the ends.
  const before = layer.positionOf(rec, 2000);
  assert.equal(before.lat, 0);
  const after = layer.positionOf(rec, 3000);
  assert.equal(after.lat, 1);
});

/* --------------------------- LIVE vs SIMULATED --------------------------- */

test('isLiveTime is true at the real clock and false only under warp', () => {
  assert.equal(isLiveTime(Date.now(), 1), true);
  assert.equal(isLiveTime(Date.now(), 10), false, 'warp withdraws live layers');
  // A static offset (local-hour set, or the tab being backgrounded so Date.now
  // races ahead) must NOT withdraw the layers — that was the bug that left
  // weather and aircraft permanently unavailable after loading a city.
  assert.equal(isLiveTime(Date.now() + 60000, 1), true, 'a static offset stays live');
  assert.equal(isLiveTime(Date.now() - 3600000, 1), true, 'an hour behind stays live');
});

/* --------------------------- layer lifecycle ----------------------------- */

// A minimal world with a real projection, so the layer is "active".
function geoWorld() {
  const bbox = [40.7466, -73.9900, 40.7576, -73.9750];
  const proj = makeProjection(bbox);
  return { bbox, proj, label: 'Test' };
}

test('AircraftLayer is inactive without a geographic world', () => {
  const layer = new AircraftLayer();
  layer.setWorld({ bbox: null, proj: null });
  assert.equal(layer.active, false);
  layer.update(1, { x: 0, y: 0, angle: 0 }, Date.now(), true, 1);
  assert.equal(layer.records.size, 0);
});

test('AircraftLayer polls and stores aircraft when live', async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(SAMPLE);
  try {
    const layer = new AircraftLayer();
    layer.setWorld(geoWorld());
    // Force an immediate poll.
    layer.acc = 1e9;
    layer.update(0.001, { x: 0, y: 0, angle: 0 }, Date.now(), true, 1,
      { addEventListener() {} });
    // The fetch is async; wait a tick for it to resolve.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(layer.records.size, 1, 'one airborne aircraft stored');
    assert.ok(layer.hasAircraft);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('AircraftLayer withdraws aircraft when time is not live', () => {
  const layer = new AircraftLayer();
  layer.setWorld(geoWorld());
  layer.records.set('a', { obs: {}, prev: {}, tObs: 0, tPrev: 0 });
  layer.update(0.001, { x: 0, y: 0, angle: 0 }, Date.now(), false, 1);
  assert.equal(layer.records.size, 0, 'no aircraft under simulated time');
});

test('AircraftLayer toggle clears records when disabled', () => {
  const layer = new AircraftLayer();
  layer.setWorld(geoWorld());
  layer.records.set('a', { obs: {}, prev: {}, tObs: 0, tPrev: 0 });
  layer.toggle();
  assert.equal(layer.enabled, false);
  assert.equal(layer.records.size, 0);
});

test('AircraftLayer draw is a no-op without a screen but does not throw', () => {
  const layer = new AircraftLayer();
  layer.setWorld(geoWorld());
  // No projection math runs when inactive; just ensure it is safe.
  assert.doesNotThrow(() => layer.draw({}, { angle: 0 }, { depth: () => '#000' }));
});
