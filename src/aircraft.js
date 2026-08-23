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
 * browser-permissive CORS headers, so the browser requires a Worker configured
 * by the person deploying this fork. An unconfigured fork reports that state
 * and sends no aircraft request anywhere.
 *
 * Everything here is strictly additive and fails safe. A malformed record is
 * dropped, a failed request clears nothing it cannot replace, and missing
 * fields stay null rather than being invented.
 */

import {
  METERS_PER_CELL, AIR_ENABLED, AIR_REFRESH_MS, AIR_RADIUS_KM,
  AIR_ALT_MIN_M, AIR_GLYPH,
} from './config.js';
import { FOV } from './config.js';
import { WORKER_URL } from './runtime-config.js';
import { fogOf } from './render/materials.js';
import { geoAt } from './world/osm.js';

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320;
const FT_PER_M = 3.2808399;

const WINDS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
               'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** Compass point for a bearing in degrees. */
export function wind(deg) {
  return WINDS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

/** Compass bearing from one nearby geographic point to another. */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const meanLat = (lat1 + lat2) * Math.PI / 360;
  const east = (lon2 - lon1) * M_PER_DEG_LON * Math.cos(meanLat);
  const north = (lat2 - lat1) * M_PER_DEG_LAT;
  return (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
}

/** Plain-language turn cue from camera heading to an absolute bearing. */
export function lookDirection(bearing, camAngle) {
  const facing = Math.atan2(Math.cos(camAngle), Math.sin(camAngle)) * 180 / Math.PI;
  let rel = (bearing - facing + 540) % 360 - 180;
  if (Math.abs(rel) <= 22.5) return 'ahead';
  if (rel > 157.5 || rel < -157.5) return 'behind';
  if (rel > 0) return rel < 112.5 ? 'right' : 'back-right';
  return rel > -112.5 ? 'left' : 'back-left';
}

/* ------------------------------- fetching ------------------------------- */

/**
 * Build the deployment-owned Worker URL for a point/radius query. With no
 * configured Worker this deliberately returns null rather than a relative URL.
 */
export function buildUrl(lat, lon, radiusKm, workerUrl = WORKER_URL) {
  if (!workerUrl) return null;
  return `${workerUrl}/api/aircraft?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&radiusKm=${radiusKm}`;
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
  workerUrl = WORKER_URL,
} = {}) {
  if (!fetchImpl) throw new Error('no fetch available');
  const url = buildUrl(lat, lon, radiusKm, workerUrl);
  if (!url) throw new Error('aircraft worker not configured');
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
  constructor({ workerUrl = WORKER_URL } = {}) {
    this.workerUrl = workerUrl;
    this.enabled = AIR_ENABLED;
    this.world = null;
    this.proj = null;
    this.records = new Map();     // icao -> { obs, prev, tObs, tPrev }
    this.marks = [];              // [{ x, y, icao }] for picking, rebuilt each draw
    this.acc = 0;                 // ms since last poll
    this.lastError = 0;
    this.lastSuccess = 0;
    this.hasPolled = false;
    this.loading = false;
    this._inflight = null;
  }

  setWorld(world) {
    if (this._inflight) this._inflight.abort();
    this._inflight = null;
    this.world = world;
    // Only a real OSM extract has a geographic location to query against.
    this.proj = world && world.bbox ? world.proj : null;
    this.records.clear();
    this.marks.length = 0;
    this.lastError = 0;
    this.lastSuccess = 0;
    this.hasPolled = false;
    this.loading = false;
    this.acc = AIR_REFRESH_MS;    // poll promptly on first frame
  }

  toggle() {
    this.enabled = !this.enabled;
    if (!this.enabled) this._withdraw();
    else this.refreshNow();
    return this.enabled;
  }

  _withdraw() {
    this.records.clear();
    this.marks.length = 0;
    if (this._inflight) this._inflight.abort();
    this._inflight = null;
    this.loading = false;
  }

  refreshNow() {
    this.acc = AIR_REFRESH_MS;
    this.hasPolled = false;
    this.lastError = 0;
  }

  get active() {
    return this.enabled && !!this.proj && !!this.workerUrl;
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
  update(dt, cam, live, signal, fetchImpl) {
    if (!this.active) { this._withdraw(); return; }
    if (!live) { this._withdraw(); return; }

    this.acc += dt * 1000;
    if (this.acc < AIR_REFRESH_MS) return;
    this.acc = 0;

    const { lat, lon } = geoAt(this.proj, cam.x, cam.y);

    if (this._inflight) this._inflight.abort();
    const ctl = new AbortController();
    this._inflight = ctl;
    this.loading = true;
    if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });

    fetchAircraft(lat, lon, AIR_RADIUS_KM, {
      signal: ctl.signal, fetchImpl, workerUrl: this.workerUrl,
    })
      .then((list) => {
        if (this._inflight !== ctl || ctl.signal.aborted) return;
        this._inflight = null;
        this.loading = false;
        this.lastError = 0;
        const now = Date.now();
        this.lastSuccess = now;
        this.hasPolled = true;
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
        if (this._inflight !== ctl) return;
        this._inflight = null;
        this.loading = false;
        if (ctl.signal.aborted) return;
        this.hasPolled = true;
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

  /** Nearest interpolated contact to the camera, with navigation guidance. */
  nearest(cam, now = Date.now()) {
    if (!this.proj || this.records.size === 0) return null;
    const here = geoAt(this.proj, cam.x, cam.y);
    let best = null;
    for (const rec of this.records.values()) {
      const p = this.positionOf(rec, now);
      const distance = distanceKm(here.lat, here.lon, p.lat, p.lon);
      if (!best || distance < best.distanceKm) {
        const bearing = bearingDeg(here.lat, here.lon, p.lat, p.lon);
        best = {
          ...p,
          name: p.callsign || p.icao?.toUpperCase() || 'AIRCRAFT',
          distanceKm: distance,
          bearingDeg: bearing,
          compass: wind(bearing),
          look: lookDirection(bearing, cam.angle),
        };
      }
    }
    return best;
  }

  /** Truthful, actionable HUD status for this layer. */
  statusOf(cam, imperial = false, live = true) {
    if (!this.enabled) return 'OFF';
    if (!this.proj) return 'N/A';
    if (!this.workerUrl) return 'SETUP REQUIRED';
    if (!live) return 'SIM · press 0 for live';
    if (this.loading && !this.hasPolled) return 'SEARCHING';
    if (this.lastError > this.lastSuccess && this.records.size === 0) return 'UNAVAILABLE';
    if (this.hasPolled && this.records.size === 0) {
      return `LIVE · none within ${AIR_RADIUS_KM} km`;
    }
    if (this.records.size === 0) return 'SEARCHING';

    const near = this.nearest(cam);
    if (!near) return `LIVE · ${this.records.size}`;
    const dist = imperial
      ? `${(near.distanceKm * 0.621371).toFixed(1)} mi`
      : `${near.distanceKm.toFixed(1)} km`;
    const alt = imperial
      ? `${Math.round(near.altM * FT_PER_M).toLocaleString('en-US')} ft`
      : `${Math.round(near.altM).toLocaleString('en-US')} m`;
    const freshness = this.lastError > this.lastSuccess ? 'STALE' : 'LIVE';
    return `${freshness} · ${this.records.size} · nearest ${near.name} `
      + `${near.compass} ${dist} · ${alt} · look ${near.look}`;
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
      v.drawn = true;
      this.marks.push({ x: cx, y: cy, icao: v.p.icao });

    }

    // Label only the nearest few contacts. All glyphs remain visible, while a
    // small collision check keeps a busy airport from turning into solid text.
    const boxes = [];
    const labelCandidates = vis.filter((v) => v.drawn)
      .sort((a, b) => (a.along * a.along + a.side * a.side)
                    - (b.along * b.along + b.side * b.side));
    let labels = 0;
    for (const v of labelCandidates) {
      if (labels >= 3) break;
      const name = v.p.callsign || v.p.icao?.toUpperCase();
      if (!name) continue;
      const cx = Math.round(v.col);
      const cy = Math.round(v.row);
      const arrow = headingArrow(v.p.trackDeg, cam.angle);
      const altFt = Math.round(v.p.altM * FT_PER_M).toLocaleString('en-US');
      const label = `${name} ${altFt}' ${arrow}`;
      const lx = cx - Math.floor(label.length / 2);
      const ly = cy - 1;
      const box = { x0: lx, x1: lx + label.length - 1, y: ly };
      if (ly < 0 || boxes.some((b) => b.y === ly && box.x0 <= b.x1 + 1
                                              && box.x1 + 1 >= b.x0)) continue;

      const f = Math.max(0.12, fogOf(v.along));
      const colour = L.depth(255, 232, 150, f);
      for (let i = 0; i < label.length; i++) {
        const gx = lx + i;
        if (gx < 0 || gx >= cols) continue;
        if (v.along >= depth[ly * cols + gx] * 1.02) continue;
        screen.set(gx, ly, label[i], colour);
      }
      boxes.push(box);
      labels++;
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
