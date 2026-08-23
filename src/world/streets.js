import { T, F, hash } from './source.js';
import { METERS_PER_CELL } from '../config.js';
import { buildRoadGraph } from './roadgraph.js';
import { buildSemanticIndex } from '../spatial.js';

/**
 * ASCII City v2: the street network, and nothing else.
 *
 * v1 rasterized buildings into a height field and raycast it. v2 throws the
 * height field away: the world is flat (h = 0 everywhere) and the renderer
 * draws the road network as projected polylines. So this module keeps only the
 * parts of v1's OSM ingestion that the streets need:
 *
 *   - the projection (north at +y, sub-cell accurate)
 *   - the road stroking (so `type`/`roadCells` still exist for ground + picking)
 *   - the named-road anchors and the junction detection that v1 already did
 *
 * and adds two things the renderer consumes directly:
 *
 *   - `roads`: the raw projected polylines, kept (v1 discarded them)
 *   - `junctions`: every place two or more named streets meet, with the set of
 *     street names that cross there. That is the data a real street sign shows.
 *
 * Orientation matters and is not arbitrary. The engine's sky code treats world
 * +y as north (a camera angle of pi/2 looks at azimuth 0), so cell y must
 * increase with latitude. Get this backwards and the sun rises in the west.
 */

/* ------------------------------ projection ------------------------------ */

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320;

/** Equirectangular about the box centre. Sub-cell accurate at city scale. */
export function makeProjection([s, w, n, e]) {
  const lat0 = (s + n) / 2;
  const lon0 = (w + e) / 2;
  const mPerLon = M_PER_DEG_LON * Math.cos(lat0 * Math.PI / 180);

  const halfW = Math.abs(e - w) / 2 * mPerLon / METERS_PER_CELL;
  const halfH = Math.abs(n - s) / 2 * M_PER_DEG_LAT / METERS_PER_CELL;

  const width = Math.max(16, Math.ceil(halfW * 2));
  const height = Math.max(16, Math.ceil(halfH * 2));

  return {
    lat0,
    lon0,
    width,
    height,
    x: (lon) => (lon - lon0) * mPerLon / METERS_PER_CELL + width / 2,
    // +y is north
    y: (lat) => (lat - lat0) * M_PER_DEG_LAT / METERS_PER_CELL + height / 2,
  };
}

/* -------------------------------- tags --------------------------------- */

/** Road width in metres, by highway class. */
const ROAD_W = {
  motorway: 20, trunk: 18, primary: 16, secondary: 13, tertiary: 11,
  residential: 9, unclassified: 9, living_street: 8, service: 5,
  pedestrian: 6, footway: 3, path: 3, cycleway: 3, steps: 3, track: 4,
};

const FOOT_LIKE = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway']);

/**
 * How much a road class deserves a label. Arterials win ties, because on a
 * screen with room for a few names you want the ones people navigate by.
 */
const NAMED_RANK = {
  motorway: 4, trunk: 4, primary: 3, secondary: 3, tertiary: 2,
  residential: 1, unclassified: 1, living_street: 1, pedestrian: 1,
};

/* ------------------------------ the world ------------------------------- */

export class StreetWorld {
  /**
   * @param {number[]} bbox [south, west, north, east]
   * @param {Array} elements Overpass elements with inline geometry
   */
  constructor(bbox, elements, label = 'OpenStreetMap') {
    this.bbox = bbox;
    this.label = label;
    this.name = label;

    const proj = makeProjection(bbox);
    this.proj = proj;
    this.width = proj.width;
    this.height = proj.height;
    this.lat = proj.lat0;
    this.lon = proj.lon0;

    this.size = 0;                 // bounded: the camera does not wrap
    this.maxHeight = 0;            // flat world

    // One extra slot past the grid, returned for anything out of bounds.
    const n = this.width * this.height;
    this.voidSlot = n;
    this.h = new Float32Array(n + 1);          // all zero: no buildings
    this.type = new Uint8Array(n + 1);
    this.rnd = new Float32Array(n + 1);
    this.lamp = new Float32Array(n + 1);
    this.pal = new Uint8Array(n + 1);
    this.flags = new Uint8Array(n + 1);

    this.roadCells = [];
    this.stats = { roads: 0, named: 0, junctions: 0, skipped: 0 };

    /* --- identification tables, all populated during rasterization --- */
    this.streetNames = [];
    this.streetTags = [];
    this.streetRank = [];           // highest road class seen for each name
    this.segs = null;               // named-road segments, for nearestStreet
    this.anchor = null;             // typed arrays, built at the end
    this.junctions = [];            // [{x, y, names:[nameId,...]}]
    this.roads = [];                // raw projected polylines for the renderer
    this.signalNodeIds = new Set();
    this.signalPoints = [];
    this.roadGraph = null;
    this._nameIds = new Map();
    this._anchors = [];             // temporary, discarded after packing
    this._segs = [];                // temporary, packed into this.segs
    this._vertexNames = new Map();  // rounded vertex -> Set of name ids

    this._rasterize(elements);
  }

