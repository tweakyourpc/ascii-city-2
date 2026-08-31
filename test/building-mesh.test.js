import assert from 'node:assert/strict';
import test from 'node:test';

import { Camera } from '../src/camera.js';
import { renderBuildingMeshes, projectBuildingPoint } from '../src/render/buildings.js';
import { Lighting } from '../src/render/materials.js';
import { renderScene } from '../src/render/raycaster.js';
import { pick } from '../src/pick.js';
import { OsmWorld } from '../src/world/osm.js';
import { makeScreen, MODE } from './support/screen.js';

const BBOX = [40.7550, -73.9880, 40.7610, -73.9820];

function worldWithAngledBuilding() {
  return new OsmWorld(BBOX, [{
    type: 'way', id: 91,
    tags: {
      building: 'office', 'building:levels': '12',
      'building:material': 'glass', name: 'Polygon Tower', wikidata: 'Q12345',
    },
    geometry: [
      { lat: 40.7582, lon: -73.9857 },
      { lat: 40.7586, lon: -73.9848 },
      { lat: 40.7594, lon: -73.9851 },
      { lat: 40.7590, lon: -73.9860 },
      { lat: 40.7582, lon: -73.9857 },
    ],
  }], 'Mesh Test');
}

function cameraFacing(building, screen) {
  const cam = new Camera();
  cam.x = building.cx;
  cam.y = building.bounds.minY - 12;
  cam.z = 1.65;
  cam.angle = Math.PI / 2;
  cam.hz = screen.horizon;
  cam.buildRays(screen);
  return cam;
}

test('OSM buildings retain projected source rings and enter the mesh index', () => {
  const world = worldWithAngledBuilding();
  const building = world.buildings[1];
  assert.ok(building.rings.length === 1);
  assert.ok(building.rings[0].length >= 4);
  assert.ok(building.bounds.minX < building.bounds.maxX);
  assert.ok(building.bounds.minY < building.bounds.maxY);
  assert.equal(building.mat, 1, 'glass material survives into mesh metadata');

  const found = world.buildingIndex.query(building.bounds);
  assert.deepEqual(found, [building]);
  assert.ok(building.rings[0].some(([x, y]) => x % 1 !== 0 || y % 1 !== 0),
    'source footprint keeps sub-cell edges instead of snapping to the height grid');
});

test('cinematic mode renders polygon facades into the shared depth buffer', () => {
  const world = worldWithAngledBuilding();
  const building = world.buildings[1];
  const screen = makeScreen(100, 50, MODE.CINEMATIC);
  const cam = cameraFacing(building, screen);
  const light = new Lighting();
  light.update(25);

  screen.clear();
  renderScene(screen, cam, world, light, 0);

  assert.ok(screen.meshStats.buildings > 0);
  assert.ok(screen.meshStats.facades >= 3);
  assert.ok(screen.meshStats.pixels > 20);
  assert.ok(screen.meshSurfaces.some((surface) => surface.type === 'wall'),
    'cinematic mode queues display-resolution facade paths');
  assert.ok(screen.meshSurfaces.some((surface) => surface.windows?.length),
    'near facades carry display-resolution window panes');

  const meshCell = screen.kind.findIndex((kind) => kind === 3);
  assert.ok(meshCell >= 0);
  screen.set(meshCell % screen.cols, Math.floor(meshCell / screen.cols), '✈', '#fff');
  screen.blit();
  const { rects, paths, texts, fillPath, stroke } = screen._calls;
  assert.ok(fillPath > 0, 'the cinematic compositor paints vector paths');
  assert.ok(stroke > 0, 'vector facade edges are antialiased and outlined');

  // Compositing is an order, not a set of calls. Base world, then the vector
  // building pass, then the live glyph overlay on top of both.
  const overlay = texts.find(([text]) => text.includes('✈'));
  assert.ok(overlay, 'live overlay glyphs remain visible above the vector pass');
  const firstPath = Math.min(...paths.map(([, order]) => order));
  const lastPath = Math.max(...paths.map(([, order]) => order));
  const firstRect = Math.min(...rects.map((r) => r[5]));
  assert.ok(firstRect < firstPath,
    'the base world is painted before the vector building pass');
  assert.ok(overlay[4] > lastPath,
    'a live overlay glyph over a facade is composited after the vector pass');

  let buildingHit = null;
  for (let y = 0; y < Math.ceil(cam.hz) && !buildingHit; y++) {
    for (let x = 0; x < screen.cols; x++) {
      const i = y * screen.cols + x;
      if (screen.depth[i] >= 1e8) continue;
      const hit = pick(screen, cam, world, x, y, null);
      if (hit?.kind === 'building') { buildingHit = hit; break; }
    }
  }
  assert.ok(buildingHit, 'a polygon facade remains clickable through the existing picker');
  assert.equal(buildingHit.object.name, 'Polygon Tower');
  assert.equal(buildingHit.object.tags.wikidata, 'Q12345',
    'the polygon path preserves the identity used by the Wikipedia panel');
});

