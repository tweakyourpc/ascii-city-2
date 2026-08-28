import assert from 'node:assert/strict';
import test from 'node:test';

import { Camera } from '../src/camera.js';
import { Lighting } from '../src/render/materials.js';
import {
  drawVehicle, smoothVehicleHeading, vehicleLod, vehicleProfile, VEHICLE_LOD,
} from '../src/render/vehicles.js';
import { makeScreen, MODE } from './support/screen.js';

function scene(mode = MODE.GLYPH, sunAlt = 45) {
  const screen = makeScreen(100, 46, mode);
  const cam = new Camera();
  cam.x = 0; cam.y = 0; cam.z = 1.65; cam.angle = 0; cam.pitch = 0;
  cam.hz = screen.horizon;
  cam.buildRays(screen);
  const light = new Lighting();
  light.update(sunAlt);
  screen.clear();
  return { screen, cam, light };
}

function colours(screen) {
  return new Set(screen.colour.filter((_, i) => screen.kind[i] === 1));
}

function rgb(value) {
  const match = /rgb\((\d+),(\d+),(\d+)\)/.exec(value || '');
  return match ? match.slice(1).map(Number) : [0, 0, 0];
}

test('vehicle profiles are stable and visibly varied by seed', () => {
  assert.deepEqual(vehicleProfile(1234), vehicleProfile(1234));
  const profiles = [1, 2, 3, 4, 5, 6, 7, 8].map(vehicleProfile);
  assert.ok(new Set(profiles.map((profile) => profile.kind)).size >= 3);
  assert.ok(new Set(profiles.map((profile) => profile.paint.join(','))).size >= 4);
});

test('vehicle LOD degrades by projected size and distance', () => {
  assert.equal(vehicleLod(8, 10), VEHICLE_LOD.NEAR);
  assert.equal(vehicleLod(2.5, 35), VEHICLE_LOD.MID);
  assert.equal(vehicleLod(0.7, 90), VEHICLE_LOD.FAR);
  assert.equal(vehicleLod(5, 35, 2), VEHICLE_LOD.MID,
    'block-mode internal rows must normalize to text-line height');
});

test('near glyph vehicles contain body, roof, cabin, wheels, and lights', () => {
  const { screen, cam, light } = scene();
  const car = {
    kind: 'car', x: 8, y: 0, hx: -1, hy: 0, vehicle: vehicleProfile(42),
  };
  const result = drawVehicle(screen, cam, light, car, { distance: 8 });
  const glyphs = screen.glyph.filter((glyph, i) => screen.kind[i] === 1 && glyph).join('');
  assert.equal(result.lod, VEHICLE_LOD.NEAR);
  assert.ok(result.cells >= 12, `expected structured geometry, got ${result.cells} cells`);
  assert.match(glyphs, /[@#%=]/, 'body faces should be directional surface glyphs');
  assert.match(glyphs, /[:^]/, 'cabin windows or roof should remain distinct');
  assert.match(glyphs, /[o*]/, 'wheels or directional lamps should be present');
  assert.ok(colours(screen).size >= 4, 'faces, windows, lights, and shadow need distinct shading');
});

test('block vehicles share geometry but use clean colour silhouettes', () => {
  const { screen, cam, light } = scene(MODE.BLOCK);
  const car = {
    kind: 'car', x: 8, y: 1, hx: -1, hy: 0, vehicle: vehicleProfile(99),
  };
  const result = drawVehicle(screen, cam, light, car, { distance: 8 });
  assert.equal(result.lod, VEHICLE_LOD.NEAR);
  assert.ok(result.cells >= 18);
  assert.ok(colours(screen).size >= 4);
  assert.ok(screen.kind.some((kind) => kind === 1));
});

test('night lamps distinguish approaching fronts from receding rears', () => {
  const frontScene = scene(MODE.GLYPH, -18);
  drawVehicle(frontScene.screen, frontScene.cam, frontScene.light, {
    kind: 'car', x: 9, y: 0, hx: -1, hy: 0, vehicle: vehicleProfile(11),
  }, { distance: 9 });
  const frontColours = [...colours(frontScene.screen)].map(rgb);
  assert.ok(frontColours.some(([r, g, b]) => r > 200 && g > 180 && b > 170),
    'approaching headlights should remain warm-white');

  const rearScene = scene(MODE.GLYPH, -18);
  drawVehicle(rearScene.screen, rearScene.cam, rearScene.light, {
    kind: 'car', x: 9, y: 0, hx: 1, hy: 0, braking: true, vehicle: vehicleProfile(11),
  }, { distance: 9 });
  const rearColours = [...colours(rearScene.screen)].map(rgb);
  assert.ok(rearColours.some(([r, g, b]) => r > 200 && g < 120 && b < 100),
    'receding brake lights should remain red');
});

test('vehicle geometry obeys the existing scene depth buffer', () => {
  const { screen, cam, light } = scene();
  screen.depth.fill(2);
  const result = drawVehicle(screen, cam, light, {
    kind: 'car', x: 8, y: 0, hx: -1, hy: 0, vehicle: vehicleProfile(5),
  }, { distance: 8 });
  assert.equal(result.cells, 0);
  assert.ok(screen.kind.every((kind) => kind === 0),
    'a foreground building depth must fully obscure the vehicle');
});

test('heading smoothing turns without snapping or losing unit length', () => {
  const car = { hx: 1, hy: 0 };
  smoothVehicleHeading(car, 0, 1, 0.05);
  assert.ok(car.hx > 0 && car.hy > 0, 'the first turn step should be intermediate');
  assert.ok(Math.abs(Math.hypot(car.hx, car.hy) - 1) < 1e-9);
});
