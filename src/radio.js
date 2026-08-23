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
      this.status = 'SETUP REQUIRED';
      this.render();
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
      this.status = 'UNAVAILABLE';
    }
    this.render();
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
