/**
 * The Moon and the five naked-eye planets.
 *
 * Low-precision orbital elements after Schlyter, which is the right accuracy
 * class here: positions land within a couple of arcminutes, and one character
 * cell subtends roughly half a degree. Pure functions, no dependencies.
 *
 * Validated against physical invariants rather than against a stored
 * ephemeris (see test/sky.test.js): greatest elongations, sidereal periods,
 * lunar distance and latitude ranges, and the synodic month.
 */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const rev = (x) => ((x % 360) + 360) % 360;

/** Days since the element epoch, 1999-12-31 00:00 UT. */
export function daysSinceEpoch(date) {
  return (date.getTime() - Date.UTC(1999, 11, 31)) / 86400000;
}

/**
 * Elements as [value at epoch, change per day]:
 * N ascending node, i inclination, w argument of perihelion,
 * a semi-major axis (AU), e eccentricity, M mean anomaly.
 */
const ELEMENTS = {
  Mercury: {
    N: [48.3313, 3.24587e-5], i: [7.0047, 5.00e-8], w: [29.1241, 1.01444e-5],
    a: 0.387098, e: [0.205635, 5.59e-10], M: [168.6562, 4.0923344368],
    colour: [214, 198, 176], baseMag: -0.36,
  },
  Venus: {
    N: [76.6799, 2.46590e-5], i: [3.3946, 2.75e-8], w: [54.8910, 1.38374e-5],
    a: 0.723330, e: [0.006773, -1.302e-9], M: [48.0052, 1.6021302244],
    colour: [255, 246, 214], baseMag: -4.34,
  },
  Mars: {
    N: [49.5574, 2.11081e-5], i: [1.8497, -1.78e-8], w: [286.5016, 2.92961e-5],
    a: 1.523688, e: [0.093405, 2.516e-9], M: [18.6021, 0.5240207766],
    colour: [255, 138, 96], baseMag: -1.51,
  },
  Jupiter: {
    N: [100.4542, 2.76854e-5], i: [1.3030, -1.557e-7], w: [273.8777, 1.64505e-5],
    a: 5.20256, e: [0.048498, 4.469e-9], M: [19.8950, 0.0830853001],
    colour: [255, 226, 178], baseMag: -9.25,
  },
  Saturn: {
    N: [113.6634, 2.38980e-5], i: [2.4886, -1.081e-7], w: [339.3939, 2.97661e-5],
    a: 9.55475, e: [0.055546, -9.499e-9], M: [316.9670, 0.0334442282],
    colour: [240, 222, 172], baseMag: -9.0,
  },
};

export const PLANET_NAMES = Object.keys(ELEMENTS);

/** Solve Kepler's equation for the eccentric anomaly. */
function kepler(M, e) {
  let E = M + e * Math.sin(M) * (1 + e * Math.cos(M));
  for (let k = 0; k < 14; k++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-13) break;
  }
  return E;
}

/** Heliocentric ecliptic rectangular coordinates, AU. */
function heliocentric(el, d) {
  const N = rev(el.N[0] + el.N[1] * d) * D2R;
  const i = (el.i[0] + el.i[1] * d) * D2R;
  const w = rev(el.w[0] + el.w[1] * d) * D2R;
  const a = el.a;
  const e = el.e[0] + el.e[1] * d;
  const M = rev(el.M[0] + el.M[1] * d) * D2R;

  const E = kepler(M, e);
  const xv = a * (Math.cos(E) - e);
  const yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const v = Math.atan2(yv, xv);
  const r = Math.hypot(xv, yv);

  const cN = Math.cos(N);
  const sN = Math.sin(N);
  const cvw = Math.cos(v + w);
  const svw = Math.sin(v + w);
  const ci = Math.cos(i);

  return {
    x: r * (cN * cvw - sN * svw * ci),
    y: r * (sN * cvw + cN * svw * ci),
    z: r * svw * Math.sin(i),
    r,
  };
}

