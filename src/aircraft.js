 /**
 * Live aircraft as a layer of the real world.
 *
 * OpenStreetMap gives the geography; the astronomical code gives the sky; this
 * gives the human activity actually occurring in that sky. The pipeline is:
 *
 *   live ADS-B observation -> lat/lon/alt -> world cell via the OSM projection
 *   -> a glyph drawn in the same perspective as the buildings and streets.
 *
 * The provider is adsb.lol (ODbL 1.0). No keyless ADS-B source sends
 * browser-permissive CORS headers, so the browser uses this project's
 * allowlisted Cloudflare Worker. CORS_PROXY remains available as a local
 * override; failures simply leave the layer empty and the world keeps running.
 *
 * Everything here is strictly additive and fails safe. A malformed record is
 * dropped, a failed request clears nothing it cannot replace, and missing
 * fields stay null rather than being invented.
 */

import {
  METERS_PER_CELL, AIR_ENABLED, AIR_REFRESH_MS, AIR_RADIUS_KM,
  AIR_ALT_MIN_M, AIR_GLYPH, CORS_PROXY, API_BASE,
} from './config.js';
import { FOV } from './config.js';
import { fogOf } from './render/materials.js';

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320;
const FT_PER_M = 3.2808399;

const WINDS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
               'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** Compass point for a bearing in degrees. */
