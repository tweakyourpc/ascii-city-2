import { MODE } from '../screen.js';
import { fogOf } from './materials.js';
import {
  meshContext, localPoint, rasterQuad, stamp, prismVertices as meshPrism,
  drawPrism as meshDrawPrism,
} from './mesh.js';

export const VEHICLE_LOD = Object.freeze({ FAR: 0, MID: 1, NEAR: 2 });
export const MAX_RICH_VEHICLES = 8;

const PAINT = [
  [166, 58, 48], [54, 91, 142], [176, 150, 72], [64, 120, 104],
  [154, 158, 164], [84, 78, 94], [132, 66, 88], [184, 178, 154],
];

const SHAPES = [
  { kind: 'sedan', length: 1.86, width: 0.78, bodyH: 0.37, height: 0.72,
    cabinLength: 1.02, cabinWidth: 0.68, cabinOffset: -0.03, roofScale: 0.78 },
  { kind: 'hatch', length: 1.66, width: 0.76, bodyH: 0.40, height: 0.76,
    cabinLength: 1.02, cabinWidth: 0.68, cabinOffset: -0.10, roofScale: 0.82 },
  { kind: 'suv', length: 1.94, width: 0.84, bodyH: 0.45, height: 0.84,
    cabinLength: 1.25, cabinWidth: 0.74, cabinOffset: -0.05, roofScale: 0.86 },
  { kind: 'van', length: 2.12, width: 0.86, bodyH: 0.53, height: 0.94,
    cabinLength: 1.56, cabinWidth: 0.76, cabinOffset: -0.05, roofScale: 0.92 },
];

// Rendering is synchronous. These scratch values avoid changing every car's
// hidden object shape or allocating a projection wrapper for every component.
// The mesh helpers take the context explicitly; this is where a car's one
// context per frame is parked so the drawing functions need not thread it.
let activeProjection = null;
let activeDistance = 0;
let activeX = 0;
let activeY = 0;

function mix32(value) {
  let n = value >>> 0;
  n ^= n >>> 16;
  n = Math.imul(n, 0x7feb352d);
  n ^= n >>> 15;
  n = Math.imul(n, 0x846ca68b);
  return (n ^ (n >>> 16)) >>> 0;
}

/** Stable, restrained vehicle variation. Construct once and keep on the car. */
export function vehicleProfile(seed) {
  const a = mix32(seed || 1);
  const b = mix32(a ^ 0x9e3779b9);
  const shape = SHAPES[a % SHAPES.length];
  const scale = 0.94 + ((b & 255) / 255) * 0.12;
  return Object.freeze({
    seed: seed >>> 0,
    kind: shape.kind,
    length: shape.length * scale,
    width: shape.width * (0.97 + (((b >>> 8) & 255) / 255) * 0.06),
    bodyH: shape.bodyH,
    height: shape.height,
    cabinLength: shape.cabinLength * scale,
    cabinWidth: shape.cabinWidth,
    cabinOffset: shape.cabinOffset,
    roofScale: shape.roofScale,
    paint: PAINT[(a >>> 5) % PAINT.length],
    condition: 0.84 + (((b >>> 16) & 255) / 255) * 0.20,
  });
}

export function vehicleLod(projectedRows, distance, rowStep = 1) {
  const lines = projectedRows / Math.max(1, rowStep);
  if (distance <= 16 || lines >= 4.2) return VEHICLE_LOD.NEAR;
  if (distance <= 68 && lines >= 1.15) return VEHICLE_LOD.MID;
  return VEHICLE_LOD.FAR;
}

/** Exponential heading response: quick enough for turns, with no snap or overshoot. */
export function smoothVehicleHeading(car, targetX, targetY, dt) {
  const targetLen = Math.hypot(targetX, targetY) || 1;
  const tx = targetX / targetLen;
  const ty = targetY / targetLen;
  if (!Number.isFinite(car.hx) || !Number.isFinite(car.hy)) {
    car.hx = tx;
    car.hy = ty;
    return;
  }
  const blend = 1 - Math.exp(-Math.max(0, dt) * 10);
  let hx = car.hx + (tx - car.hx) * blend;
  let hy = car.hy + (ty - car.hy) * blend;
  const len = Math.hypot(hx, hy) || 1;
  car.hx = hx / len;
  car.hy = hy / len;
}

function worldPoint(hx, hy, along, side, z) {
  return localPoint(activeProjection, hx, hy, along, side, z);
}

function faceColour(profile, L, f, role, nx = 0, ny = 0) {
  if (role === 'shadow') return L.depth(8, 10, 14, f);
  if (role.startsWith('window')) {
    const day = L.dayAmt;
    const lift = role === 'window-top' ? 1.18 : 1;
    return L.depth((12 + day * 34) * lift, (18 + day * 42) * lift,
      (28 + day * 56) * lift, f);
  }
  const sun = Math.max(0, nx * 0.48 + ny * -0.88);
  let shade = 0.29 + L.dayAmt * (0.52 + sun * 0.22);
  if (role === 'roof') shade *= 1.16;
  if (role === 'top') shade *= 1.13;
  if (role === 'front') shade *= 1.03;
  if (role === 'rear') shade *= 0.82;
  shade *= profile.condition;
  const [r, g, b] = profile.paint;
  return L.depth(r * shade, g * shade, b * shade, f);
}

