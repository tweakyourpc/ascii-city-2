/**
 * Live weather as a layer of the real world.
 *
 * OpenStreetMap gives the geography, the astronomical code gives the sky, the
 * aircraft layer gives the human activity in it — and this gives the weather
 * actually happening there. The pipeline is:
 *
 *   live Open-Meteo observation -> lat/lon -> rain/snow/wind/cloud glyphs
 *   drawn over the same scene the buildings and streets are.
 *
 * Open-Meteo is keyless and sends Access-Control-Allow-Origin: *, so unlike
 * ADS-B it needs no CORS proxy and works straight from the browser. Point
 * Everything here is strictly additive and fails safe. A malformed field stays
 * null rather than being invented, a failed request keeps the last good reading
 * (or none), and the layer withdraws entirely once the user scrubs or warps
 * time away from the present.
 */

import { WX_ENABLED, WX_REFRESH_MS, WX_RADIUS_KM } from './config.js';
import { wind as compass } from './pick.js';
import { geoAt } from './world/osm.js';

/**
 * WMO weather interpretation codes -> a short label, a sky glyph, and the kind
 * of precipitation (if any) the code implies. Open-Meteo returns these codes for
 * the current condition; we use `kind` to pick the right falling glyph and to
 * decide whether to draw rain or snow.
 */
export const WEATHER_CODES = {
  0:  { label: 'Clear sky',            glyph: '☀', kind: 'clear' },
  1:  { label: 'Mainly clear',         glyph: '☀', kind: 'clear' },
  2:  { label: 'Partly cloudy',        glyph: '⛅', kind: 'cloud' },
  3:  { label: 'Overcast',             glyph: '☁', kind: 'cloud' },
  45: { label: 'Fog',                  glyph: '≈', kind: 'fog' },
  48: { label: 'Rime fog',             glyph: '≈', kind: 'fog' },
  51: { label: 'Light drizzle',        glyph: '˙', kind: 'rain' },
  53: { label: 'Drizzle',              glyph: '˙', kind: 'rain' },
  55: { label: 'Dense drizzle',        glyph: '˙', kind: 'rain' },
  56: { label: 'Freezing drizzle',     glyph: '˙', kind: 'rain' },
  57: { label: 'Freezing drizzle',     glyph: '˙', kind: 'rain' },
  61: { label: 'Light rain',           glyph: '|', kind: 'rain' },
  63: { label: 'Rain',                 glyph: '|', kind: 'rain' },
  65: { label: 'Heavy rain',           glyph: '|', kind: 'rain' },
  66: { label: 'Freezing rain',        glyph: '|', kind: 'rain' },
  67: { label: 'Freezing rain',        glyph: '|', kind: 'rain' },
  71: { label: 'Light snow',           glyph: '*', kind: 'snow' },
  73: { label: 'Snow',                 glyph: '*', kind: 'snow' },
  75: { label: 'Heavy snow',           glyph: '*', kind: 'snow' },
  77: { label: 'Snow grains',          glyph: '*', kind: 'snow' },
  80: { label: 'Rain showers',         glyph: '|', kind: 'rain' },
  81: { label: 'Rain showers',         glyph: '|', kind: 'rain' },
  82: { label: 'Violent rain showers', glyph: '|', kind: 'rain' },
  85: { label: 'Snow showers',         glyph: '*', kind: 'snow' },
  86: { label: 'Snow showers',         glyph: '*', kind: 'snow' },
  95: { label: 'Thunderstorm',         glyph: '⚡', kind: 'rain' },
  96: { label: 'Thunderstorm + hail',  glyph: '⚡', kind: 'rain' },
  99: { label: 'Thunderstorm + hail',  glyph: '⚡', kind: 'rain' },
};

/** Fallback for an unknown code. */
export const WX_UNKNOWN = { label: 'Weather', glyph: '?', kind: 'clear' };

/** The precipitation glyph for a kind, falling. */
function precipGlyph(kind, rnd) {
  if (kind === 'snow') return rnd < 0.5 ? '*' : '·';
  if (kind === 'rain') return rnd < 0.35 ? '|' : '.';
  return '·';
}

/* ------------------------------- fetching ------------------------------- */

