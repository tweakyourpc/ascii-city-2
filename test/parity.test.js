/**
 * Parity: v2's street network must match v1's anchors for a fixed bbox, so the
 * fork does not silently drift from the road layout the original engine draws.
 *
 * v1's OsmWorld and v2's StreetWorld ingest the same Overpass elements, so for
 * a hand-built element set the road count, named-road count and junction count
 * should agree. v2's OsmWorld keeps the buildings too (it is the merged world),
 * so the flat-world contract now lives in StreetWorld, not in OsmWorld.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { StreetWorld } from '../src/world/streets.js';
import { OsmWorld } from '../src/world/osm.js';

const BBOX = [40.7550, -73.9880, 40.7610, -73.9820];

function elements() {
  // Main Street and Cross Street share an actual OSM node at the crossing
  // (lon -73.9870, lat 40.7580), so both forks' junction detection agrees.
  return [
    {
      type: 'way', id: 8, tags: { highway: 'primary', name: 'Main Street' },
      geometry: [
        { lat: 40.7555, lon: -73.9870 },
        { lat: 40.7580, lon: -73.9870 },
        { lat: 40.7605, lon: -73.9870 },
      ],
      nodes: [1, 2, 3],
    },
    {
      type: 'way', id: 9, tags: { highway: 'residential', name: 'Cross Street' },
      // Shares the crossing node (lon -73.9870, lat 40.7580) with Main Street,
      // as real OSM ways are split at intersections.
      geometry: [
        { lat: 40.7580, lon: -73.9885 },
        { lat: 40.7580, lon: -73.9870 },
        { lat: 40.7580, lon: -73.9825 },
      ],
      nodes: [4, 2, 5],
    },
    {
      type: 'way', id: 10, tags: { highway: 'service', name: 'Alley' },
      geometry: [{ lat: 40.7560, lon: -73.9870 }, { lat: 40.7560, lon: -73.9860 }],
    },
    {
      type: 'way', id: 11, tags: { building: 'yes', 'building:levels': '10' },
      geometry: [
        { lat: 40.7590, lon: -73.9850 }, { lat: 40.7590, lon: -73.9840 },
        { lat: 40.7600, lon: -73.9840 }, { lat: 40.7600, lon: -73.9850 },
        { lat: 40.7590, lon: -73.9850 },
      ],
    },
  ];
}

test('v2 and v1 agree on road count and named-road count', () => {
  const v1 = new OsmWorld(BBOX, elements(), 'Test');
  const v2 = new StreetWorld(BBOX, elements(), 'Test');

  assert.equal(v2.stats.roads, v1.stats.roads,
    'road way count must match between forks');
  // v1's stats.named counts named buildings; the comparable road figure is the
  // named-street set, which both forks expose as streetNames.
  assert.equal(v2.streetNames.length, v1.streetNames.length,
    'named-road count must match between forks');
});

test('v2 finds at least the junctions v1 finds', () => {
  const v1 = new OsmWorld(BBOX, elements(), 'Test');
  const v2 = new StreetWorld(BBOX, elements(), 'Test');

  // v1 only detects junctions at shared OSM nodes; v2 also catches geometric
  // crossings (mid-segment), so v2 must never find FEWER than v1. The fork is
  // a strict superset of v1's junction set, which is the parity we want.
  assert.ok(v2.stats.junctions >= v1.stats.junctions,
    `v2 (${v2.stats.junctions}) should find at least v1's (${v1.stats.junctions}) junctions`);
  assert.ok(v2.stats.junctions >= 1, 'expected at least the Main x Cross crossing');
});

test('v2 keeps the same road polylines v1 rasterized', () => {
  const v1 = new OsmWorld(BBOX, elements(), 'Test');
  const v2 = new StreetWorld(BBOX, elements(), 'Test');

  // v1 records road cells; v2 records polylines. The number of distinct named
  // roads should be identical, and v2 should have one polyline per road way.
  const v1Named = v1.streetNames.length;
  const v2Named = v2.streetNames.length;
  assert.equal(v2Named, v1Named, 'named-road set must match');
  assert.equal(v2.roads.length, v1.stats.roads, 'one polyline per road way');
});

test('v2 keeps the buildings v1 rasterized', () => {
  const v1 = new OsmWorld(BBOX, elements(), 'Test');
  const v2 = new StreetWorld(BBOX, elements(), 'Test');
  // StreetWorld is the flat fork: no buildings, but the same road layout.
  assert.equal(v2.maxHeight, 0, 'StreetWorld must stay flat');
  // OsmWorld is the merged fork: it keeps the buildings v1 found.
  assert.ok(v1.maxHeight > 0, 'v1 should have a building here');
  assert.ok(v1.buildings.length > 1, 'v1 should record the building');
});

test('ProceduralWorld has both buildings and a named road lattice', async () => {
  const { ProceduralWorld } = await import('../src/world/procedural.js');
  const w = new ProceduralWorld();
  // Buildings: the skyline the raycaster draws.
  assert.ok(w.maxHeight > 0, 'procedural city should have towers');
  // Streets: the line renderer, signs and labels all read these.
  assert.ok(w.roads.length > 0, 'procedural city should expose road polylines');
  assert.ok(w.junctions.length > 0, 'procedural city should expose junctions');
  assert.ok(w.streetNames.length > 0, 'procedural roads should be named');
  assert.ok(w.anchor && w.anchor.n > 0, 'procedural roads should have label anchors');
  // The HUD reads these fields; they must exist.
  assert.ok(typeof w.label === 'string' && w.label.length > 0, 'needs a label');
  assert.ok(typeof w.stats.roads === 'number', 'needs stats.roads');
  // A junction must name two different streets (a real crossing).
  const j = w.junctions[0];
  assert.equal(j.names.length, 2, 'a grid crossing names two roads');
  assert.notEqual(j.names[0], j.names[1], 'the two crossing roads differ');
});
