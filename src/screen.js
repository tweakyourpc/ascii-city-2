import {
  FONT_PX, FONT_STACK, LINE_RATIO, FOV, HORIZON_FRAC, RENDER_MODE,
} from './config.js';

/** Quantised rgb() string cache. 5 bits per channel is plenty for text. */
const colCache = new Map();

export function col2str(r, g, b) {
  r = r < 0 ? 0 : r > 255 ? 255 : r | 0;
  g = g < 0 ? 0 : g > 255 ? 255 : g | 0;
  b = b < 0 ? 0 : b > 255 ? 255 : b | 0;
  const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
  let s = colCache.get(key);
  if (s === undefined) {
    s = `rgb(${(r >> 3) << 3},${(g >> 3) << 3},${(b >> 3) << 3})`;
    colCache.set(key, s);
  }
  return s;
}

/** How the grid is painted. */
export const MODE = {
  /** One character per cell. Glyphs carry texture: markings, water, windows. */
  GLYPH: 0,
  /**
   * Two stacked half-height colour blocks per text line, so the grid runs at
   * double vertical resolution and the scene is painted as solid colour.
   * Sharper silhouettes and much more vivid colour, because a glyph only inks
   * part of its cell and silently dims everything it draws.
   */
  BLOCK: 1,
};

/**
 * The character grid and its canvas backing.
 *
 * Cells hold a glyph, a colour, a depth, and a `kind` saying which family the
 * cell belongs to: nothing, scene geometry, or text. `kind` is what lets the
 * blitter paint the world as solid blocks while still drawing labels and
 * panels as characters.
 *
 * Two vertical coordinate systems exist, and the distinction matters:
 *
 *   rows     internal cells, what the raycaster and sprites address
 *   outRows  text lines, what panels and centred text address
 *
 * `rowStep` is the ratio: 1 in glyph mode, 2 in block mode. Anything laying
 * out text works in output lines; anything projecting geometry works in
 * internal rows. Picking divides by `ch`, which is the internal row height, so
 * a mouse position maps to an internal row in both modes without special
 * cases.
 */
