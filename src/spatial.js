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

const SEMANTIC_KINDS = ['roads', 'junctions', 'anchors', 'signals', 'landmarks'];

/**
 * One cell traversal for all static semantic layers used by a frame.
 *
 * Entries retain a category tag inside shared buckets. queryFrame walks the
 * camera envelope once, deduplicates per category, and returns the candidate
 * bundle consumed by each renderer. Exact projection/FOV/depth checks remain
 * the renderers' responsibility.
 */
export class SemanticIndex {
  constructor(cellSize = 32) {
    this.cellSize = Math.max(1, cellSize);
    this.cells = new Map();
  }

  _range(min, max) {
    return [Math.floor(min / this.cellSize), Math.floor(max / this.cellSize)];
  }

  _key(x, y) { return `${x},${y}`; }

  insert(kind, bounds, value) {
    if (!SEMANTIC_KINDS.includes(kind)) throw new Error(`Unknown semantic kind: ${kind}`);
    const [x0, x1] = this._range(bounds.minX, bounds.maxX);
    const [y0, y1] = this._range(bounds.minY, bounds.maxY);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const key = this._key(x, y);
        let bucket = this.cells.get(key);
        if (!bucket) { bucket = []; this.cells.set(key, bucket); }
        bucket.push({ kind, value });
      }
    }
    return this;
  }

  queryFrame(bounds) {
    const result = Object.fromEntries(SEMANTIC_KINDS.map((kind) => [kind, []]));
    const seen = Object.fromEntries(SEMANTIC_KINDS.map((kind) => [kind, new Set()]));
    const [x0, x1] = this._range(bounds.minX, bounds.maxX);
    const [y0, y1] = this._range(bounds.minY, bounds.maxY);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const bucket = this.cells.get(this._key(x, y));
        if (!bucket) continue;
        for (const { kind, value } of bucket) {
          if (seen[kind].has(value)) continue;
          seen[kind].add(value);
          result[kind].push(value);
        }
      }
    }
    return { envelope: bounds, ...result };
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
  const index = new SemanticIndex(cellSize);
  for (const road of world.roads || []) {
    if (road.pts?.length) index.insert('roads', boundsOfPoints(road.pts), road);
  }

  for (let i = 0; i < (world.junctions || []).length; i++) {
    const junction = world.junctions[i];
    junction._spatialIndex = i;
    index.insert('junctions', {
      minX: junction.x, maxX: junction.x,
      minY: junction.y, maxY: junction.y,
    }, junction);
  }

  const A = world.anchor;
  if (A) {
    for (let i = 0; i < A.n; i++) {
      index.insert('anchors', {
        minX: A.x[i], maxX: A.x[i], minY: A.y[i], maxY: A.y[i],
      }, i);
    }
  }

  // Traffic signals: one point per signal junction, queried by the camera
  // envelope so the renderer need not scan every junction every frame.
  const signalJunctions = world.roadGraph?.signalJunctions;
  if (signalJunctions) {
    for (let i = 0; i < signalJunctions.length; i++) {
      const jn = signalJunctions[i];
      index.insert('signals', {
        minX: jn.x, maxX: jn.x, minY: jn.y, maxY: jn.y,
      }, jn);
    }
  }

  // Landmarks: named/tall buildings, indexed by footprint bounds so the label
  // layer can cull to the camera envelope instead of scanning every building.
  if (world.landmarks && world.buildings) {
    for (let i = 0; i < world.landmarks.length; i++) {
      const b = world.buildings[world.landmarks[i]];
      if (!b) continue;
      const r = b.r || 0;
      index.insert('landmarks', {
        minX: b.cx - r, maxX: b.cx + r, minY: b.cy - r, maxY: b.cy + r,
      }, b);
    }
  }

  world.spatial = index;
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

/** Build the shared semantic candidate bundle used by one rendered frame. */
export function querySemanticFrame(world, cam, radius = FOG_FULL * 0.7) {
  const envelope = cameraEnvelope(cam, radius);
  if (world.spatial?.queryFrame) return world.spatial.queryFrame(envelope);
  const A = world.anchor;
  return {
    envelope,
    roads: world.roads || [],
    junctions: world.junctions || [],
    anchors: A ? Array.from({ length: A.n }, (_, i) => i) : [],
    signals: world.roadGraph?.signalJunctions || [],
    landmarks: (world.landmarks || []).map((i) => world.buildings?.[i]).filter(Boolean),
  };
}

/** Read one category from a shared frame bundle or from an ad-hoc envelope. */
export function semanticCandidates(world, semanticOrBounds, kind, cam, radius) {
  if (semanticOrBounds?.envelope && Array.isArray(semanticOrBounds[kind])) {
    return semanticOrBounds[kind];
  }
  const bounds = semanticOrBounds || cameraEnvelope(cam, radius);
  if (world.spatial?.queryFrame) return world.spatial.queryFrame(bounds)[kind];
  if (kind === 'anchors') {
    const n = world.anchor?.n || 0;
    return Array.from({ length: n }, (_, i) => i);
  }
  if (kind === 'signals') return world.roadGraph?.signalJunctions || [];
  if (kind === 'landmarks') {
    return (world.landmarks || []).map((i) => world.buildings?.[i]).filter(Boolean);
  }
  return world[kind] || [];
}
