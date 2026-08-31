import assert from 'node:assert/strict';
import test from 'node:test';

import { AircraftLayer } from '../src/aircraft.js';
import {
  resolveAircraftModel, modelProvenance, MODEL_TIER, MOUNT,
} from '../src/render/aircraft-model.js';
import { aircraftLod, flightPathAngle, AIR_LOD } from '../src/render/aircraft-mesh.js';
import { Lighting } from '../src/render/materials.js';
import { OsmWorld } from '../src/world/osm.js';
import { makeScreen, MODE } from './support/screen.js';

const BBOX = [41.9740, -87.9080, 41.9850, -87.8930];
const TEST_WORKER = 'https://worker.example.test';

/** An empty extract, so the only thing in the scene is the aircraft. */
function emptyWorld() {
  return new OsmWorld(BBOX, [], 'Test Field');
}

function layerOn(world) {
  const layer = new AircraftLayer({ workerUrl: TEST_WORKER });
  layer.setWorld(world);
  return layer;
}

/** Place one contact `km` north of the world centre at `altM`. */
function contact(layer, world, { km, altM, type = 'B738', icao = 'abc123' }) {
  const p = {
    lat: world.proj.lat0 + km / 110.54,
    lon: world.proj.lon0,
    altM,
    gsKt: 160, trackDeg: 180, headingDeg: null,
    icao, callsign: 'TEST123', type, reg: 'N0000X', category: 'A3',
    squawk: null, originCountry: null, vertRate: -700, onGround: false,
  };
  layer.records.set(icao, { obs: p, prev: p, tObs: 1000, tPrev: 1000 });
  return p;
}

/** A camera at the world centre looking north, so a contact due north is ahead. */
function northCam(world, screen) {
  return {
    x: world.proj.width / 2,
    y: world.proj.height / 2,
    angle: Math.PI / 2,
    z: 1.65,
    proj: screen.proj,
    vscale: screen.vscale,
    hz: screen.horizon,
    rowOf(z, d) { return this.hz + (this.z - z) * this.vscale / d; },
  };
}

function paintedCells(screen) {
  let n = 0;
  for (let i = 0; i < screen.kind.length; i++) if (screen.kind[i] === 1) n++;
  return n;
}

/* ---------------------------- the model table ---------------------------- */

test('an exact type designator resolves to its own dimensions', () => {
  const m = resolveAircraftModel('B738', 'A3');
  assert.equal(m.tier, MODEL_TIER.TYPE);
  assert.equal(m.metres.span, 35.79);
  assert.equal(m.engines, 2);
  assert.equal(m.mount, MOUNT.WING);
  // Cells, not metres, are what the renderer consumes.
  assert.ok(m.span > 14 && m.span < 16, `span in cells was ${m.span}`);
  assert.match(modelProvenance(m), /DERIVED/);
});

test('a widebody and a regional jet are not the same size', () => {
  const heavy = resolveAircraftModel('B77W');
  const regional = resolveAircraftModel('CRJ9');
  assert.ok(heavy.span > regional.span * 2,
    'a 777 is more than twice the span of a CRJ-900');
  assert.equal(regional.mount, MOUNT.TAIL, 'CRJ engines are on the rear fuselage');
});

test('model resolution falls back through family, category, then generic', () => {
  const family = resolveAircraftModel('B77L2', null);
  assert.equal(family.tier, MODEL_TIER.FAMILY);
  assert.equal(family.designator, 'B77L2');

  const category = resolveAircraftModel(null, 'A5');
  assert.equal(category.tier, MODEL_TIER.CATEGORY);
  assert.ok(category.span > resolveAircraftModel(null, 'A1').span,
    'a heavy is bigger than a light, even with no type at all');

  const generic = resolveAircraftModel(null, null);
  assert.equal(generic.tier, MODEL_TIER.GENERIC);
  assert.ok(generic.span > 0);
  assert.match(modelProvenance(generic), /type unknown/);
});

test('an exact designator is never shadowed by its own family prefix', () => {
  // 'B78' is a family prefix, so a bare B788 must still match exactly.
  assert.equal(resolveAircraftModel('B788').tier, MODEL_TIER.TYPE);
  assert.equal(resolveAircraftModel('CRJ9').tier, MODEL_TIER.TYPE);
});

/* -------------------------------- geometry ------------------------------- */

test('flight path angle is derived from vertical and ground speed', () => {
  assert.equal(flightPathAngle(null, 200), 0, 'no rate reported, no pitch invented');
  assert.equal(flightPathAngle(-700, 0), 0, 'stationary, no meaningful path angle');
  const descending = flightPathAngle(-700, 140);
  assert.ok(descending < 0, 'a descent points the nose down');
  assert.ok(Math.abs(descending) < 0.1, `a 3 degree approach, got ${descending}`);
  assert.ok(flightPathAngle(-90000, 140) >= -0.35, 'absurd rates are clamped');
});