function glyphFor(role, mode) {
  if (mode !== MODE.GLYPH) return ' ';
  if (role === 'shadow') return '_';
  if (role === 'roof') return '^';
  if (role === 'top') return '=';
  if (role === 'front') return '@';
  if (role === 'rear') return '%';
  if (role === 'window-top') return '-';
  if (role.startsWith('window')) return ':';
  return '#';
}

function prismVertices(hx, hy, halfL, halfW, z0, z1,
  topHalfL = halfL, topHalfW = halfW, offset = 0) {
  return meshPrism(activeProjection, hx, hy, halfL, halfW, z0, z1,
    topHalfL, topHalfW, offset);
}

const CAR_ROLES = {
  top: 'top', front: 'front', rear: 'rear', side: 'side',
};
const CABIN_ROLES = {
  top: 'roof', front: 'window-front', rear: 'window-rear', side: 'window-side',
};

function drawPrism(screen, car, profile, L, f, vertices, cabin = false) {
  return meshDrawPrism(screen, vertices, car.hx, car.hy,
    (role, nx, ny) => [
      glyphFor(role, screen.mode),
      faceColour(profile, L, f, role, nx, ny),
    ],
    cabin ? CABIN_ROLES : CAR_ROLES);
}

function drawLights(screen, car, profile, L, hx, hy, near) {
  const frontVisible = hx * (activeX - activeProjection.cam.x) +
    hy * (activeY - activeProjection.cam.y) < 0;
  const end = frontVisible ? profile.length * 0.5 : -profile.length * 0.5;
  const z = profile.bodyH * 0.56;
  const spread = profile.width * 0.31;
  const night = 1 - L.dayAmt;
  const colour = frontVisible
    ? L.depth(220 + night * 35, 214 + night * 35, 188 + night * 55, 1)
    : car.braking
      ? L.depth(255, 64 + night * 35, 42 + night * 24, 1)
      : L.depth(210 + night * 45, 28 + night * 35, 22 + night * 25, 1);
  const glyph = screen.mode === MODE.GLYPH ? (frontVisible ? '*' : 'o') : ' ';
  let cells = 0;
  cells += stamp(screen, worldPoint(hx, hy, end, -spread, z), glyph, colour, -0.025);
  cells += stamp(screen, worldPoint(hx, hy, end, spread, z), glyph, colour, -0.025);

  if (near && frontVisible && night > 0.38) {
    const glow = L.depth(90 * night, 82 * night, 58 * night, 0.9);
    const ahead = profile.length * 0.62;
    cells += stamp(screen, worldPoint(hx, hy, end + ahead, -spread * 0.75, 0.018), '.', glow, 0.03);
    cells += stamp(screen, worldPoint(hx, hy, end + ahead, spread * 0.75, 0.018), '.', glow, 0.03);
  }
  return cells;
}

function drawWheels(screen, profile, L, hx, hy) {
  const colour = L.depth(10, 12, 15, Math.max(0.25, fogOf(activeDistance)));
  const side = profile.width * 0.53;
  const along = profile.length * 0.30;
  let cells = 0;
  for (const a of [-along, along]) {
    for (const s of [-side, side]) {
      cells += stamp(screen, worldPoint(hx, hy, a, s, 0.12),
        screen.mode === MODE.GLYPH ? 'o' : ' ', colour, -0.018);
    }
  }
  return cells;
}

