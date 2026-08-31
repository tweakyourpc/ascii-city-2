import { T, F, hash } from './source.js';
import { METERS_PER_CELL, FLOOR_H, FACADE } from '../config.js';
import { buildRoadGraph } from './roadgraph.js';
import { SpatialHash, boundsOfPoints, buildSemanticIndex } from '../spatial.js';

/**
 * An OpenStreetMap extract, rasterized into the engine's height field.
 *
 * Implements the WorldSource contract from source.js, but with flat arrays
 * rather than chunks: an OSM extract is bounded and fully known at load time,
 * so there is nothing to generate lazily.
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
    // Inverses, so real-world coordinates (aircraft, the camera's own
    // position) can be mapped back into the cell grid.
    lon: (x) => (x - width / 2) * METERS_PER_CELL / mPerLon + lon0,
    lat: (y) => (y - height / 2) * METERS_PER_CELL / M_PER_DEG_LAT + lat0,
  };
}

/** Convert one world-grid point back to geographic coordinates. */
export function geoAt(projection, x, y) {
  return { lat: projection.lat(y), lon: projection.lon(x) };
}

/* -------------------------------- tags --------------------------------- */

/**
 * Building height in cells.
 * `height` in metres wins, then `building:levels`, then a 3-level default as
 * specified. Roof height is added when it is given separately.
 */
export function heightOfCells(tags = {}) {
  const metres = parseMetres(tags.height ?? tags['building:height']);
  if (metres !== null && metres > 0) return metres / METERS_PER_CELL;

  const levels = parseFloat(tags['building:levels']);
  if (Number.isFinite(levels) && levels > 0) {
    const roof = parseFloat(tags['roof:levels']);
    const total = levels + (Number.isFinite(roof) ? roof : 0);
    // Storeys map onto the facade texture's floor pitch exactly.
    return total * FLOOR_H;
  }

  return 3 * FLOOR_H;   // default: 3 levels
}

/** Number of storeys for a building, or null when unknown. */
export function parseLevels(tags = {}) {
  const levels = parseFloat(tags['building:levels']);
  if (Number.isFinite(levels) && levels > 0) {
    const roof = parseFloat(tags['roof:levels']);
    return levels + (Number.isFinite(roof) ? roof : 0);
  }
  return null;
}

/** Parse an OSM distance: "25", "25 m", "82'", "82 ft". Returns metres. */
export function parseMetres(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  const m = /^(-?[\d.]+)\s*(.*)$/.exec(s);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toLowerCase();
  if (unit.startsWith("'") || unit.startsWith('ft') || unit.startsWith('feet')) {
    return n * 0.3048;
  }
  return n;
}

/** Road width in metres, by highway class. */
const ROAD_W = {
  motorway: 20, trunk: 18, primary: 16, secondary: 13, tertiary: 11,
  residential: 9, unclassified: 9, living_street: 8, service: 5,
  pedestrian: 6, footway: 3, path: 3, cycleway: 3, steps: 3, track: 4,
};

const FOOT_LIKE = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway']);

const WATERWAY_W = { river: 26, canal: 14, stream: 5 };

/**
 * Surfaces that are not paved. Most airfields in the world are one of these,
 * and a grass strip carries no painted markings.
 */
const UNPAVED = new Set([
  'grass', 'dirt', 'earth', 'ground', 'sand', 'gravel', 'fine_gravel',
  'unpaved', 'compacted', 'grass_paver', 'mud', 'ice', 'snow',
]);

/**
 * Is this element the paved AREA rather than a centreline?
 *
 * OSM maps aeroways both ways. `area=yes` says so outright; otherwise a way
 * whose last node is its first is a polygon. Three points is the minimum that
 * encloses anything.
 */
function isAreaElement(el) {
  if (el.tags?.area === 'yes') return true;
  if (el.type === 'relation' || el.members) return true;
  const g = el.geometry;
  if (!g || g.length < 4) return false;
  return Math.abs(g[0].lat - g[g.length - 1].lat) < 1e-9
      && Math.abs(g[0].lon - g[g.length - 1].lon) < 1e-9;
}

