/**
 * Frame-time quality controller for the cinematic compositor.
 *
 * It changes one quality step at a time and waits for a settle window before
 * changing direction. This prevents an integrated-GPU laptop from oscillating
 * between resolutions while the user moves the camera.
 */
export class QualityController {
  constructor({ targetMs = 33.3, clock = () => performance.now() } = {}) {
    this.targetMs = targetMs;
    this.clock = clock;
    this.level = 0;
    this.mode = 'auto';
    this.samples = [];
    this.lastChange = -Infinity;
    this.cooldownMs = 1800;
    this.maxSamples = 30;
    this.scales = [1, 0.88, 0.76, 0.64];
  }

  setMode(mode) {
    this.mode = mode === 'manual' ? 'manual' : 'auto';
    return this.mode;
  }

  setLevel(level) {
    this.level = Math.max(0, Math.min(this.scales.length - 1, level | 0));
    return this.level;
  }

  sample(frameMs, now = this.clock()) {
    if (!Number.isFinite(frameMs) || this.mode !== 'auto') return false;
    this.samples.push(frameMs);
    if (this.samples.length > this.maxSamples) this.samples.shift();
    if (this.samples.length < this.maxSamples || now - this.lastChange < this.cooldownMs) return false;
    const avg = this.samples.reduce((sum, value) => sum + value, 0) / this.samples.length;
    this.samples.length = 0;
    if (avg > this.targetMs + 4 && this.level < this.scales.length - 1) {
      this.level++;
      this.lastChange = now;
      return true;
    }
    if (avg < this.targetMs - 8 && this.level > 0) {
      this.level--;
      this.lastChange = now;
      return true;
    }
    return false;
  }

  get scale() { return this.scales[this.level]; }
}