export class Screen {
  constructor(canvas, mode = RENDER_MODE) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.mode = mode;
    this.resize();
  }

  /** Switch rendering mode. Reallocates, because the grid changes shape. */
  setMode(mode) {
    if (mode === this.mode) return this.mode;
    this.mode = mode;
    this.resize();
    return this.mode;
  }

  cycleMode() {
    return this.setMode(this.mode === MODE.GLYPH ? MODE.BLOCK : MODE.GLYPH);
  }

  resize() {
    // CSS may reserve a docked HUD gutter. Use the canvas's actual viewport,
    // not the browser window, so the city never renders underneath that HUD.
    const w = Math.max(1, Math.round(this.canvas.clientWidth || window.innerWidth));
    const h = Math.max(1, Math.round(this.canvas.clientHeight || window.innerHeight));
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;

    const ctx = this.ctx;
    ctx.textBaseline = 'top';
    ctx.font = `${FONT_PX}px ${FONT_STACK}`;
    // Measure rather than assume: monospace metrics differ across platforms.
    this.cw = ctx.measureText('MMMMMMMMMM').width / 10 || 8;

    this.lineH = Math.round(FONT_PX * LINE_RATIO);
    if (this.mode === MODE.BLOCK) {
      // A text line splits into two half-blocks, so it has to be even.
      if (this.lineH & 1) this.lineH += 1;
      this.rowStep = 2;
    } else {
      this.rowStep = 1;
    }
    this.ch = this.lineH / this.rowStep;

    this.cols = Math.max(24, Math.floor(w / this.cw));
    this.rows = Math.max(12 * this.rowStep, Math.floor(h / this.ch));
    this.rows -= this.rows % this.rowStep;
    this.outRows = this.rows / this.rowStep;
    this.horizon = Math.floor(this.rows * HORIZON_FRAC);

    this.proj = (this.cols / 2) / Math.tan(FOV / 2);
    // Vertical units are rows, not columns, so the projection scale differs.
    this.vscale = this.proj * this.cw / this.ch;

    const n = this.cols * this.rows;
    this.glyph = new Array(n);
    this.colour = new Array(n);
    this.depth = new Float32Array(n);
    // 0 empty, 1 scene, 2 text. Replaces inferring the two from the depth.
    this.kind = new Uint8Array(n);
    this.skyEnd = new Int32Array(this.cols);
    this.scrims = [];

    // Per-column coverage for the raycaster. `cov` is scratch, reused for
    // whichever column is being traced. `holeMask` keeps the above-horizon
    // coverage of columns that turned out to have gaps in them, so the sky
    // can be painted behind a canopy rather than under it.
    this.covWords = (this.rows + 31) >> 5;
    this.cov = new Uint32Array(this.covWords);
    this.hasHoles = new Uint8Array(this.cols);
    this.holeMask = new Uint32Array(this.cols * this.covWords);
  }

  clear() {
    this.glyph.fill(undefined);
    this.depth.fill(1e9);
    this.kind.fill(0);
    this.scrims.length = 0;
    this.hasHoles.fill(0);
  }

  /** Write a text cell. `y` is an internal row. */
  set(x, y, ch, colour) {
    if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) return;
    const i = y * this.cols + x;
    this.glyph[i] = ch;
    this.colour[i] = colour;
    this.kind[i] = 2;
  }

  /** Write a scene cell and record its depth, for later compositing. */
  setDepth(x, y, ch, colour, d) {
    if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) return;
    const i = y * this.cols + x;
    this.glyph[i] = ch;
    this.colour[i] = colour;
    this.depth[i] = d;
    this.kind[i] = 1;
  }

  fillRow(y, ch, colour, d) {
    if (y < 0 || y >= this.rows) return;
    const base = y * this.cols;
    for (let x = 0; x < this.cols; x++) {
      this.glyph[base + x] = ch;
      this.colour[base + x] = colour;
      this.depth[base + x] = d;
      this.kind[base + x] = 1;
    }
  }

  /**
   * Left-aligned text on an OUTPUT line, clipped to the grid. Spaces are left
   * transparent so a label does not punch a hole in whatever it sits on.
   * @returns {number} glyphs actually written
   */
  text(x, outY, str, colour) {
    if (outY < 0 || outY >= this.outRows) return 0;
    const base = outY * this.rowStep * this.cols;
    let n = 0;
    for (let i = 0; i < str.length; i++) {
      const cx = x + i;
      if (cx < 0) continue;
      if (cx >= this.cols) break;
      if (str[i] === ' ') continue;
      // Claim every internal row of the line, so the blitter sees one whole
      // text line rather than a half block with a gap beneath it.
      for (let s = 0; s < this.rowStep; s++) {
        const j = base + s * this.cols + cx;
        this.glyph[j] = str[i];
        this.colour[j] = colour;
        this.kind[j] = 2;
      }
      n++;
    }
    return n;
  }

  /**
   * As text(), but writes only the cells the caller's depth `d` is in front of,
   * so world-anchored labels are occluded by geometry.
   */
  textDepth(x, outY, str, colour, d) {
    if (outY < 0 || outY >= this.outRows) return 0;
    const base = outY * this.rowStep * this.cols;
    let n = 0;
    for (let i = 0; i < str.length; i++) {
      const cx = x + i;
      if (cx < 0) continue;
      if (cx >= this.cols) break;
      if (str[i] === ' ') continue;
      if (d > this.depth[base + cx]) continue;
      for (let s = 0; s < this.rowStep; s++) {
        const j = base + s * this.cols + cx;
        this.glyph[j] = str[i];
        this.colour[j] = colour;
        this.kind[j] = 2;
      }
      n++;
    }
    return n;
  }

  /**
   * Blank a rectangle of cells, in output-line coordinates. Panels need this:
   * a scrim paints under the glyph layer, so without clearing, the scene blits
   * straight over the top of the backdrop.
   */
  clearBox(x, outY, w, h) {
    for (let r = 0; r < h; r++) {
      const oy = outY + r;
      if (oy < 0 || oy >= this.outRows) continue;
      const base = oy * this.rowStep * this.cols;
      for (let c = 0; c < w; c++) {
        const cx = x + c;
        if (cx < 0 || cx >= this.cols) continue;
        for (let st = 0; st < this.rowStep; st++) {
          const j = base + st * this.cols + cx;
          this.glyph[j] = ' ';
          this.colour[j] = null;
          this.kind[j] = 2;
        }
      }
    }
  }

  /** Centre a line of text on an output line. */
  centreText(outY, text, colour) {
    return this.text(Math.floor((this.cols - text.length) / 2), outY, text, colour);
  }

  /**
   * Queue a translucent rectangle, in output-line coordinates, painted at the
   * start of the next blit. The glyph grid has no per-cell background, and the
   * sky is painted straight to the canvas, so a panel backdrop has to go here.
   */
  scrim(x, outY, w, h, style) {
    this.scrims.push([x, outY, w, h, style]);
  }

  blit() {
    const { ctx, cw, lineH } = this;

    // Backdrops first, under everything else.
    for (let i = 0; i < this.scrims.length; i++) {
      const [sx, sy, sw, sh, style] = this.scrims[i];
      ctx.fillStyle = style;
      ctx.fillRect(sx * cw, sy * lineH, sw * cw, sh * lineH);
    }
    this.scrims.length = 0;

    ctx.font = `${FONT_PX}px ${FONT_STACK}`;
    if (this.mode === MODE.BLOCK) this._blitBlocks();
    else this._blitGlyphs();
  }

  /**
   * One character per cell, runs of one colour batched into a single fillText.
   * A full screen costs a few hundred draws, not tens of thousands.
   */
  _blitGlyphs() {
    const { ctx, cols, rows, cw, ch, glyph, colour } = this;

    for (let y = 0; y < rows; y++) {
      const base = y * cols;
      let run = '';
      let runCol = null;
      let runStart = 0;

      for (let x = 0; x < cols; x++) {
        const g = glyph[base + x];
        if (g === undefined || g === ' ') {
          if (run) {
            ctx.fillStyle = runCol;
            ctx.fillText(run, runStart * cw, y * ch);
            run = '';
          }
          continue;
        }
        const c = colour[base + x];
        if (run && c !== runCol) {
          ctx.fillStyle = runCol;
          ctx.fillText(run, runStart * cw, y * ch);
          run = '';
        }
        if (!run) { runStart = x; runCol = c; }
        run += g;
      }
      if (run) {
        ctx.fillStyle = runCol;
        ctx.fillText(run, runStart * cw, y * ch);
      }
    }
  }

  /**
   * Two half-height blocks per text line.
   *
   * Scene cells become horizontal fillRect strips; text cells are batched into
   * fillText runs as in glyph mode. A text cell claims its whole output line,
   * so a column carrying text is skipped by the block passes.
   *
   * Each half-row is batched INDEPENDENTLY, then merged vertically where the
   * two halves agree. Requiring a matching colour PAIR before continuing a run
   * roughly squares the chance of a break, which collapses runs to about one
   * cell in a scene as varied as a city.
   */
  _blitBlocks() {
    const { ctx, cols, outRows, cw, ch, lineH, glyph, colour, kind } = this;

    for (let k = 0; k < outRows; k++) {
      const b0 = k * 2 * cols;
      const b1 = b0 + cols;
      const yPix = k * lineH;

      for (let half = 0; half < 2; half++) {
        const base = half === 0 ? b0 : b1;
        const top = yPix + half * ch;
        let x = 0;

        while (x < cols) {
          // A text cell owns the whole line, so neither half is a block there.
          if (kind[base + x] !== 1 || kind[b0 + x] === 2 || kind[b1 + x] === 2) {
            x++;
            continue;
          }
          const c = colour[base + x];
          let x2 = x + 1;
          while (x2 < cols
                 && kind[base + x2] === 1
                 && kind[b0 + x2] !== 2 && kind[b1 + x2] !== 2
                 && colour[base + x2] === c) x2++;

          // Merge both halves into one rect where the other row agrees along
          // the whole run, so flat areas like sky and open ground stay cheap.
          let h = ch;
          if (half === 0) {
            let same = true;
            for (let i = x; i < x2; i++) {
              if (kind[b1 + i] !== 1 || colour[b1 + i] !== c) { same = false; break; }
            }
            if (same) {
              h = lineH;
              for (let i = x; i < x2; i++) kind[b1 + i] = 3;   // already painted
            }
          }
          ctx.fillStyle = c;
          ctx.fillRect(x * cw, top, (x2 - x) * cw, h);
          x = x2;
        }
      }

      /* ---- text runs ---- */
      let run = '';
      let runCol = null;
      let runStart = 0;
      const flush = () => {
        if (run) {
          ctx.fillStyle = runCol;
          ctx.fillText(run, runStart * cw, yPix);
          run = '';
        }
      };
      for (let x = 0; x < cols; x++) {
        let g;
        let c;
        if (kind[b0 + x] === 2 && glyph[b0 + x] !== undefined) {
          g = glyph[b0 + x]; c = colour[b0 + x];
        } else if (kind[b1 + x] === 2 && glyph[b1 + x] !== undefined) {
          g = glyph[b1 + x]; c = colour[b1 + x];
        } else {
          flush();
          runCol = null;
          continue;
        }
        if (g === ' ') { flush(); runCol = null; continue; }
        if (run && c !== runCol) flush();
        if (!run) { runStart = x; runCol = c; }
        run += g;
      }
      flush();
    }
  }
}
