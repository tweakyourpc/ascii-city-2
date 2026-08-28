import { ChunkedWorld, T, F, CHUNK, hash } from './source.js';
import { WORLD, BLOCK, SEED, METERS_PER_CELL, DEFAULT_LAT, DEFAULT_LON, FACADE } from '../config.js';
import { buildRoadGraph } from './roadgraph.js';
import { buildSemanticIndex } from '../spatial.js';

const CENTER = WORLD / 2;      // 1024, where the park sits

/**
 * The original engine's procedural city, behind the WorldSource interface.
 *
 * Terrain is a pure function of coordinates: a park at the centre so the
 * skyline has an open foreground, then concentric rings of towers, houses,
 * farmland, forest and water, over a block grid with roads, sidewalks, street
 * trees and lamp-glow falloff.
 *
 * v2 addition: the same block grid is exposed as a set of named road polylines
 * (`roads`) and the junctions where they cross (`junctions`), so the street
 * line renderer, the signpost layer and the label layer all work on the
 * procedural city exactly as they do on a real OSM import. The grid is regular
 * (every BLOCK cells), so every crossing is a junction and every road is named.
 */
export class ProceduralWorld extends ChunkedWorld {
  constructor({ seed = SEED } = {}) {
    super({ size: WORLD, maxChunks: 4096 });
    this.seed = seed;
    // A bound, not an observation: the tallest term below is 10 + 10 + 21.
    this.maxHeight = 42;
    this.name = 'Procedural City';
    this.label = 'Procedural City';
    this.bbox = null;
    this.lat = DEFAULT_LAT;
    this.lon = DEFAULT_LON;
    this.width = WORLD;
    this.height = WORLD;

    // v2: the road lattice, so the line renderer / signs / labels have data.
    this.roadCells = [];
    this.streetNames = [];
    this.streetTags = [];
    this.streetRank = [];
    this.segs = null;
    this.anchor = null;
    this.junctions = [];
    this.roads = [];
    this.buildings = [null];
    this.landmarks = [];
    this.stats = { buildings: 0, roads: 0, named: 0, junctions: 0, skipped: 0 };

    this._buildRoads();
  }

