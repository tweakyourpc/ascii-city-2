import { FOV, EYE_HEIGHT, MIN_CAM_Z, MAX_CAM_Z } from './config.js';

/**
 * Camera state and the per-column ray tables.
 *
 * `z` is free, because the camera flies. The two projection helpers below are
 * exact inverses of each other, which is what lets the renderer turn a screen
 * row back into a world distance for floor and roof casting:
 *
 *     rowOf(z, d)   world height + distance -> screen row
 *     distOf(z, row) world height + screen row -> distance
 *
 * Note that the horizon does NOT move with altitude. rowOf(z, d) tends to `hz`
 * as d tends to infinity, for every camera height and every world height: on a
 * flat world the horizon sits at eye level however high you are, and only its
 * distance changes. Compensating `hz` for altitude would be an actual error,
 * and would decouple the sky gradient, stars and sun from the geometry.
 */
export class Camera {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.z = EYE_HEIGHT;
    this.vz = 0;
    this.angle = Math.PI / 2;
    this.pitch = 0;

    this.hz = 0;          // horizon row, after pitch
    this.vscale = 1;
    this.proj = 1;
    this.cols = 0;

    this.rc = new Float32Array(0);    // cos of each column's ray
    this.rs = new Float32Array(0);    // sin
    this.rinv = new Float32Array(0);  // 1 / cos(rayAngle - facing), the
                                      // fisheye correction factor
  }

  placeAt({ x, y, angle }) {
    this.x = x;
    this.y = y;
    if (angle !== undefined) this.angle = angle;
    this.z = EYE_HEIGHT;
    this.vz = 0;
  }

  /** Rebuild ray tables. Call after resize or when the facing angle changes. */
  buildRays(screen) {
    if (this.cols !== screen.cols) {
      this.cols = screen.cols;
      this.rc = new Float32Array(screen.cols);
      this.rs = new Float32Array(screen.cols);
      this.rinv = new Float32Array(screen.cols);
    }
    this.proj = screen.proj;
    this.vscale = screen.vscale;

    const { cols } = screen;
    for (let i = 0; i < cols; i++) {
      // Screen columns increase to the right, and angles increase
      // counter-clockwise, so the fan must run DOWN across the screen: the
      // left edge looks further counter-clockwise than the right. Running it
      // the other way mirrors the whole world horizontally, which on a
      // symmetric procedural city is invisible and on real map data puts the
      // buildings from one side of a street on the other.
      const a = this.angle + FOV / 2 - (i + 0.5) / cols * FOV;
      this.rc[i] = Math.cos(a);
      this.rs[i] = Math.sin(a);
      this.rinv[i] = 1 / Math.cos(a - this.angle);
    }
  }

  /** Screen row of world height `z` at perpendicular distance `d`. */
  rowOf(z, d) {
    return this.hz + (this.z - z) * this.vscale / d;
  }

  /** Perpendicular distance at which world height `z` lands on `row`. */
  distOf(z, row) {
    return (this.z - z) * this.vscale / (row + 0.5 - this.hz);
  }

  clampZ() {
    if (this.z < MIN_CAM_Z) { this.z = MIN_CAM_Z; this.vz = 0; }
    if (this.z > MAX_CAM_Z) { this.z = MAX_CAM_Z; this.vz = 0; }
  }
}

export function normAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
