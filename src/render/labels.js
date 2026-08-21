import { fogOf } from './materials.js';
import { FOV, FOG_FULL } from '../config.js';

/**
 * Street and landmark labels, drawn into the character grid.
 *
 * The design constraint is "knowing where you are without it being in the way",
 * so: one label per street name, a hard cap per class, depth tested against the
 * scene so buildings occlude them, and the whole layer switches off.
 *
 * The thing that makes ASCII labels work at all is that character height is
 * constant. A label is therefore legible at any altitude, provided it is culled
 * by its PROJECTED ROW rather than by a fixed distance band. At 100 cells up
 * looking down, the visible rows correspond to street distances of roughly
 * 59-98 cells; a hardcoded band puts every label off-screen from the air.
 */

const TAN_HALF = Math.tan(FOV / 2) * 1.04;   // slight pad, so labels don't pop
const FAR = FOG_FULL * 0.7;
const NEAR = 6;
const STREET_CAP = 8;
const LANDMARK_CAP = 4;
// Some OSM names are a sentence. "Algonquin Hotel Times Square Autograph
// Collection" is 48 characters and takes a third of the screen.
const MAX_NAME = 26;

const ABBREV = [
  [/\bSTREET\b/g, 'ST'], [/\bAVENUE\b/g, 'AVE'], [/\bBOULEVARD\b/g, 'BLVD'],
  [/\bROAD\b/g, 'RD'], [/\bDRIVE\b/g, 'DR'], [/\bLANE\b/g, 'LN'],
  [/\bPLACE\b/g, 'PL'], [/\bSQUARE\b/g, 'SQ'], [/\bCOURT\b/g, 'CT'],
  [/\bTERRACE\b/g, 'TER'], [/\bPARKWAY\b/g, 'PKWY'], [/\bHIGHWAY\b/g, 'HWY'],
  [/\bNORTH\b/g, 'N'], [/\bSOUTH\b/g, 'S'], [/\bEAST\b/g, 'E'], [/\bWEST\b/g, 'W'],
];

function short(name) {
  let s = name.toUpperCase();
  for (const [re, to] of ABBREV) s = s.replace(re, to);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length <= MAX_NAME ? s : s.slice(0, MAX_NAME - 1).replace(/[ .,-]+$/, '') + '.';
}

export const MODE = { OFF: 0, STREETS: 1, ALL: 2 };

export class Labels {
  constructor() {
    this.mode = MODE.ALL;
    this.mask = null;          // Uint8Array(cols*rows), per-frame occupancy
    this.maskCols = 0;
    this.frame = 0;
    this.prevDrawn = new Set();
    this.drawn = new Set();
    this._n = 0;
    this.lastCounts = { streets: 0, landmarks: 0 };
  }

  cycle() {
    this.mode = (this.mode + 1) % 3;
    return this.mode;
  }

  _ensure(screen, world) {
    const need = screen.cols * screen.rows;
    if (!this.mask || this.mask.length !== need) {
      this.mask = new Uint8Array(need);
      this.maskCols = screen.cols;
    }
    const n = world.streetNames ? world.streetNames.length : 0;
    if (n !== this._n) {
      this._n = n;
      this.stamp = new Int32Array(n);
      this.score = new Float32Array(n);
      this.best = new Int32Array(n);
      this.col = new Float32Array(n);
      this.row = new Float32Array(n);
      this.dist = new Float32Array(n);
      this.stamp.fill(-1);
    }
  }

  draw(screen, cam, world, L) {
    this.lastCounts.streets = 0;
    this.lastCounts.landmarks = 0;
    if (this.mode === MODE.OFF || !world.anchor || world.anchor.n === 0) return;

    this._ensure(screen, world);
    this.mask.fill(0);
    this.frame++;
    this.drawn.clear();

    const fwdX = Math.cos(cam.angle);
    const fwdY = Math.sin(cam.angle);

    this._streets(screen, cam, world, L, fwdX, fwdY);
    if (this.mode === MODE.ALL) this._landmarks(screen, cam, world, L, fwdX, fwdY);

    const swap = this.prevDrawn;
    this.prevDrawn = this.drawn;
    this.drawn = swap;
  }

