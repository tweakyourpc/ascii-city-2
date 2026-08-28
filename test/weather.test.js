/**
 * Weather layer: a live Open-Meteo reading must normalize into the shape the
 * renderer expects, rain and snow must pick the right falling glyph, the layer
 * must stay inactive without a geographic world, and a failed fetch must throw
 * cleanly (so the caller can treat it as "no weather right now").
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WeatherLayer, fetchWeather, normalizeWx, WEATHER_CODES, WX_UNKNOWN,
} from '../src/weather.js';
import { geoAt, makeProjection } from '../src/world/osm.js';

function samplePayload(over = {}) {
  return {
    current: {
      time: '2026-08-20T12:00',
      temperature_2m: 18.4,
      relative_humidity_2m: 63,
      precipitation: 2.1,
      rain: 2.1,
      snowfall: 0,
      weather_code: 63,
      wind_speed_10m: 11.2,
      wind_direction_10m: 220,
      cloud_cover: 90,
      ...over,
    },
  };
}

test('normalizeWx extracts the current conditions', () => {
  const w = normalizeWx(samplePayload());
  assert.equal(w.tempC, 18.4);
  assert.equal(w.humidity, 63);
  assert.equal(w.rain, 2.1);
  assert.equal(w.snow, 0);
  assert.equal(w.code, 63);
  assert.equal(w.label, 'Rain');
  assert.equal(w.kind, 'rain');
  assert.equal(w.windKt, 11.2);
  assert.equal(w.windDeg, 220);
  assert.equal(w.cloud, 90);
});

test('a snow code yields the snow kind', () => {
  const w = normalizeWx(samplePayload({ weather_code: 73, snowfall: 3.5, rain: 0 }));
  assert.equal(w.kind, 'snow');
  assert.equal(w.label, 'Snow');
});

test('an unknown code falls back to the unknown meta', () => {
  const w = normalizeWx(samplePayload({ weather_code: 999 }));
  assert.equal(w.kind, WX_UNKNOWN.kind);
  assert.equal(w.label, WX_UNKNOWN.label);
});

test('normalizeWx returns null for a malformed response', () => {
  assert.equal(normalizeWx(null), null);
  assert.equal(normalizeWx({}), null);
  assert.equal(normalizeWx({ current: null }), null);
});

test('WEATHER_CODES covers the common codes', () => {
  for (const c of [0, 1, 2, 3, 45, 61, 63, 65, 71, 73, 75, 80, 95]) {
    assert.ok(WEATHER_CODES[c], `missing code ${c}`);
    assert.ok(WEATHER_CODES[c].label, `code ${c} has no label`);
    assert.ok(['clear', 'cloud', 'fog', 'rain', 'snow'].includes(WEATHER_CODES[c].kind),
      `code ${c} has a bad kind`);
  }
});

test('fetchWeather throws on a non-ok response', async () => {
  const failing = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(
    () => fetchWeather(40.7, -74, 5, { fetchImpl: failing }),
    /503/);
});

test('fetchWeather throws when the network errors', async () => {
  const netErr = async () => { throw new Error('network down'); };
  await assert.rejects(
    () => fetchWeather(40.7, -74, 5, { fetchImpl: netErr }),
    /network down/);
});

test('fetchWeather resolves a normalized reading through a stub', async () => {
  const stub = async () => ({ ok: true, status: 200, json: async () => samplePayload() });
  const w = await fetchWeather(40.7, -74, 5, { fetchImpl: stub });
  assert.equal(w.code, 63);
  assert.equal(w.kind, 'rain');
});

test('the layer is inactive without a geographic world', () => {
  const layer = new WeatherLayer();
  // A procedural-style world has no bbox/proj.
  layer.setWorld({ bbox: null });
  assert.equal(layer.active, false, 'no projection means no live weather');
  assert.equal(layer.status, 'N/A');
});

test('the layer is inactive when toggled off', () => {
  const layer = new WeatherLayer();
  layer.setWorld({ bbox: [0, 0, 1, 1], proj: { lat: () => 0, lon: () => 0 } });
  assert.equal(layer.active, true);
  layer.toggle();
  assert.equal(layer.active, false);
  assert.equal(layer.status, 'OFF');
});

test('weather rebind changes projection without resetting its reading', () => {
  const layer = new WeatherLayer();
  const reading = normalizeWx(samplePayload());
  const second = { bbox: [1, 1, 2, 2], proj: { lat: () => 1, lon: () => 1 } };
  layer.setWorld({ bbox: [0, 0, 1, 1], proj: { lat: () => 0, lon: () => 0 } });
  layer.cur = reading;
  layer.acc = 1234;
  layer.rebindWorld(second);
  assert.equal(layer.world, second);
  assert.equal(layer.cur, reading);
  assert.equal(layer.acc, 1234);
});

test('update polls and stores a reading when live', async () => {
  const layer = new WeatherLayer();
  layer.setWorld({ bbox: [0, 0, 1, 1], proj: { lat: () => 40.7, lon: () => -74 } });
  const stub = async () => ({ ok: true, status: 200, json: async () => samplePayload() });
  // Force an immediate poll.
  layer.acc = 1e9;
  await layer.update(0.016, { x: 0, y: 0, angle: Math.PI / 2 }, Date.now(), true, null, stub);
  // The fetch is async; let the microtask settle.
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(layer.cur, 'a reading should be stored after a successful poll');
  assert.equal(layer.cur.kind, 'rain');
});

test('weather queries latitude from camera y and longitude from camera x', async () => {
  const proj = makeProjection([40.7466, -73.9900, 40.7576, -73.9750]);
  const layer = new WeatherLayer();
  layer.setWorld({ bbox: [40.7466, -73.9900, 40.7576, -73.9750], proj });
  layer.acc = 1e9;
  const cam = { x: 123, y: 456, angle: 0 };
  let requested = null;
  const stub = async (url) => {
    requested = new URL(url);
    return { ok: true, status: 200, json: async () => samplePayload() };
  };
  layer.update(0.016, cam, Date.now(), true, null, stub);
  await new Promise((r) => setTimeout(r, 10));

  const expected = geoAt(proj, cam.x, cam.y);
  assert.equal(requested.searchParams.get('latitude'), expected.lat.toFixed(4));
  assert.equal(requested.searchParams.get('longitude'), expected.lon.toFixed(4));
});

test('a late weather response cannot repopulate SIM mode', async () => {
  const layer = new WeatherLayer();
  layer.setWorld({ bbox: [0, 0, 1, 1], proj: { lat: () => 40.7, lon: () => -74 } });
  layer.acc = 1e9;
  let finish;
  const delayed = () => new Promise((resolve) => {
    finish = () => resolve({ ok: true, status: 200, json: async () => samplePayload() });
  });
  const cam = { x: 0, y: 0, angle: 0 };
  layer.update(0.016, cam, Date.now(), true, null, delayed);
  layer.update(0.016, cam, Date.now(), false);
  finish();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(layer.cur, null);
});
