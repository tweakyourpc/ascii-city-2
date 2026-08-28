/**
 * Live earthquakes as a layer of the real world.
 *
 * OpenStreetMap gives the geography, the astronomical code gives the sky, the
 * aircraft layer gives the human activity in it, the weather layer gives the
 * conditions — and this gives the ground itself moving. The pipeline is:
 *
 *   live USGS GeoJSON -> lat/lon/depth -> world cell via the OSM projection
 *   -> a glyph drawn in the same perspective as the buildings and streets.
 *
 * USGS is keyless and sends Access-Control-Allow-Origin: *, so unlike ADS-B it
 * needs no CORS proxy and works straight from the browser, exactly like the
 * weather layer. Everything here is strictly additive and fails safe: a
 * malformed feature is dropped, a failed request keeps the last good set (or
 * none), and missing fields stay null rather than being invented.
 */

import {
  QUAKE_ENABLED, QUAKE_REFRESH_MS, QUAKE_RADIUS_KM, QUAKE_MIN_MAG,
} from './config.js';
import { FOV } from './config.js';
import { fogOf } from './render/materials.js';
import { geoAt } from './world/osm.js';

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320;

/** Planar great-circle-ish distance in km between two lat/lon. */
export function distanceKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * M_PER_DEG_LAT;
  const mPerLon = M_PER_DEG_LON * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
  const dLon = (lon2 - lon1) * mPerLon;
  return Math.sqrt(dLat * dLat + dLon * dLon) / 1000;
}

/** A short, stable label for a magnitude. */
export function magGlyph(mag) {
  if (mag == null || !Number.isFinite(mag)) return '·';
  if (mag < 2.5) return '·';
  if (mag < 4) return '◦';
  if (mag < 5) return '◉';
  return '◆';
}

/* ------------------------------- fetching ------------------------------- */

/**
 * Build the USGS GeoJSON feed URL. The 2.5+ past-day feed is the right size for
 * a city view: enough signal to be interesting, small enough to poll cheaply.
 */
export function buildUrl() {
  return 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson';
}

/**
 * Normalize one USGS GeoJSON feature into the shape the layer keeps. Every
 * field is taken straight from the source; nothing is guessed. A feature with
 * no usable geometry or magnitude is returned as null and dropped by the caller.
 */