test('detail tiers follow apparent wingspan', () => {
  assert.equal(aircraftLod(20), AIR_LOD.FULL);
  assert.equal(aircraftLod(3), AIR_LOD.COARSE);
  assert.equal(aircraftLod(0.4), AIR_LOD.GLYPH);
});

/* ------------------------- the actual regression ------------------------- */

test('an approaching aircraft grows on screen instead of staying one cell', () => {
  const world = emptyWorld();
  const light = new Lighting();
  light.update(30);

  // Same aircraft, same altitude, closing range. Cell counts must increase at
  // every step: that monotonic growth is the whole defect. Before this change
  // every one of these frames painted exactly one cell.
  const ranges = [8, 2, 0.5, 0.15];
  const counts = ranges.map((km) => {
    const screen = makeScreen(160, 60, MODE.GLYPH);
    const layer = layerOn(world);
    const cam = northCam(world, screen);
    contact(layer, world, { km, altM: 60 });
    screen.clear();
    layer.draw(screen, cam, light);
    return paintedCells(screen);
  });

  assert.ok(counts[0] >= 1, 'a distant contact is still marked');
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i] > counts[i - 1],
      `${ranges[i]}km must paint more than ${ranges[i - 1]}km: ` +
      `${counts.join(' -> ')}`);
  }
  // 35.8 m of wingspan at 150 m subtends about 13 degrees, which is a fifth of
  // the 66 degree view: some tens of cells, not a glyph.
  assert.ok(counts[counts.length - 1] > 35,
    `a 737 at 150 m should be a shape, got ${counts[counts.length - 1]} cells`);
});

test('a 777 draws larger than a CRJ at the same range', () => {
  const world = emptyWorld();
  const light = new Lighting();
  light.update(30);
  const sizes = {};
  for (const type of ['B77W', 'CRJ9']) {
    const screen = makeScreen(160, 60, MODE.GLYPH);
    const layer = layerOn(world);
    const cam = northCam(world, screen);
    contact(layer, world, { km: 1, altM: 150, type });
    screen.clear();
    layer.draw(screen, cam, light);
    sizes[type] = paintedCells(screen);
  }
  assert.ok(sizes.B77W > sizes.CRJ9 * 1.5,
    `the type must change the drawn size: ${JSON.stringify(sizes)}`);
});

/* ------------------------ the silhouette reads ------------------------- */

/** The glyphs painted, by part, for a GLYPH-mode frame. */
function partsOf(screen) {
  const PART = {
    '#': 'fuselage', '@': 'fuselage', '%': 'fuselage',
    '=': 'wing', '-': 'tail', '|': 'fin', o: 'engine', '*': 'navlight', '+': 'strobe',
  };
  const out = {};
  for (let i = 0; i < screen.glyph.length; i++) {
    if (screen.kind[i] !== 1) continue;
    const p = PART[screen.glyph[i]];
    if (p) out[p] = (out[p] || 0) + 1;
  }
  return out;
}

function frameOf(world, { km, type = 'B738', track = 180, mode = MODE.GLYPH }) {
  const screen = makeScreen(150, 60, mode);
  const layer = layerOn(world);
  const cam = northCam(world, screen);
  cam.cw = screen.cw;
  cam.ch = screen.ch;
  cam.hz = screen.horizon + 10;
  const light = new Lighting();
  light.update(35);
  const p = {
    lat: world.proj.lat0 + km / 110.54, lon: world.proj.lon0,
    altM: km * 1000 * 0.09, gsKt: 150, trackDeg: track, headingDeg: null,
    icao: 'sil001', callsign: 'SIL', type, reg: null, category: 'A3',
    squawk: null, originCountry: null, vertRate: null, onGround: false,
  };
  layer.records.set(p.icao, { obs: p, prev: p, tObs: 1000, tPrev: 1000 });
  screen.clear();
  layer.draw(screen, cam, light);
  return { screen, layer };
}

test('an approaching jet shows engines, not just a bar and a fin', () => {
  const world = emptyWorld();
  // The reported defect: at approach range the aircraft was a stalk on a bar,
  // which reads as a tail assembly. Engines under the wing are what make it a
  // jet, and at 350 m they are about two columns out, which the grid resolves.
  for (const km of [0.2, 0.35, 0.7]) {
    const { screen } = frameOf(world, { km });
    const parts = partsOf(screen);
    assert.ok(parts.engine > 0,
      `no engines drawn at ${km} km: ${JSON.stringify(parts)}`);
    assert.ok(parts.wing > 0, `no wing at ${km} km`);
    assert.ok(parts.fuselage > 0, `no fuselage body at ${km} km`);
  }
});