  _streets(screen, cam, world, L, fwdX, fwdY) {
    const A = world.anchor;
    const { cols, rows } = screen;
    const order = [];
    const frame = this.frame;

    for (let i = 0; i < A.n; i++) {
      const dx = A.x[i] - cam.x;
      const dy = A.y[i] - cam.y;
      // Dot with the facing vector: this is the perpendicular distance the
      // renderer uses everywhere else, and it needs no trig.
      const along = dx * fwdX + dy * fwdY;
      if (along < NEAR || along > FAR) continue;

      const side = -dx * fwdY + dy * fwdX;
      const halfW = along * TAN_HALF;
      if (side > halfW || side < -halfW) continue;

      // rowOf(0, along), inlined.
      const row = cam.hz + cam.z * cam.vscale / along;
      if (row < 0.5 || row >= rows - 0.5) continue;

      const nm = A.name[i];
      const sideRatio = side / along;
      const s = 2.0 * A.junction[i]
              + 0.45 * A.rank[i]
              - 1.6 * (along / FAR)
              - 1.1 * Math.abs(sideRatio)
              // Hysteresis. Without it two anchors of the same street swap
              // places as you walk and the label jumps across the screen,
              // which is far more distracting than the label itself.
              + (this.prevDrawn.has(nm) ? 0.5 : 0);

      if (this.stamp[nm] !== frame) {
        this.stamp[nm] = frame;
        this.score[nm] = -Infinity;
        order.push(nm);
      }
      if (s > this.score[nm]) {
        this.score[nm] = s;
        this.best[nm] = i;
        // `side` is positive to the LEFT (fwd rotated counter-clockwise), so
        // it subtracts. Same handedness as camera.buildRays.
        this.col[nm] = cols / 2 - sideRatio * cam.proj;
        this.row[nm] = row;
        this.dist[nm] = along;
      }
    }

    order.sort((a, b) => this.score[b] - this.score[a]);

    let placed = 0;
    for (let k = 0; k < order.length && placed < STREET_CAP; k++) {
      const nm = order[k];
      const label = short(world.streetNames[nm]);
      const d = this.dist[nm];
      const f = Math.max(0.10, fogOf(d));
      const colour = L.depth(198 * L.amb + 46, 210 * L.amb + 48, 226 * L.amb + 52, f);

      // Which way does this street run on screen? A street heading away from
      // you projects toward the vanishing point and reads down the screen; a
      // cross street reads across it. Writing every name horizontally is why
      // you cannot tell which name belongs to which street at a junction.
      const vertical = this._runsVertically(screen, cam, A, this.best[nm], fwdX, fwdY);
      const text = vertical ? label : ` ${label} `;
      const step = screen.rowStep || 1;

      let x;
      let y;
      if (vertical) {
        x = Math.round(this.col[nm]);
        y = Math.round(this.row[nm]) - Math.floor(text.length / 2) * step;
      } else {
        x = Math.round(this.col[nm] - text.length / 2);
        y = Math.round(this.row[nm]);
      }
      y -= y % step;

      // A label lying on the ground spans many rows when written vertically,
      // and every row is a different distance. Test each cell against the
      // ground distance at ITS row, or the near half of the label always
      // fails and the street you are standing on never gets named.
      const depthFor = vertical
        ? (row) => cam.z * cam.vscale / Math.max(0.5, row + 0.5 - cam.hz)
        : null;

      if (this._place(screen, x, y, text, colour, d, 2, vertical, step, depthFor)) {
        this.drawn.add(nm);
        placed++;
      }
    }
    this.lastCounts.streets = placed;
  }

  /**
   * Project a short piece of the street either side of its anchor and compare
   * the screen-space run. More vertical than horizontal means the street is
   * heading away from the camera, so its name should read down the screen.
   *
   * Because it is computed from the projection, it follows the camera: turn
   * ninety degrees and a name that was stacked vertically lies down flat.
   */
  _runsVertically(screen, cam, A, i, fwdX, fwdY) {
    if (i === undefined || !A.dx) return false;
    const K = 8;                                   // cells either side
    let dCol = 0;
    let dRow = 0;
    let seen = 0;
    let prevCol = 0;
    let prevRow = 0;

    for (const t of [-K, K]) {
      const wx = A.x[i] + A.dx[i] * t - cam.x;
      const wy = A.y[i] + A.dy[i] * t - cam.y;
      const along = wx * fwdX + wy * fwdY;
      if (along < 2) continue;                     // behind us or on top of us
      const side = -wx * fwdY + wy * fwdX;
      const col = screen.cols / 2 - (side / along) * cam.proj;
      const row = cam.hz + cam.z * cam.vscale / along;
      if (seen++) { dCol = col - prevCol; dRow = row - prevRow; }
      prevCol = col;
      prevRow = row;
    }
    if (seen < 2) return false;

    // Rows are taller than columns, so compare in pixels, not cells, or a
    // street at 45 degrees would be called vertical.
    const px = Math.abs(dCol) * screen.cw;
    const py = Math.abs(dRow) * screen.ch;
    return py > px;
  }

