/**
 * v2 world construction: projection, road polylines, and the flat-world contract.
 *
 * All hermetic. Geometry is hand-built so the expected grid is known exactly.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { StreetWorld, ProceduralStreets, makeProjection, strokePath } from '../src/world/streets.js';
import { T } from '../src/world/source.js';
import { METERS_PER_CELL } from '../src/config.js';
import { plotSeg } from '../src/render/streets.js';

/* ----------------------------- projection ------------------------------ */

test('projection puts north at increasing y', () => {
  const bbox = [40.74, -74.00, 40.76, -73.98];
  const p = makeProjection(bbox);
  assert.ok(p.y(40.76) > p.y(40.74), '+y must be north');
  assert.ok(p.x(-73.98) > p.x(-74.00), '+x must be east');
});

test('projection scale is metric and roughly square', () => {
  const bbox = [40.7466, -73.9900, 40.7576, -73.9750];
  const p = makeProjection(bbox);
  const km = (n) => n * METERS_PER_CELL / 1000;
  assert.ok(Math.abs(km(p.height) - 1.216) < 0.05, `height ${km(p.height)} km`);
  assert.ok(Math.abs(km(p.width) - 1.266) < 0.05, `width ${km(p.width)} km`);
});

/* ---------------------------- raster helpers ---------------------------- */

test('strokePath lays down a band of the requested width', () => {
  const hit = new Map();
  strokePath([[5, 0], [5, 20]], 6, 30, 30, (x, y, d) => hit.set(`${x},${y}`, d));
  assert.ok(hit.has('5,10'), 'centre of the road is missing');
  assert.ok(hit.has('3,10') && hit.has('7,10'), 'road is too narrow');
  assert.ok(!hit.has('0,10'), 'road bled beyond its width');
  assert.ok(hit.get('5,10') < hit.get('7,10'), 'distance-to-centre is wrong');
});

test('road line depth follows the segment instead of its nearest endpoint', () => {
  const screen = {
    cols: 5,
    rows: 1,
    depth: new Float32Array([10, 10, 10, 10, 10]),
    glyph: new Array(5),
    colour: new Array(5),
    setDepth(x, y, glyph, colour, depth) {
      const i = y * this.cols + x;
      this.glyph[i] = glyph;
      this.colour[i] = colour;
      this.depth[i] = depth;
    },
  };

  plotSeg(screen, 0, 0, 4, 0, '-', 'road', 5, 15);
  assert.deepEqual(Array.from(screen.glyph), ['-', '-', undefined, undefined, undefined],
    'the far half of the road must be hidden by the nearer depth buffer');
  assert.ok(screen.depth[0] < screen.depth[1], 'depth should increase along the segment');
});

/* ------------------------------ the world ------------------------------- */

const BBOX = [40.7550, -73.9880, 40.7610, -73.9820];

function buildWorld(extra = []) {
  const elements = [
    {
      type: 'way', id: 8, tags: { highway: 'primary', name: 'Main Street' },
      geometry: [{ lat: 40.7555, lon: -73.9870 }, { lat: 40.7605, lon: -73.9870 }],
    },
    {
      type: 'way', id: 9, tags: { highway: 'residential', name: 'Cross Street' },
      geometry: [{ lat: 40.7580, lon: -73.9885 }, { lat: 40.7580, lon: -73.9825 }],
    },
    ...extra,
  ];
  return new StreetWorld(BBOX, elements, 'Test');
}

test('a road rasterizes as walkable ground, never solid', () => {
  const w = buildWorld();
  const s = w.sample(w.proj.x(-73.9870), w.proj.y(40.7580));
  assert.equal(w.type[s], T.ROAD);
  assert.equal(w.h[s], 0, 'v2 is flat: roads must not be solid');
  assert.ok(w.roadCells.length > 0, 'no road cells collected');
});

test('the world keeps the raw road polylines for the line renderer', () => {
  const w = buildWorld();
  assert.equal(w.roads.length, 2, 'both ways should be kept as polylines');
  for (const r of w.roads) {
    assert.ok(Array.isArray(r.pts) && r.pts.length >= 2, 'polyline missing');
    assert.ok(typeof r.cls === 'string', 'road class missing');
  }
});

test('the world is flat: no height anywhere', () => {
  const w = buildWorld();
  for (let i = 0; i < w.h.length; i++) assert.equal(w.h[i], 0);
  assert.equal(w.maxHeight, 0);
});

test('named roads are recorded with their names', () => {
  const w = buildWorld();
  assert.equal(w.stats.named, 2);
  assert.ok(w.streetNames.includes('Main Street'));
  assert.ok(w.streetNames.includes('Cross Street'));
});

test('the spawn point is on a street', () => {
  const w = buildWorld();
  const s = w.spawn();
  const slot = w.sample(s.x, s.y);
  assert.ok(w.type[slot] === T.ROAD || w.type[slot] === T.SIDEWALK);
});

test('elements with unusable geometry are skipped, not fatal', () => {
  assert.doesNotThrow(() => buildWorld([
    { type: 'way', id: 11, tags: { highway: 'residential' } },
    { type: 'way', id: 12, tags: { highway: 'residential' }, geometry: [] },
    { type: 'way', id: 13, tags: { highway: 'residential' }, geometry: [{ lat: 40.757, lon: -73.985 }] },
  ]));
});

test('non-highway elements are ignored', () => {
  const w = buildWorld([
    { type: 'way', id: 20, tags: { building: 'yes' }, geometry: [
      { lat: 40.757, lon: -73.985 }, { lat: 40.758, lon: -73.985 },
    ] },
  ]);
  assert.equal(w.stats.skipped, 1);
  assert.equal(w.roads.length, 2, 'buildings must not become roads');
});

/* --------------------------- procedural fallback --------------------------- */

test('procedural streets build a named grid with junctions', () => {
  const w = new ProceduralStreets({ size: 100, pitch: 20 });
  assert.ok(w.roads.length > 0, 'no roads in the grid');
  assert.ok(w.stats.junctions > 0, 'a grid must have crossings');
  assert.ok(w.streetNames.length > 0, 'every road should be named');
  for (let i = 0; i < w.h.length; i++) assert.equal(w.h[i], 0);
});

test('procedural nearestStreet names the road you are on', () => {
  const w = new ProceduralStreets({ size: 100, pitch: 20 });
  const r = w.nearestStreet(w.width / 2, 20.5);
  assert.ok(r && typeof r.on === 'string', 'should name a street');
  assert.ok(r.cross, 'should find a crossing street');
});
