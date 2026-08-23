/**
 * Small uniform spatial hash for semantic world layers.
 *
 * The height-field renderer already performs spatial work through its DDA.
 * This index is for secondary layers such as roads, junctions, labels, and
 * props that otherwise scan every item on every frame. Values are opaque to
 * the index and may be object references or integer IDs.
 */
export class SpatialHash {
  constructor(cellSize = 32) {
    this.cellSize = Math.max(1, cellSize);
    this.cells = new Map();
  }

  clear() { this.cells.clear(); }

  _range(min, max) {
    return [Math.floor(min / this.cellSize), Math.floor(max / this.cellSize)];
  }

  _key(x, y) { return `${x},${y}`; }

  insert(bounds, value) {
    const [x0, x1] = this._range(bounds.minX, bounds.maxX);
    const [y0, y1] = this._range(bounds.minY, bounds.maxY);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const key = this._key(x, y);
        let bucket = this.cells.get(key);
        if (!bucket) { bucket = []; this.cells.set(key, bucket); }
        bucket.push(value);
      }
    }
    return this;
  }

  query(bounds) {
    const [x0, x1] = this._range(bounds.minX, bounds.maxX);
    const [y0, y1] = this._range(bounds.minY, bounds.maxY);
    const out = [];
    const seen = new Set();
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const bucket = this.cells.get(this._key(x, y));
        if (!bucket) continue;
        for (const value of bucket) {
          if (seen.has(value)) continue;
          seen.add(value);
          out.push(value);
        }
      }
    }
    return out;
  }
}

export function boundsOfPoints(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  return { minX, minY, maxX, maxY };
}

export function buildSemanticIndex(world, cellSize = 32) {
  const roads = new SpatialHash(cellSize);
  for (const road of world.roads || []) {
    if (road.pts?.length) roads.insert(boundsOfPoints(road.pts), road);
  }

  const junctions = new SpatialHash(cellSize);
  for (let i = 0; i < (world.junctions || []).length; i++) {
    const junction = world.junctions[i];
    junction._spatialIndex = i;
    junctions.insert({
      minX: junction.x, maxX: junction.x,
      minY: junction.y, maxY: junction.y,
    }, junction);
  }

  const anchors = new SpatialHash(cellSize);
  const A = world.anchor;
  if (A) {
    for (let i = 0; i < A.n; i++) {
      anchors.insert({ minX: A.x[i], maxX: A.x[i], minY: A.y[i], maxY: A.y[i] }, i);
    }
  }
  world.spatial = { roads, junctions, anchors };
  return world.spatial;
}