export function normalizeQuake(f) {
  if (!f || typeof f !== 'object') return null;
  const p = f.properties;
  const g = f.geometry;
  if (!p || !g || !Array.isArray(g.coordinates)) return null;

  const lon = Number(g.coordinates[0]);
  const lat = Number(g.coordinates[1]);
  const depthKm = Number(g.coordinates[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const mag = Number(p.mag);
  if (!Number.isFinite(mag)) return null;

  const time = Number(p.time);
  const place = typeof p.place === 'string' ? p.place : null;

  return {
    id: typeof f.id === 'string' ? f.id : String(f.id ?? ''),
    lat, lon,
    depthKm: Number.isFinite(depthKm) ? depthKm : null,
    mag,
    place,
    time: Number.isFinite(time) ? time : null,
    felt: typeof p.felt === 'number' ? p.felt : null,
  };
}

/**
 * Fetch and normalize recent earthquakes. Throws on any failure so the caller
 * can treat "could not reach the source" as "no quakes right now". `fetchImpl`
 * is injectable for tests; defaults to the global fetch.
 */
export async function fetchQuakes(radiusKm, {
  signal, timeoutMs = 8000, fetchImpl = (typeof fetch === 'function' ? fetch : null),
} = {}) {
  if (!fetchImpl) throw new Error('no fetch available');
  const url = buildUrl();
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
    const list = Array.isArray(j && j.features) ? j.features : [];
    const out = [];
    for (const f of list) {
      const q = normalizeQuake(f);
      if (q && q.mag >= QUAKE_MIN_MAG) out.push(q);
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------- the layer ------------------------------ */

/**
 * Holds the live earthquakes near the current world and draws them in
 * perspective, on the ground (z = 0). Each quake is a fixed point in the world;
 * unlike aircraft it does not move, so there is no interpolation — only a
 * recency fade so a fresh event reads as "just happened" and older ones dim.
 */
export class QuakeLayer {
  constructor() {
    this.enabled = QUAKE_ENABLED;
    this.world = null;
    this.proj = null;
    this.records = new Map();     // id -> quake
    this.marks = [];              // [{ x, y, id }] for picking, rebuilt each draw
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
    // Only a real OSM extract has a geographic location to query around.
    this.proj = world && world.bbox ? world.proj : null;
    this.records.clear();
    this.marks.length = 0;
    this.lastError = 0;
    this.lastSuccess = 0;
    this.hasPolled = false;
    this.loading = false;
    this.acc = QUAKE_REFRESH_MS;  // poll promptly on first frame
  }

  /** Update only the geographic projection after a streamed world rebuild. */
  rebindWorld(world) {
    this.world = world;
    this.proj = world && world.bbox ? world.proj : null;
    this.marks.length = 0;
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
    this.acc = QUAKE_REFRESH_MS;
    this.hasPolled = false;
    this.lastError = 0;
  }

  get active() {
    return this.enabled && !!this.proj;
  }

  /** True if any quakes are currently held (for the HUD). */
  get hasQuakes() {
    return this.records.size > 0;
  }

  /**
   * Advance the layer. Polls when due and only while the clock is live and the
   * world is geographic. The per-frame cost here is just the accumulator and the
   * occasional fetch; drawing happens in draw().
   */
  update(dt, cam, live, signal, fetchImpl) {
    if (!this.active) { this._withdraw(); return; }
    if (!live) { this._withdraw(); return; }

    this.acc += dt * 1000;
    if (this.acc < QUAKE_REFRESH_MS) return;
    this.acc = 0;

    if (this._inflight) this._inflight.abort();
    const ctl = new AbortController();
    this._inflight = ctl;
    if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });

    fetchQuakes(QUAKE_RADIUS_KM, { signal: ctl.signal, fetchImpl })
      .then((list) => {
        if (this._inflight !== ctl || ctl.signal.aborted) return;
        this._inflight = null;
        this.loading = false;
        this.lastError = 0;
        this.lastSuccess = Date.now();
        this.hasPolled = true;
        // Keep only quakes within the radius of the camera's city, so a global
        // feed does not paint the whole planet. A stale one would otherwise
        // linger at its last position, so drop anything now out of range.
        const here = geoAt(this.proj, cam.x, cam.y);
        const seen = new Set();
        for (const q of list) {
          if (!q.id) continue;
          if (distanceKm(here.lat, here.lon, q.lat, q.lon) > QUAKE_RADIUS_KM) continue;
          seen.add(q.id);
          this.records.set(q.id, q);
        }
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

  /** Nearest picked quake mark to a screen cell, within `r` cells. */
  pickAt(col, row, r = 2) {
    let best = null;
    let bd = (r + 1) * (r + 1);
    for (const m of this.marks) {
      const dx = m.x - col;
      const dy = m.y - row;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = m.id; }
    }
    return best;
  }

  /** The latest record for a picked id, for the info panel. */
  info(id) {
    return this.records.get(id) || null;
  }

  /** Largest quake currently held, with distance from the camera. */
  largest(cam) {
    if (!this.proj || this.records.size === 0) return null;
    const here = geoAt(this.proj, cam.x, cam.y);
    let best = null;
    for (const q of this.records.values()) {
      const distanceKm = distanceKm(here.lat, here.lon, q.lat, q.lon);
      if (!best || q.mag > best.mag) {
        best = { ...q, distanceKm };
      }
    }
    return best;
  }

  /**
   * A small camera shake for a very recent, large, nearby event — the ground
   * itself reacting. Returns { x, y } cell offsets (or {0,0}); the caller
   * applies them as a render offset. Only the freshest significant quake within
   * range shakes, and it decays over a few seconds so it never sticks.
   */
  shake(now = Date.now()) {
    if (!this.proj || this.records.size === 0) return { x: 0, y: 0 };
    let trigger = null;
    for (const q of this.records.values()) {
      if (q.mag == null || q.mag < 4.5) continue;
      if (q.time == null) continue;
      const ageMs = now - q.time;
      if (ageMs < 0 || ageMs > 8000) continue;
      if (!trigger || q.mag > trigger.mag) trigger = { q, ageMs };
    }
    if (!trigger) return { x: 0, y: 0 };
    const decay = 1 - trigger.ageMs / 8000;
    const amp = (trigger.q.mag - 4) * 0.6 * decay;
    const t = now / 1000;
    return {
      x: Math.round(Math.sin(t * 37) * amp),
      y: Math.round(Math.cos(t * 41) * amp * 0.6),
    };
  }

  /** Truthful HUD status for this layer. */
  statusOf(imperial = false, live = true) {
    if (!this.enabled) return 'OFF';
    if (!this.proj) return 'N/A';
    if (!live) return 'SIM · press 0 for live';
    if (this.loading && !this.hasPolled) return 'SEARCHING';
    if (this.lastError > this.lastSuccess && this.records.size === 0) return 'UNAVAILABLE';
    if (this.hasPolled && this.records.size === 0) {
      return `LIVE · none within ${QUAKE_RADIUS_KM} km`;
    }
    if (this.records.size === 0) return 'SEARCHING';

    const big = this.largest({ x: this.world ? this.world.width / 2 : 0,
      y: this.world ? this.world.height / 2 : 0 });
    const freshness = this.lastError > this.lastSuccess ? 'STALE' : 'LIVE';
    if (!big) return `${freshness} · ${this.records.size}`;
    const dist = imperial
      ? `${(big.distanceKm * 0.621371).toFixed(0)} mi`
      : `${big.distanceKm.toFixed(0)} km`;
    return `${freshness} · ${this.records.size} · largest M${big.mag.toFixed(1)} ${dist}`;
  }

  /**
   * Draw earthquakes in the same perspective as the world. Each is a point on
   * the ground (z = 0), projected with the same along/side maths the aircraft
   * and sprite renderers use, and depth-tested against the scene buffer so a
   * building in front hides a quake behind it. Recent events glow brighter and
   * redder; older ones fade toward a dim amber.
   */
  draw(screen, cam, L) {
    if (!this.active) return;
    this.marks.length = 0;

    const fwdX = Math.cos(cam.angle);
    const fwdY = Math.sin(cam.angle);
    const { cols, rows, depth } = screen;
    const now = Date.now();

    const vis = [];
    for (const q of this.records.values()) {
      const wx = this.proj.x(q.lon);
      const wy = this.proj.y(q.lat);
      const z = 0;

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

      vis.push({ q, wx, wy, z, along, side, col, row });
    }

    // Far first so nearer quakes overdraw.
    vis.sort((a, b) => b.along - a.along);

    for (const v of vis) {
      const cx = Math.round(v.col);
      const cy = Math.round(v.row);
      if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) continue;
      // Depth test: a building nearer than the quake hides it.
      if (v.along >= depth[cy * cols + cx] * 1.02) continue;

      const ageMs = v.q.time != null ? now - v.q.time : 1e9;
      const recency = Math.max(0, Math.min(1, 1 - ageMs / 3600000)); // 1h fade
      const f = Math.max(0.12, fogOf(v.along));

      // Recent + large -> hot red; older/smaller -> dim amber.
      const heat = Math.min(1, (v.q.mag - QUAKE_MIN_MAG) / 4 + recency * 0.6);
      const r = 200 + 55 * heat;
      const g = 120 - 70 * heat;
      const b = 70 - 40 * heat;
      const colour = L.depth(r, g, b, f);
      screen.set(cx, cy, magGlyph(v.q.mag), colour);
      v.drawn = true;
      this.marks.push({ x: cx, y: cy, id: v.q.id });
    }

    // Label only the largest quake in view, with a collision check.
    const big = vis.filter((v) => v.drawn)
      .sort((a, b) => b.q.mag - a.q.mag)[0];
    if (big) {
      const cx = Math.round(big.col);
      const cy = Math.round(big.row);
      const label = `M${big.q.mag.toFixed(1)} ${magGlyph(big.q.mag)}`;
      const lx = cx - Math.floor(label.length / 2);
      const ly = cy - 1;
      if (ly >= 0) {
        const f = Math.max(0.12, fogOf(big.along));
        const colour = L.depth(255, 150, 120, f);
        for (let i = 0; i < label.length; i++) {
          const gx = lx + i;
          if (gx < 0 || gx >= cols) continue;
          if (big.along >= depth[ly * cols + gx] * 1.02) continue;
          screen.set(gx, ly, label[i], colour);
        }
      }
    }
  }
}
