import { col2str } from '../screen.js';
import { T, F, hash } from '../world/source.js';
import { FOG_K, GLYPH_RAMP, LIT, FACADE } from '../config.js';

export { GLYPH_RAMP, LIT, FACADE };

export function fogOf(d) {
  return Math.exp(-d * FOG_K);
}

export function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Stable world-space dithering threshold in [0,1).
 *
 * Keyed on world coordinates, a stable surface id, and a per-cell sub-position
 * so the same world point always yields the same value. This lets a sparse
 * glyph (a window, a star, a speck of texture) imply an intermediate brightness
 * without frame-to-frame sparkle: the threshold is a property of the world, not
 * of the camera, so it does not crawl as you move.
 *
 * `id` separates different surfaces that happen to share a world cell (e.g. a
 * window grid vs the wall it sits on); `sub` is the in-cell coordinate so two
 * adjacent cells do not collapse to one value.
 */
export function dither(wx, wy, id = 0, sub = 0) {
  return hash((wx * 2.37) | 0, ((wy * 2.37) | 0) * 131 + (sub * 17) + (id * 7), 0x9e37);
}

/**
 * Quantize a continuous value to one of `levels` bands, with hysteresis so tiny
 * numeric changes do not flip the band (and therefore the glyph) every frame.
 *
 * `prev` is the band chosen last frame (or -1). A switch only happens once the
 * value has moved past the band edge by `margin` of a band width, which removes
 * the shimmer you get from rounding a noisy value at a boundary. Returns the
 * stable band index in [0, levels).
 */
export function quantize(v, levels, prev = -1, margin = 0.12) {
  const clamped = v < 0 ? 0 : v > 1 ? 1 : v;
  const raw = clamped * levels - 0.5;
  const target = Math.max(0, Math.min(levels - 1, Math.round(raw)));
  if (prev < 0 || prev >= levels) return target;
  if (target === prev) return prev;
  // Require the value to be at least `margin` of a band past the edge before
  // leaving the current band, so a value hovering on a boundary stays put.
  const edge = (prev + 0.5) / levels;
  const dir = target > prev ? 1 : -1;
  const needed = edge + dir * (margin / levels);
  if (dir > 0 ? clamped <= needed : clamped >= needed) return prev;
  return target;
}

/** Smooth 0..1 ramp: 0 below e0, 1 above e1, smooth between. */
export function smoothstep(e0, e1, x) {
  if (e0 === e1) return x < e0 ? 0 : 1;
  let t = (x - e0) / (e1 - e0);
  if (t < 0) t = 0; else if (t > 1) t = 1;
  return t * t * (3 - 2 * t);
}

/**
 * Current lighting, recomputed once per frame from the sun's altitude and
 * shared by every material function.
 *
 * The model has two jobs the original conflated:
 *
 *   - `dayAmt` / `amb` scale the whole scene's brightness, so the sun visibly
 *     lights roads and buildings (bright at noon, warm and dim at golden hour,
 *     dark at night). This is a smooth ramp over the sun's real arc, not a hard
 *     clamp at +/-6 degrees, so the evening falloff is actually visible.
 *
 *   - `litProb` is the chance a given window is lit. It is gated to EVENING:
 *     windows stay dark through the day (sunAlt above ~+4 deg) and only switch
 *     on as the sun sets, reaching full probability at/after dusk. That is the
 *     "building lights wait until evening" behaviour.
 *
 * `sunWarm` is a warm tint mixed into sunlit surfaces, strongest at midday and
 * fading to nothing by dusk, so the city reads as actually lit by the sun
 * rather than merely scaled by ambient.
 */
export class Lighting {
  constructor() {
    this.dayAmt = 1;     // 0 night .. 1 day
    this.amb = 1;        // ambient multiplier
    this.litProb = 0.4;  // chance a given window is lit
    this.sunWarm = 0;    // 0..1 warm tint on sunlit surfaces
    this.haze = [0, 0, 0];
    this.skyTop = [0, 0, 0];
    this.skyBottom = [0, 0, 0];
  }

