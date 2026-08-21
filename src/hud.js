import { METERS_PER_CELL } from './config.js';
import { PRESETS, parseLocation } from './world/overpass.js';
import { lookup } from './geocode.js';

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** HUD readouts, the city picker, and the URL hash that makes a view shareable. */
export class Hud {
  constructor({ onLoad }) {
    this.warp = document.getElementById('warp');
    this.warpv = document.getElementById('warpv');
    this.clock = document.getElementById('clock');
    this.date = document.getElementById('date');
    this.mode = document.getElementById('mode');
    this.phase = document.getElementById('phase');
    this.loc = document.getElementById('loc');
    this.where = document.getElementById('where');
    this.attrib = document.getElementById('attrib');
    this.air = document.getElementById('air');
    this.wx = document.getElementById('wx');
    this.city = document.getElementById('city');
    this.coords = document.getElementById('coords');
    this.go = document.getElementById('go');
    this.onLoad = onLoad;

    for (const [key, preset] of Object.entries(PRESETS)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = preset.label;
      this.city.appendChild(opt);
    }

    this.city.addEventListener('change', () => {
      this.resolved = null;
      const key = this.city.value;
      this.onLoad({ preset: key, bbox: PRESETS[key].bbox, label: PRESETS[key].label });
    });

    this.go.addEventListener('click', () => this._submitCoords());
    this.coords.addEventListener('input', () => { this.resolved = null; });
    this.coords.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._submitCoords();
      e.stopPropagation();
    });
  }

  _submitCoords() {
    const text = this.coords.value.trim();
    if (!text) return;

    const bbox = parseLocation(text);
    if (bbox) {
      this.city.value = '';
      this.onLoad({ preset: null, bbox, label: 'Custom area' });
      return;
    }

    if (/^[\s\d.,+-]+$/.test(text)) {
      this.setError('Could not read those numbers. Try "40.75,-73.98" or "s,w,n,e".');
      return;
    }

    this._lookupToken = (this._lookupToken || 0) + 1;
    const token = this._lookupToken;
    this.setBusy(true);
    this.setStatus(`Looking up ${text}\u2026`);

    lookup(text, (r) => {
      if (token !== this._lookupToken) return;
      this.setBusy(false);
      if (!r) {
        this.setError(`Could not find "${text}". Try a larger place, or coordinates.`);
        return;
      }
      this.city.value = '';
      this.resolved = r.display;
      this.onLoad({ preset: null, bbox: r.bbox, label: r.label, display: r.display });
    });
  }

  /**
   * Reflect the current view in the URL, so any moment can be shared or
   * reloaded exactly. Written with replaceState, so it adds no history
   * entries, and throttled so it is not touched every frame.
   */
  syncHash({ preset, bbox }, cam = null, hour = null) {
    const parts = [];
    if (preset) parts.push(`city=${preset}`);
    else if (bbox) parts.push(`bbox=${bbox.map((v) => v.toFixed(5)).join(',')}`);

    if (cam) {
      parts.push(`x=${cam.x.toFixed(1)}`, `y=${cam.y.toFixed(1)}`,
                 `z=${cam.z.toFixed(1)}`, `a=${cam.angle.toFixed(3)}`,
                 `p=${cam.pitch.toFixed(1)}`);
    }
    if (hour !== null) parts.push(`h=${hour.toFixed(2)}`);

    const hash = parts.length ? '#' + parts.join('&') : '';
    if (location.hash !== hash) {
      history.replaceState(null, '', hash || location.pathname);
    }
  }

  /**
   * Read the initial view from the URL.
   * Accepts `city=` or `bbox=`, plus optional camera placement (x, y, z, a,
   * p) and hour of day (h).
   */
  static initialView() {
    const q = new URLSearchParams(location.hash.slice(1));
    const num = (k) => (q.has(k) ? Number(q.get(k)) : undefined);
    const finite = (v) => (Number.isFinite(v) ? v : undefined);

    const camera = {
      x: finite(num('x')), y: finite(num('y')), z: finite(num('z')),
      angle: finite(num('a')), pitch: finite(num('p')),
    };
    const hour = finite(num('h'));

    const city = q.get('city');
    if (city && PRESETS[city]) {
      return { preset: city, bbox: PRESETS[city].bbox,
               label: PRESETS[city].label, camera, hour };
    }
    const bbox = q.get('bbox');
    if (bbox) {
      const parsed = parseLocation(bbox);
      if (parsed) return { preset: null, bbox: parsed, label: 'Custom area', camera, hour };
    }
    return { preset: 'procedural', bbox: null,
             label: PRESETS.procedural.label, camera, hour };
  }

  select(preset) {
    if (preset) this.city.value = preset;
  }

  setBusy(busy) {
    this.go.disabled = busy;
    this.city.disabled = busy;
  }

  setError(msg) {
    this.attrib.className = 'err';
    this.attrib.textContent = msg;
  }

  setStatus(msg) {
    this.attrib.className = 'dim';
    this.attrib.textContent = msg;
  }

  /**
   * OpenStreetMap's licence requires attribution wherever its data is shown.
   */
  setAttribution(world) {
    this.attrib.className = 'dim';
    if (!world.bbox) {
      this.attrib.textContent = 'Procedural streets. No map data.';
      return;
    }
    const km = (world.width * METERS_PER_CELL / 1000).toFixed(2);
    const found = this.resolved && this.resolved !== world.label
      ? `<span class="found">${escapeHtml(this.resolved)}</span> &middot; `
      : '';
    this.attrib.innerHTML = found +
      `${escapeHtml(world.label)} &middot; ${world.stats.roads} ways, ` +
      `${world.stats.junctions} junctions &middot; ${km} km across &middot; ` +
      'map data &copy; <a href="https://www.openstreetmap.org/copyright" ' +
      'target="_blank" rel="noopener">OpenStreetMap</a> contributors';
  }

  warpFactor() {
    return Math.pow(10, Number(this.warp.value) / 25);
  }

  update({ warp, simTime, lon, sunAlt, cam, screen, fps, where,
            signMode, renderMode, air, weather, live, imperial }) {
    this.warpv.textContent = (warp < 10 ? warp.toFixed(1) : Math.round(warp)) + 'x';

    const local = new Date(simTime + lon / 15 * 3600000);
    const hh = String(local.getUTCHours()).padStart(2, '0');
    const mm = String(local.getUTCMinutes()).padStart(2, '0');
    this.clock.textContent = `${hh}:${mm}`;
    this.phase.textContent = sunAlt > 0 ? '(day)' : sunAlt > -6 ? '(twilight)' : '(night)';

    // Full local date, e.g. "Thu 20 Aug 2026". The clock alone is ambiguous
    // across time travel, so the date travels with it.
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][local.getUTCDay()];
    const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
                'Oct', 'Nov', 'Dec'][local.getUTCMonth()];
    this.date.textContent = `${wd} ${local.getUTCDate()} ${mo} ${local.getUTCFullYear()}`;

    // LIVE means the clock is the real clock; SIM means the user has warped or
    // scrubbed time away from the present, so weather/aircraft no longer apply.
    this.mode.textContent = live ? 'LIVE' : 'SIM';
    this.mode.className = live ? 'live' : 'sim';

    if (this.where) {
      if (where && where.on) {
        const cross = where.cross && where.crossDist < 26
          ? ` · near ${where.cross}` : '';
        this.where.textContent = where.on.toUpperCase() + cross.toUpperCase();
      } else {
        this.where.textContent = '';
      }
    }

    const altM = cam.z * METERS_PER_CELL;
    const altStr = imperial
      ? `${Math.round(altM * 3.2808399).toLocaleString('en-US')} ft`
      : `${Math.round(altM)} m`;
    this.loc.textContent =
      `x ${cam.x.toFixed(0)}  y ${cam.y.toFixed(0)}  ·  alt ${altStr}` +
      `  ·  ${screen.cols}x${screen.outRows} cells  ·  ${fps.toFixed(0)} fps` +
      (renderMode === 1 ? '  ·  blocks' : '') +
      (signMode ? '' : '  ·  signs off');

    if (this.air) {
      let txt = '';
      if (!air || !air.enabled) txt = 'OFF';
      else if (!air.active) txt = 'N/A';
      else if (!air.live) txt = 'UNAVAILABLE';
      else txt = `LIVE${air.count ? ' · ' + air.count : ''}`;
      this.air.textContent = `air traffic ${txt}`;
    }

    if (this.wx) {
      let txt = '';
      if (!weather || !weather.enabled) txt = 'OFF';
      else if (!weather.active) txt = 'N/A';
      else txt = weather.status || '…';
      this.wx.textContent = `weather ${txt}`;
    }
  }
}
