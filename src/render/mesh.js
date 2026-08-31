/**
 * Projecting and rasterizing small oriented solids into the cell/depth grid.
 *
 * Cars were the first thing to need this: a handful of boxes, projected corner
 * by corner and filled as triangles, rather than a fixed sprite that ignores
 * which way the object is facing. Aircraft need exactly the same machinery, so
 * it lives here instead of staying private to one layer.
 *
 * Two coordinate frames matter:
 *
 *   world     absolute cells, what the camera and the height field use
 *   local     along / side / up, relative to an origin and a heading vector
 *
 * `local` is what a model is authored in: nose at +along, right wing at +side,
 * fin at +up. A context carries the origin, the heading, an optional pitch and
 * the base height, so a model's numbers never mention the camera.
 *
 * Everything here writes through `screen.setDepth`, so a solid occludes and is
 * occluded per cell. A layer that paints with `screen.set` instead leaves the
 * depth buffer at its cleared value and becomes invisible to every later pass.
 */

/**
 * Bind a camera, a screen and a world origin.
 *
 * `pitch` rotates the model nose-up about its lateral axis, in radians. `z0`
 * is the height the model's `up = 0` plane sits at. Both default to the
 * ground-level, unpitched case a vehicle wants.
 */
export function meshContext(cam, screen, x, y, { pitch = 0, z0 = 0 } = {}) {
  return {
    cam,
    screen,
    fx: Math.cos(cam.angle),
    fy: Math.sin(cam.angle),
    x,
    y,
    z0,
    pitch,
    cosP: pitch ? Math.cos(pitch) : 1,
    sinP: pitch ? Math.sin(pitch) : 0,
  };
}

/**
 * One absolute world point to a screen cell.
 *
 * The same pinhole every other world-anchored layer uses: streets, signs,
 * labels, buildings and the sky all compute a column this way. A projector
 * that disagrees puts its objects somewhere the rest of the scene is not.
 */
export function project(ctx, x, y, z) {
  const dx = x - ctx.cam.x;
  const dy = y - ctx.cam.y;
  const d = dx * ctx.fx + dy * ctx.fy;
  if (d <= 0.08) return null;
  const side = -dx * ctx.fy + dy * ctx.fx;
  return {
    x: ctx.screen.cols / 2 - side / d * ctx.cam.proj,
    y: ctx.cam.rowOf(z, d),
    d,
  };
}

/**
 * One model-local point to a screen cell.
 *
 * `hx, hy` is the unit heading. The lateral axis is its right-hand normal, so
 * a positive `side` is the object's right regardless of which way it faces.
 */
export function localPoint(ctx, hx, hy, along, side, up) {
  let a = along;
  let z = up;
  if (ctx.sinP !== 0) {
    a = ctx.cosP * along - ctx.sinP * up;
    z = ctx.sinP * along + ctx.cosP * up;
  }
  const rx = hy;
  const ry = -hx;
  return project(ctx,
    ctx.x + hx * a + rx * side,
    ctx.y + hy * a + ry * side,
    ctx.z0 + z);
}

/**
 * Fill one projected triangle, depth-tested per cell.
 *
 * Depth is interpolated in 1/d rather than d, because screen-space linear
 * interpolation of distance is wrong under perspective and shows up as a
 * surface that wins the depth test at one end and loses it at the other.
 *
 * @returns {number} cells actually painted
 */
export function rasterTriangle(screen, a, b, c, glyph, colour, tolerance = 0.025) {
  if (!a || !b || !c) return 0;
  const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (Math.abs(area) < 1e-5) return 0;
  const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
  const maxX = Math.min(screen.cols - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
  const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
  const maxY = Math.min(screen.rows - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
  const invArea = 1 / area;
  let painted = 0;
  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const wa = ((b.x - px) * (c.y - py) - (b.y - py) * (c.x - px)) * invArea;
      const wb = ((c.x - px) * (a.y - py) - (c.y - py) * (a.x - px)) * invArea;
      const wc = 1 - wa - wb;
      if (wa < -0.001 || wb < -0.001 || wc < -0.001) continue;
      const invD = wa / a.d + wb / b.d + wc / c.d;
      if (invD <= 0) continue;
      const d = 1 / invD;
      const index = y * screen.cols + x;
      if (d > screen.depth[index] + tolerance) continue;
      screen.setDepth(x, y, glyph, colour, d);
      painted++;
    }
  }
  return painted;
}