  update(sunAlt) {
    // Day amount: smooth over the sun's real arc. Full day well above the
    // horizon, full night well below, with a visible golden-hour falloff in
    // between (roughly -8 deg .. +12 deg) rather than a hard +/-6 clamp.
    const k = smoothstep(-8, 12, sunAlt);
    // Dusk factor: peaks as the sun crosses the horizon, for the sky tint.
    const dusk = Math.max(0, 1 - Math.abs(sunAlt) / 9);

    this.dayAmt = k;
    // Genuine darkness at night: the ambient floor is low so unlit walls read as
    // near-black silhouettes against the lit windows, not as a flat grey ramp.
    this.amb = 0.06 + 0.94 * k;
    // Windows wait for evening: off in daylight (sunAlt > ~+4), ramping on
    // through late afternoon and fully on by dusk. smoothstep(4, -3, sunAlt)
    // is 0 above +4 deg and 1 below -3 deg.
    this.litProb = 0.62 * smoothstep(4, -3, sunAlt);
    // Warm sun tint: strongest at midday, gone by the time the sun is low.
    this.sunWarm = Math.max(0, smoothstep(-2, 18, sunAlt)) * (1 - dusk * 0.5);

    let top = mix([3, 4, 12], [24, 58, 122], k);
    let bot = mix([9, 11, 28], [132, 172, 212], k);
    top = mix(top, [34, 22, 62], dusk * 0.8);
    bot = mix(bot, [224, 112, 58], dusk * 0.85);

    this.skyTop = top;
    this.skyBottom = bot;
    this.haze = [bot[0] * 0.30, bot[1] * 0.30, bot[2] * 0.32];
    return k;
  }

  /** Blend a colour toward the haze by fog factor `f` (1 = near, 0 = far). */
  depth(r, g, b, f) {
    const h = this.haze;
    return col2str(r * f + h[0] * (1 - f),
                   g * f + h[1] * (1 - f),
                   b * f + h[2] * (1 - f));
  }

  /**
   * Atmospheric contrast: as a surface recedes, desaturate it toward the haze
   * colour so distant buildings lose their material hue and the foreground
   * reads as the only thing with colour. `f` is the fog factor (1 near, 0 far).
   * The desaturation is gentle near and strong far, which is what gives the
   * skyline its depth without washing the whole frame out.
   */
  desaturate(r, g, b, f) {
    const h = this.haze;
    const t = (1 - f) * 0.55;          // how far toward grey-haze to push
    const lum = (r * 0.3 + g * 0.59 + b * 0.11);
    const gr = lum + (h[0] - lum) * 0.4;
    const gg = lum + (h[1] - lum) * 0.4;
    const gb = lum + (h[2] - lum) * 0.4;
    return [r + (gr - r) * t, g + (gg - g) * t, b + (gb - b) * t];
  }

  hazeColour() {
    const h = this.haze;
    return col2str(h[0], h[1], h[2]);
  }

  /**
   * Apply the sun's warm tint to a base (already ambient-scaled) colour. The
   * tint is a gentle warm push (more red, a touch less blue) that is strongest
   * at midday and fades by dusk, so sunlit surfaces read as actually lit by the
   * sun rather than merely brighter. `amt` scales how much a surface catches
   * sun (roofs/facades facing up catch more than shaded walls).
   */
  sunTint(r, g, b, amt) {
    const w = this.sunWarm * amt;
    if (w <= 0) return col2str(r, g, b);
    return col2str(
      r + (28 - r * 0.10) * w,
      g + (8 - g * 0.04) * w,
      b - b * 0.10 * w,
    );
  }
}

/* ------------------------------ ground ------------------------------ */

export function groundGlyph(world, s, wx, wy, t) {
  const r = hash(Math.floor(wx * 2), Math.floor(wy * 2), 0);
  switch (world.type[s]) {
    // v2: roads are flat pavement. The clean line glyphs are drawn on top by
    // the street renderer (renderStreets), so the floor must not compete with
    // them — a uniform '.' reads as a calm road surface, not noise.
    case T.ROAD: return '.';
    case T.PATH: return r < 0.2 ? ',' : '.';
    case T.SIDEWALK: return r < 0.5 ? ':' : ';';
    case T.PLAZA: return r < 0.25 ? '+' : '.';
    case T.YARD:
    case T.FIELD: return r < 0.45 ? '"' : ',';
    case T.FARM: return r < 0.5 ? '=' : '-';
    case T.WATER:
      return (Math.sin(wx * 0.7 + t * 1.4) + Math.cos(wy * 0.9 - t * 1.1)) > 0.2 ? '~' : '-';
    default: return '.';
  }
}

