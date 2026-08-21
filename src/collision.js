import { T } from './world/source.js';
import { BODY_R, MOVE_CLEAR, EYE_HEIGHT, WADE_Z } from './config.js';

/**
 * Collision against the height field.
 *
 * Movement is no longer a yes/no test against "is this cell solid", because the
 * camera can fly. It is a clearance test: you may enter a cell if you are above
 * whatever stands in it.
 */

/** Tallest roof under the body box at (x, y). */
export function floorAt(world, x, y) {
  const r = BODY_R;
  const h = world.h;
  return Math.max(
    h[world.sample(x - r, y - r)],
    h[world.sample(x + r, y - r)],
    h[world.sample(x - r, y + r)],
    h[world.sample(x + r, y + r)],
  );
}

/** True if any corner of the body box is over water. */
export function wetAt(world, x, y) {
  const r = BODY_R;
  const type = world.type;
  return type[world.sample(x - r, y - r)] === T.WATER
      || type[world.sample(x + r, y - r)] === T.WATER
      || type[world.sample(x - r, y + r)] === T.WATER
      || type[world.sample(x + r, y + r)] === T.WATER;
}

/**
 * May the camera occupy (x, y) at height z?
 *
 * At z = EYE_HEIGHT over open ground this reproduces the original walk
 * behaviour exactly. Over a house it blocks until you have climbed past the
 * roof, and water blocks only while you are low enough to be wading.
 */
export function canMoveTo(world, x, y, z) {
  if (z < floorAt(world, x, y) + MOVE_CLEAR) return false;
  if (z < WADE_Z && wetAt(world, x, y)) return false;
  return true;
}

/**
 * Keep the camera above whatever it is standing on. Landing on a roof of
 * height h puts the eye at h + EYE_HEIGHT, so you can walk around up there.
 */
export function settle(world, cam) {
  const ground = wetAt(world, cam.x, cam.y)
    ? Math.max(floorAt(world, cam.x, cam.y), 0.9)
    : floorAt(world, cam.x, cam.y);
  const minZ = ground + EYE_HEIGHT;
  if (cam.z < minZ) {
    cam.z = minZ;
    if (cam.vz < 0) cam.vz = 0;
  }
}