test('the tailplane never overprints the wing it cannot be told apart from', () => {
  const world = emptyWorld();
  // Head-on at range the stabiliser is a fraction of a row from the wing. All
  // it can do there is repaint the middle of the wing bar as tail, which is
  // exactly what made the bar read as a stabiliser. It is suppressed instead.
  const { screen } = frameOf(world, { km: 0.35 });
  const parts = partsOf(screen);
  assert.equal(parts.tail, undefined,
    'an unresolvable tailplane must be dropped, not drawn over the wing');

  // Close enough to separate, it comes back.
  const near = partsOf(frameOf(world, { km: 0.12 }).screen);
  assert.ok(near.tail > 0, 'once it can land on its own row it is drawn again');
});

test('a T-tail carries its stabiliser far higher than a fuselage one', () => {
  const world = emptyWorld();
  // Every rear-engined jet in the table is a T-tail, and drawing a CRJ with a
  // fuselage-mounted tailplane gets its silhouette wrong in the one way
  // anybody who looks at aircraft would notice. Both types put the stabiliser
  // above a low wing; what separates them is how far above, so that is what
  // this measures rather than the mere sign.
  const gap = (type) => {
    const { screen } = frameOf(world, { km: 0.12, type });
    let tailRow = -1;
    let wingRow = -1;
    for (let i = 0; i < screen.glyph.length; i++) {
      if (screen.kind[i] !== 1) continue;
      const row = Math.floor(i / screen.cols);
      if (screen.glyph[i] === '-' && tailRow < 0) tailRow = row;
      if (screen.glyph[i] === '=' && wingRow < 0) wingRow = row;
    }
    assert.ok(tailRow >= 0 && wingRow >= 0, `${type} drew both surfaces`);
    return wingRow - tailRow;      // rows the stabiliser sits above the wing
  };

  const conventional = gap('B738');
  const tTail = gap('CRJ9');
  assert.ok(conventional >= 0, 'a fuselage stabiliser is above a low wing');
  assert.ok(tTail > conventional + 1,
    `a T-tail is clearly higher: CRJ9 ${tTail} rows vs B738 ${conventional}`);
});

test('the silhouette grows without popping as an aircraft closes', () => {
  const world = emptyWorld();
  // Requirement: gradual degradation. The original defect was a hard step from
  // a bare cross to a solid, with nothing in between.
  let prev = 0;
  const counts = [];
  for (const km of [2.0, 1.4, 1.0, 0.7, 0.5, 0.35, 0.25, 0.18, 0.12]) {
    const { screen } = frameOf(world, { km, mode: MODE.CINEMATIC });
    let n = 0;
    for (let i = 0; i < screen.kind.length; i++) if (screen.kind[i] === 1) n++;
    counts.push(n);
    assert.ok(n >= prev, `shrank when closing: ${counts.join(' -> ')}`);
    prev = n;
  }
  assert.ok(counts[counts.length - 1] > counts[0] * 8,
    `should grow substantially overall: ${counts.join(' -> ')}`);
});

/* -------------------------- depth and occlusion -------------------------- */

test('an aircraft claims depth, so later layers can occlude it', () => {
  const world = emptyWorld();
  const screen = makeScreen(160, 60, MODE.GLYPH);
  const layer = layerOn(world);
  const cam = northCam(world, screen);
  const light = new Lighting();
  light.update(30);
  contact(layer, world, { km: 1, altM: 150 });

  screen.clear();
  layer.draw(screen, cam, light);

  let claimed = 0;
  for (let i = 0; i < screen.depth.length; i++) {
    if (screen.depth[i] < 1e8) claimed++;
  }
  assert.ok(claimed > 0,
    'the layer used to paint with screen.set and leave depth untouched');
});

test('a nearer surface hides the aircraft behind it', () => {
  const world = emptyWorld();
  const screen = makeScreen(160, 60, MODE.GLYPH);
  const layer = layerOn(world);
  const cam = northCam(world, screen);
  const light = new Lighting();
  light.update(30);
  contact(layer, world, { km: 1, altM: 150 });

  screen.clear();
  const open = (() => {
    layer.draw(screen, cam, light);
    return paintedCells(screen);
  })();

  // Now put a wall one cell in front of the camera across the whole grid.
  screen.clear();
  for (let y = 0; y < screen.rows; y++) {
    for (let x = 0; x < screen.cols; x++) screen.setDepth(x, y, '#', '#fff', 2);
  }
  const before = paintedCells(screen);
  layer.draw(screen, cam, light);
  assert.equal(paintedCells(screen), before,
    'nothing new was painted through a nearer surface');
  assert.ok(open > 0, 'and the same aircraft was visible with the wall removed');
});

