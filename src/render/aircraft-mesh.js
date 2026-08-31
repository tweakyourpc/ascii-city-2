/**
 * An aircraft as an oriented solid, not a fixed glyph.
 *
 * The layer used to paint one `✈` per contact at every distance, so a 777 on
 * short final looked exactly like a regional jet at cruise. Here the published
 * dimensions for the type (see `aircraft-model.js`) are built into a handful
 * of boxes in the aircraft's own frame, rotated by its track and flight path
 * angle, and projected corner by corner through the same pinhole as the rest
 * of the world. Size then falls out of the projection rather than being
 * decided by a lookup table.
 *
 * Local frame, as the model table is authored:
 *
 *   +along   nose
 *   +side    right wing (starboard)
 *   +up      fin
 *
 * with `up = 0` on the fuselage centreline, which is the height ADS-B reports.
 */

import { MODE } from '../screen.js';
import { fogOf } from './materials.js';
import { MOUNT } from './aircraft-model.js';
import {
  meshContext, localPoint, rasterQuad, stamp, strokeSegment, strokeTapered,
  radialWidth, prismVertices, drawPrism,
} from './mesh.js';

export const AIR_LOD = Object.freeze({ GLYPH: 0, COARSE: 1, FULL: 2 });

/**
 * Detail from apparent wingspan in columns.
 *
 * Columns rather than rows: an aircraft is far wider than it is tall, so its
 * span is what decides whether there is anything worth drawing. A 737 at a
 * kilometre is about three columns across and has no business being a mesh.
 */
export function aircraftLod(projectedCols) {
  if (projectedCols >= 6) return AIR_LOD.FULL;
  if (projectedCols >= 1.5) return AIR_LOD.COARSE;
  return AIR_LOD.GLYPH;
}

/**
 * Flight path angle from vertical speed and ground speed.
 *
 * This is the angle the aircraft is travelling along, not its pitch attitude,
 * which ADS-B does not carry. On approach the two are close enough that the
 * silhouette reads correctly, and it is the honest quantity: it is derived
 * only from two numbers the aircraft actually broadcast.
 */
export function flightPathAngle(vertRateFtMin, gsKt) {
  if (!Number.isFinite(vertRateFtMin) || !Number.isFinite(gsKt)) return 0;
  const vs = vertRateFtMin / 60 / 3.2808399;     // ft/min -> m/s
  const gs = Math.abs(gsKt) * 0.514444;          // kt -> m/s
  if (gs < 1) return 0;
  const a = Math.atan2(vs, gs);
  return Math.max(-0.35, Math.min(0.35, a));
}

const ROLES = { top: 'top', front: 'front', rear: 'rear', side: 'side' };

/* Livery is not in the feed, so every hull is the same neutral scheme. Making
 * one up per airline would be invention presented as observation. */
const UPPER = [224, 228, 234];
const LOWER = [148, 154, 164];
const ENGINE = [92, 98, 108];

function shade(L, f, base, role, nx, ny) {
  const sun = Math.max(0, nx * 0.48 + ny * -0.88);
  let k = 0.30 + L.dayAmt * (0.54 + sun * 0.20);
  if (role === 'top') k *= 1.18;
  if (role === 'rear') k *= 0.84;
  return L.depth(base[0] * k, base[1] * k, base[2] * k, f);
}

function glyphFor(role, part, mode) {
  if (mode !== MODE.GLYPH) return ' ';
  // One glyph per part, not per face. '-' used to mean both "wing seen
  // edge-on" and "tailplane", which made the two indistinguishable on screen
  // and in a test.
  if (part === 'wing') return '=';
  if (part === 'fin') return '|';
  if (part === 'tail') return '-';
  if (part === 'engine') return 'o';
  if (role === 'top') return '=';
  if (role === 'front') return '@';
  if (role === 'rear') return '%';
  return '#';
}

function painter(L, f, base, part, mode) {
  return (role, nx, ny) => [
    glyphFor(role, part, mode),
    shade(L, f, base, role, nx, ny),
  ];
}

/** A crude stable hash, so each airframe strobes on its own phase. */
function phaseOf(icao) {
  let h = 2166136261;
  const s = icao || '';
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1200) / 1200;
}