/**
 * The Sun's true ecliptic longitude and distance, from the same element set.
 * Reusing this keeps the planets consistent with the existing sun, and the
 * true longitude (not the mean) is what lunar phase must be measured against.
 */
export function sunEcliptic(d) {
  const w = rev(282.9404 + 4.70935e-5 * d);
  const e = 0.016709 - 1.151e-9 * d;
  const M = rev(356.0470 + 0.9856002585 * d) * D2R;
  const E = kepler(M, e);
  const xv = Math.cos(E) - e;
  const yv = Math.sqrt(1 - e * e) * Math.sin(E);
  return {
    lon: rev(Math.atan2(yv, xv) * R2D + w),
    r: Math.hypot(xv, yv),
    M: M * R2D,
    w,
  };
}

/** Ecliptic longitude and latitude to right ascension and declination. */
function eclipticToEquatorial(lon, lat, d) {
  const ecl = (23.4393 - 3.563e-7 * d) * D2R;
  const lo = lon * D2R;
  const la = lat * D2R;
  const x = Math.cos(la) * Math.cos(lo);
  const y = Math.cos(la) * Math.sin(lo);
  const z = Math.sin(la);
  const ye = y * Math.cos(ecl) - z * Math.sin(ecl);
  const ze = y * Math.sin(ecl) + z * Math.cos(ecl);
  return {
    ra: rev(Math.atan2(ye, x) * R2D) / 15,     // hours
    dec: Math.atan2(ze, Math.hypot(x, ye)) * R2D,
  };
}

/**
 * Geocentric position of a planet.
 * @returns {{name, ra, dec, lon, lat, dist, mag, colour, elongation}}
 */
export function planet(name, d) {
  const el = ELEMENTS[name];
  const p = heliocentric(el, d);
  const s = sunEcliptic(d);

  // Earth's heliocentric position is the Sun's geocentric one, reversed.
  const ex = s.r * Math.cos((s.lon + 180) * D2R);
  const ey = s.r * Math.sin((s.lon + 180) * D2R);

  const gx = p.x - ex;
  const gy = p.y - ey;
  const gz = p.z;

  const lon = rev(Math.atan2(gy, gx) * R2D);
  const lat = Math.atan2(gz, Math.hypot(gx, gy)) * R2D;
  const dist = Math.hypot(gx, gy, gz);
  const { ra, dec } = eclipticToEquatorial(lon, lat, d);

  // Phase angle, for a magnitude that actually varies the way the sky does.
  const cosPhase = Math.max(-1, Math.min(1,
    (p.r * p.r + dist * dist - s.r * s.r) / (2 * p.r * dist)));
  const phaseAngle = Math.acos(cosPhase) * R2D;
  const mag = el.baseMag + 5 * Math.log10(p.r * dist) + 0.013 * phaseAngle
            + 4.5e-7 * phaseAngle ** 3;

  let elong = Math.abs(((lon - s.lon + 540) % 360) - 180);

  return {
    kind: 'planet', name, ra, dec, lon, lat, dist, mag,
    colour: el.colour, elongation: elong,
    // Heliocentric longitude and radius. Geocentric longitude tracks the Sun
    // for an inner planet, so only this one measures the sidereal period.
    helioLon: rev(Math.atan2(p.y, p.x) * R2D),
    helioDist: p.r,
  };
}

export function planets(d) {
  return PLANET_NAMES.map((n) => planet(n, d));
}

/**
 * Geocentric position and phase of the Moon.
 * The twelve main longitude perturbations and five in latitude; enough for a
 * couple of arcminutes, which is well inside one character cell.
 */
