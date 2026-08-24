/**
 * The line renderer: streets must come out as straight projected polylines,
 * not as a noisy floor texture. These tests drive the real Screen so the grid
 * contract is covered.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { renderStreets, lineChar, clipAndProject } from '../src/render/streets.js';
import { ProceduralStreets } from '../src/world/streets.js';
import { Lighting, groundColour } from '../src/render/materials.js';
import { renderScene } from '../src/render/raycaster.js';
import { Camera } from '../src/camera.js';
import { makeScreen, asText } from './support/screen.js';
import { FACADE } from '../src/config.js';
import { T } from '../src/world/source.js';

function setup(cols = 120, rows = 44) {
  const screen = makeScreen(cols, rows);
  const cam = new Camera();
  const spawn = { x: 60, y: 60, angle: Math.PI / 2 };
  cam.placeAt(spawn);
  cam.z = 1.65;
  cam.pitch = 0;
  cam.hz = screen.horizon - cam.pitch;
  cam.buildRays(screen);
  screen.clear();                 // production clears before renderStreets
  const L = new Lighting();
  L.update(60);
  return { screen, cam, L };
}

test('lineChar picks orientation from screen-space direction', () => {
  assert.equal(lineChar(10, 0), '-', 'horizontal');
  assert.equal(lineChar(0, 10), '|', 'vertical');
  assert.equal(lineChar(10, 10), '\\', 'down-right diagonal');
  assert.equal(lineChar(10, -10), '/', 'up-right diagonal');
});

test('a long straight road is drawn even when its endpoints are off screen', () => {
  // The classic v1 failure: a road with only two far-apart vertices would be
  // dropped. v2 clips each segment to the view, so the middle still draws.
  const { screen, cam, L } = setup();
  cam.y = 50;                       // stand off the line so it is in front
  const world = {
    roads: [{ pts: [[-1000, 60], [1000, 60]], cls: 'residential', nameId: -1, rank: 1 }],
    junctions: [],
  };
  renderStreets(screen, cam, world, L);
  const text = asText(screen);
  let dashes = 0;
  for (const line of text) for (const ch of line) if (ch === '-') dashes++;
  assert.ok(dashes > 5, `road should cross the screen as a line, got ${dashes} dashes`);
});

test('a road behind the camera is not drawn', () => {
  const { screen, cam, L } = setup();
  // Both endpoints well behind the camera (facing +y, so behind is -y).
  const world = {
    roads: [{ pts: [[60, -1000], [60, -500]], cls: 'residential', nameId: -1, rank: 1 }],
    junctions: [],
  };
  renderStreets(screen, cam, world, L);
  const text = asText(screen);
  let painted = 0;
  for (const line of text) for (const ch of line) if (ch !== ' ') painted++;
  assert.equal(painted, 0, 'nothing behind the camera should draw');
});

test('the procedural grid renders as connected lines', () => {
  const { screen, cam, L } = setup(120, 44);
  const world = new ProceduralStreets({ size: 200, pitch: 20 });
  cam.x = world.width / 2;
  cam.y = world.height / 2;
  cam.angle = Math.PI / 4;            // look diagonally so both axes show
  cam.hz = screen.horizon;
  cam.buildRays(screen);
  renderStreets(screen, cam, world, L);
  const text = asText(screen);
  let painted = 0;
  for (const line of text) for (const ch of line) if (ch !== ' ') painted++;
  assert.ok(painted > 20, `grid should fill with lines, got ${painted}`);
});

test('clipAndProject keeps a segment that crosses the screen', () => {
  const cam = new Camera();
  cam.x = 0; cam.y = 0; cam.angle = Math.PI / 2; cam.z = 1.65;
  const screen = makeScreen(80, 30);
  cam.hz = screen.horizon;
  cam.buildRays(screen);
  const seg = clipAndProject(cam, screen, -1000, 10, 1000, 10);
  assert.ok(seg, 'segment crossing the view should survive clipping');
  assert.ok(seg.a.col < 0 || seg.b.col > screen.cols, 'endpoints should be off-screen');
});

test('clipAndProject drops a segment fully behind the camera', () => {
  const cam = new Camera();
  cam.x = 0; cam.y = 0; cam.angle = Math.PI / 2; cam.z = 1.65;
  const screen = makeScreen(80, 30);
  cam.hz = screen.horizon;
  cam.buildRays(screen);
  const seg = clipAndProject(cam, screen, 0, -100, 0, -50);
  assert.equal(seg, null, 'behind-camera segment must be dropped');
});

test('no NaN depths are written', () => {
  const { screen, cam, L } = setup();
  const world = new ProceduralStreets({ size: 200, pitch: 20 });
  cam.x = world.width / 2;
  cam.y = world.height / 2;
  cam.buildRays(screen);
  renderStreets(screen, cam, world, L);
  for (let i = 0; i < screen.depth.length; i++) {
    assert.ok(Number.isFinite(screen.depth[i]), `NaN/Inf depth at ${i}`);
  }
});

// Buildings must read as a different colour from the roads, so they are easy to
// tell apart. The FACADE palette is warm (more red than blue) while the road
// surface stays cool blue-grey (blue >= red). This pins that separation so a
// future palette tweak cannot silently make towers blend into the street.
test('buildings are warm-toned and roads stay cool-toned', () => {
  // The FACADE palette (building facades + roofs) is warm: more red than blue.
  for (const [r, g, b] of FACADE) {
    assert.ok(r > b, `building facade should be warmer than the road (R>B), got ${r},${g},${b}`);
  }
  // Variety: the palette must hold several distinct hues (beige, grey, cream,
  // ...) so the city does not read as one flat colour. At least 6 entries, and
  // at least 3 visibly different tones.
  assert.ok(FACADE.length >= 6, `palette should offer variety, got ${FACADE.length}`);
  const tones = new Set(FACADE.map(([r, g, b]) => `${r >> 4},${g >> 4},${b >> 4}`));
  assert.ok(tones.size >= 3, `palette hues should differ, got ${tones.size}`);
  // The road SURFACE base is cool blue-grey (blue >= red). The sun tint warms it
  // at noon, but the underlying pavement hue stays cooler than the warm towers.
  const L = new Lighting();
  L.update(30);
  const world = {
    type: new Uint8Array([T.ROAD]),
    flags: new Uint8Array([0]),
    lamp: new Float32Array([0]),
    sample: () => 0,
  };
  const road = groundColour(world, 0, 1, L);
  const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(road);
  assert.ok(m, 'road colour should be an rgb() string');
  const rr = Number(m[1]), bb = Number(m[3]);
  // Buildings (FACADE R~126) must be clearly warmer than the road surface.
  assert.ok(rr < 110, `road surface should stay cooler than buildings, got R=${rr}`);
  assert.ok(bb >= 60, `road surface should keep its blue character, got B=${bb}`);
});

// Edge-aware silhouettes: a wall face that borders a different building (or the
// street) must read as a crisp vertical edge, not dissolve into window texture.
// The renderer keys this on the per-cell `bid` array, so a world that exposes
// `bid` should produce '|' along building outlines.
test('building outlines render as crisp vertical edges via bid', () => {
  const cols = 80, rows = 40;
  const screen = makeScreen(cols, rows);
  const cam = new Camera();
  cam.x = 10; cam.y = 20; cam.z = 1.65;
  cam.angle = Math.PI / 2; cam.pitch = 0; cam.hz = screen.horizon;
  cam.buildRays(screen);
  const L = new Lighting();
  L.update(60);

  // A 6-wide, 10-tall block at x in [14,19], y in [18,27], bid 1.
  const W = 40, H = 40, n = W * H;
  const world = {
    width: W, height: H, size: 0, maxHeight: 10, voidSlot: n,
    h: new Float32Array(n + 1),
    type: new Uint8Array(n + 1).fill(T.PLAZA),
    rnd: new Float32Array(n + 1),
    lamp: new Float32Array(n + 1),
    pal: new Uint8Array(n + 1),
    flags: new Uint8Array(n + 1),
    bid: new Uint16Array(n + 1),
    sample(x, y) {
      x = Math.floor(x); y = Math.floor(y);
      return x < 0 || x >= W || y < 0 || y >= H ? this.voidSlot : y * W + x;
    },
  };
  for (let y = 18; y <= 27; y++) {
    for (let x = 14; x <= 19; x++) {
      const i = y * W + x;
      world.h[i] = 10; world.type[i] = T.TOWER; world.bid[i] = 1;
    }
  }

  screen.clear();
  renderScene(screen, cam, world, L, 0);
  const text = asText(screen);

  // The two side faces (x=14 and x=19) face the camera and should be outlined
  // with '|' columns. Count '|' glyphs on the building's projected silhouette.
  let edges = 0;
  for (const line of text) for (const ch of line) if (ch === '|') edges++;
  assert.ok(edges > 0, 'building outline should produce vertical edge glyphs');
});
