/**
 * Live ALPR / "flock" camera map as a layer of the real world.
 *
 * DeFlock publishes the global license-plate-reader network — Flock Safety,
 * Motorola, and others — as keyless 20-degree vector tiles on a CDN. The
 * pipeline is:
 *
 *   DeFlock region tile -> lat/lon -> world cell via the OSM projection
 *   -> a glyph drawn in the same perspective as the buildings and streets.
 *
 * The CDN sends no CORS headers, so unlike the weather and quake feeds it needs
 * a deployment-owned Worker proxy (exactly like the ADS-B aircraft feed). An
 * unconfigured fork reports that state and sends no camera request anywhere.
 *
 * Everything here is strictly additive and fails safe. A malformed record is
 * dropped, a failed request clears nothing it cannot replace, and missing
 * fields stay null rather than being invented.
 */

import {
  FLOCK_ENABLED, FLOCK_REFRESH_MS, FLOCK_RADIUS_KM, FLOCK_TILE_DEG,
} from './config.js';
import { FOV } from './config.js';
import { WORKER_URL } from './runtime-config.js';
import { fogOf } from './render/materials.js';
import { geoAt } from './world/osm.js';
import { bearingTo, wind } from './pick.js';

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320;

/** Planar great-circle-ish distance in km between two lat/lon. */
export function distanceKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * M_PER_DEG_LAT;
  const mPerLon = M_PER_DEG_LON * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
  const dLon = (lon2 - lon1) * mPerLon;
  return Math.sqrt(dLat * dLat + dLon * dLon) / 1000;
}

/** The 20-degree region tile key (e.g. "20/-100") covering a lat/lon. */
export function tileKey(lat, lon, tileDeg = FLOCK_TILE_DEG) {
  const tLat = Math.floor(lat / tileDeg) * tileDeg;
  const tLon = Math.floor(lon / tileDeg) * tileDeg;
  return `${tLat}/${tLon}`;
}

/** All region tile keys spanning a lat/lon bounding box. */
export function tilesForBBox(minLat, minLon, maxLat, maxLon, tileDeg = FLOCK_TILE_DEG) {
  const keys = new Set();
  const loLat = Math.floor(minLat / tileDeg) * tileDeg;
  const hiLat = Math.floor(maxLat / tileDeg) * tileDeg;
  const loLon = Math.floor(minLon / tileDeg) * tileDeg;
  const hiLon = Math.floor(maxLon / tileDeg) * tileDeg;
  for (let la = loLat; la <= hiLat; la += tileDeg) {
    for (let lo = loLon; lo <= hiLon; lo += tileDeg) {
      keys.add(`${la}/${lo}`);
    }
  }
  return [...keys];
}

/* ------------------------------- fetching ------------------------------- */

/**
 * Build the deployment-owned Worker URL for a point/radius query. With no
 * configured Worker this deliberately returns null rather than a relative URL.
 */
export function buildUrl(lat, lon, radiusKm, workerUrl = WORKER_URL) {
  if (!workerUrl) return null;
  return `${workerUrl}/api/flock?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&radiusKm=${radiusKm}`;
}

/**
 * Normalize one DeFlock camera record into the shape the layer keeps. Every
 * field is taken straight from the source; nothing is guessed. A record with no
 * usable position is returned as null and dropped by the caller.
 */