/* --------------------------------- picking -------------------------------- */

test('a painted aircraft cell resolves to that aircraft', () => {
  const world = emptyWorld();
  const screen = makeScreen(160, 60, MODE.GLYPH);
  const layer = layerOn(world);
  const cam = northCam(world, screen);
  const light = new Lighting();
  light.update(30);
  contact(layer, world, { km: 1, altM: 150, icao: 'aa11bb' });

  screen.clear();
  layer.draw(screen, cam, light);
  assert.ok(layer.marks.length > 0);

  const m = layer.marks[0];
  const cx = Math.round((m.x0 + m.x1) / 2);
  const cy = Math.round((m.y0 + m.y1) / 2);
  assert.equal(layer.pickAt(cx, cy, screen), 'aa11bb');

  // A cell nowhere near the aircraft belongs to nobody.
  assert.equal(layer.pickAt(0, screen.rows - 1, screen), null);
});

test('an aircraft does not claim a cell a nearer surface owns', () => {
  const world = emptyWorld();
  const screen = makeScreen(160, 60, MODE.GLYPH);
  const layer = layerOn(world);
  const cam = northCam(world, screen);
  const light = new Lighting();
  light.update(30);
  contact(layer, world, { km: 1, altM: 150, icao: 'aa11bb' });

  screen.clear();
  layer.draw(screen, cam, light);
  const m = layer.marks[0];
  const cx = Math.round((m.x0 + m.x1) / 2);
  const cy = Math.round((m.y0 + m.y1) / 2);

  // Something much closer takes the cell after the aircraft was drawn.
  screen.setDepth(cx, cy, '#', '#fff', 1.5);
  assert.equal(layer.pickAt(cx, cy, screen), null,
    'the depth check is what stops a hull stealing a building click');
});

/* ---------------------------- surface traffic ---------------------------- */

test('an aircraft on the ground is still drawn', () => {
  const world = emptyWorld();
  const screen = makeScreen(160, 60, MODE.GLYPH);
  const layer = layerOn(world);
  const cam = northCam(world, screen);
  const light = new Lighting();
  light.update(30);

  const p = {
    lat: world.proj.lat0 + 0.3 / 110.54, lon: world.proj.lon0,
    altM: 0, gsKt: 12, trackDeg: null, headingDeg: 180,
    icao: 'gr0und', callsign: 'TAXI1', type: 'A320', reg: 'N1TX',
    category: 'A3', squawk: null, originCountry: null,
    vertRate: null, onGround: true,
  };
  layer.records.set(p.icao, { obs: p, prev: p, tObs: 1000, tPrev: 1000 });

  screen.clear();
  layer.draw(screen, cam, light);
  assert.ok(paintedCells(screen) > 12,
    'surface traffic used to be dropped before it ever reached the layer');
});

test('the drawn orientation follows the aircraft, not the camera', () => {
  const world = emptyWorld();
  const light = new Lighting();
  light.update(30);

  // The same aircraft at the same range, flying towards the camera and then
  // across it. Head-on the wingspan is what shows; side-on the fuselage is.
  const width = (trackDeg) => {
    const screen = makeScreen(160, 60, MODE.GLYPH);
    const layer = layerOn(world);
    const cam = northCam(world, screen);
    const p = {
      lat: world.proj.lat0 + 0.4 / 110.54, lon: world.proj.lon0,
      altM: 60, gsKt: 150, trackDeg, headingDeg: null,
      icao: 'or1ent', callsign: 'ORIENT', type: 'A321', reg: null,
      category: 'A3', squawk: null, originCountry: null,
      vertRate: null, onGround: false,
    };
    layer.records.set(p.icao, { obs: p, prev: p, tObs: 1000, tPrev: 1000 });
    screen.clear();
    layer.draw(screen, cam, light);
    const m = layer.marks[0];
    return m ? m.x1 - m.x0 : 0;
  };

  // An A321 is 44.5 m long and 35.8 m across, so side-on is the wider view.
  // A sprite pasted at a fixed size could not tell these two apart.
  const headOn = width(180);
  const crossing = width(90);
  assert.ok(headOn > 0 && crossing > 0);
  assert.ok(crossing > headOn,
    `an A321 is longer than it is wide: head-on ${headOn}, crossing ${crossing}`);
});
