/**
 * Street signs: a signpost is drawn at each junction naming the cross streets,
 * depth-tested and capped to the nearest few. Toggleable with N.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { Signs } from '../src/render/signs.js';
import { ProceduralStreets } from '../src/world/streets.js';
import { Lighting } from '../src/render/materials.js';

function headlessScreen(cols = 90, rows = 40) {
  // A minimal screen stub with the set() contract the signs use.
  return {
    cols, rows, hz: rows * 0.52, proj: (cols / 2) / Math.tan(1.15 / 2),
    vscale: 1, glyph: new Array(cols * rows), colour: new Array(cols * rows),
    set(x, y, g, c) {
      if (x < 0 || x >= cols || y < 0 || y >= rows) return;
      this.glyph[y * cols + x] = g;
      this.colour[y * cols + x] = c;
    },
  };
}

function camAt(world, x, y, angle = Math.PI / 2) {
  return { x, y, z: 1.65, angle, pitch: 0, hz: 20, proj: 50, vscale: 1 };
}

test('signs are on by default and toggle off', () => {
  const s = new Signs();
  assert.equal(s.on, true);
  assert.equal(s.toggle(), false);
  assert.equal(s.toggle(), true);
});

test('a sign is drawn at a nearby junction', () => {
  const world = new ProceduralStreets({ size: 100, pitch: 20 });
  const screen = headlessScreen(90, 40);
  const cam = camAt(world, world.width / 2, world.height / 2 - 10);
  const L = new Lighting();
  L.update(60);

  const s = new Signs();
  s.draw(screen, cam, world, L);

  // Something was painted (the board, post, or names).
  let painted = 0;
  for (let i = 0; i < screen.glyph.length; i++) if (screen.glyph[i] !== undefined) painted++;
  assert.ok(painted > 0, 'no sign was drawn');
  assert.ok(s.prev.size > 0, 'the placed set should be recorded');
});

test('an approaching driver sees the cross street, not the current street', () => {
  const world = {
    streetNames: ['CURRENT STREET', 'CROSS ROAD'],
    junctions: [{
      x: 50, y: 50, names: [0, 1],
      approaches: [
        { dx: 0, dy: -1, nameId: 0 }, { dx: 0, dy: 1, nameId: 0 },
        { dx: -1, dy: 0, nameId: 1 }, { dx: 1, dy: 0, nameId: 1 },
      ],
    }],
  };
  const screen = headlessScreen(90, 40);
  const cam = camAt(world, 50, 30);
  const L = new Lighting();
  L.update(60);
  new Signs().draw(screen, cam, world, L);
  const painted = screen.glyph.filter(Boolean).join('');
  assert.match(painted, /CROSS RD/);
  assert.doesNotMatch(painted, /CURRENT/);
});

test('signs respect the cap', () => {
  const world = new ProceduralStreets({ size: 100, pitch: 10 });
  const screen = headlessScreen(120, 50);
  const cam = camAt(world, world.width / 2, world.height / 2);
  const L = new Lighting();
  L.update(60);

  const s = new Signs();
  s.draw(screen, cam, world, L);
  assert.ok(s.prev.size <= 6, `too many signs: ${s.prev.size}`);
});

test('signs are skipped when toggled off', () => {
  const world = new ProceduralStreets({ size: 100, pitch: 20 });
  const screen = headlessScreen(90, 40);
  const cam = camAt(world, world.width / 2, world.height / 2);
  const L = new Lighting();
  L.update(60);

  const s = new Signs();
  s.on = false;
  s.draw(screen, cam, world, L);
  let painted = 0;
  for (let i = 0; i < screen.glyph.length; i++) if (screen.glyph[i] !== undefined) painted++;
  assert.equal(painted, 0, 'signs should not draw when off');
});

test('a world with no junctions draws no signs', () => {
  // A single straight road, no crossings.
  const world = {
    junctions: [],
    streetNames: ['Lone Road'],
  };
  const screen = headlessScreen(90, 40);
  const cam = camAt({ width: 100, height: 100 }, 50, 50);
  const L = new Lighting();
  L.update(60);
  const s = new Signs();
  s.draw(screen, cam, world, L);
  assert.equal(s.prev.size, 0);
});
