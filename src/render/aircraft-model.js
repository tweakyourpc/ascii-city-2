/**
 * Airframe dimensions for an ICAO type designator.
 *
 * ADS-B already tells us what the aircraft is: adsb.lol and adsb.fi carry the
 * type designator in `t` (a 737-800 arrives as the string `B738`), and the
 * emitter category in `category`. Neither needs a registration lookup, and the
 * one provider that omits the type — the OpenSky fallback — also omits the
 * registration, so a tail-number database would have nothing to key on there.
 * The category fallback covers that path instead.
 *
 * PROVENANCE. A position from ADS-B is OBSERVED. The numbers in this file are
 * DERIVED: published dimensions for the type, not a measurement of the
 * individual airframe overhead. Two 737-800s differ in winglets and antennas
 * and this table cannot tell them apart. `tier` says how confident the match
 * is, and the info panel must show it rather than implying the drawn shape was
 * measured.
 *
 * All dimensions are metres, as published. Callers convert with
 * METERS_PER_CELL; keeping the table in metres means a reader can check an
 * entry against a spec sheet without doing arithmetic.
 */

import { METERS_PER_CELL } from '../config.js';

export const MODEL_TIER = Object.freeze({
  /** The designator matched an entry outright. */
  TYPE: 'type',
  /** A relative of the same family and broadly the same size. */
  FAMILY: 'family',
  /** Only the ADS-B size class was known. */
  CATEGORY: 'category',
  /** Nothing was known. A neutral hull, and the panel must say so. */
  GENERIC: 'generic',
});

export const MOUNT = Object.freeze({ WING: 'wing', TAIL: 'tail', NOSE: 'nose' });

/**
 * span    wingtip to wingtip
 * len     nose to tail
 * height  ground to fin tip
 * fuse    fuselage diameter
 * tail    horizontal stabiliser span
 * eng     engine count
 * mount   where the engines hang
 * prop    propeller rather than turbofan, which changes the nacelle shape
 */