function drawFar(screen, profile, L, hx, hy) {
  const toward = hx * (activeX - activeProjection.cam.x) +
    hy * (activeY - activeProjection.cam.y) < 0;
  const end = toward ? profile.length * 0.5 : -profile.length * 0.5;
  const spread = profile.width * 0.30;
  const left = worldPoint(hx, hy, end, -spread, profile.bodyH * 0.55);
  const right = worldPoint(hx, hy, end, spread, profile.bodyH * 0.55);
  const centre = worldPoint(hx, hy, 0, 0, profile.bodyH * 0.62);
  const nose = worldPoint(hx, hy, profile.length * 0.5, 0, profile.bodyH * 0.62);
  if (!centre) return 0;
  const f = Math.max(0.12, fogOf(activeDistance));
  const body = faceColour(profile, L, f, 'side', hx, hy);
  const lamp = toward
    ? L.depth(255, 248, 218, Math.max(f, 0.5))
    : L.depth(255, 48, 34, Math.max(f, 0.5));
  const bodyGlyph = screen.mode === MODE.GLYPH ? '=' : ' ';
  let cells = stamp(screen, centre, bodyGlyph, body);
  // A two-cell minimum prevents daylight traffic collapsing into flickering
  // single pixels in elevated views. Follow the projected travel axis when it
  // is legible, otherwise use a horizontal pair as the stable fallback.
  let stepX = 1;
  let stepY = 0;
  if (nose) {
    const dx = nose.x - centre.x;
    const dy = nose.y - centre.y;
    if (Math.abs(dy) > Math.abs(dx)) {
      stepX = 0;
      stepY = dy < 0 ? -1 : 1;
    } else if (Math.abs(dx) > 0.01) {
      stepX = dx < 0 ? -1 : 1;
    }
  }
  cells += stamp(screen, {
    x: centre.x + stepX, y: centre.y + stepY, d: centre.d,
  }, bodyGlyph, body);
  if (L.dayAmt < 0.62) {
    const lampGlyph = screen.mode === MODE.GLYPH ? (toward ? '.' : 'o') : ' ';
    if (left && right && Math.abs(left.x - right.x) >= 0.75) {
      cells += stamp(screen, left, lampGlyph, lamp, -0.02);
      cells += stamp(screen, right, lampGlyph, lamp, -0.02);
    } else {
      const baseX = Math.round(centre.x);
      const y = Math.round(centre.y);
      for (const x of [baseX - 1, baseX + 1]) {
        if (x < 0 || x >= screen.cols || y < 0 || y >= screen.rows) continue;
        const index = y * screen.cols + x;
        if (centre.d <= screen.depth[index] + 0.08) {
          screen.setDepth(x, y, lampGlyph, lamp, centre.d - 0.02);
          cells++;
        }
      }
    }
  }
  return cells;
}

/** Draw one oriented pseudo-volumetric vehicle into the canonical cell/depth buffers. */
export function drawVehicle(screen, cam, L, car, {
  distance, rich = true, forcedLod = null,
} = {}) {
  const profile = car.vehicle || vehicleProfile(car.vehicleSeed || car.pal + 1);
  const hx0 = Number.isFinite(car.hx) ? car.hx : 1;
  const hy0 = Number.isFinite(car.hy) ? car.hy : 0;
  const headingLen = Math.hypot(hx0, hy0) || 1;
  const hx = hx0 / headingLen;
  const hy = hy0 / headingLen;
  activeX = Number.isFinite(car.renderX) ? car.renderX : car.x;
  activeY = Number.isFinite(car.renderY) ? car.renderY : car.y;
  const dx = activeX - cam.x;
  const dy = activeY - cam.y;
  const d = distance ?? Math.hypot(dx, dy);
  const centreDepth = dx * Math.cos(cam.angle) + dy * Math.sin(cam.angle);
  if (centreDepth <= 0.12) return { cells: 0, lod: VEHICLE_LOD.FAR };

  const projectedRows = profile.height * cam.vscale / centreDepth;
  let lod = vehicleLod(projectedRows, d, screen.rowStep || 1);
  if (!rich && lod === VEHICLE_LOD.NEAR) lod = VEHICLE_LOD.MID;
  if (forcedLod !== null) lod = forcedLod;
  activeProjection = meshContext(cam, screen, activeX, activeY);
  activeDistance = d;

  if (lod === VEHICLE_LOD.FAR) {
    const cells = drawFar(screen, profile, L, hx, hy);
    return { cells, lod };
  }

  const f = Math.max(0.12, fogOf(centreDepth));
  const halfL = profile.length * 0.5;
  const halfW = profile.width * 0.5;
  const shadow = [
    worldPoint(hx, hy, -halfL * 1.03, -halfW * 1.12, 0.014),
    worldPoint(hx, hy, halfL * 1.03, -halfW * 1.12, 0.014),
    worldPoint(hx, hy, halfL * 1.03, halfW * 1.12, 0.014),
    worldPoint(hx, hy, -halfL * 1.03, halfW * 1.12, 0.014),
  ];
  let cells = rasterQuad(screen, shadow, glyphFor('shadow', screen.mode),
    faceColour(profile, L, f, 'shadow'));

  const body = prismVertices(hx, hy, halfL, halfW, 0.07, profile.bodyH,
    halfL * 0.94, halfW * 0.96);
  cells += drawPrism(screen, car, profile, L, f, body, false);

  const cabinHalfL = profile.cabinLength * 0.5;
  const cabinHalfW = profile.cabinWidth * 0.5;
  const cabin = prismVertices(hx, hy, cabinHalfL, cabinHalfW,
    profile.bodyH * 0.82, profile.height,
    cabinHalfL * profile.roofScale, cabinHalfW * 0.88, profile.cabinOffset);
  cells += drawPrism(screen, car, profile, L, f, cabin, true);
  cells += drawLights(screen, car, profile, L, hx, hy, lod === VEHICLE_LOD.NEAR);
  if (lod === VEHICLE_LOD.NEAR) cells += drawWheels(screen, profile, L, hx, hy);

  return { cells, lod };
}