export function normalizeCamera(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = Number(raw.lat);
  const lon = Number(raw.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const id = raw.id != null ? String(raw.id) : null;
  if (!id) return null;

  const tags = raw.tags && typeof raw.tags === 'object' ? raw.tags : {};
  const manufacturer = typeof tags.manufacturer === 'string' ? tags.manufacturer
    : (typeof tags.brand === 'string' ? tags.brand : null);
  const operator = typeof tags.operator === 'string' ? tags.operator : null;
  const direction = typeof tags.direction === 'string' ? tags.direction : null;

  return {
    id, lat, lon,
    manufacturer: manufacturer && manufacturer.length ? manufacturer : null,
    operator: operator && operator.length ? operator : null,
    direction: direction && direction.length ? direction : null,
  };
}

/**
 * Fetch and normalize ALPR cameras near a point. Throws on any failure so the
 * caller can treat "could not reach the source" as "no cameras right now".
 * `fetchImpl` is injectable for tests; defaults to the global fetch.
 */
export async function fetchCameras(lat, lon, radiusKm, {
  signal, timeoutMs = 15000, fetchImpl = (typeof fetch === 'function' ? fetch : null),
  workerUrl = WORKER_URL,
} = {}) {
  if (!fetchImpl) throw new Error('no fetch available');
  const url = buildUrl(lat, lon, radiusKm, workerUrl);
  if (!url) throw new Error('flock worker not configured');
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
    const list = Array.isArray(j && j.cameras) ? j.cameras : [];
    const out = [];
    for (const r of list) {
      const c = normalizeCamera(r);
      if (c) out.push(c);
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------- the layer ------------------------------ */

/**
 * Holds the live ALPR cameras for the current world and draws them in
 * perspective, on the ground (z = 0). Each camera is a fixed point in the
 * world; unlike aircraft it does not move, so there is no interpolation — only
 * a static mark, colored by manufacturer so Flock vs Motorola reads at a glance.
 */
export class FlockLayer {
  constructor({ workerUrl = WORKER_URL } = {}) {
    this.workerUrl = workerUrl;
    this.enabled = FLOCK_ENABLED;
    this.world = null;
    this.proj = null;
    this.records = new Map();     // id -> camera
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
    // Only a real OSM extract has a geographic location to query against.
    this.proj = world && world.bbox ? world.proj : null;
    this.records.clear();
    this.marks.length = 0;
    this.lastError = 0;
    this.lastSuccess = 0;
    this.hasPolled = false;
    this.loading = false;
    this.acc = FLOCK_REFRESH_MS;  // poll promptly on first frame
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
    this.acc = FLOCK_REFRESH_MS;
    this.hasPolled = false;
    this.lastError = 0;
  }

  get active() {
    return this.enabled && !!this.proj && !!this.workerUrl;
  }

  /** True if any cameras are currently held (for the HUD). */
  get hasCameras() {
    return this.records.size > 0;
  }

  /**
   * Advance the layer. Polls when due and only while the clock is live and the
   * world is geographic. The per-frame cost here is just the accumulator and
   * the occasional fetch; drawing happens in draw().
   */
  update(dt, cam, live, signal, fetchImpl) {
    if (!this.active) { this._withdraw(); return; }
    if (!live) { this._withdraw(); return; }

    this.acc += dt * 1000;
    if (this.acc < FLOCK_REFRESH_MS) return;
    this.acc = 0;

    const { lat, lon } = geoAt(this.proj, cam.x, cam.y);

    if (this._inflight) this._inflight.abort();
    const ctl = new AbortController();
    this._inflight = ctl;
    this.loading = true;
    if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });

    fetchCameras(lat, lon, FLOCK_RADIUS_KM, {
      signal: ctl.signal, fetchImpl, workerUrl: this.workerUrl,
    })
      .then((list) => {
        if (this._inflight !== ctl || ctl.signal.aborted) return;
        this._inflight = null;
        this.loading = false;
        this.lastError = 0;
        this.lastSuccess = Date.now();
        this.hasPolled = true;
        const here = geoAt(this.proj, cam.x, cam.y);
        const seen = new Set();
        for (const c of list) {
          if (!c.id) continue;
          if (distanceKm(here.lat, here.lon, c.lat, c.lon) > FLOCK_RADIUS_KM) continue;
          seen.add(c.id);
          this.records.set(c.id, c);
        }
        // Drop cameras no longer reported. A stale one would otherwise linger
        // at its last position, so drop anything now out of range.
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

  /** Nearest picked camera mark to a screen cell, within `r` cells. */
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

  /** Nearest camera to the camera, with distance. */
  nearest(cam) {
    if (!this.proj || !cam || this.records.size === 0) return null;
    const here = geoAt(this.proj, cam.x, cam.y);
    let best = null;
    for (const c of this.records.values()) {
      const separationKm = distanceKm(here.lat, here.lon, c.lat, c.lon);
      if (!best || separationKm < best.distanceKm) {
        best = {
          ...c,
          distanceKm: separationKm,
          wx: this.proj.x(c.lon),
          wy: this.proj.y(c.lat),
        };
      }
    }
    return best;
  }

  /** Truthful HUD status for this layer. */
  statusOf(cam = null, imperial = false, live = true) {
    if (!this.enabled) return 'OFF';
    if (!this.proj) return 'N/A';
    if (!this.workerUrl) return 'SETUP REQUIRED';
    if (!live) return 'SIM · press 0 for live';
    if (this.loading && !this.hasPolled) return 'SEARCHING';
    if (this.lastError > this.lastSuccess && this.records.size === 0) return 'UNAVAILABLE';
    if (this.hasPolled && this.records.size === 0) {
      return `LIVE · none within ${FLOCK_RADIUS_KM} km`;
    }
    if (this.records.size === 0) return 'SEARCHING';

    const from = cam || {
      x: this.world ? this.world.width / 2 : 0,
      y: this.world ? this.world.height / 2 : 0,
    };
    const near = this.nearest(from);
    const freshness = this.lastError > this.lastSuccess ? 'STALE' : 'LIVE';
    if (!near) return `${freshness} · ${this.records.size}`;
    const dist = imperial
      ? `${(near.distanceKm * 0.621371).toFixed(1)} mi`
      : `${near.distanceKm.toFixed(1)} km`;
    // Distance alone does not say which way to turn, and a camera is a single
    // ground glyph that a building can hide. The compass point is what makes
    // one findable, so it matches the aircraft layer's "nearest" line.
    const compass = wind(bearingTo(from, near.wx, near.wy));
    return `${freshness} · ${this.records.size} · nearest ${dist} ${compass}`;
  }

  /**
   * Draw cameras in the same perspective as the world. Each is a point on the
   * ground (z = 0), projected with the same along/side maths the aircraft and
   * quake renderers use, and depth-tested against the scene buffer so a
   * building in front hides a camera behind it. Color encodes the manufacturer.
   */
  draw(screen, cam, L) {
    if (!this.active) return;
    this.marks.length = 0;

    const fwdX = Math.cos(cam.angle);
    const fwdY = Math.sin(cam.angle);
    const { cols, rows, depth } = screen;

    const vis = [];
    for (const c of this.records.values()) {
      const wx = this.proj.x(c.lon);
      const wy = this.proj.y(c.lat);
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

      vis.push({ c, wx, wy, z, along, side, col, row });
    }

    // Far first so nearer cameras overdraw.
    vis.sort((a, b) => b.along - a.along);

    for (const v of vis) {
      const cx = Math.round(v.col);
      const cy = Math.round(v.row);
      if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) continue;
      // Depth test: a building nearer than the camera hides it.
      if (v.along >= depth[cy * cols + cx] * 1.02) continue;

      const f = Math.max(0.12, fogOf(v.along));
      const colour = L.depth(...flockColour(v.c.manufacturer), f);
      screen.set(cx, cy, '▣', colour);
      v.drawn = true;
      this.marks.push({ x: cx, y: cy, id: v.c.id });
    }

    // Label only the nearest few cameras. A collision check keeps a busy
    // downtown from turning into solid text.
    const boxes = [];
    const labelCandidates = vis.filter((v) => v.drawn)
      .sort((a, b) => (a.along * a.along + a.side * a.side)
                    - (b.along * b.along + b.side * b.side));
    let labels = 0;
    for (const v of labelCandidates) {
      if (labels >= 3) break;
      const name = v.c.manufacturer || 'ALPR';
      const cx = Math.round(v.col);
      const cy = Math.round(v.row);
      const label = name;
      const lx = cx - Math.floor(label.length / 2);
      const ly = cy - 1;
      const box = { x0: lx, x1: lx + label.length - 1, y: ly };
      if (ly < 0 || boxes.some((b) => b.y === ly && box.x0 <= b.x1 + 1
                                               && box.x1 + 1 >= b.x0)) continue;

      const f = Math.max(0.12, fogOf(v.along));
      const colour = L.depth(...flockColour(v.c.manufacturer), f);
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

/** RGB for a manufacturer: Flock amber, Motorola blue, else grey-green. */
export function flockColour(manufacturer) {
  if (manufacturer === 'Flock Safety' || manufacturer === 'Flock') {
    return [255, 176, 64];
  }
  if (manufacturer === 'Motorola Solutions' || manufacturer === 'Motorola') {
    return [120, 180, 255];
  }
  return [180, 200, 190];
}