test('classic glyph mode keeps the original height-field renderer', () => {
  const world = worldWithAngledBuilding();
  const building = world.buildings[1];
  const screen = makeScreen(90, 40, MODE.GLYPH);
  const cam = cameraFacing(building, screen);
  const light = new Lighting();
  light.update(25);

  screen.clear();
  renderScene(screen, cam, world, light, 0);
  assert.equal(screen.meshStats, undefined);
  assert.ok(screen.glyph.some((glyph) => glyph && glyph !== ' '),
    'classic ASCII facade glyphs are still produced');
});

/**
 * The projection every other world-anchored layer uses: streets, signs,
 * labels, vehicles, aircraft and the sky all compute a column this way. The
 * mesh renderer has to agree with it, or the polygon city lands somewhere the
 * street network and the labels do not.
 */
function overlayColumn(screen, cam, wx, wy) {
  const dx = wx - cam.x;
  const dy = wy - cam.y;
  const fwdX = Math.cos(cam.angle);
  const fwdY = Math.sin(cam.angle);
  const along = dx * fwdX + dy * fwdY;
  const side = -dx * fwdY + dy * fwdX;
  return { col: screen.cols / 2 - (side / along) * cam.proj, along };
}

test('building projection uses the same rectilinear camera plane as overlays', () => {
  const screen = makeScreen(80, 30, MODE.CINEMATIC);
  const cam = new Camera();
  cam.x = 0; cam.y = 0; cam.z = 1.65; cam.angle = Math.PI / 2;
  cam.hz = screen.horizon; cam.buildRays(screen);

  const centre = projectBuildingPoint(screen, cam, 0, 10, 1.65);
  assert.ok(centre);
  assert.ok(Math.abs(centre.x - screen.cols / 2) < 1e-9);
  assert.ok(Math.abs(centre.y - cam.hz) < 1e-9);
  assert.equal(centre.d, 10);

  // A centred point is symmetric, so it agrees with a mirrored projection too.
  // Only off-centre points on BOTH sides pin the handedness down.
  for (const angle of [Math.PI / 2, 0, -0.7, 2.4]) {
    cam.angle = angle;
    cam.buildRays(screen);
    for (const [wx, wy] of [[-9, 14], [9, 14], [-3, 40], [22, 31], [-18, 6]]) {
      const expected = overlayColumn(screen, cam, wx, wy);
      if (expected.along <= 0.5) continue;
      const p = projectBuildingPoint(screen, cam, wx, wy, 0);
      assert.ok(p, `point ${wx},${wy} at angle ${angle} should project`);
      assert.ok(Math.abs(p.x - expected.col) < 1e-6,
        `mesh column ${p.x} must match the overlay column ${expected.col} ` +
        `for ${wx},${wy} at angle ${angle}`);
      assert.ok(Math.abs(p.d - expected.along) < 1e-6);
    }
  }

  cam.angle = Math.PI / 2;
  cam.buildRays(screen);
  const stats = renderBuildingMeshes(screen, cam, null, new Lighting());
  assert.deepEqual(stats, { candidates: 0, buildings: 0, facades: 0, roofs: 0, pixels: 0 });
});

test('a building sits on the same screen columns as the street layer sees it', () => {
  const world = worldWithAngledBuilding();
  const building = world.buildings[1];
  const screen = makeScreen(120, 50, MODE.CINEMATIC);
  const cam = cameraFacing(building, screen);
  // Stand well off to one side. A building centred in the view projects to
  // nearly the same columns whichever way the side axis points.
  cam.x = building.cx - 16;
  cam.buildRays(screen);
  const light = new Lighting();
  light.update(25);

  screen.clear();
  renderScene(screen, cam, world, light, 0);

  // Where the footprint's own corners project is where its painted cells have
  // to be. A mirrored projection puts them on the far side of the screen.
  let minCol = Infinity;
  let maxCol = -Infinity;
  for (const [wx, wy] of building.rings[0]) {
    const p = overlayColumn(screen, cam, wx, wy);
    if (p.along <= 0.5) continue;
    minCol = Math.min(minCol, p.col);
    maxCol = Math.max(maxCol, p.col);
  }
  assert.ok(Number.isFinite(minCol) && maxCol > minCol);

  const painted = [];
  for (let i = 0; i < screen.kind.length; i++) {
    if (screen.kind[i] === 3) painted.push(i % screen.cols);
  }
  assert.ok(painted.length > 0, 'the facade painted some cells');
  assert.ok(Math.min(...painted) >= Math.floor(minCol) - 1,
    `leftmost painted column ${Math.min(...painted)} is outside the footprint ` +
    `span ${minCol.toFixed(1)}..${maxCol.toFixed(1)}`);
  assert.ok(Math.max(...painted) <= Math.ceil(maxCol) + 1,
    `rightmost painted column ${Math.max(...painted)} is outside the footprint ` +
    `span ${minCol.toFixed(1)}..${maxCol.toFixed(1)}`);
});
