import { MAXD, FOG_FULL } from '../config.js';
import { fogOf } from './materials.js';
import { cameraEnvelope, semanticCandidates } from '../spatial.js';

/**
 * The street renderer for ASCII City v2.
 *
 * v1 painted roads as a textured floor of `=`/`-` glyphs, which reads as noise
 * rather than lines. v2 draws the road network as projected polylines: each OSM
 * way is a list of world points, and a 3D line projects to a 2D line, so the
 * streets come out genuinely straight in perspective. At a shared vertex two or
 * more roads meet, and we stamp a box-drawing join so the crossing reads as a
 * crossing.
 *
 * The world is flat (h = 0 everywhere), so there is no height-field raycast and
 * no occlusion: the only depth question is "which road is nearer", answered by
 * painter's algorithm. We draw far roads first and let nearer ones overdraw.
 *
 * A subtlety: a long straight road may have only two vertices, both far off to
 * the sides of the screen. Projecting just the vertices would drop the whole
 * road, even though it crosses the screen in the middle. So every segment is
 * clipped to the camera's near plane and to the screen's left/right edges before
 * it is rasterized. That is what makes a straight avenue read as one straight
 * line instead of vanishing.
 */

const FAR = Math.min(MAXD, FOG_FULL);

/* --------------------------- projection --------------------------- */

/**
 * Project a world point to a screen cell, or null if behind the camera.
 * Returns { col, row, d } where d is the forward distance.
 *
 * Uses the same handedness as camera.buildRays: screen columns increase to the
 * right while angles increase counter-clockwise, so the fan runs DOWN across
 * the screen. `side` is positive to the LEFT (fwd rotated counter-clockwise),
 * which is why it subtracts. This is the exact projection v1's label system
 * uses, so street lines land where v1 would put street names.
 */
function project(cam, screen, wx, wy) {
  const dx = wx - cam.x;
  const dy = wy - cam.y;
  const fwdX = Math.cos(cam.angle);
  const fwdY = Math.sin(cam.angle);
  const along = dx * fwdX + dy * fwdY;
  if (along <= 0.05) return null;                 // behind the camera
  const side = -dx * fwdY + dy * fwdX;
  const d = along;
  const col = screen.cols / 2 - (side / along) * cam.proj;
  const row = cam.hz + cam.z * screen.vscale / along;
  return { col, row, d };
}

/**
 * Clip a world-space segment to the camera's near plane and to the screen's
 * left/right edges, then project the (possibly shortened) endpoints. Returns
 * the two projected endpoints, or null if the segment is entirely outside.
 *
 * The near-plane clip keeps `along` positive so the perspective divide is
 * well-behaved; the side clip keeps the segment from wrapping across the
 * screen when it passes the camera's left or right edge.
 */