  /* --- WorldSource contract --- */

  sample(cx, cy) {
    const x = Math.floor(cx);
    const y = Math.floor(cy);
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return this.voidSlot;
    return y * this.width + x;
  }

  ready() { return Promise.resolve(this); }

  maxHeightAt() { return 0; }

  dispose() { this.roadCells.length = 0; }

  /** Traffic needs somewhere to put a car; v2 has none, but keep the flag. */
  get hasStreets() { return this.roadCells.length > 0; }

  randomRoadCell() {
    if (this.roadCells.length === 0) return null;
    const p = this.roadCells[(Math.random() * this.roadCells.length) | 0];
    return { x: (p % this.width) + 0.5, y: Math.floor(p / this.width) + 0.5 };
  }

  /** Nearest road cell to the middle of the extract. */
  spawn() {
    const cx = this.width / 2;
    const cy = this.height / 2;
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < this.roadCells.length; i++) {
      const p = this.roadCells[i];
      const x = p % this.width;
      const y = (p / this.width) | 0;
      const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (d < bestD) { bestD = d; best = { x: x + 0.5, y: y + 0.5 }; }
    }
    return best
      ? { ...best, angle: Math.PI / 2 }
      : { x: cx, y: cy, angle: Math.PI / 2 };
  }

  /* ------------------------------ raster ------------------------------ */

  _set(x, y, type, flagBits = 0) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const s = y * this.width + x;
    this.type[s] = type;
    this.rnd[s] = hash(x, y, 0x5eed);
    this.flags[s] = flagBits;
  }

  _rasterize(elements) {
    const roads = [];

    for (const el of elements) {
      const tags = el.tags || {};
      if (el.type === 'node' && tags.highway === 'traffic_signals' &&
          el.lat !== undefined && el.lon !== undefined) {
        this.signalNodeIds.add(el.id);
        this.signalPoints.push({ x: this.proj.x(el.lon), y: this.proj.y(el.lat) });
      } else if (tags.highway) roads.push(el);
      else this.stats.skipped++;
    }

    // Default ground. Neutral paving, not grass: v2 is about streets.
    this.type.fill(T.PLAZA);
    for (let i = 0; i < this.width * this.height; i++) {
      this.rnd[i] = hash(i % this.width, (i / this.width) | 0, 0x5eed);
    }
    this.type[this.voidSlot] = T.VOID;

    for (const el of roads) this._strokeRoad(el);

    // Collect road cells after stroking.
    for (let s = 0; s < this.width * this.height; s++) {
      if (this.type[s] === T.ROAD || this.type[s] === T.SIDEWALK ||
          this.type[s] === T.PATH) {
        this.roadCells.push(s);
      }
    }

    this._finishAnchors();
    this.roadGraph = buildRoadGraph(this.roads, {
      signalNodeIds: this.signalNodeIds,
      signalPoints: this.signalPoints,
    });
    this.junctions = this.roadGraph.junctions;
    this.stats.junctions = this.junctions.length;
    this.stats.signals = this.roadGraph.signalJunctions.length;
    buildSemanticIndex(this);
  }

  _strokeRoad(el) {
    if (!el.geometry || el.geometry.length < 2) return;
    const kind = el.tags?.highway;
    const metres = ROAD_W[kind] ?? 8;
    const w = metres / METERS_PER_CELL;
    const foot = FOOT_LIKE.has(kind);
    const type = foot ? T.SIDEWALK : T.ROAD;
    const pts = el.geometry.map((p) => [this.proj.x(p.lon), this.proj.y(p.lat)]);

    // Keep the raw polyline for the line renderer. Unnamed ways get nameId -1.
    const name = el.tags?.name;
    let nameId = -1;
    if (name) {
      nameId = this._nameIds.get(name);
      if (nameId === undefined) {
        nameId = this.streetNames.length;
        this.streetNames.push(name);
        this.streetTags.push(el.tags);
        this.streetRank.push(NAMED_RANK[kind] ?? 0);
        this._nameIds.set(name, nameId);
        this.stats.named++;
      } else if ((NAMED_RANK[kind] ?? 0) > this.streetRank[nameId]) {
        this.streetRank[nameId] = NAMED_RANK[kind] ?? 0;
      }
    }

    this.roads.push({
      pts, cls: kind, nameId, rank: NAMED_RANK[kind] ?? 0,
      tags: el.tags || {}, nodeIds: el.nodes || [],
    });

    strokePath(pts, w, this.width, this.height, (x, y, distToCentre, along) => {
      // A dashed centre line on the wider carriageways only.
      const stripe = !foot && metres >= 9 && distToCentre < 0.6 &&
                     (Math.floor(along) % 5) < 2;
      this._set(x, y, type, stripe ? F.STRIPE : 0);
    });

    // Label anchors and junction vertices come from the polyline, deliberately
    // NOT from the callback above: that one touches every cell of every road
    // and has to stay hot.
    if (name) this._roadAnchors(pts, nameId, NAMED_RANK[kind] ?? 0);

    this.stats.roads++;
  }

  /**
   * Emit label anchors along a named way, at a spacing set by its class, and
   * record its vertices so intersections can be found afterwards.
   */
  _roadAnchors(pts, nameId, rank) {
    // Bucket points along the whole centreline at half-cell resolution. Two
    // different names sharing a bucket is a junction, which is where a street
    // sign would actually be. We sample along segments (not just the polyline
    // vertices) because in hand-built and simplified data two roads can cross
    // in the middle of their segments without sharing a node.
    const STEP = 0.5;
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i - 1][0], ay = pts[i - 1][1];
      const bx = pts[i][0], by = pts[i][1];
      const len = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.ceil(len / STEP));
      for (let s = 0; s <= n; s++) {
        const t = s / n;
        const x = ax + (bx - ax) * t;
        const y = ay + (by - ay) * t;
        const k = ((x * 2) | 0) * 65536 + ((y * 2) | 0);
        let set = this._vertexNames.get(k);
        if (!set) this._vertexNames.set(k, (set = new Set()));
        set.add(nameId);
      }
    }

    // Keep the segments themselves. Anchors are spaced tens of cells apart, so
    // "which street am I on" answered from the nearest anchor can name a
    // parallel street; answered from the centreline it cannot.
    for (let i = 1; i < pts.length; i++) {
      this._segs.push({
        x1: pts[i - 1][0], y1: pts[i - 1][1],
        x2: pts[i][0], y2: pts[i][1], name: nameId,
      });
    }

    const seg = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const len = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      seg.push(len);
      total += len;
    }
    if (total < 4) return;     // stubs and clipped fragments get nothing

    const spacing = rank >= 3 ? 34 : rank === 2 ? 26 : 20;
    const n = Math.max(1, Math.round(total / spacing));

    for (let k = 0; k < n; k++) {
      const want = (k + 0.5) / n * total;
      let acc = 0;
      for (let i = 0; i < seg.length; i++) {
        if (acc + seg[i] >= want) {
          const t = seg[i] > 1e-9 ? (want - acc) / seg[i] : 0;
          const ax = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t;
          const ay = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
          const sx = pts[i + 1][0] - pts[i][0];
          const sy = pts[i + 1][1] - pts[i][1];
          const sl = Math.hypot(sx, sy) || 1;
          this._anchors.push({
            x: ax, y: ay, name: nameId, rank, junction: 0,
            dx: sx / sl, dy: sy / sl,
          });
          break;
        }
        acc += seg[i];
      }
    }
  }

  /**
   * Flag anchors near a junction, then pack everything into typed arrays.
   * Runs once at load; the per-frame pass only reads the packed form.
   */
  _finishAnchors() {
    const junctions = [];
    for (const [k, set] of this._vertexNames) {
      if (set.size < 2) continue;
      const jx = Math.floor(k / 65536) / 2;
      const jy = (k % 65536) / 2;
      junctions.push([jx, jy, [...set]]);

      // Emit an anchor at the crossing itself, for every street meeting here.
      for (const nameId of set) {
        this._anchors.push({
          x: jx, y: jy, name: nameId,
          rank: this.streetRank[nameId] ?? 0, junction: 1,
          dx: 0, dy: 0,
        });
      }
    }

    // Expose the junctions for the sign renderer.
    this.junctions = junctions.map(([jx, jy, names]) => ({ x: jx, y: jy, names }));
    this.stats.junctions = this.junctions.length;

    const R2 = 9;   // within 3 cells
    for (const a of this._anchors) {
      if (a.junction) continue;
      for (let j = 0; j < junctions.length; j++) {
        const dx = a.x - junctions[j][0];
        const dy = a.y - junctions[j][1];
        if (dx * dx + dy * dy <= R2) { a.junction = 1; break; }
      }
    }

    // Junction anchors inherit the tangent of the nearest anchor of the same
    // street that has one.
    for (const a of this._anchors) {
      if (a.dx || a.dy) continue;
      let bd = Infinity;
      for (const b of this._anchors) {
        if (b.name !== a.name || (!b.dx && !b.dy)) continue;
        const d = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
        if (d < bd) { bd = d; a.dx = b.dx; a.dy = b.dy; }
      }
      if (!a.dx && !a.dy) a.dx = 1;
    }

    const n = this._anchors.length;
    const A = {
      n,
      x: new Float32Array(n),
      y: new Float32Array(n),
      dx: new Float32Array(n),
      dy: new Float32Array(n),
      name: new Uint16Array(n),
      rank: new Uint8Array(n),
      junction: new Uint8Array(n),
    };
    for (let i = 0; i < n; i++) {
      const a = this._anchors[i];
      A.x[i] = a.x; A.y[i] = a.y;
      A.dx[i] = a.dx; A.dy[i] = a.dy;
      A.name[i] = a.name; A.rank[i] = a.rank; A.junction[i] = a.junction;
    }
    this.anchor = A;

    const m = this._segs.length;
    this.segs = {
      n: m,
      x1: new Float32Array(m), y1: new Float32Array(m),
      x2: new Float32Array(m), y2: new Float32Array(m),
      name: new Uint16Array(m),
    };
    for (let i = 0; i < m; i++) {
      const g = this._segs[i];
      this.segs.x1[i] = g.x1; this.segs.y1[i] = g.y1;
      this.segs.x2[i] = g.x2; this.segs.y2[i] = g.y2;
      this.segs.name[i] = g.name;
    }

    this._anchors = null;
    this._segs = null;
    this._vertexNames = null;
    this._nameIds = null;
  }

  /** Squared distance from a point to segment i of the named-road set. */
  _segDist2(i, x, y) {
    const S = this.segs;
    const vx = S.x2[i] - S.x1[i];
    const vy = S.y2[i] - S.y1[i];
    const px = x - S.x1[i];
    const py = y - S.y1[i];
    const len2 = vx * vx + vy * vy;
    let t = len2 > 1e-12 ? (px * vx + py * vy) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const dx = px - vx * t;
    const dy = py - vy * t;
    return dx * dx + dy * dy;
  }

  /**
   * Which named street a point is on, and the nearest different one.
   * Measured against road centrelines, so it is correct even standing between
   * two anchors.
   */
  nearestStreet(x, y) {
    const S = this.segs;
    if (!S || S.n === 0) return null;

    let on = -1;
    let bd = Infinity;
    for (let i = 0; i < S.n; i++) {
      const d = this._segDist2(i, x, y);
      if (d < bd) { bd = d; on = S.name[i]; }
    }
    if (on < 0) return null;

    let cross = -1;
    let cd = Infinity;
    for (let i = 0; i < S.n; i++) {
      if (S.name[i] === on) continue;
      const d = this._segDist2(i, x, y);
      if (d < cd) { cd = d; cross = S.name[i]; }
    }
    return {
      on: this.streetNames[on],
      onDist: Math.sqrt(bd),
      cross: cross >= 0 ? this.streetNames[cross] : null,
      crossDist: cross >= 0 ? Math.sqrt(cd) : Infinity,
    };
  }
}

