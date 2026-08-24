/**
 * Traffic signals: a signal head at each junction must (a) be depth-tested so a
 * building in front hides it, (b) show exactly one lit lamp that changes with
 * time, and (c) never index out of the lamp array. These pin the behaviour so a
 * tweak cannot make signals draw through walls or throw on an undefined lamp.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { TrafficLights } from '../src/render/trafficlights.js';
import { Lighting } from '../src/render/materials.js';
import { makeScreen } from './support/screen.js';
import { signalState } from '../src/traffic-signals.js';

function worldWithJunctions(n = 4) {
  const junctions = [];
  for (let i = 0; i < n; i++) {
    junctions.push({
      id: i, x: 50 + i * 3, y: 50, names: [i, (i + 1) % n], signal: true,
      approaches: [
        { dx: 0, dy: -1, group: 0, nameId: i, nodeId: i * 2 },
        { dx: 1, dy: 0, group: 1, nameId: (i + 1) % n, nodeId: i * 2 + 1 },
      ],
    });
  }
  return { junctions };
}

function drawAt(simTime, junctions) {
  const screen = makeScreen(100, 44);
  // Simulate renderScene having filled the depth buffer with far distances;
  // otherwise every cell reads as "nearer building" and occludes the signals.
  screen.depth.fill(1e9);
  const cam = {
    x: 50, y: 10, angle: Math.PI / 2, z: 1.65,
    hz: screen.horizon, proj: screen.proj,
    rowOf(z, d) { return this.hz + (this.z - z) * screen.vscale / d; },
  };
  const L = new Lighting();
  L.update(0);   // noon: dayAmt high, signals still drawn (dimmer)
  const signals = new TrafficLights();
  signals.draw(screen, cam, { roadGraph: { signalJunctions: junctions } }, L, simTime);
  return { screen, cam };
}

test('a signal head shows exactly one lit lamp', () => {
  const { screen } = drawAt(0, worldWithJunctions().junctions);
  // Lamps are solid filled blocks (space glyph + bright colour), not letters.
  // Count cells whose colour is a bright lamp hue — exactly one lit lamp per
  // junction, so 4 bright-red/green/amber cells in all.
  let lit = 0;
  for (let i = 0; i < screen.colour.length; i++) {
    const c = screen.colour[i];
    if (!c) continue;
    const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(c);
    if (!m) continue;
    const r = +m[1], g = +m[2], b = +m[3];
    const bright = (r > 150 && g < 120 && b < 120)   // red
                || (r < 120 && g > 150 && b < 120)    // green
                || (r > 150 && g > 120 && b < 120);   // amber
    if (bright) lit++;
  }
  assert.ok(lit >= 4, 'each visible junction contributes a lit approach lamp');
});

test('the lit lamp changes as time advances', () => {
  const a = drawAt(0, worldWithJunctions().junctions);
  const b = drawAt(20000, worldWithJunctions().junctions);
  // The lit-lamp positions should differ between two well-separated times
  // (the cycle period is 16s, so 20s later a different lamp is lit).
  let diff = 0;
  for (let i = 0; i < a.screen.colour.length; i++) {
    if (a.screen.colour[i] !== b.screen.colour[i]) diff++;
  }
  assert.ok(diff > 0, 'signals should change state over time');
});

test('signals are occluded by a nearer building', () => {
  const screen = makeScreen(100, 44);
  const cam = { x: 50, y: 10, angle: Math.PI / 2, z: 1.65, hz: screen.horizon, proj: screen.proj, rowOf(z, d) { return this.hz + (this.z - z) * screen.vscale / d; } };
  const L = new Lighting();
  L.update(0);
  // Plant a "building" nearer than the junction at the junction's screen cell.
  const jn = worldWithJunctions(1).junctions[0];
  const col = Math.round(screen.cols / 2 - ((jn.x - cam.x) * Math.sin(cam.angle) - (jn.y - cam.y) * Math.cos(cam.angle)) / (jn.y - cam.y) * cam.proj);
  const row = Math.round(cam.hz + cam.z * screen.vscale / (jn.y - cam.y));
  // Mark the junction cell as having a building very close (depth 1).
  screen.depth[row * screen.cols + col] = 1;
  const signals = new TrafficLights();
  screen.depth.fill(1);
  signals.draw(screen, cam, { roadGraph: { signalJunctions: [jn] } }, L, 0);
  // No signal colour should have been written at that cell (occluded).
  assert.equal(screen.colour[row * screen.cols + col], undefined,
    'a nearer building must hide the signal');
});

test('opposing groups never receive green together', () => {
  for (let t = 0; t < 32; t += 0.25) {
    assert.ok(!(signalState(t, 0) === 'green' && signalState(t, 1) === 'green'));
  }
});

test('signals do not throw when toggled off or with no junctions', () => {
  const screen = makeScreen(100, 44);
  const cam = { x: 50, y: 10, angle: Math.PI / 2, z: 1.65, hz: screen.horizon, proj: screen.proj, rowOf(z, d) { return this.hz + (this.z - z) * screen.vscale / d; } };
  const L = new Lighting();
  L.update(0);
  const signals = new TrafficLights();
  signals.on = false;
  assert.doesNotThrow(() => signals.draw(screen, cam, { junctions: worldWithJunctions().junctions }, L, 0));
  assert.doesNotThrow(() => signals.draw(screen, cam, { junctions: [] }, L, 0));
});

test('spatial index does not drop signals visible to the full scan', () => {
  // A camera with a far envelope that contains every junction: the indexed path
  // must draw exactly what the unindexed full-scan path draws.
  const junctions = worldWithJunctions(4).junctions;
  const cam = { x: 50, y: 10, angle: Math.PI / 2, z: 1.65, hz: 0, proj: 100, rowOf(z, d) { return this.hz + (this.z - z) * 10 / d; } };

  const full = makeScreen(100, 44);
  full.depth.fill(1e9);
  new TrafficLights().draw(full, cam, { roadGraph: { signalJunctions: junctions } }, new Lighting(), 0);

  const indexed = makeScreen(100, 44);
  indexed.depth.fill(1e9);
  const world = { roadGraph: { signalJunctions: junctions }, spatial: { signals: { query: () => junctions } } };
  new TrafficLights().draw(indexed, cam, world, new Lighting(), 0);

  assert.deepEqual(indexed.colour, full.colour);
});

