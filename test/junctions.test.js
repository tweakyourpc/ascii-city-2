/**
 * Junction detection: v2 finds where two or more named streets meet, because
 * that is exactly where a real street sign would stand.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { StreetWorld, ProceduralStreets } from '../src/world/streets.js';

const BBOX = [40.7550, -73.9880, 40.7610, -73.9820];

function buildWorld(extra = []) {
  const elements = [
    {
      type: 'way', id: 8, tags: { highway: 'primary', name: 'Main Street' },
      geometry: [
        { lat: 40.7555, lon: -73.9870 }, { lat: 40.7580, lon: -73.9870 },
        { lat: 40.7605, lon: -73.9870 },
      ],
      nodes: [1, 2, 3],
    },
    {
      type: 'way', id: 9, tags: { highway: 'residential', name: 'Cross Street' },
      geometry: [
        { lat: 40.7580, lon: -73.9885 }, { lat: 40.7580, lon: -73.9870 },
        { lat: 40.7580, lon: -73.9850 }, { lat: 40.7580, lon: -73.9825 },
      ],
      nodes: [4, 2, 6, 5],
    },
    ...extra,
  ];
  return new StreetWorld(BBOX, elements, 'Test');
}

test('two named roads crossing make one junction naming both', () => {
  const w = buildWorld();
  assert.equal(w.stats.junctions, 1, 'one crossing expected');
  const j = w.junctions[0];
  assert.ok(j, 'junction missing');
  // The crossing is at lon -73.9870, lat 40.7580.
  assert.ok(Math.abs(j.x - w.proj.x(-73.9870)) < 1.5);
  assert.ok(Math.abs(j.y - w.proj.y(40.7580)) < 1.5);
  const names = j.names.map((id) => w.streetNames[id]).sort();
  assert.deepEqual(names, ['Cross Street', 'Main Street']);
});

test('parallel roads that never meet make no junction', () => {
  const w = buildWorld([
    {
      type: 'way', id: 10, tags: { highway: 'residential', name: 'Parallel Road' },
      // 8 cells south of Main Street (lat 40.7580): well clear of the
      // half-cell bucketing resolution, so it must not merge into a junction.
      geometry: [{ lat: 40.7500, lon: -73.9885 }, { lat: 40.7500, lon: -73.9825 }],
    },
  ]);
  // Main Street (lat 40.7580) and Parallel Road (lat 40.7500) do not cross.
  assert.equal(w.stats.junctions, 1, 'only the Main x Cross crossing counts');
});

test('an unnamed road meeting a named one is not a junction', () => {
  const w = buildWorld([
    {
      type: 'way', id: 11, tags: { highway: 'service' },
      geometry: [{ lat: 40.7580, lon: -73.9885 }, { lat: 40.7580, lon: -73.9825 }],
    },
  ]);
  // The service road shares geometry with Cross Street but has no name, so it
  // must not create a junction on its own.
  assert.equal(w.stats.junctions, 1);
});

test('a T-junction names the through street and the spur', () => {
  const w = buildWorld([
    {
      type: 'way', id: 12, tags: { highway: 'residential', name: 'Spur' },
      geometry: [{ lat: 40.7580, lon: -73.9850 }, { lat: 40.7590, lon: -73.9850 }],
      nodes: [6, 12],
    },
  ]);
  // Spur meets Main Street (lat 40.7580, lon -73.9850) at one point.
  assert.equal(w.stats.junctions, 2);
  const spurJ = w.junctions.find((j) =>
    j.names.map((id) => w.streetNames[id]).includes('Spur'));
  assert.ok(spurJ, 'the T-junction should name Spur');
  assert.ok(spurJ.names.length >= 2);
});

test('procedural grid junctions name both crossing roads', () => {
  const w = new ProceduralStreets({ size: 100, pitch: 20 });
  assert.ok(w.junctions.length > 0);
  for (const j of w.junctions) {
    assert.ok(j.names.length >= 2, 'a grid crossing must name two roads');
    for (const id of j.names) assert.ok(w.streetNames[id], 'name id resolves');
  }
});