export function wind(deg) {
  return WINDS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

/**
 * Is the simulated clock effectively the real clock? Live aircraft and weather
 * only belong to a present-day sky; once the user warps time they are withdrawn.
 *
 * Withdraw ONLY on an active time warp (the warp slider pushed above 1x). A
 * static offset must not withdraw the layers — loading a city can set a local
 * hour in the URL, and backgrounding the tab lets Date.now() race ahead of the
 * paused simTime. Either would otherwise make weather and aircraft permanently
 * unavailable the moment you load a city or switch tabs, which is the bug that
 * left them showing "…"/"UNAVAILABLE". The warp slider is the deliberate
 * "time travel" control, so it is the only thing that withdraws them.
 */
export function isLiveTime(simTime, warpFactor) {
  return warpFactor <= 1.0001;
}

/* ------------------------------- fetching ------------------------------- */

/**
 * Build the provider URL for a point/radius query. The proxy, if any, is
 * prepended verbatim, so a self-hosted proxy that forwards the path works.
 */
export function buildUrl(lat, lon, radiusKm) {
  const base = `https://api.adsb.lol/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/${radiusKm}`;
  if (CORS_PROXY) return CORS_PROXY.replace(/\/$/, '') + '/' + base;
  return `${API_BASE}/api/aircraft?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&radiusKm=${radiusKm}`;
}

/**
 * Normalize one raw adsb.lol aircraft record into the shape the layer keeps.
 * Every field is taken straight from the source; nothing is guessed. A record
 * with no usable position is returned as null and dropped by the caller.
 */
export function normalizeAc(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = Number(raw.lat);
  const lon = Number(raw.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  // Barometric altitude is "ground" for surface traffic; geometric altitude is
  // the truthful one when present. Fall back to baro only if it is numeric.
  let altM = Number(raw.alt_geom);
  if (!Number.isFinite(altM)) {
    const b = raw.alt_baro;
    altM = (typeof b === 'number') ? b : NaN;
  }
  if (!Number.isFinite(altM)) return null;
  altM /= FT_PER_M;                    // adsb.lol altitude fields are feet

  const gs = Number(raw.gs);            // knots
  const track = Number(raw.track);      // degrees clockwise from north
  const onGround = raw.alt_baro === 'ground' || raw.on_ground === true;

  const callsign = typeof raw.flight === 'string'
    ? raw.flight.replace(/\s+$/, '') : null;

  return {
    icao: typeof raw.hex === 'string' ? raw.hex.toLowerCase() : null,
    callsign: callsign && callsign.length ? callsign : null,
    type: typeof raw.t === 'string' && raw.t.length ? raw.t : null,
    originCountry: typeof raw.origin_country === 'string'
      ? raw.origin_country : null,
    squawk: typeof raw.squawk === 'string' && raw.squawk.length ? raw.squawk : null,
    lat, lon,
    altM,
    gsKt: Number.isFinite(gs) ? gs : null,
    trackDeg: Number.isFinite(track) ? track : null,
    vertRate: Number.isFinite(Number(raw.geom_rate)) ? Number(raw.geom_rate)
               : (Number.isFinite(Number(raw.baro_rate)) ? Number(raw.baro_rate) : null),
    onGround: !!onGround,
  };
}

/**
 * Fetch and normalize aircraft near a point. Throws on any failure so the
 * caller can treat "could not reach the source" as "no aircraft right now".
 * `fetchImpl` is injectable for tests; defaults to the global fetch.
 */
export async function fetchAircraft(lat, lon, radiusKm, {
  signal, timeoutMs = 8000, fetchImpl = (typeof fetch === 'function' ? fetch : null),
} = {}) {
  if (!fetchImpl) throw new Error('no fetch available');
  const url = buildUrl(lat, lon, radiusKm);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) { clearTimeout(timer); throw new DOMException('Aborted', 'AbortError'); }
    signal.addEventListener('abort', () => ctl.abort(), { once: true });
  }
  try {
    const res = await fetchImpl(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(String(res.status));
    const j = await res.json();
    const list = Array.isArray(j && j.ac) ? j.ac : [];
    const out = [];
    for (const r of list) {
      const a = normalizeAc(r);
      if (a && !a.onGround && a.altM >= AIR_ALT_MIN_M) out.push(a);
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------- the layer ------------------------------ */

/**
 * Holds the live aircraft for the current world and draws them in perspective.
 *
 * Each aircraft keeps its last two observations so motion between the 20-second
 * polls can be interpolated: `prev` is the previous observation, `obs` the
 * latest, and `positionOf` lerps between them by elapsed time. The interpolated
 * position is explicitly "calculated", never presented as a fresh observation.
 */
export class AircraftLayer {
  constructor() {
    this.enabled = AIR_ENABLED;
    this.world = null;
    this.proj = null;
    this.records = new Map();     // icao -> { obs, prev, tObs, tPrev }
    this.marks = [];              // [{ x, y, icao }] for picking, rebuilt each draw
    this.acc = 0;                 // ms since last poll
    this.lastError = 0;
    this._inflight = null;
  }

  setWorld(world) {
    this.world = world;
    // Only a real OSM extract has a geographic location to query against.
    this.proj = world && world.bbox ? world.proj : null;
    this.records.clear();
    this.marks.length = 0;
    this.acc = AIR_REFRESH_MS;    // poll promptly on first frame
  }

  toggle() {
    this.enabled = !this.enabled;
    if (!this.enabled) this.records.clear();
    return this.enabled;
  }

  get active() {
    return this.enabled && !!this.proj;
  }

  /** True if any aircraft are currently held (for the HUD). */
  get hasAircraft() {
    return this.records.size > 0;
  }

  /**
   * Advance the layer. Polls when due and only while the clock is live and the
   * world is geographic. Interpolation happens lazily in positionOf(), so the
   * per-frame cost here is just the accumulator and the occasional fetch.
   */
  update(dt, cam, simTime, live, warpFactor, signal) {
    if (!this.active) { this.records.clear(); return; }
    if (!live) { this.records.clear(); return; }

    this.acc += dt * 1000;
    if (this.acc < AIR_REFRESH_MS) return;
    this.acc = 0;

    const lat = this.proj.lat(cam.x);
    const lon = this.proj.lon(cam.x);

    if (this._inflight) this._inflight.abort();
    const ctl = new AbortController();
    this._inflight = ctl;
    if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });

    fetchAircraft(lat, lon, AIR_RADIUS_KM, { signal: ctl.signal })
      .then((list) => {
        this._inflight = null;
        this.lastError = 0;
        const now = Date.now();
        const seen = new Set();
        for (const a of list) {
          if (!a.icao) continue;
          seen.add(a.icao);
          const rec = this.records.get(a.icao);
          if (rec) {
            rec.prev = rec.obs;
            rec.tPrev = rec.tObs;
            rec.obs = a;
            rec.tObs = now;
          } else {
            this.records.set(a.icao, { obs: a, prev: a, tObs: now, tPrev: now });
          }
        }
        // Drop aircraft no longer reported. A stale one would otherwise hover
        // forever at its last interpolated position.
        for (const key of this.records.keys()) {
          if (!seen.has(key)) this.records.delete(key);
        }
      })
      .catch(() => {
        this._inflight = null;
        this.lastError = Date.now();
        // Keep the last good set; do not wipe on a transient failure.
      });
  }

  /**
   * Interpolated position of a record at time `now`. Lerps prev->obs by the
   * fraction of one observation interval elapsed after the newest sample,
   * clamped to [0,1]. This intentional one-sample delay makes a new poll begin
   * exactly where the previous animation ended instead of snapping immediately
   * to the latest coordinates.
   */
  positionOf(rec, now = Date.now()) {
    const span = rec.tObs - rec.tPrev;
    let f = span > 0 ? (now - rec.tObs) / span : 1;
    if (f < 0) f = 0; else if (f > 1) f = 1;
    const a = rec.prev;
    const b = rec.obs;
    return {
      lat: a.lat + (b.lat - a.lat) * f,
      lon: a.lon + (b.lon - a.lon) * f,
      altM: a.altM + (b.altM - a.altM) * f,
      gsKt: b.gsKt,
      trackDeg: b.trackDeg,
      icao: b.icao,
      callsign: b.callsign,
      type: b.type,
      squawk: b.squawk,
      originCountry: b.originCountry,
      vertRate: b.vertRate,
      onGround: b.onGround,
    };
  }

  /** Nearest picked aircraft mark to a screen cell, within `r` cells. */
  pickAt(col, row, r = 2) {
    let best = null;
    let bd = (r + 1) * (r + 1);
    for (const m of this.marks) {
      const dx = m.x - col;
      const dy = m.y - row;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = m.icao; }
    }
    return best;
  }

  /** The latest observation for a picked icao, for the info panel. */
  info(icao) {
    const rec = this.records.get(icao);
    return rec ? rec.obs : null;
  }

  /**
   * Draw aircraft in the same perspective as the world. Each is a finite
   * distance point at height z, projected with the same along/side maths the
   * sprite and label renderers use, and depth-tested against the scene buffer
   * so a building in front hides an aircraft behind it.
   */
  draw(screen, cam, L) {
    if (!this.active) return;
    this.marks.length = 0;

    const fwdX = Math.cos(cam.angle);
    const fwdY = Math.sin(cam.angle);
    const { cols, rows, depth } = screen;
    const now = Date.now();

    const vis = [];
    for (const rec of this.records.values()) {
      const p = this.positionOf(rec, now);
      const wx = this.proj.x(p.lon);
      const wy = this.proj.y(p.lat);
      const z = p.altM / METERS_PER_CELL;

      const rx = wx - cam.x;
      const ry = wy - cam.y;
      const along = rx * fwdX + ry * fwdY;
      if (along < 1) continue;                       // behind the camera
      const side = -rx * fwdY + ry * fwdX;
      const halfW = along * Math.tan(FOV / 2) * 1.04;
      if (side > halfW || side < -halfW) continue;   // outside the view fan

      const col = cols / 2 - (side / along) * cam.proj;
      const row = cam.rowOf(z, along);
      if (col < 0 || col >= cols || row < 0 || row >= rows) continue;

      vis.push({ p, wx, wy, z, along, side, col, row });
    }

    // Far first so nearer aircraft overdraw.
    vis.sort((a, b) => b.along - a.along);

    for (const v of vis) {
      const cx = Math.round(v.col);
      const cy = Math.round(v.row);
      if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) continue;
      // Depth test: a building nearer than the aircraft hides it.
      if (v.along >= depth[cy * cols + cx] * 1.02) continue;

      const f = Math.max(0.12, fogOf(v.along));
      const colour = L.depth(255, 232, 150, f);
      screen.set(cx, cy, AIR_GLYPH, colour);
      this.marks.push({ x: cx, y: cy, icao: v.p.icao });

      // A nearby aircraft earns a compact label: callsign, altitude, and a
      // heading arrow derived from a short look-ahead along its track.
      if (v.along < 60 && v.p.callsign) {
        const arrow = headingArrow(v.p.trackDeg, cam.angle);
        const altFt = Math.round(v.p.altM * FT_PER_M).toLocaleString('en-US');
        const label = `${v.p.callsign} ${altFt}' ${arrow}`;
        const lx = cx - Math.floor(label.length / 2);
        const ly = cy - 1;
        if (ly >= 0) {
          for (let i = 0; i < label.length; i++) {
            const gx = lx + i;
            if (gx < 0 || gx >= cols) continue;
            if (v.along >= depth[ly * cols + gx] * 1.02) continue;
            screen.set(gx, ly, label[i], colour);
          }
        }
      }
    }
  }
}