/* ---------------------------- raster helpers ---------------------------- */

/**
 * Stamp a polyline of a given width. `plot` receives the perpendicular
 * distance to the centre line and the distance travelled along it, so callers
 * can draw kerbs and centre markings.
 */
export function strokePath(pts, width, gridW, gridH, plot) {
  const r = Math.max(0.5, width / 2);
  let along = 0;

  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy;
    const len = Math.sqrt(len2);
    if (len < 1e-9) continue;

    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r));
    const x1 = Math.min(gridW - 1, Math.ceil(Math.max(ax, bx) + r));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r));
    const y1 = Math.min(gridH - 1, Math.ceil(Math.max(ay, by) + r));

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5 - ax;
        const py = y + 0.5 - ay;
        let t = (px * vx + py * vy) / len2;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const dx = px - vx * t;
        const dy = py - vy * t;
        const d = Math.hypot(dx, dy);
        if (d <= r) plot(x, y, d, along + t * len);
      }
    }
    along += len;
  }
}

/* --------------------------- procedural fallback --------------------------- */

/**
 * A clean grid of named streets, used when Overpass is unreachable.
 *
 * No buildings, no noise: just a regular lattice of avenues and streets, every
 * crossing a junction, every road named. It implements the same interface the
 * renderer and HUD expect, so the rest of the app cannot tell it apart from a
 * real import.
 */