export function moon(d) {
  const Nd = rev(125.1228 - 0.0529538083 * d);
  const wd = rev(318.0634 + 0.1643573223 * d);
  const Md = rev(115.3654 + 13.0649929509 * d);

  const N = Nd * D2R;
  const i = 5.1454 * D2R;
  const w = wd * D2R;
  const a = 60.2666;                    // Earth radii
  const e = 0.054900;
  const M = Md * D2R;

  const E = kepler(M, e);
  const xv = a * (Math.cos(E) - e);
  const yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const v = Math.atan2(yv, xv);
  const r0 = Math.hypot(xv, yv);

  const xh = r0 * (Math.cos(N) * Math.cos(v + w) - Math.sin(N) * Math.sin(v + w) * Math.cos(i));
  const yh = r0 * (Math.sin(N) * Math.cos(v + w) + Math.cos(N) * Math.sin(v + w) * Math.cos(i));
  const zh = r0 * Math.sin(v + w) * Math.sin(i);

  let lon = rev(Math.atan2(yh, xh) * R2D);
  let lat = Math.atan2(zh, Math.hypot(xh, yh)) * R2D;
  let dist = Math.hypot(xh, yh, zh);

  const s = sunEcliptic(d);
  const Ls = rev(s.w + s.M);            // Sun's MEAN longitude, for the arguments
  const Lm = rev(Nd + wd + Md);
  const Dm = rev(Lm - Ls);
  const F = rev(Lm - Nd);
  const Ms = s.M;

  lon += -1.274 * Math.sin((Md - 2 * Dm) * D2R)
       + 0.658 * Math.sin(2 * Dm * D2R)
       - 0.186 * Math.sin(Ms * D2R)
       - 0.059 * Math.sin((2 * Md - 2 * Dm) * D2R)
       - 0.057 * Math.sin((Md - 2 * Dm + Ms) * D2R)
       + 0.053 * Math.sin((Md + 2 * Dm) * D2R)
       + 0.046 * Math.sin((2 * Dm - Ms) * D2R)
       + 0.041 * Math.sin((Md - Ms) * D2R)
       - 0.035 * Math.sin(Dm * D2R)
       - 0.031 * Math.sin((Md + Ms) * D2R)
       - 0.015 * Math.sin((2 * F - 2 * Dm) * D2R)
       + 0.011 * Math.sin((Md - 4 * Dm) * D2R);

  lat += -0.173 * Math.sin((F - 2 * Dm) * D2R)
       - 0.055 * Math.sin((Md - F - 2 * Dm) * D2R)
       - 0.046 * Math.sin((Md + F - 2 * Dm) * D2R)
       + 0.033 * Math.sin((F + 2 * Dm) * D2R)
       + 0.017 * Math.sin((2 * Md + F) * D2R);

  dist += -0.58 * Math.cos((Md - 2 * Dm) * D2R)
        - 0.46 * Math.cos(2 * Dm * D2R);

  lon = rev(lon);
  const { ra, dec } = eclipticToEquatorial(lon, lat, d);

  // Phase from elongation against the Sun's TRUE longitude. Using the mean
  // longitude here puts the synodic month 29 minutes out per lunation.
  const elong = rev(lon - s.lon);
  const illum = (1 - Math.cos(elong * D2R)) / 2;
  const waxing = elong < 180;

  return {
    kind: 'moon', name: 'The Moon',
    ra, dec, lon, lat,
    distEarthRadii: dist,
    distKm: dist * 6378.14,
    elongation: elong,
    illuminated: illum,
    waxing,
    phaseName: phaseName(elong),
    mag: -12.7 + 0.026 * Math.abs(180 - elong) * 0.1,
    colour: [235, 232, 220],
  };
}

export function phaseName(elongDeg) {
  const e = rev(elongDeg);
  if (e < 11.25 || e >= 348.75) return 'new';
  if (e < 78.75) return 'waxing crescent';
  if (e < 101.25) return 'first quarter';
  if (e < 168.75) return 'waxing gibbous';
  if (e < 191.25) return 'full';
  if (e < 258.75) return 'waning gibbous';
  if (e < 281.25) return 'last quarter';
  return 'waning crescent';
}

/** A glyph suggesting the lit fraction. */
export function moonGlyph(illum) {
  if (illum > 0.94) return '@';
  if (illum > 0.75) return '%';
  if (illum > 0.45) return '8';
  if (illum > 0.2) return ')';
  if (illum > 0.06) return '(';
  return 'o';
}
