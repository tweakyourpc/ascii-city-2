/**
 * The cartographic generalization layer: ground facts (OSM / procedural types)
 * map to a stable glyph + colour vocabulary, with a perceptual-LOD tier metric.
 *
 * These tests lock the contract so a future tier switch (turning surfaceTier on)
 * cannot silently change what a surface reads as, and so the tier metric behaves
 * monotonically with distance and viewing angle.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { surfaceTier, SURFACE, groundGlyph, groundColour } from '../src/render/surface.js';
import { Lighting } from '../src/render/materials.js';
import { T } from '../src/world/source.js';

// The mid tier must reproduce the original ground vocabulary exactly, so the
// refactor is a no-op until a tier is selected.
const EXPECTED_MID = {
  [T.ROAD]: '.',
  [T.PLAZA]: '+',   // r<0.25 path; hash(0,0,0) is deterministic
  [T.WATER]: '~',   // sin/cos at (0,0,t=0) > 0.2
};

test('surface vocabulary covers every ground type', () => {
  for (const type of [T.ROAD, T.PATH, T.SIDEWALK, T.PLAZA, T.YARD,
                      T.FIELD, T.FARM, T.WATER]) {
    assert.ok(SURFACE[type], `missing vocabulary for type ${type}`);
    assert.ok(SURFACE[type].mid, `type ${type} missing mid tier`);
    assert.ok(Array.isArray(SURFACE[type].mid.colour), `type ${type} missing colour`);
  }
});

test('mid-tier glyphs reproduce the original ground rendering', () => {
  const L = new Lighting();
  L.update(30);
  const world = (type) => ({
    type: new Uint8Array([type]),
    flags: new Uint8Array([0]),
    lamp: new Float32Array([0]),
    sample: () => 0,
  });
  // PLAZA at cell (0,0): hash(0,0,0) < 0.25 -> '+'
  assert.equal(groundGlyph(world(T.PLAZA), 0, 0, 0, 0), EXPECTED_MID[T.PLAZA]);
  // ROAD is always '.'
  assert.equal(groundGlyph(world(T.ROAD), 0, 5, 5, 0), EXPECTED_MID[T.ROAD]);
  // WATER at t=0, (0,0): sin(0)+cos(0)=1 > 0.2 -> '~'
  assert.equal(groundGlyph(world(T.WATER), 0, 0, 0, 0), EXPECTED_MID[T.WATER]);
});

test('road surface stays cool-toned through the vocabulary', () => {
  const L = new Lighting();
  L.update(30);
  const world = {
    type: new Uint8Array([T.ROAD]),
    flags: new Uint8Array([0]),
    lamp: new Float32Array([0]),
    sample: () => 0,
  };
  const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(groundColour(world, 0, 1, L));
  assert.ok(m, 'road colour should be an rgb() string');
  assert.ok(Number(m[1]) < 110, `road should stay cool, got R=${m[1]}`);
  assert.ok(Number(m[3]) >= 60, `road should keep blue, got B=${m[3]}`);
});

test('surfaceTier is near up close, far at distance', () => {
  // Straight-down, night: distance alone decides (no penalty).
  assert.equal(surfaceTier(5, 1, 0), 'near');
  assert.equal(surfaceTier(20, 1, 0), 'mid');
  assert.equal(surfaceTier(80, 1, 0), 'far');
});

test('surfaceTier coarsens when grazing or in daylight', () => {
  // Straight-down, night: distance alone decides.
  assert.equal(surfaceTier(20, 1, 0), 'mid');
  // Grazing view pushes a mid-distance surface one tier coarser.
  assert.equal(surfaceTier(20, 0.1, 0), 'far');
  // Bright daylight also coarsens.
  assert.equal(surfaceTier(20, 1, 1), 'far');
  // Near + grazing + bright collapses to far (penalty is clamped, not floored):
  // a near surface seen edge-on in daylight reads as a speckle, not full texture.
  assert.equal(surfaceTier(5, 0.1, 1), 'far');
});
