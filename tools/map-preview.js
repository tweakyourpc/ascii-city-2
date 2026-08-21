/**
 * Print a top-down line map of the v2 street network, so an OSM import can be
 * checked against the real road layout at a glance. v2 keeps the raw road
 * polylines, so this draws them as lines (not a rasterized type grid) — which
 * is exactly the fidelity the renderer depends on.
 *
 *   node tools/map-preview.js --city manhattan
 *   node tools/map-preview.js --city london --width 150
 *   node tools/map-preview.js --city 51.5074,-0.1278      # lat,lon
 *   node tools/map-preview.js --procedural                # the grid fallback
 *   node tools/map-preview.js --procedural --full         # the whole 2048x2048 grid
 *
 * Legend:  - | / \   road segments (orientation in the map)
 *          +          a junction (two or more named streets meet)
 *          .          open ground
 */
import fs from 'node:fs';
import path from 'node:path';

import { ProceduralWorld } from '../src/world/procedural.js';
import { OsmWorld } from '../src/world/osm.js';
import { METERS_PER_CELL } from '../src/config.js';

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const next = process.argv[i + 1];
    if (next === undefined || next.startsWith('--')) args.set(k, 'true');
    else { args.set(k, next); i++; }
  }
}

const OUT_W = Number(args.get('width') ?? 140);
const CITY = args.get('city');
const PROC = args.has('procedural');

function installCache(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = (k) => path.join(dir, k.replace(/[^\w.-]/g, '_') + '.json');
  globalThis.localStorage = {
    getItem: (k) => (fs.existsSync(file(k)) ? fs.readFileSync(file(k), 'utf8') : null),
    setItem: (k, v) => fs.writeFileSync(file(k), v),
    removeItem: (k) => { try { fs.unlinkSync(file(k)); } catch { /* gone */ } },
  };
}

let world;

if (CITY) {
  installCache(new URL('../.cache/', import.meta.url).pathname);
  const { fetchOsm, PRESETS, parseLocation } = await import('../src/world/overpass.js');
  const preset = PRESETS[CITY];
  const bbox = preset?.bbox ?? parseLocation(CITY);
  if (!bbox) {
    console.error(`Unknown city "${CITY}". Try: ${Object.keys(PRESETS).join(', ')}`);
    process.exit(1);
  }
  const elements = await fetchOsm(bbox, { onProgress: (m) => console.error('  ' + m) });
  world = new OsmWorld(bbox, elements, preset?.label ?? CITY);
  console.error(`${world.name}  bbox ${bbox.join(', ')}`);
  console.error(`${world.width}x${world.height} cells at ${METERS_PER_CELL.toFixed(2)} m/cell ` +
    `= ${(world.width * METERS_PER_CELL / 1000).toFixed(2)} x ` +
    `${(world.height * METERS_PER_CELL / 1000).toFixed(2)} km`);
  console.error(`${world.stats.roads} ways, ${world.stats.named} named, ` +
    `${world.stats.junctions} junctions, ${world.stats.buildings} buildings`);
} else {
  world = new ProceduralWorld();
  console.error(`Procedural City, ${world.width}x${world.height} cells, ` +
    `${world.stats.junctions} junctions`);
}

// The procedural city is 2048x2048 with a road every 14 cells; at a narrow
// terminal width every output cell would land on a road and the map would be a
// solid block. Crop to a legible window (matching the old 220-cell fallback)
// so the grid reads as lines. Pass --full to see the whole extent.
const WIN = 220;
const FULL = args.has('full');
const x0 = FULL ? 0 : Math.floor((world.width - WIN) / 2);
const y0 = FULL ? 0 : Math.floor((world.height - WIN) / 2);
const span = FULL ? world.width : WIN;

const W = world.width;
const H = world.height;

// Terminal cells are about twice as tall as wide, so sample half as many rows.
const step = Math.max(1, span / OUT_W);
const rows = Math.floor(span / (step * 2));
const cols = Math.floor(span / step);

// Rasterize the road polylines into a character grid. Each output cell maps to
// a block of world cells; we sample the polyline at fine resolution so thin
// roads survive downsampling.
const grid = [];
for (let i = 0; i < rows * cols; i++) grid.push('.');

function mark(x, y, ch) {
  // +y is north: print north at top, so flip the row. Coordinates are world
  // space; subtract the window origin so the crop maps to the top-left.
  const rx = Math.floor((x - x0) / step);
  const ry = Math.floor((H - y) / (step * 2));
  if (rx < 0 || rx >= cols || ry < 0 || ry >= rows) return;
  const i = ry * cols + rx;
  if (ch === '+') { grid[i] = '+'; return; }   // junctions override road lines
  if (grid[i] !== '.') return;                  // keep the first stroke
  grid[i] = ch;
}

for (const road of world.roads) {
  const pts = road.pts;
  for (let s = 1; s < pts.length; s++) {
    const [ax, ay] = pts[s - 1];
    const [bx, by] = pts[s];
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(len * 2));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      const dx = bx - ax;
      const dy = by - ay;
      const a = Math.abs(dy) / (Math.abs(dx) + Math.abs(dy) + 1e-9);
      const ch = a < 0.18 ? '-' : a > 0.82 ? '|' : (dx * dy >= 0 ? '\\' : '/');
      mark(x, y, ch);
    }
  }
}

// Junctions on top, so a crossing is never hidden by a passing line.
for (const j of world.junctions) {
  mark(j.x, j.y, '+');
}

const lines = [];
for (let ry = 0; ry < rows; ry++) {
  let line = '';
  for (let rx = 0; rx < cols; rx++) line += grid[ry * cols + rx];
  lines.push(line);
}

console.log(lines.join('\n'));
console.error('\n- | / \\  road segments   +  junction   .  ground');
