import assert from 'node:assert/strict';
import test from 'node:test';

import { OsmWorld } from '../src/world/osm.js';
import {
  buildQuery, fitLongBox, bboxArea, MAX_BBOX_DEG2, PRESETS,
} from '../src/world/overpass.js';
import { T, F } from '../src/world/source.js';
import { groundColour } from '../src/render/surface.js';
import { Lighting } from '../src/render/materials.js';

const BBOX = [41.9740, -87.9080, 41.9850, -87.8930];

/** A runway laid roughly west to east across the middle of the extract. */
function runwayWay(id, tags) {
  return {
    type: 'way', id, tags,
    geometry: [
      { lat: 41.9790, lon: -87.9060 },
      { lat: 41.9792, lon: -87.8950 },
    ],
  };
}

function countType(world, type) {
  let n = 0;
  for (let i = 0; i < world.type.length; i++) if (world.type[i] === type) n++;
  return n;
}

test('the core query asks for runways, taxiways and aprons', () => {
  const q = buildQuery(BBOX, 'core');
  assert.match(q, /aeroway/, 'aeroway was absent entirely, so runways never arrived');
  assert.match(q, /runway/);
  assert.match(q, /taxiway/);
  assert.match(q, /apron/);
  // The best-effort layers can be dropped on a slow instance, which is exactly
  // the case an airport view cannot afford.
  assert.doesNotMatch(buildQuery(BBOX, 'extra'), /aeroway/);
});

test('a runway becomes runway surface, not road and not skipped', () => {
  const world = new OsmWorld(BBOX, [
    runwayWay(1, { aeroway: 'runway', ref: '10L/28R', width: '61' }),
  ], 'Field');

  assert.equal(world.stats.aeroways, 1);
  assert.equal(world.stats.skipped, 0, 'an aeroway used to fall through as skipped');
  assert.equal(world.stats.roads, 0, 'a runway is not a street');
  assert.ok(countType(world, T.RUNWAY) > 0, 'runway cells were laid');
  assert.equal(countType(world, T.ROAD), 0);
});

test('a tagged runway width is honoured over the default', () => {
  const narrow = new OsmWorld(BBOX, [
    runwayWay(1, { aeroway: 'runway', width: '23' }),
  ], 'Field');
  const wide = new OsmWorld(BBOX, [
    runwayWay(1, { aeroway: 'runway', width: '61' }),
  ], 'Field');
  assert.ok(countType(wide, T.RUNWAY) > countType(narrow, T.RUNWAY) * 1.5,
    'OSM states a real width on most large runways and it should be used');
});

test('a runway is wider than the widest motorway', () => {
  const runway = new OsmWorld(BBOX, [
    runwayWay(1, { aeroway: 'runway' }),
  ], 'Field');
  const motorway = new OsmWorld(BBOX, [
    { ...runwayWay(1, { highway: 'motorway' }) },
  ], 'Field');
  assert.ok(countType(runway, T.RUNWAY) > countType(motorway, T.ROAD),
    'the default 45 m runway must beat the 20 m motorway in ROAD_W');
});

test('taxiways and aprons get their own surfaces', () => {
  const world = new OsmWorld(BBOX, [
    runwayWay(1, { aeroway: 'taxiway' }),
    {
      type: 'way', id: 2, tags: { aeroway: 'apron' },
      geometry: [
        { lat: 41.9800, lon: -87.9040 },
        { lat: 41.9810, lon: -87.9040 },
        { lat: 41.9810, lon: -87.9010 },
        { lat: 41.9800, lon: -87.9010 },
        { lat: 41.9800, lon: -87.9040 },
      ],
    },
  ], 'Field');
  assert.ok(countType(world, T.TAXIWAY) > 0);
  assert.ok(countType(world, T.APRON) > 0);
  assert.equal(world.stats.aeroways, 2);
});

test('no vehicle or pedestrian can spawn on the airfield', () => {
  const world = new OsmWorld(BBOX, [
    runwayWay(1, { aeroway: 'runway', width: '61' }),
    runwayWay(2, { aeroway: 'taxiway' }),
  ], 'Field');

  assert.ok(countType(world, T.RUNWAY) > 0, 'the runway is actually there');
  assert.equal(world.roadCells.length, 0,
    'roadCells is the pool spawn() and randomRoadCell() draw from');
  assert.equal(world.roads.length, 0,
    'and the line renderer must not treat a runway as a named street');
});