  fillChunk(ox, oy, base) {
    const seed = this.seed;

    for (let ly = 0; ly < CHUNK; ly++) {
      const ay = oy + ly;
      const my = ay % BLOCK;
      const by = (ay / BLOCK) | 0;
      const ddy = ay - CENTER;
      const pdy = ay - (CENTER + 7);

      for (let lx = 0; lx < CHUNK; lx++) {
        const ax = ox + lx;
        const mx = ax % BLOCK;
        const bx = (ax / BLOCK) | 0;
        const ddx = ax - CENTER;
        const pdx = ax - (CENTER + 12);

        const dist = Math.sqrt(ddx * ddx + ddy * ddy);
        const rb = hash(bx, by, seed);
        const rb2 = hash(bx + 911, by + 733, seed);
        const rc = hash(ax, ay, seed);

        let type = T.FIELD;
        let h = 0;
        let stripe = false;

        if (dist < 54) {
          // the park: an open foreground so the skyline has somewhere to stand
          const pondD = Math.sqrt(pdx * pdx + pdy * pdy);
          if (pondD < 9.5) {
            type = T.WATER;
          } else if (Math.abs(ddx) < 1.5 || Math.abs(ddy) < 1.5 ||
                     (dist > 28.5 && dist < 30.5)) {
            type = T.PLAZA;
          } else if (rc < 0.018 && Math.abs(ddx) > 7 && Math.abs(ddy) > 7) {
            type = T.TREE; h = 3.4 + rc * 90;
          } else {
            type = T.FIELD;
          }
        } else if (mx < 3 || my < 3) {
          type = dist < 780 ? T.ROAD : T.PATH;
          if (mx === 1 && my >= 3 && (ay % 4) < 2) stripe = true;
          if (my === 1 && mx >= 3 && (ax % 4) < 2) stripe = true;
        } else if (mx === 3 || mx === 13 || my === 3 || my === 13) {
          type = T.SIDEWALK;
          if (dist < 560 && rc < 0.05) { type = T.TREE; h = 3.2 + rc * 20; }
        } else if (dist < 265) {
          if (rb < 0.07) {
            type = T.PLAZA;
          } else {
            type = T.TOWER;
            const lf = Math.max(0, 1 - dist / 320);
            // a skyline needs low-rise too, or every street is a slot canyon
            h = rb < 0.46 ? 4 + rb2 * 6 : 10 + rb2 * 10 + lf * rc * 21;
          }
        } else if (dist < 480) {
          if (rb < 0.74) { type = T.HOUSE; h = 2.4 + rb2 * 2.2; }
          else type = T.YARD;
        } else if (dist < 790) {
          if (rb < 0.35) type = T.FIELD;
          else { type = T.FARM; h = rc < 0.5 ? 1.1 : 0; }
        } else if (rb < 0.55) {
          if (rc < 0.55) { type = T.FOREST; h = 3 + rc * 5; }
          else type = T.FIELD;
        } else {
          type = T.WATER;
        }

        let lamp = 0;
        if (type === T.ROAD || type === T.SIDEWALK ||
            type === T.PLAZA || type === T.PATH) {
          const kx = Math.min(
            Math.abs(ax - (bx * BLOCK - 1)), Math.abs(ax - (bx * BLOCK + 3)),
            Math.abs(ax - (bx * BLOCK + 13)), Math.abs(ax - (bx * BLOCK + BLOCK + 3)));
          const ky = Math.min(
            Math.abs(ay - (by * BLOCK - 1)), Math.abs(ay - (by * BLOCK + 3)),
            Math.abs(ay - (by * BLOCK + 13)), Math.abs(ay - (by * BLOCK + BLOCK + 3)));
          const sx = Math.abs(ax - Math.round(ax / 7) * 7);
          const sy = Math.abs(ay - Math.round(ay / 7) * 7);
          lamp = Math.exp(-Math.min(kx * kx + sy * sy, ky * ky + sx * sx) / 7.5);
        }

        let flags = stripe ? F.STRIPE : 0;
        // One beacon per block, at a fixed spot inside it. Testing per cell
        // would scatter a red light over every cell of a tower's roof.
        if (h > 25 && mx === 8 && my === 8) flags |= F.BEACON;

        const s = base + (ly << 5) + lx;
        this.h[s] = h;
        this.type[s] = type;
        this.rnd[s] = rc;
        this.lamp[s] = lamp;
        this.pal[s] = (hash(bx + 5, by + 9, seed) * FACADE.length) | 0;
        this.flags[s] = flags;
      }
    }
  }

  /** A sensible place to drop the camera: a street near the park's edge. */
  spawn() {
    let x = CENTER + 0.5;
    let y = CENTER - 47.5;   // 976.5, matching the original start position
    for (let n = 0; n < 24; n++) {
      const t = this.type[this.sample(x, y)];
      const l = this.type[this.sample(x - 1, y)];
      const r = this.type[this.sample(x + 1, y)];
      if (t !== T.TREE && t !== T.WATER && l !== T.TREE && r !== T.TREE) break;
      y += 1;
    }
    return { x, y, angle: Math.PI / 2 };
  }

  /* ------------------------------ WorldSource ------------------------------ */

  ready() { return Promise.resolve(this); }
  maxHeightAt() { return this.maxHeight; }
  dispose() { this.roadCells.length = 0; }

  get hasStreets() { return this.roadCells.length > 0; }

  randomRoadCell() {
    if (this.roadCells.length === 0) return null;
    const p = this.roadCells[(Math.random() * this.roadCells.length) | 0];
    return { x: (p % this.width) + 0.5, y: Math.floor(p / this.width) + 0.5 };
  }

