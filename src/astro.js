/**
 * Solar and stellar positions. Pure functions, no dependencies.
 *
 * Accuracy is low-precision-almanac grade: sun position to within about a
 * degree, which is far tighter than a character grid can show.
 */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export function julianDay(date) {
  let y = date.getUTCFullYear();
  let m = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  if (m <= 2) { y--; m += 12; }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  const jd0 = Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1))
            + d + B - 1524.5;
  // Without the time of day the sun never moves.
  const frac = (date.getUTCHours() + date.getUTCMinutes() / 60
              + date.getUTCSeconds() / 3600
              + date.getUTCMilliseconds() / 3600000) / 24;
  return jd0 + frac;
}

/** Apparent right ascension (degrees) and declination (degrees) of the sun. */
export function sunPos(jd) {
  const n = jd - 2451545.0;
  let L = (280.460 + 0.9856474 * n) % 360; if (L < 0) L += 360;
  let g = (357.528 + 0.9856003 * n) % 360; if (g < 0) g += 360;
  const lambda = (L + 1.915 * Math.sin(g * D2R) + 0.020 * Math.sin(2 * g * D2R)) % 360;
  const eps = 23.439 - 0.0000004 * n;
  let ra = Math.atan2(Math.cos(eps * D2R) * Math.sin(lambda * D2R),
                      Math.cos(lambda * D2R)) * R2D;
  if (ra < 0) ra += 360;
  const dec = Math.asin(Math.sin(eps * D2R) * Math.sin(lambda * D2R)) * R2D;
  return { ra, dec };
}

/** Local sidereal time in hours. */
export function lst(jd, lon) {
  const n = jd - 2451545.0;
  let gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  if (gmst < 0) gmst += 24;
  return (gmst + lon / 15 + 24) % 24;
}

/** Equatorial to horizontal coordinates. `raH` in hours, everything else degrees. */
export function altAz(raH, decD, jd, lat, lon) {
  const ra = raH * 15;
  const sid = lst(jd, lon) * 15;
  const ha = (sid - ra) * D2R;
  const decR = decD * D2R;
  const latR = lat * D2R;
  const alt = Math.asin(Math.sin(decR) * Math.sin(latR)
            + Math.cos(decR) * Math.cos(latR) * Math.cos(ha)) * R2D;
  let az = Math.atan2(-Math.sin(ha),
             Math.tan(decR) * Math.cos(latR) - Math.sin(latR) * Math.cos(ha)) * R2D;
  if (az < 0) az += 360;
  return { alt, az };
}

/**
 * [right ascension hours, declination degrees, visual magnitude].
 * The named bright stars, then a fixed procedural field so the sky isn't empty.
 *
 * NAMED_STARS runs parallel to the first entries of STARS. Everything pushed
 * by the filler below is anonymous by construction and stays that way.
 */
