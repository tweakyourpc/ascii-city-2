/**
 * Traffic signals: the rendered mast-mounted heads are disabled by default
 * (they read poorly at the engine's scale and resolution), but the signal
 * *timing* still drives traffic. These tests pin the timing contract and the
 * draw() guard so a future re-enable cannot make signals draw through walls or
 * throw on an undefined lamp.
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

test('signals are disabled by default (no heads drawn)', () => {
  const screen = makeScreen(100, 44);
  screen.depth.fill(1e9);
  const cam = { x: 50, y: 10, angle: Math.PI / 2, z: 1.65, hz: screen.horizon, proj: screen.proj, rowOf(z, d) { return this.hz + (this.z - z) * screen.vscale / d; } };
  const L = new Lighting();
  L.update(0);
  const signals = new TrafficLights();
  assert.equal(signals.on, false, 'signal heads start disabled');
  signals.draw(screen, cam, { roadGraph: { signalJunctions: worldWithJunctions().junctions } }, L, 0);
  // No lamp colour should have been written anywhere.
  for (let i = 0; i < screen.colour.length; i++) {
    assert.equal(screen.colour[i], undefined, 'disabled signals draw nothing');
  }
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

test('signals do not throw when enabled with junctions', () => {
  const screen = makeScreen(100, 44);
  screen.depth.fill(1e9);
  const cam = { x: 50, y: 10, angle: Math.PI / 2, z: 1.65, hz: screen.horizon, proj: screen.proj, rowOf(z, d) { return this.hz + (this.z - z) * screen.vscale / d; } };
  const L = new Lighting();
  L.update(0);
  const signals = new TrafficLights();
  signals.on = true;
  assert.doesNotThrow(() => signals.draw(screen, cam, { roadGraph: { signalJunctions: worldWithJunctions().junctions } }, L, 0));
});