  /* ------------------------------ road lattice ------------------------------ */

  /**
   * Build the named road polylines and junctions from the block grid.
   *
   * The grid is regular: a road runs along every row and column whose index is
   * a multiple of BLOCK. We name the rows "STREET n" and the columns "AVENUE n"
   * (matching the flat ProceduralStreets convention), emit one polyline per
   * road, and record a junction at every grid crossing. The polyline endpoints
   * sit at the world edges so a long avenue reads as one straight line in
   * perspective, exactly as the OSM import does.
   */
  _buildRoads() {
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

    const streetRows = [];
    const avenueCols = [];
    for (let y = 0; y < H; y += BLOCK) {
      streetRows.push(y);
      for (let x = 0; x < W; x++) for (let dy = -r; dy <= r; dy++) mark(x, y + dy);
    }
    for (let x = 0; x < W; x += BLOCK) {
      avenueCols.push(x);
      for (let y = 0; y < H; y++) for (let dx = -r; dx <= r; dx++) mark(x + dx, y);
    }

    const addName = (name) => {
      let id = this.streetNames.indexOf(name);
      if (id < 0) {
        id = this.streetNames.length;
        this.streetNames.push(name);
        this.streetTags.push({ name, highway: 'residential' });
        this.streetRank.push(1);
      }
      return id;
    };

    for (let i = 0; i < streetRows.length; i++) {
      const y = streetRows[i] + 0.5;
      const nameId = addName(`STREET ${i + 1}`);
      const pts = [[0.5, y], ...avenueCols.map((x) => [x + 0.5, y]), [W - 0.5, y]];
      this.roads.push({ pts, cls: 'residential', nameId, rank: 1,
        width: r * 2 + 1, tags: { highway: 'residential' } });
      this._addSeg(0.5, y, W - 0.5, y, nameId);
    }
    for (let i = 0; i < avenueCols.length; i++) {
      const x = avenueCols[i] + 0.5;
      const nameId = addName(`AVENUE ${i + 1}`);
      const pts = [[x, 0.5], ...streetRows.map((y) => [x, y + 0.5]), [x, H - 0.5]];
      this.roads.push({ pts, cls: 'residential', nameId, rank: 1,
        width: r * 2 + 1, tags: { highway: 'residential' } });
      this._addSeg(x, 0.5, x, H - 0.5, nameId);
    }

    for (const y of streetRows) {
      for (const x of avenueCols) {
        const sx = this.streetNames.indexOf(`STREET ${streetRows.indexOf(y) + 1}`);
        const ax = this.streetNames.indexOf(`AVENUE ${avenueCols.indexOf(x) + 1}`);
        this.junctions.push({ x: x + 0.5, y: y + 0.5, names: [sx, ax] });
      }
    }

    this.stats.roads = streetRows.length + avenueCols.length;
    this.stats.named = this.streetNames.length;
    this.stats.junctions = this.junctions.length;
    const signalPoints = this.junctions.filter((_, i) => i % 4 === 0);
    this.roadGraph = buildRoadGraph(this.roads, { signalPoints });
    this.junctions = this.roadGraph.junctions;
    this.stats.junctions = this.junctions.length;
    this.stats.signals = this.roadGraph.signalJunctions.length;
    this._packAnchorsAndSegs();
    buildSemanticIndex(this);
  }

  _addSeg(x1, y1, x2, y2, name) {
    if (!this.segs) this.segs = { n: 0, x1: [], y1: [], x2: [], y2: [], name: [] };
    this.segs.x1.push(x1); this.segs.y1.push(y1);
    this.segs.x2.push(x2); this.segs.y2.push(y2);
    this.segs.name.push(name);
    this.segs.n++;
  }

  _packAnchorsAndSegs() {
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

  /** Which named street a point is on, and the nearest different one. */
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
