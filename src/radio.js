import { WORKER_URL } from './runtime-config.js';

/**
 * One boundary, not a ladder of them. Results are sorted nearest-first and the
 * HUD shows each station's distance, so a nearer tier only hid usable stations:
 * a single 12 km station suppressed the twenty others inside the same stated
 * radius. Widening past this is what let another city's radio look local.
 */
export const RADIO_RADIUS_KM = 150;
const RADIO_LIMIT = 12;
const DIRECTORY_LIMIT = 300;
const DIRECTORY_HOST = 'https://de1.api.radio-browser.info';
const SELECTION_PREFIX = 'ascii-city:radio-selection:1:';

export function distanceKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** Keep the nearest stations inside the first useful local/regional radius. */
export function selectLocalStations(raw, lat, lon) {
  const candidates = (Array.isArray(raw) ? raw : [])
    .filter((s) => s.stationuuid && s.name
      && s.geo_lat !== null && s.geo_long !== null
      && Number.isFinite(Number(s.geo_lat)) && Number.isFinite(Number(s.geo_long))
      && /^https:\/\//i.test(s.url_resolved || '')
      && !/\.m3u8?(\?|$)/i.test(s.url_resolved || ''))
    .map((s) => ({
      id: String(s.stationuuid),
      name: String(s.name).trim().slice(0, 80),
      url: s.url_resolved,
      country: s.country || '',
      language: s.language || '',
      distanceKm: distanceKm(lat, lon, Number(s.geo_lat), Number(s.geo_long)),
    }))
    .sort((a, b) => a.distanceKm - b.distanceKm);

  return {
    radiusKm: RADIO_RADIUS_KM,
    stations: candidates
      .filter((s) => s.distanceKm <= RADIO_RADIUS_KM)
      .slice(0, RADIO_LIMIT),
  };
}

export class RadioPlayer {
  constructor({
    workerUrl = WORKER_URL,
    // Bound, not passed by reference: a browser's fetch throws "Illegal
    // invocation" when it is called as a method of anything but the global.
    fetchImpl = (...args) => globalThis.fetch(...args),
    storage = globalThis.localStorage,
  } = {}) {
    this.workerUrl = workerUrl;
    this.fetchImpl = fetchImpl;
    this.storage = storage;
    this.audio = new Audio();
    this.audio.preload = 'none';
    this.stations = [];
    this.index = 0;
    this.status = 'N/A';
    this.token = 0;
    this.locationKey = '';
    this.radiusKm = null;
    this.el = document.getElementById('radio');
    document.getElementById('radio-prev')?.addEventListener('click', () => this.step(-1));
    document.getElementById('radio-play')?.addEventListener('click', () => this.toggle());
    document.getElementById('radio-next')?.addEventListener('click', () => this.step(1));
    this.audio.addEventListener('playing', () => this.render());
    this.audio.addEventListener('pause', () => this.render());
    this.audio.addEventListener('error', () => { this.status = 'STREAM UNAVAILABLE'; this.render(); });
  }

  async setWorld(world) {
    const token = ++this.token;
    this.audio.pause();
    this.stations = [];
    this.index = 0;
    this.radiusKm = null;
    this.locationKey = Number.isFinite(world?.lat) && Number.isFinite(world?.lon)
      ? `${world.lat.toFixed(1)},${world.lon.toFixed(1)}` : '';
    if (!this.locationKey) {
      // A world with no real coordinates has no local radio to discover. Say so
      // plainly rather than asking a directory about an undefined position.
      this.status = 'N/A';
      this.render();
      return;
    }
    if (!this.workerUrl) {
      // No Worker configured: try the direct Radio Browser discovery path so
      // nearby stations still work without a deployment-owned proxy.
      await this._discoverDirect(world, token);
      return;
    }
    this.status = 'TUNING…';
    this.render();
    try {
      const url = `${this.workerUrl}/api/radio?lat=${world.lat.toFixed(4)}&lon=${world.lon.toFixed(4)}`;
      const res = await this.fetchImpl(url);
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      if (token !== this.token) return;
      this.stations = (Array.isArray(data.stations) ? data.stations : [])
        .filter((s) => Number.isFinite(Number(s.distanceKm))
          && Number(s.distanceKm) <= RADIO_RADIUS_KM)
        .slice(0, RADIO_LIMIT);
      this.radiusKm = Number(data.radiusKm) || RADIO_RADIUS_KM;
      this._restoreSelection();
      this.status = this.stations.length ? 'READY' : 'NO LOCAL STATIONS';
      this.render();
    } catch {
      if (token !== this.token) return;
      // Worker route failed: fall back to direct Radio Browser discovery rather
      // than leaving the radio empty. A failed neighbour is reported, not faked.
      await this._discoverDirect(world, token);
    }
  }