const TYPES = {
  /* Narrowbodies */
  B737: { name: 'Boeing 737-700', span: 35.79, len: 33.63, height: 12.55, fuse: 3.76, tail: 13.678, eng: 2, mount: MOUNT.WING },
  B738: { name: 'Boeing 737-800', span: 35.79, len: 39.47, height: 12.55, fuse: 3.76, tail: 14.35, eng: 2, mount: MOUNT.WING },
  B739: { name: 'Boeing 737-900', span: 35.79, len: 42.11, height: 12.55, fuse: 3.76, tail: 14.35, eng: 2, mount: MOUNT.WING },
  B38M: { name: 'Boeing 737 MAX 8', span: 35.92, len: 39.52, height: 12.30, fuse: 3.76, tail: 14.35, eng: 2, mount: MOUNT.WING },
  B39M: { name: 'Boeing 737 MAX 9', span: 35.92, len: 42.16, height: 12.30, fuse: 3.76, tail: 14.35, eng: 2, mount: MOUNT.WING },
  A319: { name: 'Airbus A319', span: 35.80, len: 33.84, height: 11.76, fuse: 3.95, tail: 12.45, eng: 2, mount: MOUNT.WING },
  A320: { name: 'Airbus A320', span: 35.80, len: 37.57, height: 11.76, fuse: 3.95, tail: 12.45, eng: 2, mount: MOUNT.WING },
  A321: { name: 'Airbus A321', span: 35.80, len: 44.51, height: 11.76, fuse: 3.95, tail: 12.45, eng: 2, mount: MOUNT.WING },
  A19N: { name: 'Airbus A319neo', span: 35.80, len: 33.84, height: 11.76, fuse: 3.95, tail: 12.45, eng: 2, mount: MOUNT.WING },
  A20N: { name: 'Airbus A320neo', span: 35.80, len: 37.57, height: 11.76, fuse: 3.95, tail: 12.45, eng: 2, mount: MOUNT.WING },
  A21N: { name: 'Airbus A321neo', span: 35.80, len: 44.51, height: 11.76, fuse: 3.95, tail: 12.45, eng: 2, mount: MOUNT.WING },
  B752: { name: 'Boeing 757-200', span: 38.05, len: 47.32, height: 13.56, fuse: 3.76, tail: 15.21, eng: 2, mount: MOUNT.WING },

  /* Widebodies */
  B763: { name: 'Boeing 767-300', span: 47.57, len: 54.94, height: 15.85, fuse: 5.03, tail: 18.62, eng: 2, mount: MOUNT.WING },
  B764: { name: 'Boeing 767-400', span: 51.92, len: 61.37, height: 16.87, fuse: 5.03, tail: 19.40, eng: 2, mount: MOUNT.WING },
  B772: { name: 'Boeing 777-200', span: 60.93, len: 63.73, height: 18.51, fuse: 6.20, tail: 21.53, eng: 2, mount: MOUNT.WING },
  B77L: { name: 'Boeing 777F', span: 64.80, len: 63.73, height: 18.60, fuse: 6.20, tail: 21.53, eng: 2, mount: MOUNT.WING },
  B77W: { name: 'Boeing 777-300ER', span: 64.80, len: 73.86, height: 18.60, fuse: 6.20, tail: 21.53, eng: 2, mount: MOUNT.WING },
  B788: { name: 'Boeing 787-8', span: 60.12, len: 56.72, height: 16.92, fuse: 5.77, tail: 19.60, eng: 2, mount: MOUNT.WING },
  B789: { name: 'Boeing 787-9', span: 60.12, len: 62.81, height: 17.02, fuse: 5.77, tail: 20.60, eng: 2, mount: MOUNT.WING },
  B78X: { name: 'Boeing 787-10', span: 60.12, len: 68.28, height: 17.02, fuse: 5.77, tail: 20.60, eng: 2, mount: MOUNT.WING },
  B744: { name: 'Boeing 747-400', span: 64.44, len: 70.66, height: 19.41, fuse: 6.50, tail: 22.17, eng: 4, mount: MOUNT.WING },
  B748: { name: 'Boeing 747-8', span: 68.45, len: 76.25, height: 19.35, fuse: 6.50, tail: 22.17, eng: 4, mount: MOUNT.WING },
  A332: { name: 'Airbus A330-200', span: 60.30, len: 58.82, height: 17.39, fuse: 5.64, tail: 19.40, eng: 2, mount: MOUNT.WING },
  A333: { name: 'Airbus A330-300', span: 60.30, len: 63.69, height: 16.79, fuse: 5.64, tail: 19.40, eng: 2, mount: MOUNT.WING },
  A339: { name: 'Airbus A330-900neo', span: 64.00, len: 63.66, height: 16.79, fuse: 5.64, tail: 19.40, eng: 2, mount: MOUNT.WING },
  A359: { name: 'Airbus A350-900', span: 64.75, len: 66.80, height: 17.05, fuse: 5.96, tail: 19.15, eng: 2, mount: MOUNT.WING },
  A35K: { name: 'Airbus A350-1000', span: 64.75, len: 73.79, height: 17.08, fuse: 5.96, tail: 19.15, eng: 2, mount: MOUNT.WING },
  A388: { name: 'Airbus A380-800', span: 79.75, len: 72.72, height: 24.09, fuse: 7.14, tail: 30.37, eng: 4, mount: MOUNT.WING },
  MD11: { name: 'McDonnell Douglas MD-11', span: 51.66, len: 61.60, height: 17.60, fuse: 6.02, tail: 19.20, eng: 3, mount: MOUNT.TAIL, ttail: true },

  /* Regional jets, engines on the rear fuselage rather than the wing */
  CRJ2: { name: 'Bombardier CRJ-200', span: 21.21, len: 26.77, height: 6.22, fuse: 2.69, tail: 7.20, eng: 2, mount: MOUNT.TAIL, ttail: true },
  CRJ7: { name: 'Bombardier CRJ-700', span: 23.24, len: 32.33, height: 7.57, fuse: 2.69, tail: 8.15, eng: 2, mount: MOUNT.TAIL, ttail: true },
  CRJ9: { name: 'Bombardier CRJ-900', span: 24.85, len: 36.24, height: 7.51, fuse: 2.69, tail: 8.15, eng: 2, mount: MOUNT.TAIL, ttail: true },
  E145: { name: 'Embraer ERJ-145', span: 20.04, len: 29.87, height: 6.76, fuse: 2.28, tail: 7.40, eng: 2, mount: MOUNT.TAIL, ttail: true },
  E170: { name: 'Embraer 170', span: 26.00, len: 29.90, height: 9.85, fuse: 3.01, tail: 10.00, eng: 2, mount: MOUNT.WING },
  E175: { name: 'Embraer 175', span: 26.00, len: 31.68, height: 9.86, fuse: 3.01, tail: 10.00, eng: 2, mount: MOUNT.WING },
  E190: { name: 'Embraer 190', span: 28.72, len: 36.24, height: 10.57, fuse: 3.01, tail: 10.00, eng: 2, mount: MOUNT.WING },

  /* Turboprops */
  DH8D: { name: 'De Havilland Dash 8 Q400', span: 28.42, len: 32.83, height: 8.34, fuse: 2.69, tail: 9.40, eng: 2, mount: MOUNT.WING, highWing: true, ttail: true, prop: true },
  AT72: { name: 'ATR 72', span: 27.05, len: 27.17, height: 7.65, fuse: 2.57, tail: 7.31, eng: 2, mount: MOUNT.WING, highWing: true, ttail: true, prop: true },

  /* General aviation and business */
  PC12: { name: 'Pilatus PC-12', span: 16.28, len: 14.40, height: 4.26, fuse: 1.70, tail: 5.20, eng: 1, mount: MOUNT.NOSE, prop: true },
  C172: { name: 'Cessna 172', span: 11.00, len: 8.28, height: 2.72, fuse: 1.20, tail: 3.40, eng: 1, mount: MOUNT.NOSE, highWing: true, prop: true },
  SR22: { name: 'Cirrus SR22', span: 11.68, len: 7.92, height: 2.71, fuse: 1.24, tail: 3.30, eng: 1, mount: MOUNT.NOSE, prop: true },
  C208: { name: 'Cessna 208 Caravan', span: 15.88, len: 12.67, height: 4.71, fuse: 1.62, tail: 6.25, eng: 1, mount: MOUNT.NOSE, highWing: true, prop: true },
  BE20: { name: 'Beechcraft King Air 200', span: 16.61, len: 13.34, height: 4.57, fuse: 1.68, tail: 5.61, eng: 2, mount: MOUNT.WING, prop: true },
  E55P: { name: 'Embraer Phenom 300', span: 15.90, len: 15.64, height: 5.10, fuse: 1.55, tail: 6.20, eng: 2, mount: MOUNT.TAIL, ttail: true },
  CL35: { name: 'Bombardier Challenger 350', span: 21.00, len: 20.90, height: 6.10, fuse: 2.19, tail: 7.70, eng: 2, mount: MOUNT.TAIL, ttail: true },
  GLF6: { name: 'Gulfstream G650', span: 30.36, len: 30.41, height: 7.82, fuse: 2.59, tail: 9.10, eng: 2, mount: MOUNT.TAIL, ttail: true },
};

