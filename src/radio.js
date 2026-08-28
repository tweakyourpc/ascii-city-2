import { WORKER_URL } from './runtime-config.js';

export const RADIO_RADII_KM = Object.freeze([50, 150]);
const RADIO_LIMIT = 12;
const DIRECTORY_LIMIT = 1000;
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

  for (const radiusKm of RADIO_RADII_KM) {
    const stations = candidates.filter((s) => s.distanceKm <= radiusKm).slice(0, RADIO_LIMIT);
    if (stations.length) return { radiusKm, stations };
  }
  return { radiusKm: RADIO_RADII_KM.at(-1), stations: [] };
}

export class RadioPlayer {
  constructor({
    workerUrl = WORKER_URL,
    fetchImpl = globalThis.fetch,
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
      const maxRadius = RADIO_RADII_KM.at(-1);
      this.stations = (Array.isArray(data.stations) ? data.stations : [])
        .filter((s) => Number.isFinite(Number(s.distanceKm)) && Number(s.distanceKm) <= maxRadius)
        .slice(0, RADIO_LIMIT);
      this.radiusKm = Number(data.radiusKm) || maxRadius;
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
   * Reverse-geocodes coordinates to a country and state, then asks Radio
   * Browser for enough candidates to apply the same strict 50/150 km boundary
   * as the Worker. A distant but popular station is never presented as local.
   */
  async _discoverDirect(world, token) {
    if (token !== this.token) return;
    this.status = 'TUNING…';
    this.render();
    try {
      const region = await this._region(world.lat, world.lon, token);
      if (token !== this.token) return;
      if (!region?.countryCode) throw new Error('no country');
      const searches = region.state
        ? [{ state: region.state, stateExact: 'true' }, {}]
        : [{}];
      let selected = { radiusKm: RADIO_RADII_KM.at(-1), stations: [] };
      for (const area of searches) {
        const q = new URLSearchParams({
          countrycode: region.countryCode,
          has_geo_info: 'true',
          is_https: 'true',
          hidebroken: 'true',
          order: 'votes',
          reverse: 'true',
          limit: String(DIRECTORY_LIMIT),
          ...area,
        });
        const res = await this.fetchImpl(
          `https://de1.api.radio-browser.info/json/stations/search?${q}`,
          { headers: { Accept: 'application/json' } },
        );
        if (!res.ok) continue;
        selected = selectLocalStations(await res.json(), world.lat, world.lon);
        if (token !== this.token) return;
        if (selected.stations.length) break;
      }
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

  async _region(lat, lon, token) {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2`
      + `&lat=${lat}&lon=${lon}&zoom=5&addressdetails=1`;
    const res = await this.fetchImpl(url, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(String(res.status));
    const j = await res.json();
    if (token !== this.token) return null;
    const countryCode = String(j?.address?.country_code || '').toUpperCase();
    return countryCode ? {
      countryCode,
      state: String(j?.address?.state || j?.address?.region || '').trim(),
    } : null;
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
