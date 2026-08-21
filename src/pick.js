import { T } from './world/source.js';

/**
 * What is at a given screen cell, for v2 (streets, buildings, sky).
 *
 * This is a depth-buffer readback, not a fresh ray cast. The renderer already
 * computed the exact distance of whatever it drew at every cell, so the answer
 * is already in memory: O(1), and pixel-exact by construction.
 */

const SKY_D = 1e8;

export function pick(screen, cam, world, col, row, skyMarks) {
  if (col < 0 || col >= screen.cols || row < 0 || row >= screen.rows) return null;
  const i = row * screen.cols + col;
  const d = screen.depth[i];

  // Nothing wrote depth there, so it is sky.
  if (d >= SKY_D) {
    const aim = unproject(screen, cam, col, row);
    const hit = skyMarks ? skyMarks.nearest(col, row) : null;
    return hit ? { kind: 'sky', object: hit, ...aim } : { kind: 'sky', object: null, ...aim };
  }

  // Reconstruct the world point from the stored distance. The depth the
  // renderer stored is the distance to the FACADE (the front wall), so the
  // point lands exactly on the cell boundary. Nudge it half a cell FORWARD
  // along the ray — into the surface the ray actually struck — so the floored
  // cell is the footprint cell that carries the building id, not the pavement
  // in front of it. Without this, floor() drops the point into the neighbouring
  // ground cell and every building click reads as "ground".
  const dw = d * cam.rinv[col];
  const wx = cam.x + cam.rc[col] * dw + cam.rc[col] * 0.5;
  const wy = cam.y + cam.rs[col] * dw + cam.rs[col] * 0.5;

  // A building glyph was drawn here, but the height field alone cannot name
  // the tower: many footprints share a height. OsmWorld stamps every building
  // cell with its id during rasterization, so the owner is one array read.
  const b = buildingAt(world, wx, wy);
  if (b) {
    return {
      kind: 'building',
      object: b,
      x: wx, y: wy, d,
      type: world.type[world.sample(wx, wy)],
      street: world.nearestStreet ? world.nearestStreet(wx, wy) : null,
    };
  }

  return {
    kind: 'ground',
    x: wx, y: wy, d,
    type: world.type[world.sample(wx, wy)],
    street: world.nearestStreet ? world.nearestStreet(wx, wy) : null,
  };
}

/**
 * Which building owns the world point (wx, wy), or null.
 *
 * O(1) and exact: OsmWorld writes the owning building id into `world.bid` for
 * every footprint cell at rasterization time, so the answer is a single array
 * read. A click can land on a cell just outside the footprint (the ray grazes
 * a wall and the depth resolves to a cell the fill never touched), in which
 * case we take the nearest orthogonal neighbour that is a building. That
 * recovers the right tower for the overwhelming majority of edge clicks
 * without a search, and only matters at silhouette boundaries anyway.
 *
 * Worlds without buildings (procedural, the flat StreetWorld fork) have no
 * `bid` array, so this returns null and the caller falls through to ground.
 */
export function buildingAt(world, wx, wy) {
  if (!world || !world.bid || !world.buildings) return null;
  const cx = Math.floor(wx);
  const cy = Math.floor(wy);
  if (cx < 0 || cy < 0 || cx >= world.width || cy >= world.height) return null;

  const id = world.bid[cy * world.width + cx];
  if (id) return world.buildings[id] || null;

  // Facade-boundary fallback: the clicked cell is just outside a footprint.
  let best = null;
  let bd = Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= world.width || ny >= world.height) continue;
      const nid = world.bid[ny * world.width + nx];
      if (!nid) continue;
      const dist = dx * dx + dy * dy;
      if (dist < bd) { bd = dist; best = world.buildings[nid] || null; }
    }
  }
  return best;
}

/**
 * Screen cell back to a horizon direction. The inverse of sky.js's project(),
 * so a click on empty sky still yields a real altitude and azimuth rather than
 * "nothing here".
 */
export function unproject(screen, cam, x, y) {
  const da = Math.atan2(-(x + 0.5 - screen.cols / 2), screen.proj);
  const az = ((90 - (cam.angle + da) * 180 / Math.PI) % 360 + 360) % 360;
  const alt = Math.atan2(cam.hz - y, screen.vscale) * 180 / Math.PI;
  return { az, alt };
}

const WINDS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
               'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** Compass point for a bearing in degrees. */
export function wind(deg) {
  return WINDS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

/** Bearing from the camera to a world point. World +y is north. */
export function bearingTo(cam, x, y) {
  const deg = Math.atan2(y - cam.y, x - cam.x) * 180 / Math.PI;
  return ((90 - deg) % 360 + 360) % 360;
}

export const GROUND_NAME = {
  [T.ROAD]: 'Road', [T.PATH]: 'Path', [T.SIDEWALK]: 'Footway',
  [T.PLAZA]: 'Ground', [T.YARD]: 'Yard', [T.FIELD]: 'Open ground',
  [T.FARM]: 'Farmland', [T.WATER]: 'Water', [T.TREE]: 'Tree',
  [T.FOREST]: 'Woodland', [T.VOID]: 'Beyond the map',
};

/**
 * Records which named sky object was drawn where, so the sky can be picked.
 * Reused across frames; nothing allocates per frame.
 */
export class SkyMarks {
  constructor() {
    this.n = 0;
    this.x = [];
    this.y = [];
    this.obj = [];
  }

  reset() { this.n = 0; }

  add(x, y, object) {
    this.x[this.n] = x;
    this.y[this.n] = y;
    this.obj[this.n] = object;
    this.n++;
  }

  /** Nearest recorded object within `r` cells of a click. */
  nearest(col, row, r = 3) {
    let best = null;
    let bd = (r + 1) * (r + 1);
    for (let i = 0; i < this.n; i++) {
      const dx = this.x[i] - col;
      const dy = this.y[i] - row;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = this.obj[i]; }
    }
    return best;
  }
}