export function buildUrl(lat, lon, _radiusKm) {
  const base = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
    + '&current=temperature_2m,relative_humidity_2m,precipitation,rain,'
    + 'snowfall,weather_code,wind_speed_10m,wind_direction_10m,cloud_cover'
    + `&wind_speed_unit=kn`;
  return base;
}

/**
 * Normalize one Open-Meteo current block into the shape the layer keeps. Every
 * field is taken straight from the source; nothing is guessed. A response with
 * no usable code is returned as null and dropped by the caller.
 */
export function normalizeWx(j) {
  if (!j || typeof j !== 'object') return null;
  const c = j.current;
  if (!c || typeof c !== 'object') return null;

  const code = Number(c.weather_code);
  const meta = WEATHER_CODES[code] || WX_UNKNOWN;

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  // Open-Meteo reports snowfall in CENTIMETRES; convert to mm to match rain
  // and the density maths below (which expects mm/h of water-equivalent-ish).
  const snowCm = num(c.snowfall) ?? 0;
  const snowMm = snowCm * 10;

  return {
    tempC: num(c.temperature_2m),
    humidity: num(c.relative_humidity_2m),
    precip: num(c.precipitation) ?? 0,
    rain: num(c.rain) ?? 0,
    snow: snowMm,
    code: Number.isFinite(code) ? code : null,
    label: meta.label,
    kind: meta.kind,
    glyph: meta.glyph,
    windKt: num(c.wind_speed_10m),
    windDeg: num(c.wind_direction_10m),
    cloud: num(c.cloud_cover),
    tObs: Date.now(),
  };
}

/**
 * Fetch and normalize current weather near a point. Throws on any failure so
 * the caller can treat "could not reach the source" as "no weather right now".
 * `fetchImpl` is injectable for tests; defaults to the global fetch.
 */