/** Two triangles over four projected corners, in order. */
export function rasterQuad(screen, points, glyph, colour, tolerance = 0.025) {
  return rasterTriangle(screen, points[0], points[1], points[2], glyph, colour, tolerance) +
    rasterTriangle(screen, points[0], points[2], points[3], glyph, colour, tolerance);
}

/**
 * One projected point as a single cell. Lamps, wheels and other details that
 * are smaller than a cell but should not disappear entirely.
 */
export function stamp(screen, p, glyph, colour, depthBias = 0, tolerance = 0.08) {
  if (!p) return 0;
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  if (x < 0 || x >= screen.cols || y < 0 || y >= screen.rows) return 0;
  const d = p.d + depthBias;
  const index = y * screen.cols + x;
  if (d > screen.depth[index] + tolerance) return 0;
  screen.setDepth(x, y, glyph, colour, d);
  return 1;
}

/**
 * Stamp the cells along a projected segment.
 *
 * A filled quad only paints where a cell centre falls inside it, which is the
 * right rule for a solid but loses anything thinner than a cell. A wing seen
 * head-on is a few hundredths of a row tall and vanishes entirely, however
 * wide it is. Stroking the edge keeps thin structure legible at exactly the
 * distances where a filled mesh has nothing left to say, which is most of them
 * in a character grid.
 *
 * Depth is interpolated linearly in 1/d along the segment, matching the fill.
 */
export function strokeSegment(screen, a, b, glyph, colour, depthBias = 0, tolerance = 0.04) {
  if (!a || !b) return 0;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)));
  if (!Number.isFinite(steps)) return 0;
  const n = Math.max(1, Math.min(512, steps));
  const invA = 1 / a.d;
  const invB = 1 / b.d;
  let painted = 0;
  let lastX = -1;
  let lastY = -1;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = Math.round(a.x + dx * t);
    const y = Math.round(a.y + dy * t);
    if (x === lastX && y === lastY) continue;
    lastX = x; lastY = y;
    if (x < 0 || x >= screen.cols || y < 0 || y >= screen.rows) continue;
    const inv = invA + (invB - invA) * t;
    if (inv <= 0) continue;
    const d = 1 / inv + depthBias;
    const index = y * screen.cols + x;
    if (d > screen.depth[index] + tolerance) continue;
    screen.setDepth(x, y, glyph, colour, d);
    painted++;
  }
  return painted;
}

/**
 * On-screen width of a tube of world radius `r` at depth `d`, measured across
 * a segment whose screen-space unit normal is `(nx, ny)`.
 *
 * A round section projects to an ellipse, because cells are taller than they
 * are wide: `r * proj / d` columns across but only `r * vscale / d` rows tall.
 * A fuselage crossing the view therefore needs a different capsule width from
 * the same fuselage pointing at you, and this is that width without any
 * per-view special casing.
 */
export function radialWidth(cam, d, r, nx, ny) {
  const wx = r * cam.proj / d;
  const wy = r * cam.vscale / d;
  return 2 * Math.hypot(wx * nx, wy * ny);
}

/**
 * Stroke a segment with thickness, in cells, measured on screen.
 *
 * `strokeSegment` draws a hairline, which keeps thin structure alive but gives
 * an object no mass: a fuselage a metre and a half across is a hairline at
 * every distance, so an airliner reads as a bare cross rather than a body with
 * wings. This walks the same line and stamps a perpendicular run of cells,
 * with the half-width interpolated end to end so a tapering part narrows the
 * way perspective says it should.
 *
 * `w0` and `w1` are full widths in CELLS at each end, already projected by the
 * caller (world size * cam.proj / depth). Anything under one cell still paints
 * one cell, which is the floor that stops a part flickering in and out.
 */