/** Roughly 60 m: the height above which buildings carry warning lights. */
const BEACON_MIN_H = 25;

/**
 * Building material classes, derived from OSM tags. The renderer uses these to
 * pick a glyph/colour family (glass reads differently from brick), so the city
 * is not one uniform warm-stone tone. Indexed by the per-cell `mat` array.
 */
export const MAT = {
  STONE: 0,     // default masonry / concrete-ish
  GLASS: 1,     // curtain wall, glazed
  BRICK: 2,     // brick / terracotta
  CONCRETE: 3,  // bare concrete / modern
  METAL: 4,     // metal / industrial
  WOOD: 5,      // timber / wood
};

/** Map an OSM building tag set to a material class. */
export function materialOf(tags = {}) {
  const b = (tags.building || '').toLowerCase();
  const mat = (tags['building:material'] || tags.material || '').toLowerCase();
  const wall = (tags['building:colour'] || '').toLowerCase();
  if (/glass|glaz|curtain|steel|aluminium|aluminum/.test(mat + b)) return MAT.GLASS;
  if (/brick|terracotta|brownstone/.test(mat + b)) return MAT.BRICK;
  if (/concrete|cement|precast|brutalist/.test(mat + b)) return MAT.CONCRETE;
  if (/metal|steel|tin|corrugat/.test(mat + b)) return MAT.METAL;
  if (/wood|timber|log|clapboard/.test(mat + b)) return MAT.WOOD;
  // A few named building types imply a material even without an explicit tag.
  if (/tower|office|skyscraper|commercial/.test(b)) return MAT.GLASS;
  if (/warehouse|industrial|factory|shed|garage/.test(b)) return MAT.METAL;
  if (/house|terrace|residential|detached|semi/.test(b)) return MAT.BRICK;
  if (/concrete|parking|carriage/.test(b)) return MAT.CONCRETE;
  // A glassy blue/teal building colour is a strong hint of a curtain wall.
  if (/blue|teal|cyan|silver|grey|gray/.test(wall)) return MAT.GLASS;
  return MAT.STONE;
}

/**
 * How much a road class deserves a label. Arterials win ties, because on a
 * screen with room for eight names you want the ones people navigate by.
 */
const NAMED_RANK = {
  motorway: 4, trunk: 4, primary: 3, secondary: 3, tertiary: 2,
  residential: 1, unclassified: 1, living_street: 1, pedestrian: 1,
};

/** A building is a landmark if it is named AND (tall OR has a Wikipedia link). */
const LANDMARK_H = 25;

/* ------------------------------ the world ------------------------------- */

export class OsmWorld {
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
    this.maxHeight = 0;

    // One extra slot past the grid, returned for anything out of bounds.
    const n = this.width * this.height;
    this.voidSlot = n;
    this.h = new Float32Array(n + 1);
    this.type = new Uint8Array(n + 1);
    this.rnd = new Float32Array(n + 1);
    this.lamp = new Float32Array(n + 1);
    this.pal = new Uint8Array(n + 1);
    this.flags = new Uint8Array(n + 1);
    // Seventh per-cell array: which building owns this cell, 0 for none.
    // Uint16 caps at 65534 buildings; the bbox limit allows about 5300 at
    // Manhattan density, so this is a 12x margin.
    this.bid = new Uint16Array(n + 1);
    // Eighth per-cell array: material class of the building owning this cell
    // (see MAT below). Lets the renderer pick a glyph/colour family from what
    // the building actually is (glass, concrete, brick, ...) rather than from a
    // single warm-stone palette. 0 = no building / default.
    this.mat = new Uint8Array(n + 1);

    this.roadCells = [];
    this.pois = [];
    this.stats = {
      buildings: 0, roads: 0, water: 0, green: 0, pois: 0, aeroways: 0, skipped: 0,
    };

    /* --- identification tables, all populated during rasterization --- */
    this.buildings = [null];        // index 0 is the "no building" sentinel
    this.landmarks = [];            // indices into buildings, tallest first
    this.streetNames = [];
    this.streetTags = [];
    this.streetRank = [];           // highest road class seen for each name
    this.segs = null;               // named-road segments, for nearestStreet
    this.anchor = null;             // typed arrays, built at the end
    this._nameIds = new Map();
    this._anchors = [];            // temporary, discarded after packing
    this._segs = [];               // temporary, packed into this.segs
    this._vertexNames = new Map();  // rounded vertex -> Set of name ids