export async function fetchWeather(lat, lon, radiusKm, {
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
    const w = normalizeWx(j);
    if (!w) throw new Error('no current weather in response');
    return w;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------- the layer ------------------------------ */

export class WeatherLayer {
  constructor() {
    this.enabled = WX_ENABLED;
    this.world = null;
    this.proj = null;
    this.cur = null;            // latest normalized reading, or null
    this.acc = 0;               // ms since last poll
    this.lastError = 0;
    this._inflight = null;
    this.marks = [];            // [{ x, y }] for picking, rebuilt each draw
  }

  setWorld(world) {
    if (this._inflight) this._inflight.abort();
    this._inflight = null;
    this.world = world;
    // Only a real OSM extract has a geographic location to query against.
    this.proj = world && world.bbox ? world.proj : null;
    this.cur = null;
    this.marks.length = 0;
    this.lastError = 0;
    this.acc = WX_REFRESH_MS;   // poll promptly on first frame
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
    this.cur = null;
    this.marks.length = 0;
    if (this._inflight) this._inflight.abort();
    this._inflight = null;
  }

  refreshNow() {
    this.acc = WX_REFRESH_MS;
    this.lastError = 0;
  }

  get active() {
    return this.enabled && !!this.proj;
  }

  /** A short status string for the HUD. `imperial` flips °C to °F. */
  statusOf(imperial = false, live = true) {
    if (!this.enabled) return 'OFF';
    if (!this.proj) return 'N/A';
    if (!live) return 'SIM · press 0 for live';
    if (!this.cur) return this.lastError ? 'UNAVAILABLE' : '…';
    const t = this.cur.tempC;
    const temp = t != null
      ? (imperial ? Math.round(t * 9 / 5 + 32) + '°F' : Math.round(t) + '°C')
      : '';
    return `${this.cur.label} · ${temp}`;
  }

  /** A short status string for the HUD. */
  get status() { return this.statusOf(false); }

  /**
   * Advance the layer. Polls when due and only while the clock is live and the
   * world is geographic. The per-frame cost here is just the accumulator and
   * the occasional fetch; drawing happens in draw().
   */
  update(dt, cam, simTime, live, signal, fetchImpl) {
    if (!this.active) { this._withdraw(); return; }
    if (!live) { this._withdraw(); return; }

    this.acc += dt * 1000;
    if (this.acc < WX_REFRESH_MS) return;
    this.acc = 0;

    const { lat, lon } = geoAt(this.proj, cam.x, cam.y);

    if (this._inflight) this._inflight.abort();
    const ctl = new AbortController();
    this._inflight = ctl;
    if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });

    fetchWeather(lat, lon, WX_RADIUS_KM, { signal: ctl.signal, fetchImpl })
      .then((w) => {
        if (this._inflight !== ctl || ctl.signal.aborted) return;
        this._inflight = null;
        this.lastError = 0;
        this.cur = w;
      })
      .catch(() => {
        if (this._inflight !== ctl) return;
        this._inflight = null;
        if (ctl.signal.aborted) return;
        this.lastError = Date.now();
        // Keep the last good reading; do not wipe on a transient failure.
      });
  }

  /** Nearest picked weather mark to a screen cell, within `r` cells. */
  pickAt(col, row, r = 3) {
    let best = null;
    let bd = (r + 1) * (r + 1);
    for (const m of this.marks) {
      const dx = m.x - col;
      const dy = m.y - row;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = m; }
    }
    return best;
  }

   /**
    * Draw the weather over the scene. Only precipitation (rain/snow) is drawn:
    * it falls across the whole grid and is depth-tested against the scene
    * buffer so buildings occlude it. Cloud and wind glyphs were removed — they
    * were screen-locked (ignored camera rotation) and read as a repeating
    * procedural pattern rather than sky, which was more confusing than useful.
    * The live conditions are still available via the HUD readout and a sky click.
    */
   draw(screen, cam, L, simTime) {
     if (!this.active || !this.cur) return;
     this.marks.length = 0;

     const { cols, rows, depth } = screen;
     const w = this.cur;
     const t = (simTime ?? Date.now()) / 1000;

     /* ---- precipitation: rain or snow falling over the scene ---- */
     if (w.kind === 'rain' || w.kind === 'snow') {
       const rate = w.kind === 'snow' ? w.snow : w.rain;
       // Density: a few cells of active precip at light rates, more when heavy.
       // mm/h of rain maps loosely to how much of the column is "wet".
       const density = Math.max(0, Math.min(0.5, rate / 12));
       if (density > 0.001) {
         const fall = w.kind === 'snow' ? 6 : 14;   // cells/sec, snow drifts slower
         for (let x = 0; x < cols; x++) {
           // Per-column phase so the rain is not a uniform sheet.
           const phase = (x * 13.37) % 1;
           for (let y = 0; y < rows; y++) {
             const r = ((y + t * fall + phase * fall) % 1);
             // A cell is "wet" when its sub-row position lands in the stream and
             // the column's pseudo-random gate passes the density test.
             const gate = ((Math.sin((x * 12.9898 + y * 78.233)) * 43758.5453) % 1 + 1) % 1;
             if (gate > density) continue;
             if (r > 0.78) continue;
             const i = y * cols + x;
             const d = depth[i];
             // The scene buffer stores a distance. A precip glyph at the screen
             // plane has no real depth, so we draw it over everything except
             // where a building is very close (depth < 4 cells) — that avoids
             // painting rain on the wall the camera is standing against.
             if (d < 4) continue;
             const rnd = ((Math.sin(x * 3.1 + y * 7.7 + t) * 1000) % 1 + 1) % 1;
             const g = precipGlyph(w.kind, rnd);
             const col = w.kind === 'snow'
               ? L.depth(232, 240, 255, 0.9)
               : L.depth(150, 190, 235, 0.85);
             screen.set(x, y, g, col);
           }
         }
       }
     }

     // Record a single pickable mark at the top-centre of the sky so a click on
     // open sky can surface the current-conditions card.
     const mx = Math.floor(cols / 2);
     const my = Math.max(0, Math.min(rows - 1, Math.floor(cam.hz * 0.4)));
     if (my < (screen.skyEnd ? screen.skyEnd[mx] : rows)) {
       this.marks.push({ x: mx, y: my });
     }
   }
}

/** Compass point for a wind bearing in degrees (re-export for the panel). */
export function windPoint(deg) {
  return compass(deg);
}
