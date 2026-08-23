const PHASES = ['simulation', 'raycast', 'worldQuery', 'compose', 'frame'];

/**
 * Low-overhead rolling engine timings.
 *
 * Canvas 2D does not expose a portable GPU timer. `compose` therefore measures
 * JavaScript-to-Canvas submission; `gpu` remains null instead of inventing a
 * number for work the browser performs asynchronously.
 */
export class PerformanceTracker {
  constructor({ clock = () => performance.now(), smoothing = 0.12 } = {}) {
    this.clock = clock;
    this.smoothing = smoothing;
    this.enabled = false;
    this.fps = 0;
    this.current = Object.fromEntries(PHASES.map((name) => [name, 0]));
    this.average = Object.fromEntries(PHASES.map((name) => [name, 0]));
    this.started = Object.create(null);
    this.frameStart = 0;
    this.fpsStart = 0;
    this.fpsFrames = 0;
  }

  toggle() {
    this.enabled = !this.enabled;
    this.fpsStart = 0;
    this.fpsFrames = 0;
    return this.enabled;
  }

  beginFrame(now) {
    if (!this.enabled) return;
    if (now === undefined) now = this.clock();
    this.frameStart = now;
    for (const name of PHASES) this.current[name] = 0;
    if (!this.fpsStart) this.fpsStart = now;
  }

  start(name, now) {
    if (!this.enabled) return;
    if (now === undefined) now = this.clock();
    this.started[name] = now;
  }

  end(name, now) {
    if (!this.enabled || this.started[name] === undefined) return 0;
    if (now === undefined) now = this.clock();
    const elapsed = Math.max(0, now - this.started[name]);
    delete this.started[name];
    this._record(name, elapsed);
    return elapsed;
  }

  endFrame(now) {
    if (!this.enabled) return;
    if (now === undefined) now = this.clock();
    this._record('frame', Math.max(0, now - this.frameStart));
    this.fpsFrames++;
    const span = now - this.fpsStart;
    if (span >= 500) {
      this.fps = this.fpsFrames * 1000 / span;
      this.fpsStart = now;
      this.fpsFrames = 0;
    }
  }

  _record(name, elapsed) {
    if (!(name in this.current)) return;
    this.current[name] += elapsed;
    const old = this.average[name];
    this.average[name] = old === 0
      ? this.current[name]
      : old + (this.current[name] - old) * this.smoothing;
  }

  snapshot() {
    return {
      enabled: this.enabled,
      simulation: this.average.simulation,
      raycast: this.average.raycast,
      worldQuery: this.average.worldQuery,
      compose: this.average.compose,
      gpu: null,
      frame: this.average.frame,
      fps: this.fps,
    };
  }
}
