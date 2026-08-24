/**
 * Buildings: clicking a tower must identify it (not fall through to "ground"),
 * the card must name it and link back to OpenStreetMap, and — when the building
 * carries a Wikipedia/Wikidata tag — fetch a summary and offer a clickable
 * link back to the encyclopedia.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { OsmWorld, materialOf, MAT, parseLevels } from '../src/world/osm.js';
import { buildingAt, pick } from '../src/pick.js';
import { Panel } from '../src/render/panel.js';
import { Camera } from '../src/camera.js';
import { makeScreen } from './support/screen.js';
import { wikiKeyFor } from '../src/wiki.js';

const BBOX = [40.7550, -73.9880, 40.7610, -73.9820];

function elements() {
  return [
    {
      type: 'way', id: 8, tags: { highway: 'primary', name: 'Main Street' },
      geometry: [
        { lat: 40.7555, lon: -73.9870 },
        { lat: 40.7580, lon: -73.9870 },
        { lat: 40.7605, lon: -73.9870 },
      ],
    },
    {
      type: 'way', id: 9, tags: { highway: 'residential', name: 'Cross Street' },
      geometry: [
        { lat: 40.7580, lon: -73.9885 },
        { lat: 40.7580, lon: -73.9870 },
        { lat: 40.7580, lon: -73.9825 },
      ],
    },
    {
      type: 'way', id: 11,
      tags: {
        building: 'yes', 'building:levels': '10',
        name: 'Test Tower', 'addr:street': 'Main Street',
        'addr:housenumber': '1', wikidata: 'Q12345',
      },
      geometry: [
        { lat: 40.7590, lon: -73.9850 }, { lat: 40.7590, lon: -73.9840 },
        { lat: 40.7600, lon: -73.9840 }, { lat: 40.7600, lon: -73.9850 },
        { lat: 40.7590, lon: -73.9850 },
      ],
    },
  ];
}

/** First building cell and its owning record, for assertions. */
function firstBuildingCell(world) {
  for (let cy = 0; cy < world.height; cy++) {
    for (let cx = 0; cx < world.width; cx++) {
      const id = world.bid[cy * world.width + cx];
      if (id) return { cx, cy, id, b: world.buildings[id] };
    }
  }
  return null;
}

test('buildingAt returns the owning record for a footprint cell', () => {
  const w = new OsmWorld(BBOX, elements(), 'Test');
  const cell = firstBuildingCell(w);
  assert.ok(cell, 'the test building should be rasterized');

  const b = buildingAt(w, cell.cx + 0.5, cell.cy + 0.5);
  assert.equal(b, cell.b, 'the cell should name its own building');
  assert.equal(b.name, 'Test Tower');
});

test('buildingAt returns null off a footprint and for building-less worlds', () => {
  const w = new OsmWorld(BBOX, elements(), 'Test');
  // A cell far from any building (the park / open ground) is not a building.
  assert.equal(buildingAt(w, 1.5, 1.5), null, 'open ground is not a building');

  // A world with no bid array (procedural-style) must not throw.
  const bare = { width: 10, height: 10 };
  assert.equal(buildingAt(bare, 5.5, 5.5), null);
});

test('buildingAt recovers the tower from a click just outside the footprint', () => {
  const w = new OsmWorld(BBOX, elements(), 'Test');
  const cell = firstBuildingCell(w);
  // Find an orthogonal neighbour that is NOT a building but touches one.
  let edge = null;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = cell.cx + dx;
    const ny = cell.cy + dy;
    if (nx < 0 || ny < 0 || nx >= w.width || ny >= w.height) continue;
    if (!w.bid[ny * w.width + nx]) { edge = { nx, ny }; break; }
  }
  assert.ok(edge, 'expected a non-building cell adjacent to the footprint');
  const b = buildingAt(w, edge.nx + 0.5, edge.ny + 0.5);
  assert.equal(b, cell.b, 'the facade-boundary fallback should name the tower');
});

test('pick reports a building click, not ground', () => {
  const w = new OsmWorld(BBOX, elements(), 'Test');
  const cell = firstBuildingCell(w);

  // Minimal screen: one cell whose depth resolves to the building's cell.
  const screen = { cols: 1, rows: 1, depth: new Float32Array([cell.cy + 0.5]) };
  const cam = new Camera();
  cam.x = cell.cx + 0.5;
  cam.y = 0;
  cam.angle = Math.PI / 2;
  cam.rc = new Float32Array([0]);   // straight ahead, +y
  cam.rs = new Float32Array([1]);
  cam.rinv = new Float32Array([1]);

  const hit = pick(screen, cam, w, 0, 0, null);
  assert.equal(hit.kind, 'building', 'a building cell must pick as a building');
  assert.equal(hit.object, cell.b);
  assert.equal(hit.object.name, 'Test Tower');
});

test('pick identifies a building when the ray hits the facade boundary', () => {
  // The real renderer stores the distance to the FRONT WALL, so the
  // reconstructed point lands on a cell boundary and floor() would otherwise
  // drop it into the pavement in front of the tower. This is the bug that made
  // every building read as "ground".
  const w = new OsmWorld(BBOX, elements(), 'Test');
  const cell = firstBuildingCell(w);

  // Camera due south of the footprint, looking north (+y) at the south wall.
  // The wall is at world y = cell.cy (a boundary), so the depth is cell.cy.
  const screen = { cols: 1, rows: 1, depth: new Float32Array([cell.cy]) };
  const cam = new Camera();
  cam.x = cell.cx + 0.5;
  cam.y = 0;
  cam.angle = Math.PI / 2;
  cam.rc = new Float32Array([0]);   // straight ahead, +y
  cam.rs = new Float32Array([1]);
  cam.rinv = new Float32Array([1]);

  const hit = pick(screen, cam, w, 0, 0, null);
  assert.equal(hit.kind, 'building', 'a facade-boundary click must pick as a building');
  assert.equal(hit.object, cell.b);
});