/**
 * Designator prefixes to a representative family member, longest first so
 * `CRJ` never shadows an exact `CRJ9` and `B78` never shadows `B788`. Only
 * families whose members are close enough in size that substituting one for
 * another is honest at ASCII resolution.
 */
const FAMILIES = [
  ['B38', 'B38M'], ['B39', 'B39M'], ['B73', 'B738'], ['B74', 'B744'],
  ['B75', 'B752'], ['B76', 'B763'], ['B77', 'B772'], ['B78', 'B788'],
  ['A19', 'A319'], ['A31', 'A319'], ['A32', 'A320'], ['A33', 'A333'],
  ['A35', 'A359'], ['A38', 'A388'],
  ['CRJ', 'CRJ7'], ['E13', 'E145'], ['E14', 'E145'], ['E17', 'E175'],
  ['E19', 'E190'], ['E75', 'E175'], ['E90', 'E190'],
  ['DH8', 'DH8D'], ['AT4', 'AT72'], ['AT7', 'AT72'],
];

/**
 * ADS-B emitter category to a representative hull. This is the last honest
 * fallback: the category is a weight class the aircraft broadcasts about
 * itself, so the size is right even when the type is not.
 */
const CATEGORIES = {
  A1: 'C172',   // light, under 7t
  A2: 'PC12',   // small, 7t to 34t
  A3: 'B738',   // large, 34t to 136t
  A4: 'B752',   // high-vortex large
  A5: 'B77W',   // heavy, over 136t
  A6: 'GLF6',   // high performance
  A7: 'C172',   // rotorcraft: no model, but the size class is right
};

