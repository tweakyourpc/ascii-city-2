import { FACADE, FLOOR_H, MAXD } from '../config.js';
import { hash } from '../world/source.js';
import { fogOf } from './materials.js';

const NEAR = 0.06;
const WINDOW_W = 0.82;
const WINDOW_LO = 0.24;
const WINDOW_HI = 0.80;
const WINDOW_MARGIN = 0.16;
const MAX_VECTOR_WINDOWS = 3600;

const MATERIAL = [
  null,
  [76, 112, 146],   // glass
  [154, 83, 61],    // brick
  [132, 132, 126],  // concrete
  [108, 120, 130],  // metal
  [132, 96, 66],    // wood
];

function cameraPoint(cam, x, y) {
  const dx = x - cam.x;
  const dy = y - cam.y;
  const c = Math.cos(cam.angle);
  const s = Math.sin(cam.angle);
  return {
    forward: dx * c + dy * s,
    // Same handedness as streets, signs, labels, vehicles and the sky: a
    // point to the camera's left has a negative side, and the projection
    // below subtracts it. Flipping either half alone mirrors the city.
    side: -dx * s + dy * c,
  };
}

/** Project one world-space point through the same pinhole model as every label. */
export function projectBuildingPoint(screen, cam, x, y, z) {
  const p = cameraPoint(cam, x, y);
  if (p.forward <= NEAR) return null;
  return {
    x: screen.cols / 2 - p.side / p.forward * screen.proj,
    y: cam.rowOf(z, p.forward),
    d: p.forward,
  };
}

function mixPoint(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    u: a.u + (b.u - a.u) * t,
  };
}

function clipEdge(cam, a, b) {
  let pa = { ...a, ...cameraPoint(cam, a.x, a.y) };
  let pb = { ...b, ...cameraPoint(cam, b.x, b.y) };
  if (pa.forward <= NEAR && pb.forward <= NEAR) return null;
  if (pa.forward <= NEAR) {
    const t = (NEAR - pa.forward) / (pb.forward - pa.forward);
    pa = { ...mixPoint(pa, pb, t), ...cameraPoint(cam,
      pa.x + (pb.x - pa.x) * t, pa.y + (pb.y - pa.y) * t) };
  }
  if (pb.forward <= NEAR) {
    const t = (NEAR - pb.forward) / (pa.forward - pb.forward);
    pb = { ...mixPoint(pb, pa, t), ...cameraPoint(cam,
      pb.x + (pa.x - pb.x) * t, pb.y + (pa.y - pb.y) * t) };
  }
  return [pa, pb];
}

function projectedVertex(screen, cam, p, z) {
  return {
    x: screen.cols / 2 - p.side / p.forward * screen.proj,
    y: cam.rowOf(z, p.forward),
    d: p.forward,
    u: p.u,
    z,
  };
}

function edge(a, b, x, y) {
  return (x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x);
}

function writePixel(screen, cam, x, y, d, colour, stats) {
  if (x < 0 || x >= screen.cols || y < 0 || y >= screen.rows || !Number.isFinite(d)) return;
  if (!screen.setMeshDepth(x, y, colour, d)) return;
  stats.pixels++;

  // drawSky paints directly to the canvas before the grid is blitted. Extend
  // the raycaster's opaque coverage so stars, the Moon and the gradient stay
  // behind polygon buildings too.
  if (y < Math.ceil(cam.hz)) {
    if (screen.hasHoles[x]) {
      const base = x * screen.covWords;
      screen.holeMask[base + (y >> 5)] |= 1 << (y & 31);
    } else if (y < screen.skyEnd[x]) {
      screen.skyEnd[x] = y;
    }
  }
}

function baseColour(building) {
  return MATERIAL[building.mat] || FACADE[building.pal & (FACADE.length - 1)];
}

function solidFacadeColour(building, d, faceLight, L) {
  const base = baseColour(building);
  const a = L.amb * faceLight;
  return L.depth(base[0] * a, base[1] * a, base[2] * a, fogOf(d));
}

function facadeColour(building, u, z, d, faceLight, L) {
  const floor = Math.max(0, Math.floor(z / FLOOR_H));
  const floorPart = z / FLOOR_H - floor;
  const bay = Math.floor(u / WINDOW_W);
  const bayPart = u / WINDOW_W - bay;
  const pane = floorPart > WINDOW_LO && floorPart < WINDOW_HI
    && bayPart > WINDOW_MARGIN && bayPart < 1 - WINDOW_MARGIN;
  const f = fogOf(d);

  if (pane) {
    const lit = hash((building._meshId || 0) * 131 + bay, floor * 17 + 7, 0) < L.litProb;
    if (lit) {
      const warm = 0.86 + hash(bay, floor, building._meshId || 0) * 0.18;
      return L.depth(255 * warm, 196 * warm, 112 * warm, Math.max(0.22, f));
    }
    const glass = building.mat === 1 ? [48, 78, 106] : [54, 66, 76];
    return L.depth(glass[0] * faceLight, glass[1] * faceLight,
                   glass[2] * faceLight, f);
  }

  return solidFacadeColour(building, d, faceLight, L);
}