test('wikiKeyFor prefers an explicit tag, then falls back to a name search', () => {
  assert.equal(wikiKeyFor({ wikidata: 'Q12345' }, 'Empire State Building'),
    'q:Q12345', 'an explicit tag wins');
  assert.equal(wikiKeyFor({ wikipedia: 'en:Foo' }, 'Foo'),
    'w:en:Foo', 'a wikipedia tag wins');
  assert.equal(wikiKeyFor({}, 'Empire State Building'),
    's:empire state building', 'a bare name becomes a search key');
  assert.equal(wikiKeyFor({}, ''), null, 'nothing to look up with no name');
});

test('the panel card names a building and links to OpenStreetMap', () => {
  const w = new OsmWorld(BBOX, elements(), 'Test');
  const cell = firstBuildingCell(w);
  const screen = makeScreen(90, 40);
  const cam = new Camera();
  cam.placeAt({ x: 60, y: 60, angle: Math.PI / 2 });
  cam.z = 1.65;
  cam.hz = screen.horizon;
  cam.buildRays(screen);

  const panel = new Panel();
  panel.select({
    kind: 'building', object: cell.b,
    x: cell.cx + 0.5, y: cell.cy + 0.5, d: 5,
    type: w.type[w.sample(cell.cx + 0.5, cell.cy + 0.5)],
    street: w.nearestStreet(cell.cx + 0.5, cell.cy + 0.5),
  });
  panel.draw(screen, cam, w);

  // The footer carries the OSM element id and is a clickable link.
  const box = panel.rect(screen);
  assert.ok(box, 'the card should have a layout box');
  const url = panel.linkAt(screen, box.x + 2, box.y + box.h - 2);
  assert.equal(url, 'https://www.openstreetmap.org/way/11',
    'the footer should link to the building on OpenStreetMap');
});

test('the panel shows a clickable Wikipedia link when a summary is cached', () => {
  const w = new OsmWorld(BBOX, elements(), 'Test');
  const cell = firstBuildingCell(w);
  const screen = makeScreen(90, 40);
  const cam = new Camera();
  cam.placeAt({ x: 60, y: 60, angle: Math.PI / 2 });
  cam.z = 1.65;
  cam.hz = screen.horizon;
  cam.buildRays(screen);

  const panel = new Panel();
  panel.select({
    kind: 'building', object: cell.b,
    x: cell.cx + 0.5, y: cell.cy + 0.5, d: 5,
    type: w.type[w.sample(cell.cx + 0.5, cell.cy + 0.5)],
    street: w.nearestStreet(cell.cx + 0.5, cell.cy + 0.5),
  });
  // Simulate a completed Wikipedia fetch (no network in tests).
  panel._wiki = {
    key: 'q:Q12345',
    value: { text: 'A test tower.', title: 'Test Tower', url: 'https://en.wikipedia.org/wiki/Test_Tower' },
  };
  panel.draw(screen, cam, w);

  // Scan every link the card registered for the Wikipedia article URL.
  const L = panel._layout;
  assert.ok(L && L.links, 'the card should register links');
  const wiki = L.links.find((k) => k.url === 'https://en.wikipedia.org/wiki/Test_Tower');
  assert.ok(wiki, 'a clickable Wikipedia link should be present');
});

/* --------------------------- material semantics --------------------------- */

test('materialOf infers a class from OSM tags', () => {
  assert.equal(materialOf({ building: 'office', 'building:material': 'glass' }), MAT.GLASS);
  assert.equal(materialOf({ building: 'house', 'building:material': 'brick' }), MAT.BRICK);
  assert.equal(materialOf({ building: 'warehouse' }), MAT.METAL);
  assert.equal(materialOf({ building: 'yes' }), MAT.STONE, 'unknown defaults to stone');
});

test('parseLevels reads storeys from tags', () => {
  assert.equal(parseLevels({ 'building:levels': '12' }), 12);
  assert.equal(parseLevels({ 'building:levels': '10', 'roof:levels': '1' }), 11);
  assert.equal(parseLevels({}), null);
});

test('rasterized building cells carry a material class', () => {
  const w = new OsmWorld(BBOX, [
    {
      type: 'way', id: 11,
      tags: { building: 'office', 'building:material': 'glass', 'building:levels': '10' },
      geometry: [
        { lat: 40.7590, lon: -73.9850 }, { lat: 40.7590, lon: -73.9840 },
        { lat: 40.7600, lon: -73.9840 }, { lat: 40.7600, lon: -73.9850 },
        { lat: 40.7590, lon: -73.9850 },
      ],
    },
  ], 'Test');
  const cell = firstBuildingCell(w);
  assert.ok(cell, 'building rasterized');
  assert.equal(w.mat[cell.cy * w.width + cell.cx], MAT.GLASS, 'cell material matches tags');
  assert.equal(cell.b.mat, MAT.GLASS);
  assert.equal(cell.b.levels, 10, 'storey count retained');
});