function clipAndProject(cam, screen, ax, ay, bx, by) {
  let fwdX = Math.cos(cam.angle);
  let fwdY = Math.sin(cam.angle);
  const dxa = ax - cam.x, dya = ay - cam.y;
  const dxb = bx - cam.x, dyb = by - cam.y;
  // Forward (along) and side components in the camera frame. `along` is what
  // the perspective divide uses; `side` is the horizontal screen offset.
  let aA = dxa * fwdX + dya * fwdY;
  let aS = -dxa * fwdY + dya * fwdX;
  let bA = dxb * fwdX + dyb * fwdY;
  let bS = -dxb * fwdY + dyb * fwdX;

  // Clip to the near plane (along > NEAR).
  const NEAR = 0.1;
  if (aA < NEAR && bA < NEAR) return null;
  if (aA < NEAR) {
    const t = (NEAR - aA) / (bA - aA);
    aA = NEAR; aS = aS + (bS - aS) * t;
  } else if (bA < NEAR) {
    const t = (NEAR - bA) / (aA - bA);
    bA = NEAR; bS = bS + (aS - bS) * t;
  }

  // Clip to the screen's left/right edges in side space. Each endpoint is
  // clamped to its own edge independently, so a segment that crosses from one
  // side of the view to the other survives (a horizontal road in front of the
  // camera goes from far-left to far-right). The half-width is recomputed from
  // each endpoint's own forward distance, because the near-plane clip above can
  // leave one endpoint very close to the camera where the screen is narrow.
  const halfWOf = (A) => (screen.cols / 2) * (A / cam.proj) * 1.02;
  let halfWa = halfWOf(aA);
  if (aS > halfWa) {
    const t = (halfWa - aS) / (bS - aS);
    aA = aA + (bA - aA) * t;
    aS = halfWa;
  } else if (aS < -halfWa) {
    const t = (-halfWa - aS) / (bS - aS);
    aA = aA + (bA - aA) * t;
    aS = -halfWa;
  }
  let halfWb = halfWOf(bA);
  if (bS > halfWb) {
    const t = (halfWb - bS) / (aS - bS);
    bA = bA + (aA - bA) * t;
    bS = halfWb;
  } else if (bS < -halfWb) {
    const t = (-halfWb - bS) / (aS - bS);
    bA = bA + (aA - bA) * t;
    bS = -halfWb;
  }
  // A small epsilon tolerates the exact-edge case from the clip above, where a
  // clamped endpoint sits precisely on the boundary.
  const EPS = 1e-6;
  if (aS > halfWOf(aA) + EPS || aS < -halfWOf(aA) - EPS ||
      bS > halfWOf(bA) + EPS || bS < -halfWOf(bA) - EPS) return null;

  const aCol = screen.cols / 2 - (aS / aA) * cam.proj;
  const bCol = screen.cols / 2 - (bS / bA) * cam.proj;
  const aRow = cam.hz + cam.z * screen.vscale / aA;
  const bRow = cam.hz + cam.z * screen.vscale / bA;
  return {
    a: { col: aCol, row: aRow, d: aA },
    b: { col: bCol, row: bRow, d: bA },
  };
}

/* --------------------------- line raster --------------------------- */

/**
 * Choose a line character from the screen-space direction of a segment.
 * Near-vertical -> '|', near-horizontal -> '-', diagonals -> '/' '\'.
 * This is what keeps a straight road reading as a straight line instead of a
 * staircase of floor glyphs.
 */
function lineChar(dCol, dRow) {
  const a = Math.abs(dRow) / (Math.abs(dCol) + Math.abs(dRow) + 1e-9);
  if (a < 0.18) return '-';
  if (a > 0.82) return '|';
  // Diagonal: sign of the slope picks the slash direction.
  return (dCol * dRow >= 0) ? '\\' : '/';
}

/**
 * Rasterize one projected segment (screen-space, already perspective-correct)
 * into the grid, painting each cell with `ch` and `colour` at depth `d`.
 * We step in the dominant axis and accept the minor-axis step so diagonals get
 * their proper character.
 *
 * When drawn on top of the raycaster's output (renderScene), `screen.depth`
 * already holds the distance of any building in front. A road line only paints
 * where nothing nearer exists, so buildings correctly occlude the streets —
 * the depth test is what lets a line renderer coexist with a height field.
 */
function plotSeg(screen, x0, y0, x1, y1, ch, colour, d0, d1 = d0) {
  const ex = Math.round(x1);
  const ey = Math.round(y1);
  let cx = Math.round(x0);
  let cy = Math.round(y0);
  const dx = ex - cx;
  const dy = ey - cy;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
  const sx = dx / steps;
  const sy = dy / steps;
  for (let i = 0; i <= steps; i++) {
    if (cx >= 0 && cx < screen.cols && cy >= 0 && cy < screen.rows) {
      const i2 = cy * screen.cols + cx;
      // Perspective makes the forward distance change along a segment. Using
      // the nearest endpoint for every cell makes a distant road appear to be
      // in front of a nearer building. Interpolate the depth per raster step
      // so the road line is occluded correctly at every screen cell.
      const u = steps ? i / steps : 0;
      const d = d0 + (d1 - d0) * u;
      // Only draw where the road is at least as near as what's there. Equal
      // depth (the pavement we just laid) is allowed; nearer geometry wins.
      if (screen.depth[i2] >= d) screen.setDepth(cx, cy, ch, colour, d);
    }
    cx = Math.round(x0 + sx * i);
    cy = Math.round(y0 + sy * i);
  }
}