/**
 * A single glyph indicating which way the aircraft is heading relative to the
 * camera. The track is a world bearing (0=N, 90=E); the camera's forward
 * bearing is derived from its angle (world +y is north, forward = (cos,sin)).
 * rel = 0 means the aircraft is moving away (up the screen), 90 to the right,
 * 180 toward the camera. Returns '?' when heading is unknown.
 */
export function headingArrow(trackDeg, camAngle) {
  if (trackDeg === null || !Number.isFinite(trackDeg)) return '?';
  const camBearing = Math.atan2(Math.cos(camAngle), Math.sin(camAngle))
    * 180 / Math.PI;
  let rel = (trackDeg - camBearing + 360) % 360;
  if (rel > 180) rel -= 360;
  if (rel >= 157.5 || rel <= -157.5) return '↘';   // toward (down)
  if (rel >= 112.5) return '↘';                     // down-right
  if (rel >= 67.5) return '→';                      // right
  if (rel >= 22.5) return '↗';                      // up-right
  if (rel > -22.5) return '↖';                      // away (up)
  if (rel > -67.5) return '↖';                      // up-left
  if (rel > -112.5) return '↙';                     // left
  if (rel > -157.5) return '↙';                     // down-left
  return '↘';
}

/** Planar great-circle-ish distance in km between two lat/lon, for the panel. */
export function distanceKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * M_PER_DEG_LAT;
  const mPerLon = M_PER_DEG_LON * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
  const dLon = (lon2 - lon1) * mPerLon;
  return Math.sqrt(dLat * dLat + dLon * dLon) / 1000;
}