function interpolateCameraPoint(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    forward: a.forward + (b.forward - a.forward) * t,
    side: a.side + (b.side - a.side) * t,
    u: a.u + (b.u - a.u) * t,
  };
}

function queueFacade(screen, cam, building, ca, cb, topA, topB, botA, botB,
                     faceLight, L) {
  if (!screen.meshSurfaces) return;
  const d = (ca.forward + cb.forward) * 0.5;
  const base = baseColour(building);
  const surface = {
    type: 'wall',
    depth: d,
    points: [topA, topB, botB, botA],
    fill: solidFacadeColour(building, d, faceLight, L),
    stroke: L.depth(base[0] * L.amb * 0.34, base[1] * L.amb * 0.34,
                    base[2] * L.amb * 0.34, fogOf(d)),
    windows: [],
  };
  screen.meshSurfaces.push(surface);

  const pixelW = Math.abs(topB.x - topA.x) * screen.cw;
  const pixelH = Math.max(Math.abs(botA.y - topA.y), Math.abs(botB.y - topB.y)) * screen.ch;
  const du = cb.u - ca.u;
  if (pixelW * pixelH < 90 || Math.abs(du) < 1e-6 ||
      screen.meshPaneCount >= MAX_VECTOR_WINDOWS) return;

  const uMin = Math.min(ca.u, cb.u);
  const uMax = Math.max(ca.u, cb.u);
  const firstBay = Math.floor(uMin / WINDOW_W);
  const lastBay = Math.floor(uMax / WINDOW_W);
  const floors = Math.max(1, Math.ceil(building.h / FLOOR_H));

  for (let floor = 0; floor < floors; floor++) {
    const z0 = Math.min(building.h, (floor + WINDOW_LO) * FLOOR_H);
    const z1 = Math.min(building.h, (floor + WINDOW_HI) * FLOOR_H);
    if (z1 <= z0) continue;
    for (let bay = firstBay; bay <= lastBay; bay++) {
      const u0 = Math.max(uMin, (bay + WINDOW_MARGIN) * WINDOW_W);
      const u1 = Math.min(uMax, (bay + 1 - WINDOW_MARGIN) * WINDOW_W);
      if (u1 <= u0) continue;
      const t0 = (u0 - ca.u) / du;
      const t1 = (u1 - ca.u) / du;
      if (t0 < -1e-5 || t0 > 1.00001 || t1 < -1e-5 || t1 > 1.00001) continue;
      const p0 = interpolateCameraPoint(ca, cb, t0);
      const p1 = interpolateCameraPoint(ca, cb, t1);
      const points = [
        projectedVertex(screen, cam, p0, z1),
        projectedVertex(screen, cam, p1, z1),
        projectedVertex(screen, cam, p1, z0),
        projectedVertex(screen, cam, p0, z0),
      ];
      const minX = Math.min(...points.map((p) => p.x));
      const maxX = Math.max(...points.map((p) => p.x));
      const minY = Math.min(...points.map((p) => p.y));
      const maxY = Math.max(...points.map((p) => p.y));
      if (maxX < 0 || minX >= screen.cols || maxY < 0 || minY >= screen.rows ||
          (maxX - minX) * screen.cw < 1.2 || (maxY - minY) * screen.ch < 1.2) continue;
      surface.windows.push({
        points,
        fill: facadeColour(building, (u0 + u1) * 0.5, (z0 + z1) * 0.5,
                            (p0.forward + p1.forward) * 0.5, faceLight, L),
      });
      screen.meshPaneCount++;
      if (screen.meshPaneCount >= MAX_VECTOR_WINDOWS) return;
    }
  }
}

function rasterTriangle(screen, cam, a, b, c, paint, stats) {
  const area = edge(a, b, c.x, c.y);
  if (Math.abs(area) < 1e-7) return;
  const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
  const x1 = Math.min(screen.cols - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
  const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
  const y1 = Math.min(screen.rows - 1, Math.ceil(Math.max(a.y, b.y, c.y)));

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const wa = edge(b, c, px, py) / area;
      const wb = edge(c, a, px, py) / area;
      const wc = 1 - wa - wb;
      if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) continue;
      const invD = wa / a.d + wb / b.d + wc / c.d;
      if (invD <= 0) continue;
      const d = 1 / invD;
      const u = (wa * a.u / a.d + wb * b.u / b.d + wc * c.u / c.d) * d;
      const z = (wa * a.z / a.d + wb * b.z / b.d + wc * c.z / c.d) * d;
      writePixel(screen, cam, x, y, d, paint(u, z, d), stats);
    }
  }
}