export function strokeTapered(screen, a, b, w0, w1, glyph, colour,
  depthBias = 0, tolerance = 0.04, yScale = 1) {
  if (!a || !b) return 0;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.min(512, Math.ceil(len * 2)));
  // Perpendicular in screen space, so the run is across the line however the
  // object is oriented. `yScale` is cw/ch: cells are taller than they are
  // wide, so an offset of one cell vertically covers more ground than one
  // cell horizontally. Without it a round fuselage would come out oval.
  const nx = len > 1e-6 ? -dy / len : 0;
  const ny = (len > 1e-6 ? dx / len : 1) * yScale;
  const invA = 1 / a.d;
  const invB = 1 / b.d;
  let painted = 0;
  const seen = new Set();
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = a.x + dx * t;
    const cy = a.y + dy * t;
    const inv = invA + (invB - invA) * t;
    if (inv <= 0) continue;
    const d = 1 / inv + depthBias;
    const half = Math.max(0.5, (w0 + (w1 - w0) * t) * 0.5);
    const span = Math.ceil(half);
    for (let k = -span; k <= span; k++) {
      const s = (k / Math.max(1, span)) * half;
      const x = Math.round(cx + nx * s);
      const y = Math.round(cy + ny * s);
      if (x < 0 || x >= screen.cols || y < 0 || y >= screen.rows) continue;
      const index = y * screen.cols + x;
      if (seen.has(index)) continue;
      seen.add(index);
      if (d > screen.depth[index] + tolerance) continue;
      screen.setDepth(x, y, glyph, colour, d);
      painted++;
    }
  }
  return painted;
}

/**
 * The eight corners of a box, bottom face first then top, each face wound the
 * same way. The top may be inset from the bottom, which is what turns a plain
 * box into a car roof or a wing with taper.
 */
export function prismVertices(ctx, hx, hy, halfL, halfW, z0, z1,
  topHalfL = halfL, topHalfW = halfW, offset = 0) {
  const bottom = [
    localPoint(ctx, hx, hy, -halfL + offset, -halfW, z0),
    localPoint(ctx, hx, hy, halfL + offset, -halfW, z0),
    localPoint(ctx, hx, hy, halfL + offset, halfW, z0),
    localPoint(ctx, hx, hy, -halfL + offset, halfW, z0),
  ];
  const top = [
    localPoint(ctx, hx, hy, -topHalfL + offset, -topHalfW, z1),
    localPoint(ctx, hx, hy, topHalfL + offset, -topHalfW, z1),
    localPoint(ctx, hx, hy, topHalfL + offset, topHalfW, z1),
    localPoint(ctx, hx, hy, -topHalfL + offset, topHalfW, z1),
  ];
  return bottom.concat(top);
}

/**
 * The five faces of a prism that can ever be seen from outside it, painted
 * back to front so the near face wins where the depth test is a tie.
 *
 * `paint(role, nx, ny)` returns `[glyph, colour]` for one face. The caller
 * owns the material; this owns the geometry and the ordering.
 */
export function drawPrism(screen, vertices, hx, hy, paint, roles, tolerance = 0.025) {
  const rx = hy;
  const ry = -hx;
  const faces = [
    { p: [vertices[4], vertices[5], vertices[6], vertices[7]], role: roles.top, nx: 0, ny: 0 },
    { p: [vertices[1], vertices[2], vertices[6], vertices[5]], role: roles.front, nx: hx, ny: hy },
    { p: [vertices[3], vertices[0], vertices[4], vertices[7]], role: roles.rear, nx: -hx, ny: -hy },
    { p: [vertices[0], vertices[1], vertices[5], vertices[4]], role: roles.side, nx: -rx, ny: -ry },
    { p: [vertices[2], vertices[3], vertices[7], vertices[6]], role: roles.side, nx: rx, ny: ry },
  ];
  faces.sort((a, b) => {
    const ad = a.p.reduce((sum, p) => sum + (p?.d || 0), 0) / 4;
    const bd = b.p.reduce((sum, p) => sum + (p?.d || 0), 0) / 4;
    return bd - ad;
  });
  let cells = 0;
  for (const face of faces) {
    const [glyph, colour] = paint(face.role, face.nx, face.ny);
    cells += rasterQuad(screen, face.p, glyph, colour, tolerance);
  }
  return cells;
}