function enginePositions(model) {
  const half = model.span / 2;
  if (model.mount === MOUNT.NOSE) return [{ side: 0, along: model.length * 0.42, up: 0 }];
  if (model.mount === MOUNT.TAIL) {
    const s = model.fuselage * 0.86;
    return [
      { side: -s, along: -model.length * 0.28, up: model.fuselage * 0.18 },
      { side: s, along: -model.length * 0.28, up: model.fuselage * 0.18 },
    ];
  }
  const up = -model.fuselage * 0.52;
  const along = model.length * 0.02;
  if (model.engines >= 4) {
    return [
      { side: -half * 0.46, along, up }, { side: -half * 0.28, along, up },
      { side: half * 0.28, along, up }, { side: half * 0.46, along, up },
    ];
  }
  return [
    { side: -half * 0.32, along, up },
    { side: half * 0.32, along, up },
  ];
}

/**
 * Draw one aircraft. Returns the cells painted and the screen box it covers,
 * which is what makes it clickable without recording every cell.
 */
export function drawAircraftMesh(screen, cam, L, contact) {
  const { x, y, z, hx, hy, pitch, model, depth: dist, lod, icao, now } = contact;
  const ctx = meshContext(cam, screen, x, y, { pitch, z0: z });
  const f = Math.max(0.12, fogOf(dist));
  const mode = screen.mode;

  const halfL = model.length / 2;
  const halfF = model.fuselage / 2;

  let cells = 0;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  // The depth SPAN, not just the centre. A 737 seen head-on has its nose
  // eight cells nearer than its centre, so a picker comparing a cell against
  // one representative depth rejects the whole front half of the aircraft.
  let d0 = Infinity, d1 = -Infinity;
  const note = (p) => {
    if (!p) return;
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
    if (p.d < d0) d0 = p.d;
    if (p.d > d1) d1 = p.d;
  };
  const noteAll = (vs) => { for (const v of vs) note(v); };

  /*
   * The signature: every part as a stroke that carries its own width.
   *
   * A filled quad only paints where a cell centre falls inside it, and at any
   * honest approach distance every part of an airliner is thinner than a cell
   * in at least one axis. A 737 at 350 m is twelve columns across and less
   * than one row tall below the fin, so a fill-only aircraft collapses to a
   * bare cross: a stalk on a bar, which reads as a tail assembly and not as an
   * aircraft. That is exactly what it did.
   *
   * The thing that fixes it is horizontal, not vertical. At that same range
   * the engines sit about two columns either side of the fuselage, which the
   * grid CAN resolve, and two pods under a bar is what makes a jet a jet. The
   * fills below still run when the aircraft is genuinely large; this is what
   * is on screen the rest of the time.
   */
  const signature = () => {
    const wingZ = model.wingZ;
    const b2 = model.span / 2;
    const rootAlong = -model.length * 0.02;
    // Sweep carries the tip aft, dihedral carries it up. Neither shows head-on
    // at range, but both are real and both matter the moment the view is
    // oblique or overhead, which is most of the time in a city.
    const tipAlong = rootAlong - b2 * Math.tan(model.sweep);
    const tipZ = wingZ + b2 * Math.tan(model.dihedral);

    const port = localPoint(ctx, hx, hy, tipAlong, -b2, tipZ);
    const starboard = localPoint(ctx, hx, hy, tipAlong, b2, tipZ);
    const rootP = localPoint(ctx, hx, hy, rootAlong, -halfF * 0.9, wingZ);
    const rootS = localPoint(ctx, hx, hy, rootAlong, halfF * 0.9, wingZ);
    const nose = localPoint(ctx, hx, hy, halfL, 0, 0);
    const tailEnd = localPoint(ctx, hx, hy, -halfL, 0, halfF * 0.35);

    // A T-tail carries its stabiliser on the fin tip. Every rear-engined jet
    // in the table is one, and drawing a CRJ with a fuselage-mounted tailplane
    // gets its silhouette wrong in the one way anybody would recognise.
    const finTopZ = model.height - halfF;
    const finAlong = -model.length * 0.41;
    const tailZ = model.ttail ? finTopZ : halfF * 0.55;
    const tailAlong = model.ttail ? finAlong : -model.length * 0.43;
    const t2 = model.tailSpan / 2;
    const finTip = localPoint(ctx, hx, hy, finAlong, 0, finTopZ);
    const tailPort = localPoint(ctx, hx, hy, tailAlong, -t2, tailZ);
    const tailStbd = localPoint(ctx, hx, hy, tailAlong, t2, tailZ);
    noteAll([port, starboard, rootP, rootS, nose, tailEnd, finTip, tailPort, tailStbd]);

    const wingCol = shade(L, f, UPPER, 'top', 0, -1);
    const bodyCol = shade(L, f, UPPER, 'side', 0, 0);
    const engCol = shade(L, f, ENGINE, 'side', 0, 0);
    const yScale = screen.cw / screen.ch;
    let n = 0;

    // Fuselage first and widest: it is the body everything else hangs off, and
    // a hairline version of it is why the aircraft had no mass. Crossing the
    // view a hairline also flickers, because a 0.7-row-tall quad catches cell
    // centres only intermittently as it moves.
    if (nose && tailEnd) {
      const dxF = tailEnd.x - nose.x, dyF = tailEnd.y - nose.y;
      const lenF = Math.hypot(dxF, dyF) || 1;
      const w = radialWidth(cam, dist, halfF, -dyF / lenF, dxF / lenF);
      n += strokeTapered(screen, nose, tailEnd, w * 0.75, w,
        glyphFor('side', 'fuse', mode), bodyCol, -0.005, 0.04, yScale);
    }

    n += strokeSegment(screen, rootP, port, glyphFor('top', 'wing', mode), wingCol, -0.01);
    n += strokeSegment(screen, rootS, starboard, glyphFor('top', 'wing', mode), wingCol, -0.01);
    n += strokeSegment(screen, tailEnd, finTip, glyphFor('side', 'fin', mode), bodyCol, -0.01);

    // The tailplane only earns its cells when it can land on a row of its own.
    // Head-on at range it is within a fraction of a row of the wing, where all
    // it can do is overprint the middle of the wing bar with tail depth and
    // re-label it as a stabiliser. Dropping it there is subtractive: nothing
    // is invented, a part that could not be resolved is simply not drawn.
    const tailRows = tailPort && rootP ? Math.abs(tailPort.y - rootP.y) : 0;
    if (model.ttail || tailRows >= 0.6) {
      n += strokeSegment(screen, tailPort, tailStbd, glyphFor('top', 'tail', mode), wingCol, -0.01);
    }

    // Engines. Stroked along the nacelle axis, so head-on the axis foreshortens
    // to nothing and the capsule collapses to the single dot that is wanted,
    // while side-on the same call gives a nacelle of the right length.
    for (const e of enginePositions(model)) {
      const nacL = model.length * 0.055;
      const a = localPoint(ctx, hx, hy, e.along + nacL, e.side, e.up);
      const b = localPoint(ctx, hx, hy, e.along - nacL, e.side, e.up);
      if (!a || !b) continue;
      const dxE = b.x - a.x, dyE = b.y - a.y;
      const lenE = Math.hypot(dxE, dyE) || 1;
      const w = radialWidth(cam, dist, model.fuselage * 0.31,
        -dyE / lenE, dxE / lenE);
      noteAll([a, b]);
      n += strokeTapered(screen, a, b, w, w,
        glyphFor('side', 'engine', mode), engCol, -0.02, 0.04, yScale);
    }
    return n;
  };

  if (lod === AIR_LOD.COARSE) {
    cells += signature();
    return { cells, box: { x0, x1, y0, y1, d0, d1 } };
  }

  // Fuselage. The crown is inset so the tube does not read as a flat slab.
  const fuse = prismVertices(ctx, hx, hy, halfL, halfF, -halfF, halfF,
    halfL * 0.97, halfF * 0.60);
  noteAll(fuse);
  cells += drawPrism(screen, fuse, hx, hy,
    painter(L, f, UPPER, 'fuse', mode), ROLES);

  // Wings. A thin slab is the right primitive here: at ASCII resolution the
  // aerofoil is invisible and the planform is the whole silhouette.
  const chord = model.length * 0.11;
  const wingUp = model.wingZ;
  const wings = prismVertices(ctx, hx, hy, chord, model.span / 2,
    wingUp, wingUp + model.fuselage * 0.10,
    chord * 0.45, model.span / 2 * 0.99, -model.length * 0.02);
  noteAll(wings);
  cells += drawPrism(screen, wings, hx, hy,
    painter(L, f, UPPER, 'wing', mode), ROLES);

  // Tailplane.
  const tailChord = model.length * 0.055;
  const tail = prismVertices(ctx, hx, hy, tailChord, model.tailSpan / 2,
    halfF * 0.2, halfF * 0.2 + model.fuselage * 0.07,
    tailChord * 0.5, model.tailSpan / 2 * 0.96, -model.length * 0.43);
  noteAll(tail);
  cells += drawPrism(screen, tail, hx, hy,
    painter(L, f, UPPER, 'tail', mode), ROLES);

  // Fin. Tall and thin, so its "width" is the small axis and its height runs
  // from the fuselage crown to the published overall height.
  const finTop = model.height - halfF;
  const finChord = model.length * 0.075;
  const fin = prismVertices(ctx, hx, hy, finChord, model.fuselage * 0.07,
    halfF * 0.7, finTop,
    finChord * 0.52, model.fuselage * 0.05, -model.length * 0.41);
  noteAll(fin);
  cells += drawPrism(screen, fin, hx, hy,
    painter(L, f, UPPER, 'fin', mode), ROLES);

  // Engines.
  const nacL = model.length * 0.055;
  const nacR = model.fuselage * 0.27;
  for (const e of enginePositions(model)) {
    const nacelle = [
      localPoint(ctx, hx, hy, e.along - nacL, e.side - nacR, e.up - nacR),
      localPoint(ctx, hx, hy, e.along + nacL, e.side - nacR, e.up - nacR),
      localPoint(ctx, hx, hy, e.along + nacL, e.side + nacR, e.up - nacR),
      localPoint(ctx, hx, hy, e.along - nacL, e.side + nacR, e.up - nacR),
    ];
    noteAll(nacelle);
    cells += rasterQuad(screen, nacelle, glyphFor('side', 'engine', mode),
      shade(L, f, ENGINE, 'side', 0, 0));
    const topFace = [
      localPoint(ctx, hx, hy, e.along - nacL, e.side - nacR, e.up + nacR),
      localPoint(ctx, hx, hy, e.along + nacL, e.side - nacR, e.up + nacR),
      localPoint(ctx, hx, hy, e.along + nacL, e.side + nacR, e.up + nacR),
      localPoint(ctx, hx, hy, e.along - nacL, e.side + nacR, e.up + nacR),
    ];
    noteAll(topFace);
    cells += rasterQuad(screen, topFace, glyphFor('top', 'engine', mode),
      shade(L, f, ENGINE, 'top', 0, 0));
  }

  // Belly, painted last so it wins where it faces the camera from below.
  const belly = [
    localPoint(ctx, hx, hy, -halfL, -halfF * 0.9, -halfF),
    localPoint(ctx, hx, hy, halfL, -halfF * 0.9, -halfF),
    localPoint(ctx, hx, hy, halfL, halfF * 0.9, -halfF),
    localPoint(ctx, hx, hy, -halfL, halfF * 0.9, -halfF),
  ];
  cells += rasterQuad(screen, belly, glyphFor('side', 'fuse', mode),
    shade(L, f, LOWER, 'side', 0, 0));

  // The signature again, over the fills. Even at full size the wing edge and
  // the fin are thinner than a cell edge-on, and this is what keeps the
  // silhouette crisp rather than letting the solid dissolve into gaps.
  cells += signature();

  // Navigation lights: red to port, green to starboard, and a white strobe.
  // Real, carried by every one of these aircraft, and the thing that makes a
  // night arrival legible when the hull itself is a silhouette.
  const night = 1 - L.dayAmt;
  const lampF = Math.max(0.45, f);
  const tipUp = model.wingZ + model.span / 2 * Math.tan(model.dihedral);
  cells += stamp(screen, localPoint(ctx, hx, hy, -model.length * 0.02, -model.span / 2, tipUp),
    mode === MODE.GLYPH ? '*' : ' ',
    L.depth(210 + night * 45, 34, 30, lampF), -0.03);
  cells += stamp(screen, localPoint(ctx, hx, hy, -model.length * 0.02, model.span / 2, tipUp),
    mode === MODE.GLYPH ? '*' : ' ',
    L.depth(40, 200 + night * 55, 70, lampF), -0.03);

  const strobe = ((now / 1000 + phaseOf(icao)) % 1.2) < 0.09;
  if (strobe) {
    const white = L.depth(255, 255, 255, 1);
    cells += stamp(screen, localPoint(ctx, hx, hy, -model.length * 0.02, -model.span / 2, tipUp),
      mode === MODE.GLYPH ? '+' : ' ', white, -0.05);
    cells += stamp(screen, localPoint(ctx, hx, hy, -model.length * 0.02, model.span / 2, tipUp),
      mode === MODE.GLYPH ? '+' : ' ', white, -0.05);
  }

  return { cells, box: { x0, x1, y0, y1, d0, d1 } };
}
