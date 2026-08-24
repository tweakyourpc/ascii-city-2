/**
 * Small uniform spatial hash for semantic world layers.
 *
 * The height-field renderer already performs spatial work through its DDA.
 * This index is for secondary layers such as roads, junctions, labels, and
 * props that otherwise scan every item on every frame. Values are opaque to
 * the index and may be object references or integer IDs.
 */
import { FOG_FULL } from './config.js';

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

  // Traffic signals: one point per signal junction, queried by the camera
  // envelope so the renderer need not scan every junction every frame.
  const signals = new SpatialHash(cellSize);
  const signalJunctions = world.roadGraph?.signalJunctions;
  if (signalJunctions) {
    for (let i = 0; i < signalJunctions.length; i++) {
      const jn = signalJunctions[i];
      signals.insert({ minX: jn.x, maxX: jn.x, minY: jn.y, maxY: jn.y }, jn);
    }
  }

  // Landmarks: named/tall buildings, indexed by footprint bounds so the label
  // layer can cull to the camera envelope instead of scanning every building.
  const landmarks = new SpatialHash(cellSize);
  if (world.landmarks && world.buildings) {
    for (let i = 0; i < world.landmarks.length; i++) {
      const b = world.buildings[world.landmarks[i]];
      if (!b) continue;
      const r = b.r || 0;
      landmarks.insert({
        minX: b.cx - r, maxX: b.cx + r, minY: b.cy - r, maxY: b.cy + r,
      }, b);
    }
  }

  world.spatial = { roads, junctions, anchors, signals, landmarks };
  return world.spatial;
}

/**
 * Build a spatial index of road-graph edges, keyed by each edge's segment
 * bounds. Used by traffic spawning to pick a nearby edge instead of scanning
 * every edge in the graph. Edges are plain records, so they are stored by
 * reference; callers must not mutate them. Returns null when there is no graph.
 */
export function buildEdgeIndex(graph, cellSize = 32) {
  if (!graph || !graph.edges) return null;
  const edges = new SpatialHash(cellSize);
  for (const edge of graph.edges) {
    const a = graph.nodes[edge.from];
    const b = graph.nodes[edge.to];
    if (!a || !b) continue;
    edges.insert({
      minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
      minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y),
    }, edge);
  }
  return edges;
}

/**
 * A single camera envelope shared by every semantic layer. Each layer used to
 * rebuild its own `{ minX, maxX, minY, maxY }` box from `cam` every frame; this
 * computes it once so roads, junctions, labels, signals, landmarks, and traffic
 * all draw candidates from the same query. `radius` defaults to the layer's
 * usual far cutoff; callers may pass a smaller radius for tighter culling.
 */
export function cameraEnvelope(cam, radius = FOG_FULL * 0.7) {
  return {
    minX: cam.x - radius, maxX: cam.x + radius,
    minY: cam.y - radius, maxY: cam.y + radius,
  };
}