/** A neutral twin-jet, close to the commonest thing in the sky. */
const GENERIC = {
  name: 'Unknown aircraft', span: 34.0, len: 38.0, height: 12.0,
  fuse: 3.8, tail: 13.0, eng: 2, mount: MOUNT.WING,
};

/**
 * Planform angles, in radians.
 *
 * These are NOT in the dimensions table and are not published per airframe
 * here: they are typical values for the class, and they are the most
 * interpreted numbers in this file. They earn their place because head-on —
 * the view you get watching an approach — an airliner is a shallow V with two
 * pods under it, and a flat bar with nothing under it does not read as an
 * aircraft at all. `tier` already tells the panel the shape is DERIVED; this
 * is part of that same derivation, not a measurement.
 *
 * Dihedral: airliners sit around 5 to 6 degrees, rear-engined regional jets
 * rather less, high-wing turboprops close to flat or slightly anhedral.
 * Sweep is quarter-chord, near zero on a propeller aircraft.
 */
function planform(spec) {
  const deg = Math.PI / 180;
  if (spec.prop) return { dihedral: 2.5 * deg, sweep: 3 * deg };
  if (spec.mount === MOUNT.TAIL) return { dihedral: 3 * deg, sweep: 25 * deg };
  return { dihedral: 5.5 * deg, sweep: 25 * deg };
}

function toCells(spec, tier, designator) {
  const c = (m) => m / METERS_PER_CELL;
  const { dihedral, sweep } = planform(spec);
  return {
    dihedral,
    sweep,
    ttail: !!spec.ttail,
    // Where the wing meets the fuselage, in cells relative to the centreline.
    // A low-wing jet carries its wing about a third of a fuselage radius below
    // the floor, not just under the skin; a high-wing turboprop carries it on
    // top. This drives how far the wing and the tailplane separate on screen.
    wingZ: c(spec.fuse) * (spec.highWing ? 0.42 : -0.32),
    name: spec.name,
    tier,
    designator: designator || null,
    prop: !!spec.prop,
    engines: spec.eng,
    mount: spec.mount,
    // Metres, for the info panel.
    metres: { span: spec.span, length: spec.len, height: spec.height },
    // Cells, for the renderer.
    span: c(spec.span),
    length: c(spec.len),
    height: c(spec.height),
    fuselage: c(spec.fuse),
    tailSpan: c(spec.tail),
  };
}

/**
 * Resolve an ADS-B type designator and emitter category to a drawable model.
 *
 * Never returns null: an aircraft with no type at all still gets a hull, and
 * `tier` is `GENERIC` so the caller can say where the shape came from.
 */
export function resolveAircraftModel(type, category = null) {
  const t = typeof type === 'string' ? type.trim().toUpperCase() : '';

  if (t && TYPES[t]) return toCells(TYPES[t], MODEL_TIER.TYPE, t);

  if (t.length >= 3) {
    for (const [prefix, key] of FAMILIES) {
      if (t.startsWith(prefix)) return toCells(TYPES[key], MODEL_TIER.FAMILY, t);
    }
  }

  const cat = typeof category === 'string' ? category.trim().toUpperCase() : '';
  if (cat && CATEGORIES[cat]) {
    return toCells(TYPES[CATEGORIES[cat]], MODEL_TIER.CATEGORY, t || null);
  }

  return toCells(GENERIC, MODEL_TIER.GENERIC, t || null);
}

/** How the info panel should describe where the drawn shape came from. */
export function modelProvenance(model) {
  switch (model.tier) {
    case MODEL_TIER.TYPE:
      return `DERIVED shape, ${model.designator} dimensions`;
    case MODEL_TIER.FAMILY:
      return `DERIVED shape, ${model.designator} drawn as ${model.name}`;
    case MODEL_TIER.CATEGORY:
      return 'DERIVED shape, ADS-B size category only';
    default:
      return 'DERIVED shape, type unknown';
  }
}