/* --------------------------- class colours --------------------------- */

const ROAD_COLOUR = {
  motorway: [255, 150, 120],
  trunk: [255, 170, 130],
  primary: [220, 200, 150],
  secondary: [180, 200, 210],
  tertiary: [150, 180, 200],
  residential: [150, 160, 175],
  unclassified: [150, 160, 175],
  living_street: [150, 160, 175],
  service: [110, 120, 135],
  pedestrian: [120, 150, 130],
  footway: [110, 140, 120],
  path: [110, 140, 120],
  cycleway: [120, 150, 160],
  steps: [120, 140, 130],
  track: [120, 120, 110],
};

function classColour(cls, L, f) {
  const base = ROAD_COLOUR[cls] || [150, 160, 175];
  return L.depth(base[0], base[1], base[2], f);
}

/* --------------------------- the renderer --------------------------- */

export function renderStreets(screen, cam, world, L, env) {
  const envelope = env?.envelope || env || cameraEnvelope(cam, FAR);
  const roads = semanticCandidates(world, env, 'roads', cam, FAR);
  if (roads.length === 0) return;

  // Project every road's vertices once, for the painter's sort.
  const proj = new Array(roads.length);
  for (let r = 0; r < roads.length; r++) {
    const pts = roads[r].pts;
    let nearest = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const p = project(cam, screen, pts[i][0], pts[i][1]);
      if (p && p.d < nearest) nearest = p.d;
    }
    proj[r] = { nearest, road: roads[r] };
  }

  // Painter's algorithm: far roads first, near roads overdraw.
  proj.sort((a, b) => b.nearest - a.nearest);

  for (let r = 0; r < proj.length; r++) {
    const road = proj[r].road;
    const pts = road.pts;
    for (let i = 1; i < pts.length; i++) {
      const seg = clipAndProject(cam, screen,
        pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
      if (!seg) continue;
      if (seg.a.d > FAR && seg.b.d > FAR) continue;
      const f = Math.max(0.08, fogOf(Math.min(seg.a.d, seg.b.d)));
      const ch = lineChar(seg.b.col - seg.a.col, seg.b.row - seg.a.row);
      const colour = classColour(road.cls, L, f);
      plotSeg(screen, seg.a.col, seg.a.row, seg.b.col, seg.b.row, ch, colour,
        seg.a.d, seg.b.d);
    }
  }

  // Joins: at every junction, stamp a box-drawing character so the crossing
  // reads as a crossing. Junctions come straight from the world (where two or
  // more named streets meet), so they are correct even when no road vertex
  // happens to fall exactly on the crossing.
  drawJoins(screen, cam, world, L, env || envelope);
}

/**
 * For each junction, project its centre and pick a join glyph from the screen-
 * space directions of the roads meeting there. A plain '+' is used when the
 * directions are ambiguous; the cardinal/diagonal box-drawing glyphs are used
 * when the crossing is clearly axis-aligned.
 */
function drawJoins(screen, cam, world, L, env) {
  const junctions = semanticCandidates(world, env, 'junctions', cam, FAR);
  for (let j = 0; j < junctions.length; j++) {
    const jn = junctions[j];
    const c = project(cam, screen, jn.x, jn.y);
    if (!c) continue;
    if (c.d > FAR) continue;
    if (c.col < 0 || c.col >= screen.cols || c.row < 0 || c.row >= screen.rows) continue;

    const f = Math.max(0.08, fogOf(c.d));
    const glyph = '+';
    const x = Math.round(c.col);
    const y = Math.round(c.row);
    const i = y * screen.cols + x;
    if (!screen.depth || screen.depth[i] >= c.d) {
      screen.setDepth(x, y, glyph, L.depth(210, 220, 235, f), c.d);
    }
  }
}

export { lineChar, clipAndProject, plotSeg };
