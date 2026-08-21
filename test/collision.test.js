/**
 * Collision: the camera must not pass through buildings, and must not sink
 * below the surface (ground or roof). These tests drive the real
 * `collision.js` helpers against a real ProceduralWorld, mirroring the way
 * `main.js` calls them from its movement block.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ProceduralWorld } from '../src/world/procedural.js';
import { T } from '../src/world/source.js';
import { EYE_HEIGHT, MOVE_CLEAR, WADE_Z } from '../src/config.js';
import { canMoveTo, floorAt, wetAt, settle } from '../src/collision.js';

// A tiny world we fully control, so we can place a known building and water.
function tinyWorld() {
  const W = 16, H = 16;
  const w = new ProceduralWorld();
  // Overwrite the height/type fields with a flat, empty field of size W x H.
  w.width = W; w.height = H; w.size = 0;
  const n = W * H;
  w.h = new Float32Array(n + 1);
  w.type = new Uint8Array(n + 1);
  w.voidSlot = n;
  w.h[n] = 0; w.type[n] = T.VOID;
  for (let i = 0; i < n; i++) { w.h[i] = 0; w.type[i] = T.FIELD; }
  w.sample = (cx, cy) => {
    const x = Math.floor(cx), y = Math.floor(cy);
    if (x < 0 || x >= W || y < 0 || y >= H) return w.voidSlot;
    return y * W + x;
  };
  return w;
}

test('canMoveTo blocks entry into a building at ground level', () => {
  const w = tinyWorld();
  // A 2x2 tower of height 8 at cells (5,5)..(6,6).
  for (let y = 5; y <= 6; y++) for (let x = 5; x <= 6; x++) {
    w.h[w.sample(x, y)] = 8;
    w.type[w.sample(x, y)] = T.TOWER;
  }
  // Standing on the ground next to the tower: open ground is fine.
  assert.equal(canMoveTo(w, 2, 2, EYE_HEIGHT), true);
  // Inside the tower footprint at eye height: blocked (below the roof).
  assert.equal(canMoveTo(w, 5.5, 5.5, EYE_HEIGHT), false);
  // Climbing just above the roof + clearance: now passable.
  assert.equal(canMoveTo(w, 5.5, 5.5, 8 + MOVE_CLEAR + 0.1), true);
});

test('canMoveTo blocks water while low, allows it when flying over', () => {
  const w = tinyWorld();
  for (let y = 5; y <= 6; y++) for (let x = 5; x <= 6; x++) {
    w.type[w.sample(x, y)] = T.WATER;
  }
  // Wading height: blocked.
  assert.equal(canMoveTo(w, 5.5, 5.5, 1.0), false);
  // Above WADE_Z: allowed to fly over the water.
  assert.equal(canMoveTo(w, 5.5, 5.5, WADE_Z + 1), true);
});

test('settle lifts the eye to stand on a roof, not through it', () => {
  const w = tinyWorld();
  for (let y = 5; y <= 6; y++) for (let x = 5; x <= 6; x++) {
    w.h[w.sample(x, y)] = 8;
    w.type[w.sample(x, y)] = T.TOWER;
  }
  const cam = { x: 5.5, y: 5.5, z: 0.2, vz: -3 };
  settle(w, cam);
  // Eye must rest at roof height + eye height, and downward velocity killed.
  assert.ok(Math.abs(cam.z - (8 + EYE_HEIGHT)) < 1e-6, `z=${cam.z}`);
  assert.equal(cam.vz, 0);
});

test('settle keeps you above ground on open field', () => {
  const w = tinyWorld();
  const cam = { x: 2, y: 2, z: 0.1, vz: -1 };
  settle(w, cam);
  assert.ok(Math.abs(cam.z - EYE_HEIGHT) < 1e-6, `z=${cam.z}`);
  assert.equal(cam.vz, 0);
});

test('floorAt returns the tallest roof under the body box', () => {
  const w = tinyWorld();
  // Body box (radius BODY_R) at (5.9, 5.9) straddles cells (5,5),(6,5),(5,6),
  // (6,6); the tallest corner cell is (6,5) at height 9.
  w.h[w.sample(5, 5)] = 4;
  w.h[w.sample(6, 5)] = 9;   // tallest corner
  w.h[w.sample(5, 6)] = 2;
  w.h[w.sample(6, 6)] = 3;
  assert.equal(floorAt(w, 5.9, 5.9), 9);
});

test('wetAt is true when any body-box corner is over water', () => {
  const w = tinyWorld();
  w.type[w.sample(5, 5)] = T.WATER;
  assert.equal(wetAt(w, 5.5, 5.5), true);
  assert.equal(wetAt(w, 2, 2), false);
});

test('per-axis movement slides along a wall instead of sticking', () => {
  const w = tinyWorld();
  // A wall of towers along column x=8, so moving diagonally into it should
  // let the free axis advance while the blocked axis stays put.
  for (let y = 0; y < w.height; y++) {
    w.h[w.sample(8, y)] = 6;
    w.type[w.sample(8, y)] = T.TOWER;
  }
  const cam = { x: 7.6, y: 7.0, z: EYE_HEIGHT };
  const mx = 0.5, my = 0.5;   // diagonal step toward the wall
  // X axis is blocked by the wall at x=8 (body box reaches it); Y axis is open.
  if (canMoveTo(w, cam.x + mx, cam.y, cam.z)) cam.x += mx;
  if (canMoveTo(w, cam.x, cam.y + my, cam.z)) cam.y += my;
  assert.ok(Math.abs(cam.x - 7.6) < 1e-9, `x should not advance into wall, got ${cam.x}`);
  assert.ok(Math.abs(cam.y - 7.5) < 1e-9, `y should slide freely, got ${cam.y}`);
});
