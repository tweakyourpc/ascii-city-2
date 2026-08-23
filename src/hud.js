import { METERS_PER_CELL } from './config.js';
import { PRESETS, parseLocation } from './world/overpass.js';
import { lookup } from './geocode.js';
import { formatCityTime } from './clock.js';

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const HUD_LAYOUT_KEY = 'ascii-city:hud-layout:1';
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Build the shareable hash. LIVE views omit time; SIM views carry an instant. */
export function buildViewHash({ preset, bbox }, cam = null, instantMs = null) {
  const parts = [];
  if (preset) parts.push(`city=${preset}`);
  else if (bbox) parts.push(`bbox=${bbox.map((v) => v.toFixed(5)).join(',')}`);

  if (cam) {
    parts.push(`x=${cam.x.toFixed(1)}`, `y=${cam.y.toFixed(1)}`,
               `z=${cam.z.toFixed(1)}`, `a=${cam.angle.toFixed(3)}`,
               `p=${cam.pitch.toFixed(1)}`);
  }
  if (instantMs !== null && Number.isFinite(instantMs)) {
    parts.push(`t=${Math.round(instantMs)}`);
  }
  return parts.length ? '#' + parts.join('&') : '';
}

/** Parse a view hash. Legacy h= is deliberately ignored; it was written live. */
export function parseInitialView(hash = '') {
  const q = new URLSearchParams(String(hash).replace(/^#/, ''));
  const num = (k) => (q.has(k) ? Number(q.get(k)) : undefined);
  const finite = (v) => (Number.isFinite(v) ? v : undefined);

  const camera = {
    x: finite(num('x')), y: finite(num('y')), z: finite(num('z')),
    angle: finite(num('a')), pitch: finite(num('p')),
  };
  const instantMs = finite(num('t'));

  const city = q.get('city');
  if (city && PRESETS[city]) {
    return { preset: city, bbox: PRESETS[city].bbox,
             label: PRESETS[city].label, camera, instantMs };
  }
  const bbox = q.get('bbox');
  if (bbox) {
    const parsed = parseLocation(bbox);
    if (parsed) {
      return { preset: null, bbox: parsed, label: 'Custom area', camera, instantMs };
    }
  }
  return { preset: 'procedural', bbox: null,
           label: PRESETS.procedural.label, camera, instantMs };
}

/** HUD readouts, the city picker, and the URL hash that makes a view shareable. */
export class Hud {
  constructor({ onLoad, onNow, onLayout }) {
    this.root = document.getElementById('hud');
    this.warp = document.getElementById('warp');
    this.warpv = document.getElementById('warpv');
    this.clock = document.getElementById('clock');
    this.date = document.getElementById('date');
    this.mode = document.getElementById('mode');
    this.phase = document.getElementById('phase');
    this.loc = document.getElementById('loc');
    this.perf = document.getElementById('perf');
    this.where = document.getElementById('where');
    this.attrib = document.getElementById('attrib');
    this.air = document.getElementById('air');
    this.wx = document.getElementById('wx');
    this.city = document.getElementById('city');
    this.coords = document.getElementById('coords');
    this.go = document.getElementById('go');
    this.now = document.getElementById('now');
    this.drag = document.getElementById('hud-drag');
    this.smaller = document.getElementById('hud-smaller');
    this.larger = document.getElementById('hud-larger');
    this.dock = document.getElementById('hud-dock');
    this.onLoad = onLoad;
    this.onNow = onNow;
    this.onLayout = onLayout;
    this.layout = this._readLayout();

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
    this.now?.addEventListener('click', () => this.onNow?.());
    this.coords.addEventListener('input', () => { this.resolved = null; });
    this.coords.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._submitCoords();
      e.stopPropagation();
    });
    this._bindLayout();
    this._applyLayout(false);
  }

  _readLayout() {
    const fallback = { fontSize: 13, docked: true, left: 12, top: 10 };
    try {
      const saved = JSON.parse(localStorage.getItem(HUD_LAYOUT_KEY));
      if (!saved || typeof saved !== 'object') return fallback;
      return {
        fontSize: clamp(Number(saved.fontSize) || fallback.fontSize, 10, 22),
        docked: saved.docked !== false,
        left: Number.isFinite(saved.left) ? saved.left : fallback.left,
        top: Number.isFinite(saved.top) ? saved.top : fallback.top,
      };
    } catch {
      return fallback;
    }
  }

  _saveLayout() {
    try { localStorage.setItem(HUD_LAYOUT_KEY, JSON.stringify(this.layout)); }
    catch { /* layout persistence is optional */ }
  }

  _bindLayout() {
    this.smaller?.addEventListener('click', () => {
      this.layout.fontSize = clamp(this.layout.fontSize - 1, 10, 22);
      this._applyLayout();
    });
    this.larger?.addEventListener('click', () => {
      this.layout.fontSize = clamp(this.layout.fontSize + 1, 10, 22);
      this._applyLayout();
    });
    this.dock?.addEventListener('click', () => {
      if (this.layout.docked) {
        const r = this.root.getBoundingClientRect();
        this.layout.left = r.left + 12;
        this.layout.top = r.top + 10;
      }
      this.layout.docked = !this.layout.docked;
      this._applyLayout();
    });

    this.drag?.addEventListener('pointerdown', (e) => {
      const r = this.root.getBoundingClientRect();
      if (this.layout.docked) {
        this.layout.docked = false;
        this.layout.left = r.left;
        this.layout.top = r.top;
        this._applyLayout();
      }
      this._dragState = {
        pointerId: e.pointerId,
        dx: e.clientX - this.layout.left,
        dy: e.clientY - this.layout.top,
      };
      this.drag.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    this.drag?.addEventListener('pointermove', (e) => {
      if (!this._dragState || e.pointerId !== this._dragState.pointerId) return;
      const r = this.root.getBoundingClientRect();
      this.layout.left = clamp(e.clientX - this._dragState.dx, 0,
        Math.max(0, window.innerWidth - r.width));
      this.layout.top = clamp(e.clientY - this._dragState.dy, 0,
        Math.max(0, window.innerHeight - r.height));
      this.root.style.left = `${this.layout.left}px`;
      this.root.style.top = `${this.layout.top}px`;
    });
    const finish = (e) => {
      if (!this._dragState || e.pointerId !== this._dragState.pointerId) return;
      this._dragState = null;
      this._saveLayout();
    };
    this.drag?.addEventListener('pointerup', finish);
    this.drag?.addEventListener('pointercancel', finish);
    window.addEventListener('resize', () => this._applyLayout(false));
  }

  _applyLayout(save = true) {
    this.layout.fontSize = clamp(this.layout.fontSize, 10, 22);
    this.root.style.fontSize = `${this.layout.fontSize}px`;
    document.body.classList.toggle('hud-docked', this.layout.docked);
    this.dock.textContent = this.layout.docked ? 'FLOAT' : 'DOCK';
    if (this.layout.docked) {
      this.root.style.removeProperty('left');
      this.root.style.removeProperty('top');
    } else {
      const r = this.root.getBoundingClientRect();
      this.layout.left = clamp(this.layout.left, 0,
        Math.max(0, window.innerWidth - r.width));
      this.layout.top = clamp(this.layout.top, 0,
        Math.max(0, window.innerHeight - r.height));
      this.root.style.left = `${this.layout.left}px`;
      this.root.style.top = `${this.layout.top}px`;
    }
    if (save) this._saveLayout();

    requestAnimationFrame(() => {
      const gutter = this.layout.docked
        ? Math.ceil(this.root.getBoundingClientRect().width) : 0;
      document.documentElement.style.setProperty('--hud-gutter', `${gutter}px`);
      this.onLayout?.();
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
  syncHash(view, cam = null, instantMs = null) {
    const hash = buildViewHash(view, cam, instantMs);
    if (location.hash !== hash) {
      history.replaceState(null, '', hash || location.pathname);
    }
  }

  /**
   * Read the initial view from the URL.
   * Accepts `city=` or `bbox=`, plus optional camera placement (x, y, z, a,
   * p) and an absolute simulated instant (t).
   */
  static initialView() {
    return parseInitialView(location.hash);
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

  resetWarp() {
    this.warp.value = '0';
  }

  update({ warp, simTime, timeZone, sunAlt, cam, screen, fps, where,
            signMode, renderMode, air, weather, live, imperial, perfStats }) {
    this.warpv.textContent = (warp < 10 ? warp.toFixed(1) : Math.round(warp)) + 'x';

    const local = formatCityTime(simTime, timeZone);
    this.clock.textContent = `${local.clock} ${local.zone}`;
    this.phase.textContent = sunAlt > 0 ? '(day)' : sunAlt > -6 ? '(twilight)' : '(night)';

    // Full local date, e.g. "Thu 20 Aug 2026". The clock alone is ambiguous
    // across time travel, so the date travels with it.
    this.date.textContent = local.date;

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

    if (this.perf) {
      const on = !!perfStats?.enabled;
      this.perf.hidden = !on;
      if (on) {
        const ms = (v) => Number(v || 0).toFixed(2);
        this.perf.textContent = `sim ${ms(perfStats.simulation)} ms · `
          + `ray ${ms(perfStats.raycast)} ms · world ${ms(perfStats.worldQuery)} ms · `
          + `compose ${ms(perfStats.compose)} ms · GPU n/a (Canvas 2D) · `
          + `frame ${ms(perfStats.frame)} ms`;
      }
    }

    if (this.air) {
      this.air.textContent = `air traffic ${air?.status || 'N/A'}`;
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
