import { T, F, hash } from '../world/source.js';

/**
 * The cartographic generalization layer.
 *
 * OSM (and the procedural world) hand the renderer *facts*: this cell is a
 * road, this is grass, this polygon is water. The renderer decides how those
 * facts become ASCII. That separation is what lets the city stay truthful about
 * what is on the ground while taking full artistic liberty over how it reads.
 *
 * Every ground surface type maps to a small vocabulary here: a glyph family and
 * a base colour, each expressed per perceptual tier (near / mid / far) so the
 * same truthful object can collapse gracefully as it recedes — a crosswalk that
 * is `####` up close becomes `==` then `--` far away, without ever lying about
 * what it is.
 *
 * This module is the single source of that vocabulary. `materials.js` and the
 * raycaster consult it; nothing downstream hard-codes a ground glyph anymore.
 *
 * The tier is chosen by `surfaceTier` from the view distance, the angle the
 * surface is seen at, and the time of day. Today the ground renderer pins the
 * 'mid' tier so output is unchanged; flipping it to `surfaceTier(...)` is the
 * one-line switch that turns the LOD on (see groundGlyph / groundColour below).
 */

/* --------------------------- perceptual tiers --------------------------- */

/**
 * Map a viewing situation to a surface detail tier.
 *
 * Mirrors the facade renderer's near/mid/far split (raycaster.js rowsPerFloor):
 * up close a surface earns its full texture, at mid range a coarser reading,
 * and far away it collapses to a stable speckle. The inputs are deliberately the
 * same quantities the rest of the renderer already has:
 *
 *   d        perpendicular distance in cells (the floor cast's dPerp)
 *   viewAngle cosine of the angle between the view ray and the surface normal
 *             (1 = straight down, 0 = grazing). Grazing views lose detail first,
 *             exactly like a wall seen edge-on.
 *   dayAmt   0 night .. 1 day, from Lighting. Lit detail matters less by day.
 *
 * Returns one of 'near' | 'mid' | 'far'.
 */
export function surfaceTier(d, viewAngle = 1, dayAmt = 1) {
  // Distance tiers, in cells. Tuned to the same scale as the facade LOD: a
  // surface within ~12 cells is "near", past ~40 it is "far".
  const NEAR_D = 12;
  const FAR_D = 40;

  // A grazing view (small viewAngle) pushes a surface one tier coarser, because
  // the texture would alias before it is legible. Daylight also lets us drop a
  // tier: lit surfaces need less glyph detail to read as themselves.
  const graze = viewAngle < 0.5 ? 1 : 0;
  const bright = dayAmt > 0.6 ? 1 : 0;
  const penalty = graze + bright;

  let tier = 1; // 0 near, 1 mid, 2 far
  if (d < NEAR_D) tier = 0;
  else if (d > FAR_D) tier = 2;
  tier = Math.min(2, tier + penalty);
  return ['near', 'mid', 'far'][tier];
}

const TIER_ORDER = ['near', 'mid', 'far'];

/**
 * Resolve which tier to actually draw. Centralized so the renderer can opt into
 * `surfaceTier` in one place. For now it returns 'mid' to keep the ground
 * identical to the pre-refactor output; the comment marks the switch.
 */
function selectTier(/* d, viewAngle, dayAmt */) {
  // return surfaceTier(d, viewAngle, dayAmt);  // <- flips LOD on
  return 'mid';
}

/* ----------------------------- vocabulary ----------------------------- */

/**
 * Per-type surface vocabulary.
 *
 * Each entry is `{ glyph, colour }` where `glyph` is a function
 * `(world, s, wx, wy, t, r) -> string` and `colour` is `[r, g, b]`. Both may be
 * given per tier; missing tiers fall back to 'mid'. The 'mid' values reproduce
 * the original groundGlyph / groundColour exactly, so the refactor is a no-op
 * until a tier is selected.
 *
 * `r` is the stable world-space hash for the cell, so a sparse glyph (a comma,
 * a quote) stays put as the camera moves instead of sparkling.
 */
export const SURFACE = {
  [T.ROAD]: {
    mid: {
      glyph: () => '.',
      colour: [86, 88, 96],
    },
  },
  [T.PATH]: {
    mid: {
      glyph: (_w, _s, _wx, _wy, _t, r) => (r < 0.2 ? ',' : '.'),
      colour: [96, 84, 62],
    },
  },
  [T.SIDEWALK]: {
    mid: {
      glyph: (_w, _s, _wx, _wy, _t, r) => (r < 0.5 ? ':' : ';'),
      colour: [96, 98, 104],
    },
  },
  [T.PLAZA]: {
    mid: {
      glyph: (_w, _s, _wx, _wy, _t, r) => (r < 0.25 ? '+' : '.'),
      colour: [88, 84, 76],
    },
  },
  [T.YARD]: {
    mid: {
      glyph: (_w, _s, _wx, _wy, _t, r) => (r < 0.45 ? '"' : ','),
      colour: [60, 118, 52],
    },
  },
  [T.FIELD]: {
    mid: {
      glyph: (_w, _s, _wx, _wy, _t, r) => (r < 0.45 ? '"' : ','),
      colour: [60, 118, 52],
    },
  },
  [T.FARM]: {
    mid: {
      glyph: (_w, _s, _wx, _wy, _t, r) => (r < 0.5 ? '=' : '-'),
      colour: [122, 108, 48],
    },
  },
  [T.WATER]: {
    mid: {
      glyph: (_w, _s, wx, wy, t) =>
        (Math.sin(wx * 0.7 + t * 1.4) + Math.cos(wy * 0.9 - t * 1.1)) > 0.2 ? '~' : '-',
      colour: [26, 74, 128],
    },
  },
};

const DEFAULT_SURFACE = {
  mid: { glyph: () => '.', colour: [70, 70, 70] },
};

function entryFor(type, tier) {
  const base = SURFACE[type] || DEFAULT_SURFACE;
  return base[tier] || base.mid;
}

/* --------------------------- public helpers --------------------------- */

export function groundGlyph(world, s, wx, wy, t) {
  const r = hash(Math.floor(wx * 2), Math.floor(wy * 2), 0);
  const tier = selectTier();
  return entryFor(world.type[s], tier).glyph(world, s, wx, wy, t, r);
}

export function groundColour(world, s, f, L) {
  const tier = selectTier();
  const [r, g, b] = entryFor(world.type[s], tier).colour;
  const stripe = (world.flags[s] & F.STRIPE) !== 0;

  const a = stripe ? Math.max(0.35, L.amb) : L.amb;
  const lamp = world.lamp[s] * (1 - L.dayAmt) * 0.6;
  const cr = r * a + 255 * lamp;
  const cg = g * a + 176 * lamp;
  const cb = b * a + 96 * lamp;
  // Ground catches the sun broadly (it faces up), so a full warm tint.
  return L.sunTint(cr, cg, cb, 1);
}

export { TIER_ORDER };
