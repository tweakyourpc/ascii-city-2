import { boxAround, DEFAULT_SPAN_DEG } from './world/overpass.js';

/**
 * Turn a place name into somewhere the engine can load.
 *
 * Two OpenStreetMap geocoders, both of which allow direct browser access:
 * Nominatim first because it is OSM's own and returns the richest metadata,
 * Photon as a fallback because its usage policy is more relaxed and it stays
 * up when Nominatim rate-limits.
 *
 * A geocoder answers with a point and, usually, a bounding box for the whole
 * place. That box is not useful here: Kyoto's is about 0.45 by 0.32 degrees,
 * some 2500 times the area this engine will load. What "go to Kyoto" means is
 * the middle of Kyoto, so only the centre is used and the box comes from the
 * engine's own span.
 *
 * Shaped like wiki.js: callback style, one request in flight, cached, and
 * every failure path ends in done(null) rather than throwing.
 */

const CACHE = new Map();                 // query -> result | null
const LS_PREFIX = 'ascii-city:geo:1:';
const TTL_MS = 30 * 24 * 3600 * 1000;
const TIMEOUT_MS = 8000;

let failures = 0;
let coolUntil = 0;
let inFlight = null;

/** Identify the app, as Nominatim's usage policy asks. Browsers send Referer. */
const UA = 'ascii-city/1.1 (+https://github.com/tweakyourpc/ascii-city)';

const norm = (q) => String(q).trim().toLowerCase().replace(/\s+/g, ' ');

function lang() {
  try {
    return (navigator.language || 'en').split('-')[0];
  } catch {
    return 'en';
  }
}

function readLS(key) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || Date.now() - v.at > TTL_MS) return null;
    return v;
  } catch {
    return null;
  }
}

function writeLS(key, value) {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify({ ...value, at: Date.now() }));
  } catch {
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith(LS_PREFIX)) localStorage.removeItem(k);
      }
      localStorage.setItem(LS_PREFIX + key, JSON.stringify({ ...value, at: Date.now() }));
    } catch { /* give up quietly */ }
  }
}

async function getJson(url, signal) {
  const res = await fetch(url, {
    signal,
    headers: { Accept: 'application/json', 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

/** Build the result the rest of the app consumes. */
function place(lat, lon, display) {
  const bbox = boxAround(lat, lon, DEFAULT_SPAN_DEG);
  if (!bbox) return null;
  return {
    bbox,
    // Short name for the world label, full name so the user can see what they
    // actually got. "Springfield" is ambiguous and silently loading the wrong
    // one is the failure worth preventing.
    label: String(display).split(',')[0].trim() || String(display),
    display: String(display),
  };
}

async function viaNominatim(query, signal) {
  const url = 'https://nominatim.openstreetmap.org/search'
            + `?q=${encodeURIComponent(query)}`
            + `&format=jsonv2&limit=1&accept-language=${lang()}`;
  const j = await getJson(url, signal);
  if (!Array.isArray(j) || j.length === 0) throw new Error('no match');
  const r = j[0];
  const lat = Number(r.lat);
  const lon = Number(r.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('bad result');
  return place(lat, lon, r.display_name || query);
}

async function viaPhoton(query, signal) {
  const url = 'https://photon.komoot.io/api/'
            + `?q=${encodeURIComponent(query)}&limit=1&lang=${lang()}`;
  const j = await getJson(url, signal);
  const f = j && j.features && j.features[0];
  if (!f || !f.geometry) throw new Error('no match');
  const [lon, lat] = f.geometry.coordinates;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('bad result');
  const p = f.properties || {};
  const display = [p.name, p.city, p.state, p.country]
    .filter((v, i, a) => v && a.indexOf(v) === i)
    .join(', ') || query;
  return place(lat, lon, display);
}

async function resolve(query, signal) {
  try {
    return await viaNominatim(query, signal);
  } catch (err) {
    if (signal.aborted) throw err;
    return viaPhoton(query, signal);
  }
}

/**
 * Look up a place name.
 * @param {string} query
 * @param {(r: {bbox:number[], label:string, display:string}|null) => void} done
 */
export function lookup(query, done) {
  const key = norm(query);
  if (!key) { done(null); return; }

  if (CACHE.has(key)) { done(CACHE.get(key)); return; }

  const cached = readLS(key);
  if (cached && cached.bbox) { CACHE.set(key, cached); done(cached); return; }

  if (typeof fetch !== 'function') { done(null); return; }
  if (typeof navigator === 'object' && navigator && navigator.onLine === false) {
    done(null);
    return;
  }
  if (Date.now() < coolUntil) { done(null); return; }

  if (inFlight) inFlight.abort();
  const ctl = new AbortController();
  inFlight = ctl;
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);

  resolve(query, ctl.signal)
    .then((v) => {
      if (!v) throw new Error('unusable result');
      failures = 0;
      CACHE.set(key, v);
      writeLS(key, v);
      done(v);
    })
    .catch(() => {
      if (!ctl.signal.aborted) {
        // A genuine miss is memoised in RAM but not on disk: the name may
        // simply not exist, and there is no point asking twice this session.
        CACHE.set(key, null);
        if (++failures >= 3) coolUntil = Date.now() + 60000;
      }
      done(null);
    })
    .finally(() => {
      clearTimeout(timer);
      if (inFlight === ctl) inFlight = null;
    });
}

/** Test hook. */
export function _reset() {
  CACHE.clear();
  failures = 0;
  coolUntil = 0;
  if (inFlight) inFlight.abort();
  inFlight = null;
}