export function groundColour(world, s, f, L) {
  let r, g, b;
  const stripe = (world.flags[s] & F.STRIPE) !== 0;

  switch (world.type[s]) {
    case T.ROAD:
      // Flat asphalt pavement; the dashed centre line is drawn by renderStreets.
      // A neutral cool grey, clearly distinct from the warm dirt/plaza tones.
      { r = 86; g = 88; b = 96; }
      break;
    case T.PATH: r = 96; g = 84; b = 62; break;
    case T.SIDEWALK: r = 96; g = 98; b = 104; break;
    case T.PLAZA: r = 88; g = 84; b = 76; break;
    case T.YARD:
    case T.FIELD: r = 60; g = 118; b = 52; break;
    case T.FARM: r = 122; g = 108; b = 48; break;
    case T.WATER: r = 26; g = 74; b = 128; break;
    default: r = 70; g = 70; b = 70;
  }

  const a = stripe ? Math.max(0.35, L.amb) : L.amb;
  const lamp = world.lamp[s] * (1 - L.dayAmt) * 0.6;
  const cr = r * a + 255 * lamp;
  const cg = g * a + 176 * lamp;
  const cb = b * a + 96 * lamp;
  // Ground catches the sun broadly (it faces up), so a full warm tint.
  return L.sunTint(cr, cg, cb, 1);
}

/* ------------------------------- roofs -------------------------------
 * Roofs need their own table, or from above the city reads as pavement with
 * boxes on it. Three cues do the work: a bright parapet along the building's
 * outline, gravel and plant noise inside, and red beacons on the tall towers
 * at night.
 *
 * These take plain values rather than a world slot, because the caller has to
 * sample neighbouring cells to find the outline and that would invalidate the
 * slot (see the validity rule in world/source.js).
 */

/** Bits set by the caller when the neighbour on that side is lower. */
export const OPEN = { W: 1, E: 2, N: 4, S: 8 };

const PARAPET_W = 0.13;

/**
 * Distance to the nearest edge whose neighbour is lower, or 1 if this cell is
 * in the interior of a larger building. That distinction is the whole point:
 * testing the cell edge alone outlines every cell and roofs read as graph paper.
 */
function parapetDist(wx, wy, mx, my, open) {
  const u = wx - mx;
  const v = wy - my;
  let d = 1;
  if ((open & OPEN.W) && u < d) d = u;
  if ((open & OPEN.E) && 1 - u < d) d = 1 - u;
  if ((open & OPEN.N) && v < d) d = v;
  if ((open & OPEN.S) && 1 - v < d) d = 1 - v;
  return d;
}

export function roofGlyph(type, rnd, flags, open, wx, wy, mx, my, t) {
  if (type === T.TREE || type === T.FOREST) {
    const r = hash(mx * 31, my * 17, 0);
    return r < 0.3 ? '&' : r < 0.7 ? '%' : '*';
  }

  if (parapetDist(wx, wy, mx, my, open) < PARAPET_W) return '=';

  // Blink, so it reads as an aircraft warning light rather than a stain.
  if ((flags & F.BEACON) && Math.sin(t * 2.2 + rnd * 6.3) > 0.4) {
    const u = wx - mx;
    const v = wy - my;
    if (u > 0.38 && u < 0.62 && v > 0.38 && v < 0.62) return '*';
  }

  // Flat roof: a single uniform glyph across the whole plane, so it reads as a
  // solid surface rather than random texture. The parapet above still outlines
  // the building and the beacon still marks tall towers.
  return '·';
}

export function roofColour(type, rnd, palIdx, flags, open, wx, wy, mx, my, f, t, L) {
  if (type === T.TREE || type === T.FOREST) {
    const r = hash(mx * 31, my * 17, 0);
    return L.depth((40 + r * 30) * L.amb, (110 + r * 70) * L.amb,
                   (44 + r * 30) * L.amb, f);
  }

  if ((flags & F.BEACON) && Math.sin(t * 2.2 + rnd * 6.3) > 0.4) {
    const u = wx - mx;
    const v = wy - my;
    if (u > 0.38 && u < 0.62 && v > 0.38 && v < 0.62) return col2str(255, 60, 48);
  }

  const pal = FACADE[palIdx];
  // Roofs face the sky, so they take flat light with no side dimming. A single
  // flat tone across the whole plane (no per-cell noise) reads as a solid
  // surface; only the parapet is lifted brighter to outline the building.
  const a = L.amb * 1.15;
  const lift = parapetDist(wx, wy, mx, my, open) < PARAPET_W ? 1.9 : 1.0;
  const cr = pal[0] * a * lift;
  const cg = pal[1] * a * lift;
  const cb = pal[2] * a * lift;
  // Roofs face straight up, so they catch the full sun tint.
  return L.sunTint(cr, cg, cb, 1);
}