function drawFacade(screen, cam, building, a, b, u0, u1, L, stats) {
  const clipped = clipEdge(cam, { x: a[0], y: a[1], u: u0 }, { x: b[0], y: b[1], u: u1 });
  if (!clipped) return;
  const [ca, cb] = clipped;
  const topA = projectedVertex(screen, cam, ca, building.h);
  const topB = projectedVertex(screen, cam, cb, building.h);
  const botA = projectedVertex(screen, cam, ca, 0);
  const botB = projectedVertex(screen, cam, cb, 0);

  if (Math.max(topA.x, topB.x, botA.x, botB.x) < 0 ||
      Math.min(topA.x, topB.x, botA.x, botB.x) >= screen.cols) return;

  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const faceLight = 0.62 + 0.38 * Math.abs(nx * 0.58 + ny * 0.82);
  const paint = (u, z, d) => facadeColour(building, u, z, d, faceLight, L);
  rasterTriangle(screen, cam, topA, topB, botB, paint, stats);
  rasterTriangle(screen, cam, topA, botB, botA, paint, stats);
  queueFacade(screen, cam, building, ca, cb, topA, topB, botA, botB, faceLight, L);
  stats.facades++;
}

function drawRoof(screen, cam, building, L, stats) {
  if (cam.z <= building.h + 0.02) return;
  const projected = [];
  for (const ring of building.rings) {
    const out = [];
    for (const [x, y] of ring) {
      const p = projectBuildingPoint(screen, cam, x, y, building.h);
      if (!p) return; // near-plane clipping a concave roof is not worth guessing
      out.push(p);
    }
    projected.push(out);
  }

  let y0 = screen.rows - 1, y1 = 0;
  for (const ring of projected) for (const p of ring) {
    y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
  }
  y0 = Math.max(0, Math.floor(y0));
  y1 = Math.min(screen.rows - 1, Math.ceil(y1));
  const base = baseColour(building);
  const roofLight = L.amb * 1.18;
  if (screen.meshSurfaces) {
    const points = projected.flat();
    const depth = points.reduce((sum, p) => sum + p.d, 0) / Math.max(1, points.length);
    screen.meshSurfaces.push({
      type: 'roof',
      depth,
      rings: projected,
      fill: L.depth(base[0] * roofLight, base[1] * roofLight,
                    base[2] * roofLight, fogOf(depth)),
      stroke: L.depth(base[0] * L.amb * 0.45, base[1] * L.amb * 0.45,
                      base[2] * L.amb * 0.45, fogOf(depth)),
    });
  }

  for (let y = y0; y <= y1; y++) {
    const scanY = y + 0.5;
    const xs = [];
    for (const ring of projected) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if ((a.y > scanY) !== (b.y > scanY)) {
          xs.push(a.x + (scanY - a.y) / (b.y - a.y) * (b.x - a.x));
        }
      }
    }
    xs.sort((a, b) => a - b);
    const d = cam.distOf(building.h, y);
    if (!(d > NEAR)) continue;
    const colour = L.depth(base[0] * roofLight, base[1] * roofLight,
                           base[2] * roofLight, fogOf(d));
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
      const xb = Math.min(screen.cols - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = xa; x <= xb; x++) writePixel(screen, cam, x, y, d, colour, stats);
    }
  }
  stats.roofs++;
}

function drawBuilding(screen, cam, building, L, stats) {
  for (const ring of building.rings) {
    let u = 0;
    const count = ring.length;
    for (let i = 0; i < count; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % count];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len > 1e-6) drawFacade(screen, cam, building, a, b, u, u + len, L, stats);
      u += len;
    }
  }
  drawRoof(screen, cam, building, L, stats);
}

/** Render original OSM footprint edges into the shared colour/depth buffers. */
export function renderBuildingMeshes(screen, cam, world, L) {
  const stats = { candidates: 0, buildings: 0, facades: 0, roofs: 0, pixels: 0 };
  if (!world?.buildingIndex?.query || !world.buildings || world.buildings.length <= 1) return stats;
  screen.meshPaneCount = 0;
  const radius = MAXD + 32;
  const candidates = world.buildingIndex.query({
    minX: cam.x - radius, maxX: cam.x + radius,
    minY: cam.y - radius, maxY: cam.y + radius,
  });
  stats.candidates = candidates.length;

  // Near buildings first. The spatial hash returns bucket order, which is
  // arbitrary with respect to the camera, so without this the window-pane
  // budget is spent on whichever facades happen to come out of the Map first
  // and the nearest tower can end up flat while a distant one is detailed.
  // Drawing front to back also rejects more depth samples earlier.
  const visible = [];
  for (let i = 0; i < candidates.length; i++) {
    const building = candidates[i];
    if (!building?.rings?.length) continue;
    const reach = MAXD + (building.r || 0);
    const dx = building.cx - cam.x, dy = building.cy - cam.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > reach * reach) continue;
    visible.push([d2, building]);
  }
  visible.sort((a, b) => a[0] - b[0]);

  for (const [, building] of visible) {
    drawBuilding(screen, cam, building, L, stats);
    stats.buildings++;
  }
  screen.meshStats = stats;
  return stats;
}