export const NAMED_STARS = [
  { name: 'Vega', bayer: 'Alpha Lyrae', con: 'Lyra' },
  { name: 'Polaris', bayer: 'Alpha Ursae Minoris', con: 'Ursa Minor' },
  { name: 'Rigel', bayer: 'Beta Orionis', con: 'Orion' },
  { name: 'Betelgeuse', bayer: 'Alpha Orionis', con: 'Orion' },
  { name: 'Sirius', bayer: 'Alpha Canis Majoris', con: 'Canis Major' },
  { name: 'Arcturus', bayer: 'Alpha Bootis', con: 'Bootes' },
  { name: 'Canopus', bayer: 'Alpha Carinae', con: 'Carina' },
  { name: 'Altair', bayer: 'Alpha Aquilae', con: 'Aquila' },
  { name: 'Procyon', bayer: 'Alpha Canis Minoris', con: 'Canis Minor' },
  { name: 'Aldebaran', bayer: 'Alpha Tauri', con: 'Taurus' },
  { name: 'Acrux', bayer: 'Alpha Crucis', con: 'Crux' },
  { name: 'Spica', bayer: 'Alpha Virginis', con: 'Virgo' },
  { name: 'Capella', bayer: 'Alpha Aurigae', con: 'Auriga' },
  { name: 'Antares', bayer: 'Alpha Scorpii', con: 'Scorpius' },
  { name: 'Pollux', bayer: 'Beta Geminorum', con: 'Gemini' },
  { name: 'Castor', bayer: 'Alpha Geminorum', con: 'Gemini' },
  { name: 'Deneb', bayer: 'Alpha Cygni', con: 'Cygnus' },
  { name: 'Regulus', bayer: 'Alpha Leonis', con: 'Leo' },
  { name: 'Fomalhaut', bayer: 'Alpha Piscis Austrini', con: 'Piscis Austrinus' },
  { name: 'Achernar', bayer: 'Alpha Eridani', con: 'Eridanus' },
  { name: 'Rigil Kentaurus', bayer: 'Alpha Centauri', con: 'Centaurus' },
  { name: 'Bellatrix', bayer: 'Gamma Orionis', con: 'Orion' },
  { name: 'Alnilam', bayer: 'Epsilon Orionis', con: 'Orion' },
  { name: 'Alnitak', bayer: 'Zeta Orionis', con: 'Orion' },
  { name: 'Mintaka', bayer: 'Delta Orionis', con: 'Orion' },
  { name: 'Dubhe', bayer: 'Alpha Ursae Majoris', con: 'Ursa Major' },
  { name: 'Alkaid', bayer: 'Eta Ursae Majoris', con: 'Ursa Major' },
  { name: 'Alioth', bayer: 'Epsilon Ursae Majoris', con: 'Ursa Major' },
  { name: 'Mizar', bayer: 'Zeta Ursae Majoris', con: 'Ursa Major' },
  { name: 'Algol', bayer: 'Beta Persei', con: 'Perseus' },
  { name: 'Mirfak', bayer: 'Alpha Persei', con: 'Perseus' },
  { name: 'Alpheratz', bayer: 'Alpha Andromedae', con: 'Andromeda' },
  { name: 'Hamal', bayer: 'Alpha Arietis', con: 'Aries' },
  { name: 'Denebola', bayer: 'Beta Leonis', con: 'Leo' },
  { name: 'Alphard', bayer: 'Alpha Hydrae', con: 'Hydra' },
  { name: 'Vindemiatrix', bayer: 'Epsilon Virginis', con: 'Virgo' },
];

export const STARS = [
  [18.6156, 38.78, 0.03], [2.5297, 89.26, 1.97], [5.2423, -8.20, 0.18],
  [5.9195, 7.41, 0.50], [6.7525, -16.72, -1.46], [14.2610, 19.18, 0.05],
  [6.3992, -52.70, -0.72], [19.8463, 8.87, 0.77], [7.6550, 5.22, 0.34],
  [4.5987, 16.51, 0.85], [12.4433, -63.10, 1.25], [13.4200, -11.16, 0.98],
  [5.2782, 45.998, 0.08], [16.4901, -26.43, 1.06], [7.7553, 28.03, 1.14],
  [7.5766, 31.888, 1.58], [20.6905, 45.28, 1.25], [10.1395, 11.967, 1.40],
  [22.9608, -29.62, 1.16], [1.6285, -57.24, 0.45], [14.6600, -60.83, -0.01],
  [5.4189, 6.35, 1.64], [5.6036, -1.20, 1.69], [5.6793, -1.943, 1.77],
  [5.5334, -0.299, 2.25], [11.0621, 61.751, 1.79], [13.7923, 49.313, 1.86],
  [12.9005, 55.960, 1.77], [13.3987, 54.925, 2.04], [3.1361, 40.956, 2.12],
  [3.4054, 49.861, 1.79], [0.1398, 29.091, 2.06], [2.1195, 23.462, 2.00],
  [11.8177, 14.572, 2.14], [9.4598, -8.659, 1.98], [13.0362, 10.959, 2.83],
];

(function fillSky() {
  let s = 991;
  const r = () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = 0; i < 700; i++) {
    STARS.push([r() * 24, Math.asin(r() * 2 - 1) * R2D, 1.6 + r() * 2.6]);
  }
})();