export class ProceduralStreets {
  constructor({ size = 220, pitch = 14, seed = 1337 } = {}) {
    this.label = 'Procedural Streets';
    this.name = this.label;
    this.bbox = null;
    this.lat = 40.71;
    this.lon = -74.00;

    this.size = 0;            // bounded
    this.maxHeight = 0;
    this.width = size;
    this.height = size;

    const n = size * size;
    this.voidSlot = n;
    this.h = new Float32Array(n + 1);
    this.type = new Uint8Array(n + 1).fill(T.PLAZA);
    this.rnd = new Float32Array(n + 1);
    this.lamp = new Float32Array(n + 1);
    this.pal = new Uint8Array(n + 1);
    this.flags = new Uint8Array(n + 1);
    this.type[this.voidSlot] = T.VOID;

    this.roadCells = [];
    this.streetNames = [];
    this.streetTags = [];
    this.streetRank = [];
    this.segs = null;
    this.anchor = null;
    this.junctions = [];
    this.roads = [];
    this.stats = { roads: 0, named: 0, junctions: 0, skipped: 0 };

    this._build(pitch, seed);
  }

  sample(cx, cy) {
    const x = Math.floor(cx);
    const y = Math.floor(cy);
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return this.voidSlot;
    return y * this.width + x;
  }