test('a runway mapped as an area is filled, not outlined', () => {
  // OSM maps aeroways both as centrelines and as the paved area itself. A
  // closed way used to be stroked around its perimeter, giving a hollow
  // racetrack ring with unpaved ground down the middle of the runway.
  const ring = [
    { lat: 41.9835, lon: -87.9060 }, { lat: 41.9843, lon: -87.9060 },
    { lat: 41.9843, lon: -87.8950 }, { lat: 41.9835, lon: -87.8950 },
    { lat: 41.9835, lon: -87.9060 },
  ];
  const world = new OsmWorld(BBOX, [
    { type: 'way', id: 1, tags: { aeroway: 'runway', area: 'yes' }, geometry: ring },
  ], 'Field');
  assert.equal(world.stats.aeroways, 1);

  // The centre of the polygon must be runway, which an outline stroke leaves
  // empty. That single cell is the whole difference between the two bugs.
  const cx = world.proj.x(-87.9005);
  const cy = world.proj.y(41.9839);
  assert.equal(world.type[world.sample(cx, cy)], T.RUNWAY,
    'the middle of an area-mapped runway must be runway');
  assert.ok(countType(world, T.RUNWAY) > 400, 'and it is filled, not a thin ring');
});

test('an unpaved strip carries no painted markings', () => {
  const grass = new OsmWorld(BBOX, [
    runwayWay(1, { aeroway: 'runway', surface: 'grass' }),
  ], 'Field');
  const paved = new OsmWorld(BBOX, [
    runwayWay(1, { aeroway: 'runway', surface: 'asphalt' }),
  ], 'Field');

  let grassStripes = 0;
  let pavedStripes = 0;
  for (let i = 0; i < grass.type.length; i++) {
    if (grass.type[i] === T.RUNWAY && (grass.flags[i] & F.STRIPE)) grassStripes++;
    if (paved.type[i] === T.RUNWAY && (paved.flags[i] & F.STRIPE)) pavedStripes++;
  }
  assert.ok(pavedStripes > 0, 'an asphalt runway has a painted centreline');
  assert.equal(grassStripes, 0, 'a grass strip does not');

  let unpavedFlagged = 0;
  for (let i = 0; i < grass.type.length; i++) {
    if (grass.type[i] === T.RUNWAY && (grass.flags[i] & F.UNPAVED)) unpavedFlagged++;
  }
  assert.ok(unpavedFlagged > 0, 'and it is marked unpaved so it renders as ground');
});

test('an unpaved runway does not render as asphalt', () => {
  const light = new Lighting();
  light.update(35);
  const cell = (flags) => groundColour(
    { type: [T.RUNWAY], flags: [flags], lamp: [0] }, 0, 1, light);
  assert.notEqual(cell(F.UNPAVED), cell(0),
    'grass and asphalt must not be the same colour');
});

test('an airfield service road is still a road', () => {
  const world = new OsmWorld(BBOX, [
    runwayWay(1, { aeroway: 'runway' }),
    {
      type: 'way', id: 2, tags: { highway: 'service' },
      geometry: [
        { lat: 41.9770, lon: -87.9060 },
        { lat: 41.9772, lon: -87.8950 },
      ],
    },
  ], 'Field');
  assert.equal(world.stats.roads, 1);
  assert.ok(world.roadCells.length > 0, 'traffic still has somewhere to drive');
});

/* ------------------------- reaching an airport -------------------------- */

test('an aerodrome box keeps its long axis so a whole runway fits', () => {
  // O'Hare's field is about 4.4 km square, well past the area budget. Clamping
  // it to a square gives 2.3 km, still short of a 3.4 km runway. Keeping the
  // long axis and trimming the short one gives the shape a runway needs, which
  // is how the hand-picked ord preset was built.
  const ord = fitLongBox([41.9600, -87.9370, 42.0000, -87.8800]);
  assert.ok(ord, 'a large aerodrome extent is loadable');
  assert.ok(bboxArea(ord) <= MAX_BBOX_DEG2 + 1e-12, 'and inside the budget');

  const kmLon = (ord[3] - ord[1]) * 111.320 * Math.cos(41.98 * Math.PI / 180);
  const kmLat = (ord[2] - ord[0]) * 110.540;
  assert.ok(Math.max(kmLon, kmLat) > 3.4,
    `the long axis must hold a runway, got ${Math.max(kmLon, kmLat).toFixed(1)} km`);
  assert.ok(Math.min(kmLon, kmLat) > 0.4, 'and the short axis is still standable');
});

test('a box already inside the budget is left alone', () => {
  const small = [41.9785, -87.9350, 41.9800, -87.9300];
  assert.deepEqual(fitLongBox(small), small);
});

test('PRESETS all load and the airport is among them', () => {
  for (const [key, preset] of Object.entries(PRESETS)) {
    if (!preset.bbox) continue;
    assert.ok(bboxArea(preset.bbox) <= MAX_BBOX_DEG2 + 1e-12,
      `${key} is inside the area budget`);
  }
  assert.ok(PRESETS.ord, 'an airport is reachable in one click');
});
