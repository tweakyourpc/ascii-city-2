import { WORKER_URL } from './runtime-config.js';

export class RadioPlayer {
  constructor({ workerUrl = WORKER_URL } = {}) {
    this.workerUrl = workerUrl;
    this.audio = new Audio();
    this.audio.preload = 'none';
    this.stations = [];
    this.index = 0;
    this.status = 'N/A';
    this.token = 0;
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
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      if (token !== this.token) return;
      this.stations = Array.isArray(data.stations) ? data.stations : [];
      this.index = 0;
      this.status = this.stations.length ? 'READY' : 'NO STATIONS';
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
   * Reverse-geocodes the coordinates to a country via Nominatim, then queries
   * Radio Browser for HTTPS stations in that country sorted by votes. Strictly
   * additive: any failure ends in an empty list and a truthful status, never a
   * fabricated station. Used when no Worker is configured or the Worker route
   * fails, so the radio degrades gracefully instead of going dark.
   */
  async _discoverDirect(world, token) {
    if (token !== this.token) return;
    this.status = 'TUNING…';
    this.render();
    try {
      const cc = await this._countryCode(world.lat, world.lon, token);
      if (token !== this.token) return;
      if (!cc) throw new Error('no country');
      const url = `https://de1.api.radio-browser.info/json/stations/search`
        + `?countrycode=${encodeURIComponent(cc)}&has_geo_info=true`
        + `&is_https=true&hidebroken=true&order=votes&reverse=true&limit=50`;
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'ascii-city/1.1' },
      });
      if (!res.ok) throw new Error(String(res.status));
      const raw = await res.json();
      if (token !== this.token) return;
      const stations = (Array.isArray(raw) ? raw : [])
        .filter((s) => Number.isFinite(Number(s.geo_lat)) && Number.isFinite(Number(s.geo_long))
          && /^https:\/\//i.test(s.url_resolved || ''))
        .map((s) => ({
          id: String(s.stationuuid),
          name: s.name || 'Unknown',
          url: s.url_resolved,
          country: s.country || '',
          language: s.language || '',
          distanceKm: this._distanceKm(world.lat, world.lon,
            Number(s.geo_lat), Number(s.geo_long)),
        }))
        .sort((a, b) => a.distanceKm - b.distanceKm);
      this.stations = stations;
      this.index = 0;
      this.status = stations.length ? 'READY' : 'NO STATIONS';
    } catch {
      if (token !== this.token) return;
      this.stations = [];
      this.status = this.workerUrl ? 'UNAVAILABLE' : 'SETUP REQUIRED';
    }
    this.render();
  }

  async _countryCode(lat, lon, token) {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2`
      + `&lat=${lat}&lon=${lon}&zoom=5&addressdetails=1`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'ascii-city/1.1' },
    });
    if (!res.ok) throw new Error(String(res.status));
    const j = await res.json();
    if (token !== this.token) return null;
    const cc = String(j?.address?.country_code || '').toUpperCase();
    return cc || null;
  }

  _distanceKm(lat1, lon1, lat2, lon2) {
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLon = (lon2 - lon1) * rad;
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(h));
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
      fetch(`${this.workerUrl}/api/radio/${encodeURIComponent(station.id)}/click`, { method: 'POST' }).catch(() => {});
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
    this.render();
    if (wasPlaying) this.toggle();
  }

  render() {
    if (!this.el) return;
    const station = this.current();
    const state = station ? (!this.audio.paused ? 'PLAYING' : this.status) : this.status;
    this.el.textContent = `radio ${state}${station ? ` · ${station.name}` : ''}`;
  }
}