  ready() { return Promise.resolve(this); }
  maxHeightAt() { return 0; }
  dispose() { this.roadCells.length = 0; }
  get hasStreets() { return this.roadCells.length > 0; }

  randomRoadCell() {
    if (this.roadCells.length === 0) return null;
    const p = this.roadCells[(Math.random() * this.roadCells.length) | 0];
    return { x: (p % this.width) + 0.5, y: Math.floor(p / this.width) + 0.5 };
  }

  spawn() {
    const c = Math.floor(this.width / 2);
    return { x: c + 0.5, y: c + 0.5, angle: Math.PI / 2 };
  }

  _nameAvenue(i) { return `AVENUE ${i + 1}`; }
  _nameStreet(i) { return `STREET ${i + 1}`; }

  _build(pitch, _seed) {
    const W = this.width;
    const H = this.height;
    const r = Math.max(1, Math.round((9 / METERS_PER_CELL) / 2));

    const mark = (x, y) => {
      if (x < 0 || x >= W || y < 0 || y >= H) return;
      const s = y * W + x;
      this.type[s] = T.ROAD;
      this.rnd[s] = hash(x, y, 0x5eed);
      this.roadCells.push(s);
    };

    // Horizontal streets (run along x) and vertical avenues (run along y).
    const streetRows = [];
    const avenueCols = [];
    for (let y = pitch; y < H; y += pitch) {
      streetRows.push(y);
      for (let x = 0; x < W; x++) for (let dy = -r; dy <= r; dy++) mark(x, y + dy);
    }
    for (let x = pitch; x < W; x += pitch) {
      avenueCols.push(x);
      for (let y = 0; y < H; y++) for (let dx = -r; dx <= r; dx++) mark(x + dx, y);
    }

    // Named polylines for the renderer.
    for (let i = 0; i < streetRows.length; i++) {
      const y = streetRows[i] + 0.5;
      const nameId = this._addName(this._nameStreet(i), 1);
      const pts = [[0.5, y], ...avenueCols.map((x) => [x + 0.5, y]), [W - 0.5, y]];
      this.roads.push({
        pts, cls: 'residential', nameId, rank: 1, tags: { highway: 'residential' },
      });
      this._addSeg(0.5, y, W - 0.5, y, nameId);
    }
    for (let i = 0; i < avenueCols.length; i++) {
      const x = avenueCols[i] + 0.5;
      const nameId = this._addName(this._nameAvenue(i), 1);
      const pts = [[x, 0.5], ...streetRows.map((y) => [x, y + 0.5]), [x, H - 0.5]];
      this.roads.push({
        pts, cls: 'residential', nameId, rank: 1, tags: { highway: 'residential' },
      });
      this._addSeg(x, 0.5, x, H - 0.5, nameId);
    }

    // Junctions at every grid crossing, naming both roads.
    for (const y of streetRows) {
      for (const x of avenueCols) {
        const sx = this.streetNames.indexOf(this._nameStreet(streetRows.indexOf(y)));
        const ax = this.streetNames.indexOf(this._nameAvenue(avenueCols.indexOf(x)));
        this.junctions.push({ x: x + 0.5, y: y + 0.5, names: [sx, ax] });
      }
    }
    this.stats.junctions = this.junctions.length;
    const signalPoints = this.junctions.filter((_, i) => i % 4 === 0);
    this.roadGraph = buildRoadGraph(this.roads, { signalPoints });
    this.junctions = this.roadGraph.junctions;
    this.stats.junctions = this.junctions.length;
    this.stats.signals = this.roadGraph.signalJunctions.length;
    this.stats.roads = streetRows.length + avenueCols.length;
    this.stats.named = this.streetNames.length;

    this._packAnchorsAndSegs();
  }