  /**
   * Discover nearby stations directly from Radio Browser, without a Worker.
   *
   * Radio Browser can filter by position itself, so this asks it for stations
   * inside the outer radius and keeps the same strict boundary the Worker
   * applies. There is deliberately no geocoder in this path: reverse-geocoding
   * just to name a country cost an extra request against a rate-limited
   * service that answers 403 under load, and it narrowed results to whatever
   * a country-or-state text match happened to contain. Strictly additive: any
   * failure ends in an empty list and a truthful status, never a fabricated
   * station.
   */
  async _discoverDirect(world, token) {
    if (token !== this.token) return;
    this.status = 'TUNING\u2026';
    this.render();
    try {
      const q = new URLSearchParams({
        geo_lat: String(world.lat),
        geo_long: String(world.lon),
        geo_distance: String(RADIO_RADIUS_KM * 1000),
        has_geo_info: 'true',
        hidebroken: 'true',
        order: 'distance',
        limit: String(DIRECTORY_LIMIT),
      });
      const res = await this.fetchImpl(
        `${DIRECTORY_HOST}/json/stations/search?${q}`,
        { headers: { Accept: 'application/json' } },
      );
      if (!res.ok) throw new Error(String(res.status));
      const selected = selectLocalStations(await res.json(), world.lat, world.lon);
      if (token !== this.token) return;
      this.stations = selected.stations;
      this.radiusKm = selected.radiusKm;
      this._restoreSelection();
      this.status = this.stations.length ? 'READY' : 'NO LOCAL STATIONS';
    } catch {
      if (token !== this.token) return;
      this.stations = [];
      this.status = 'UNAVAILABLE';
    }
    this.render();
  }

  _selectionKey() {
    return this.locationKey ? SELECTION_PREFIX + this.locationKey : '';
  }

  _restoreSelection() {
    const key = this._selectionKey();
    if (!key || !this.storage) return;
    try {
      const saved = this.storage.getItem(key);
      const found = this.stations.findIndex((station) => station.id === saved);
      if (found >= 0) this.index = found;
    } catch { /* selection persistence is optional */ }
  }

  _rememberSelection() {
    const key = this._selectionKey();
    const station = this.current();
    if (!key || !station || !this.storage) return;
    try { this.storage.setItem(key, station.id); }
    catch { /* selection persistence is optional */ }
  }

  current() { return this.stations[this.index] || null; }

  async toggle() {
    const station = this.current();
    if (!station) return;
    if (!this.audio.paused) { this.audio.pause(); return; }
    if (this.audio.src !== station.url) this.audio.src = station.url;
    this.status = 'CONNECTING…';
    this.render();
    try {
      await this.audio.play();
      this._rememberSelection();
      if (this.workerUrl) {
        this.fetchImpl(`${this.workerUrl}/api/radio/${encodeURIComponent(station.id)}/click`,
          { method: 'POST' }).catch(() => {});
      }
    } catch {
      this.status = 'PLAY BLOCKED';
      this.render();
    }
  }

  step(delta) {
    if (!this.stations.length) return;
    const wasPlaying = !this.audio.paused;
    this.audio.pause();
    this.index = (this.index + delta + this.stations.length) % this.stations.length;
    this.audio.removeAttribute('src');
    this.audio.load();
    this.status = 'READY';
    this._rememberSelection();
    this.render();
    if (wasPlaying) this.toggle();
  }

  render() {
    if (!this.el) return;
    const station = this.current();
    const state = station ? (!this.audio.paused ? 'PLAYING' : this.status) : this.status;
    const distance = station && Number.isFinite(Number(station.distanceKm))
      ? ` · ${Math.round(Number(station.distanceKm))} km` : '';
    this.el.textContent = `radio ${state}${station ? ` · ${station.name}${distance}` : ''}`;
  }
}