    // v2 additions: the raw road polylines (for the line renderer) and the
    // junctions where two or more named streets meet (for street signs).
    this.roads = [];                // [{ pts:[[x,y]...], cls, nameId, rank }]
    this.junctions = [];            // [{ x, y, names:[nameId,...] }]
    this.signalNodeIds = new Set();
    this.signalPoints = [];
    this.roadGraph = null;

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

  maxHeightAt() { return this.maxHeight; }

  dispose() { this.roadCells.length = 0; }

  /** Traffic needs somewhere to put a car; OSM streets are not on a grid. */
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

  _set(x, y, type, h, palSeed, flagBits = 0, mat = 0) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const s = y * this.width + x;
    this.type[s] = type;
    this.h[s] = h;
    this.rnd[s] = hash(x, y, 0x5eed);
    this.pal[s] = palSeed & 3;
    this.flags[s] = flagBits;
    this.mat[s] = mat;
    if (h > this.maxHeight) this.maxHeight = h;
  }

  _rasterize(elements) {
    // Ground first, then water, then roads, then buildings: later layers win.
    const green = [];
    const water = [];
    const roads = [];
    const waterways = [];
    const buildings = [];
    const aeroways = [];

    for (const el of elements) {
      const tags = el.tags || {};
      if (el.type === 'node' && tags.highway === 'traffic_signals' &&
          el.lat !== undefined && el.lon !== undefined) {
        this.signalNodeIds.add(el.id);
        this.signalPoints.push({ x: this.proj.x(el.lon), y: this.proj.y(el.lat) });
        continue;
      }
      // Standalone points of interest: cafes, shops, subway entrances.
      if (el.type === 'node' && el.lat !== undefined &&
          (tags.amenity || tags.shop || tags.tourism || tags.railway)) {
        const x = this.proj.x(el.lon);
        const y = this.proj.y(el.lat);
        if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
          this.pois.push({
            x, y, tags,
            name: tags.name || null,
            kind: tags.railway === 'subway_entrance' ? 'subway'
                : tags.amenity ? 'amenity'
                : tags.shop ? 'shop' : 'tourism',
            osm: `node/${el.id}`,
          });
        }
        continue;
      }
      if (tags.building || tags['building:part']) buildings.push(el);
      // Airfield surfaces before streets. An aeroway carries no highway tag,
      // but the ordering says which one wins if OSM ever grows one that does.
      else if (tags.aeroway) aeroways.push(el);
      else if (tags.highway) roads.push(el);
      else if (tags.waterway) waterways.push(el);
      else if (tags.natural === 'water') water.push(el);
      else if (tags.leisure || tags.landuse) green.push(el);
      else this.stats.skipped++;
    }

    // Default ground. Plaza reads as neutral paving between the named layers.
    this.type.fill(T.PLAZA);
    for (let i = 0; i < this.width * this.height; i++) {
      this.rnd[i] = hash(i % this.width, (i / this.width) | 0, 0x5eed);
    }
    // Beyond the extract there is simply no data. Render it as neutral,
    // hazy ground rather than inventing countryside: at altitude the view
    // reaches well past a 1 km box, and a green field out there would be a
    // claim about the world that OpenStreetMap never made.
    this.type[this.voidSlot] = T.VOID;

    for (const el of green) this._fillArea(el);
    for (const el of water) this._fillWater(el);
    for (const el of waterways) this._strokeWaterway(el);

    // Airfield surfaces before streets, so a service road crossing an apron
    // still reads as a road where the two overlap.
    for (const el of aeroways) this._layAeroway(el);

    const lamps = [];
    for (const el of roads) this._strokeRoad(el, lamps);
    this._splatLamps(lamps);

    for (const el of buildings) this._fillBuilding(el);

    // Cinematic mode intersects the original OSM footprint edges instead of
    // the 2.37 m height-field cells. Keep a separate compact index so only
    // buildings near the camera are projected each frame.
    this.buildingIndex = new SpatialHash(32);
    for (let i = 1; i < this.buildings.length; i++) {
      const building = this.buildings[i];
      if (building?.bounds) this.buildingIndex.insert(building.bounds, building);
    }

    // Collect road cells after buildings, so none of them are inside a wall.
    for (let s = 0; s < this.width * this.height; s++) {
      if (this.h[s] === 0 &&
          (this.type[s] === T.ROAD || this.type[s] === T.SIDEWALK)) {
        this.roadCells.push(s);
      }
    }

    this.stats.pois = this.pois.length;
    this._finishAnchors();
    this.roadGraph = buildRoadGraph(this.roads, {
      signalNodeIds: this.signalNodeIds,
      signalPoints: this.signalPoints,
    });
    this.junctions = this.roadGraph.junctions;
    this.stats.junctions = this.junctions.length;
    this.stats.signals = this.roadGraph.signalJunctions.length;
    this._findLandmarks();
    buildSemanticIndex(this);
  }

  /** All closed rings of an element, projected to cell coordinates. */
  _ringsOf(el) {
    const rings = [];
    const toCells = (geom) => geom.map((p) => [this.proj.x(p.lon), this.proj.y(p.lat)]);

    if (el.geometry && el.geometry.length > 2) {
      rings.push(toCells(el.geometry));
    } else if (el.members) {
      for (const m of el.members) {
        if (m.geometry && m.geometry.length > 2) rings.push(toCells(m.geometry));
      }
    }
    return rings;
  }

  _fillBuilding(el) {
    const rings = this._ringsOf(el);
    if (rings.length === 0) return;

    const h = heightOfCells(el.tags);
    const type = h > 8 ? T.TOWER : T.HOUSE;
    // Pick a facade palette per building so the city varies (beige, grey,
    // cream, ...). The id is stable per building, so the same tower keeps its
    // colour across frames; the bitmask spreads ids across the palette.
    const pal = (el.id ?? 0) & (FACADE.length - 1);
    // Material class drives the glyph/colour family (glass vs brick vs ...).
    const mat = materialOf(el.tags);
    let touched = 0;

    // Track the cell nearest the footprint's centre, so a tall building gets
    // exactly one aircraft beacon rather than one per roof cell.
    let cx = 0;
    let cy = 0;
    let n = 0;
    for (const ring of rings) {
      for (const [x, y] of ring) { cx += x; cy += y; n++; }
    }
    cx /= n || 1;
    cy /= n || 1;
    let beaconAt = null;
    let beaconD = Infinity;
    let r2max = 0;

    const id = this.buildings.length <= 65534 ? this.buildings.length : 0;

    scanFill(rings, this.width, this.height, (x, y) => {
      this._set(x, y, type, h, pal, 0, mat);
      if (id) this.bid[y * this.width + x] = id;
      touched++;
      const d = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2;
      if (d > r2max) r2max = d;
      if (d < beaconD) { beaconD = d; beaconAt = y * this.width + x; }
    });

    if (touched) {
      this.stats.buildings++;
      if (h > BEACON_MIN_H && beaconAt !== null) this.flags[beaconAt] |= F.BEACON;
      if (id) {
        // `tags` is retained by reference on purpose. The element objects are
        // otherwise garbage, and holding the tags while releasing `geometry`
        // (an order of magnitude larger) is a net saving. It also means the
        // info panel can show any tag without us guessing at load time.
        this.buildings.push({
          osm: `${el.type}/${el.id}`,
          tags: el.tags || {},
          name: el.tags?.name ?? null,
          cx, cy, h,
          r: Math.sqrt(r2max),
          cells: touched,
          notable: 0,
          mat,
          pal,
          levels: parseLevels(el.tags),
          _meshId: id,
          // Retaining projected rings costs much less than retaining the full
          // Overpass element and gives the renderer sub-cell footprint edges.
          rings,
          bounds: boundsOfPoints(rings.flat()),
        });
      }
    }
  }

  /**
   * Emit label anchors along a named way, at a spacing set by its class, and
   * record its vertices so intersections can be found afterwards.
   */
  _roadAnchors(pts, name, rank, tags) {
    let nameId = this._nameIds.get(name);
    if (nameId === undefined) {
      nameId = this.streetNames.length;
      this.streetNames.push(name);
      this.streetTags.push(tags || {});
      this.streetRank.push(rank);
      this._nameIds.set(name, nameId);
    } else if (rank > this.streetRank[nameId]) {
      this.streetRank[nameId] = rank;
    }

    // Bucket vertices at half-cell resolution. Two different names sharing a
    // bucket is a junction, which is where a street sign would actually be.
    for (const [x, y] of pts) {
      const k = ((x * 2) | 0) * 65536 + ((y * 2) | 0);
      let set = this._vertexNames.get(k);
      if (!set) this._vertexNames.set(k, (set = new Set()));
      set.add(nameId);
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
          // Which way the street runs here, so a label can be written ALONG
          // it rather than always horizontally.
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
      junctions.push([jx, jy]);

      // Emit an anchor at the crossing itself, for every street meeting here.
      // Mid-block anchors alone almost never land near a junction (measured at
      // 3%), and "42nd and 5th" is the answer a person actually wants.
      for (const nameId of set) {
        // Direction is filled in below from the nearest mid-block anchor of
        // the same street: a junction vertex has no single tangent.
        this._anchors.push({
          x: jx, y: jy, name: nameId,
          rank: this.streetRank[nameId] ?? 0, junction: 1,
          dx: 0, dy: 0,
        });
      }
    }

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
    this.stats.anchors = n;
    this.stats.junctions = junctions.length;

    // v2: build the junction list for street signs. Sample along each named
    // road's whole centreline (not just its OSM vertices) so a crossing that
    // falls in the middle of a segment is still caught. Two different names
    // sharing a half-cell bucket is a junction — exactly where a sign stands.
    const vn = new Map();
    const STEP = 0.5;
    for (const r of this.roads) {
      if (r.nameId < 0) continue;
      const pts = r.pts;
      for (let i = 1; i < pts.length; i++) {
        const ax = pts[i - 1][0], ay = pts[i - 1][1];
        const bx = pts[i][0], by = pts[i][1];
        const len = Math.hypot(bx - ax, by - ay);
        const segs = Math.max(1, Math.ceil(len / STEP));
        for (let s = 0; s <= segs; s++) {
          const t = s / segs;
          const x = ax + (bx - ax) * t;
          const y = ay + (by - ay) * t;
          const k = ((x * 2) | 0) * 65536 + ((y * 2) | 0);
          let set = vn.get(k);
          if (!set) vn.set(k, (set = new Set()));
          set.add(r.nameId);
        }
      }
    }
    const junc = [];
    for (const [k, set] of vn) {
      if (set.size < 2) continue;
      const jx = Math.floor(k / 65536) / 2;
      const jy = (k % 65536) / 2;
      junc.push({ x: jx, y: jy, names: [...set] });
    }
    this.junctions = junc;
    this.stats.junctions = junc.length;

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
    this.stats.segments = m;
    this._segs = null;

    this._anchors = null;
    this._vertexNames = null;
    this._nameIds = null;
  }

  /**
   * Which buildings are worth naming unprompted. Named and either tall or
   * carrying a Wikipedia link, sorted tallest first so the per-frame cap can
   * stop early.
   */
  _findLandmarks() {
    for (let i = 1; i < this.buildings.length; i++) {
      const b = this.buildings[i];
      if (!b.name) continue;
      const wiki = !!(b.tags.wikidata || b.tags.wikipedia);
      const tall = b.h >= LANDMARK_H;
      if (!wiki && !tall) continue;
      b.notable = (wiki ? 2 : 0) + (tall ? 1 : 0);
      this.landmarks.push(i);
    }
    this.landmarks.sort((a, z) => this.buildings[z].h - this.buildings[a].h);
    this.stats.landmarks = this.landmarks.length;
    this.stats.named = this.buildings.filter((b) => b && b.name).length;
  }

  /** The nearest named point of interest to a world point, within `r` cells. */
  nearestPoi(x, y, r = 4) {
    let best = null;
    let bd = r * r;
    for (let i = 0; i < this.pois.length; i++) {
      const p = this.pois[i];
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
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

  _fillArea(el) {
    const tags = el.tags || {};
    const rings = this._ringsOf(el);
    if (rings.length === 0) return;

    const forest = tags.landuse === 'forest' || tags.natural === 'wood';
    let touched = 0;

    scanFill(rings, this.width, this.height, (x, y) => {
      if (forest) {
        // Scatter canopy rather than a solid block of tree.
        const r = hash(x, y, 0xf0f0);
        if (r < 0.34) this._set(x, y, T.FOREST, 3 + r * 8, 0);
        else this._set(x, y, T.FIELD, 0, 0);
      } else {
        this._set(x, y, T.FIELD, 0, 0);
      }
      touched++;
    });
    if (touched) this.stats.green++;
  }

  _fillWater(el) {
    const rings = this._ringsOf(el);
    if (rings.length === 0) return;
    let touched = 0;
    scanFill(rings, this.width, this.height, (x, y) => {
      this._set(x, y, T.WATER, 0, 0);
      touched++;
    });
    if (touched) this.stats.water++;
  }

  _strokeWaterway(el) {
    if (!el.geometry || el.geometry.length < 2) return;
    const w = (WATERWAY_W[el.tags?.waterway] ?? 6) / METERS_PER_CELL;
    const pts = el.geometry.map((p) => [this.proj.x(p.lon), this.proj.y(p.lat)]);
    strokePath(pts, w, this.width, this.height, (x, y) => {
      this._set(x, y, T.WATER, 0, 0);
    });
    this.stats.water++;
  }

  /**
   * Airfield surfaces: runways, taxiways and aprons.
   *
   * Deliberately not routed through `_strokeRoad`. A runway is not a street:
   * it gets no lamps, no name anchors, no entry in `this.roads` for the line
   * renderer, and above all no cells in `roadCells`, which is the pool cars
   * and pedestrians spawn from. It is also about twice the width of the widest
   * motorway, so it would not survive the ROAD_W table either.
   */
  _layAeroway(el) {
    const kind = el.tags?.aeroway;
    const type = kind === 'runway' ? T.RUNWAY
      : kind === 'taxiway' ? T.TAXIWAY
        : (kind === 'apron' || kind === 'taxilane') ? T.APRON : 0;
    if (!type) return;

    // Unpaved is the common case worldwide by count: most airfields are a
    // grass or gravel strip, and painting one as grooved asphalt with white
    // centreline markings states something about it that is not true.
    const unpaved = UNPAVED.has(el.tags?.surface);
    const base = unpaved ? F.UNPAVED : 0;

    // An aeroway is mapped either as a centreline or as the paved area
    // itself, and both forms are common. Stroking a closed way walks its
    // perimeter, so an area-mapped runway used to come out as a hollow
    // racetrack ring with grass down the middle of it.
    const rings = isAreaElement(el) ? this._ringsOf(el) : null;
    if (rings && rings.length) {
      let touched = 0;
      scanFill(rings, this.width, this.height, (x, y) => {
        this._set(x, y, type, 0, 0, base);
        touched++;
      });
      if (touched) this.stats.aeroways++;
      return;
    }
    if (type === T.APRON) return;          // an apron has no linear form
    if (!el.geometry || el.geometry.length < 2) return;

    const runway = type === T.RUNWAY;
    // OSM tags a real width on most large runways; the defaults are the
    // common ICAO code E runway and a code E taxiway.
    const tagged = Number.parseFloat(el.tags?.width);
    const metres = Number.isFinite(tagged) && tagged > 0
      ? tagged : (runway ? 45 : 23);
    const w = metres / METERS_PER_CELL;
    const pts = el.geometry.map((p) => [this.proj.x(p.lon), this.proj.y(p.lat)]);

    strokePath(pts, w, this.width, this.height, (x, y, distToCentre, along) => {
      // Centreline marks. A real runway centreline is 30 m of paint and 20 m
      // of gap, which at 2.37 m per cell is about 13 cells and 8; one cell is
      // already almost three times the real 0.9 m width, so keep it to one.
      // A grass strip has no paint on it.
      const stripe = !unpaved && distToCentre < 0.5 && (Math.floor(along) % 21) < 13;
      this._set(x, y, type, 0, 0, base | (stripe ? F.STRIPE : 0));
    });
    this.stats.aeroways++;
  }

  _strokeRoad(el, lamps) {
    if (!el.geometry || el.geometry.length < 2) return;
    const kind = el.tags?.highway;
    const metres = ROAD_W[kind] ?? 8;
    const w = metres / METERS_PER_CELL;
    const foot = FOOT_LIKE.has(kind);
    const type = foot ? T.SIDEWALK : T.ROAD;
    const pts = el.geometry.map((p) => [this.proj.x(p.lon), this.proj.y(p.lat)]);

    strokePath(pts, w, this.width, this.height, (x, y, distToCentre, along) => {
      // A dashed centre line on the wider carriageways only.
      const stripe = !foot && metres >= 9 && distToCentre < 0.6 &&
                     (Math.floor(along) % 5) < 2;
      this._set(x, y, type, 0, 0, stripe ? F.STRIPE : 0);
    });

    // Label anchors come from the polyline, deliberately NOT from the callback
    // above: that one touches every cell of every road and has to stay hot.
    const name = el.tags?.name;
    let nameId = -1;
    if (name) {
      this._roadAnchors(pts, name, NAMED_RANK[kind] ?? 0, el.tags);
      nameId = this._nameIds.get(name);
    }

    // v2: keep the raw polyline for the line renderer. Unnamed ways get -1.
    this.roads.push({
      pts, cls: kind, nameId, rank: NAMED_RANK[kind] ?? 0,
      width: w,
      tags: el.tags || {}, nodeIds: el.nodes || [],
      sourceId: el.id === undefined ? undefined : `way/${el.id}`,
    });

    if (!foot) {
      // Street lamps every ~11 cells along the kerb.
      let acc = 0;
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1];
        const [bx, by] = pts[i];
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 1e-6) continue;
        const nx = -(by - ay) / len;
        const ny = (bx - ax) / len;
        for (let d = -acc; d < len; d += 11) {
          if (d < 0) continue;
          const t = d / len;
          const side = ((lamps.length & 1) ? 1 : -1) * (w / 2 + 0.5);
          lamps.push([ax + (bx - ax) * t + nx * side, ay + (by - ay) * t + ny * side]);
        }
        acc = (acc + len) % 11;
      }
    }
    this.stats.roads++;
  }

  /** Glow falloff around each lamp, matching the procedural world's look. */
  _splatLamps(lamps) {
    const R = 5;
    for (const [lx, ly] of lamps) {
      const x0 = Math.max(0, Math.floor(lx - R));
      const x1 = Math.min(this.width - 1, Math.ceil(lx + R));
      const y0 = Math.max(0, Math.floor(ly - R));
      const y1 = Math.min(this.height - 1, Math.ceil(ly + R));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x + 0.5 - lx;
          const dy = y + 0.5 - ly;
          const g = Math.exp(-(dx * dx + dy * dy) / 7.5);
          const s = y * this.width + x;
          if (g > this.lamp[s]) this.lamp[s] = g;
        }
      }
    }
  }
}

/* ---------------------------- raster helpers ---------------------------- */

/**
 * Even-odd scanline fill over a set of rings. Passing outer and inner rings
 * together punches holes for free, which is what multipolygon relations need.
 */
export function scanFill(rings, width, height, plot) {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const r of rings) {
    for (const [, y] of r) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minY)) return;

  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(height - 1, Math.ceil(maxY));
  const xs = [];

  for (let y = y0; y <= y1; y++) {
    const sy = y + 0.5;
    xs.length = 0;

    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        // Half-open in y, so a vertex on the scanline counts once.
        if ((yi > sy) === (yj > sy)) continue;
        xs.push(xi + (sy - yi) / (yj - yi) * (xj - xi));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);

    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
      const xb = Math.min(width - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = xa; x <= xb; x++) plot(x, y);
    }
  }
}

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