  _addName(name, rank) {
    let id = this.streetNames.indexOf(name);
    if (id < 0) {
      id = this.streetNames.length;
      this.streetNames.push(name);
      this.streetTags.push({ name, highway: 'residential' });
      this.streetRank.push(rank);
    }
    return id;
  }

  _addSeg(x1, y1, x2, y2, name) {
    if (!this.segs) this.segs = { n: 0, x1: [], y1: [], x2: [], y2: [], name: [] };
    this.segs.x1.push(x1); this.segs.y1.push(y1);
    this.segs.x2.push(x2); this.segs.y2.push(y2);
    this.segs.name.push(name);
    this.segs.n++;
  }

  _packAnchorsAndSegs() {
    // Anchor every junction for the label system.
    const anchors = [];
    for (const j of this.junctions) {
      for (const nameId of j.names) {
        anchors.push({ x: j.x, y: j.y, name: nameId, rank: 1, junction: 1, dx: 1, dy: 0 });
      }
    }
    const n = anchors.length;
    this.anchor = {
      n,
      x: new Float32Array(n), y: new Float32Array(n),
      dx: new Float32Array(n), dy: new Float32Array(n),
      name: new Uint16Array(n), rank: new Uint8Array(n), junction: new Uint8Array(n),
    };
    for (let i = 0; i < n; i++) {
      const a = anchors[i];
      this.anchor.x[i] = a.x; this.anchor.y[i] = a.y;
      this.anchor.dx[i] = a.dx; this.anchor.dy[i] = a.dy;
      this.anchor.name[i] = a.name; this.anchor.rank[i] = a.rank;
      this.anchor.junction[i] = a.junction;
    }

    const S = this.segs;
    this.segs = {
      n: S.n,
      x1: Float32Array.from(S.x1), y1: Float32Array.from(S.y1),
      x2: Float32Array.from(S.x2), y2: Float32Array.from(S.y2),
      name: Uint16Array.from(S.name),
    };
  }

  nearestStreet(x, y) {
    const S = this.segs;
    if (!S || S.n === 0) return null;
    let on = -1;
    let bd = Infinity;
    for (let i = 0; i < S.n; i++) {
      const vx = S.x2[i] - S.x1[i];
      const vy = S.y2[i] - S.y1[i];
      const px = x - S.x1[i];
      const py = y - S.y1[i];
      const len2 = vx * vx + vy * vy || 1e-12;
      let t = (px * vx + py * vy) / len2;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const dx = px - vx * t;
      const dy = py - vy * t;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; on = S.name[i]; }
    }
    if (on < 0) return null;
    let cross = -1;
    let cd = Infinity;
    for (let i = 0; i < S.n; i++) {
      if (S.name[i] === on) continue;
      const vx = S.x2[i] - S.x1[i];
      const vy = S.y2[i] - S.y1[i];
      const px = x - S.x1[i];
      const py = y - S.y1[i];
      const len2 = vx * vx + vy * vy || 1e-12;
      let t = (px * vx + py * vy) / len2;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const dx = px - vx * t;
      const dy = py - vy * t;
      const d = dx * dx + dy * dy;
      if (d < cd) { cd = d; cross = S.name[i]; }
    }
    return {
      on: this.streetNames[on],
      onDist: Math.sqrt(bd),
      cross: cross >= 0 ? this.streetNames[cross] : null,
      crossDist: cross >= 0 ? Math.sqrt(cd) : Infinity,
    };
  }
}