  _landmarks(screen, cam, world, L, fwdX, fwdY) {
    if (!world.landmarks || world.landmarks.length === 0) return;

    // The band widens as you climb: from the air you want the skyline named,
    // at street level only what is actually in front of you.
    const near = 14;
    const far = Math.min(FAR, 70 + 1.5 * cam.z);
    const cands = [];

    for (let k = 0; k < world.landmarks.length; k++) {
      const b = world.buildings[world.landmarks[k]];
      const dx = b.cx - cam.x;
      const dy = b.cy - cam.y;
      const along = dx * fwdX + dy * fwdY;
      if (along < near || along > far) continue;
      const side = -dx * fwdY + dy * fwdX;
      if (Math.abs(side) > along * TAN_HALF) continue;

      // One row above the roofline, so the name sits against the sky and any
      // tower in front of it occludes the text for free.
      //
      // A tall tower close by has its roof above the viewport, but it is very
      // much in view and worth naming, so clamp rather than drop: reject only
      // when no part of the building is on screen at all.
      const roof = cam.rowOf(b.h, along);
      const base = cam.rowOf(0, along);
      if (base < 0 || roof >= screen.rows) continue;
      const row = Math.max(0, Math.min(screen.rows - 1, Math.round(roof) - 1));

      cands.push({
        b, along, side, row,
        // Depth-test against the building's NEAR face, not its centroid.
        // Testing at the centroid means a building always occludes its own
        // label and no landmark is ever drawn.
        testD: Math.max(1, along - b.r),
        score: b.notable + b.h / 40 - along / far - Math.abs(side / along),
      });
      if (cands.length > 40) break;
    }

    cands.sort((p, q) => q.score - p.score);

    let placed = 0;
    for (let i = 0; i < cands.length && placed < LANDMARK_CAP; i++) {
      const c = cands[i];
      const f = Math.max(0.14, fogOf(c.along));
      const colour = L.depth(255, 206 * L.amb + 30, 130 * L.amb + 20, f);
      const text = ` ${short(c.b.name)} `;
      const x = Math.round(screen.cols / 2 - c.side / c.along * cam.proj
                           - text.length / 2);
      if (this._place(screen, x, c.row, text, colour, c.testD, 3)) placed++;
    }
    this.lastCounts.landmarks = placed;
  }

  /**
   * Place a label, nudging up to `nudge` rows to find clear space.
   *
   * A label is drawn only if most of it is unoccluded: partially hidden text
   * reads as corruption rather than as depth.
   */
  /**
   * Place a label, either across the screen or down it, nudging sideways to
   * find clear space.
   *
   * A label is drawn only if all of it is unoccluded: skipping individual
   * hidden characters leaves city texture between the letters, which reads as
   * corruption rather than as depth.
   */
  _place(screen, x, y, text, colour, d, nudge, vertical = false, step = 1,
         depthFor = null) {
    const { cols, rows, depth } = screen;
    const len = text.length;
    if (len === 0) return false;

    const spanX = vertical ? 1 : len;
    const spanY = vertical ? (len - 1) * step + 1 : 1;
    if (spanX > cols || spanY > rows) return false;

    for (let n = 0; n <= nudge; n++) {
      for (let pass = 0; pass < (n === 0 ? 1 : 2); pass++) {
        const off = n === 0 ? 0 : (pass === 0 ? -n : n);
        // Nudge across the label, never along it.
        let xx = vertical ? x + off : x;
        let yy = vertical ? y : y + off * step;

        xx = Math.max(0, Math.min(cols - spanX, xx));
        yy = Math.max(0, Math.min(rows - spanY, yy));
        yy -= yy % step;

        const cx = (i) => (vertical ? xx : xx + i);
        const cy = (i) => (vertical ? yy + i * step : yy);

        // Occupancy, with a one-cell margin so labels never touch.
        let free = true;
        for (let i = -1; i <= len && free; i++) {
          const k = Math.max(0, Math.min(len - 1, i));
          const ax = cx(k) + (!vertical && i < 0 ? -1 : !vertical && i >= len ? 1 : 0);
          const ay = cy(k) + (vertical && i < 0 ? -step : vertical && i >= len ? step : 0);
          for (let m = -1; m <= 1; m++) {
            const mx = vertical ? ax + m : ax;
            const my = vertical ? ay : ay + m;
            if (mx < 0 || mx >= cols || my < 0 || my >= rows) continue;
            if (this.mask[my * cols + mx]) { free = false; break; }
          }
        }
        if (!free) continue;

        // A street label sits on the row whose floor-cast distance equals the
        // anchor's, so an exact depth test fails on rounding for exactly the
        // cells that should pass. Hence the bias.
        let ink = 0;
        let hidden = 0;
        for (let i = 0; i < len; i++) {
          if (text[i] === ' ') continue;
          ink++;
          const want = depthFor ? depthFor(cy(i)) : d;
          if (want > depth[cy(i) * cols + cx(i)] * 1.02 + 0.5) { hidden = 1; break; }
        }
        if (ink === 0 || hidden) continue;

        // Spaces are written as blanks rather than skipped: ground texture in
        // the gaps between words otherwise reads as letters.
        for (let i = 0; i < len; i++) screen.set(cx(i), cy(i), text[i], colour);

        for (let i = -1; i <= len; i++) {
          const k = Math.max(0, Math.min(len - 1, i));
          const ax = cx(k) + (!vertical && i < 0 ? -1 : !vertical && i >= len ? 1 : 0);
          const ay = cy(k) + (vertical && i < 0 ? -step : vertical && i >= len ? step : 0);
          for (let m = -1; m <= 1; m++) {
            const mx = vertical ? ax + m : ax;
            const my = vertical ? ay : ay + m;
            if (mx < 0 || mx >= cols || my < 0 || my >= rows) continue;
            this.mask[my * cols + mx] = 1;
          }
        }
        return true;
      }
    }
    return false;
  }
}
