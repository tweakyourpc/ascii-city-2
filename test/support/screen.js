/**
 * A real `Screen`, backed by a stub canvas.
 *
 * The rendering tests used to hand-roll a fake screen each. That meant a
 * rewrite of `src/screen.js` could pass the entire suite without a single test
 * touching the rewritten class, which is exactly what happened when half-block
 * rendering landed. Everything now drives the real thing, so the grid
 * contract, the two coordinate systems and the blitter are all covered.
 */
import { Screen, MODE } from '../../src/screen.js';

export { MODE };

/**
 * Records what was painted, so blitting can be asserted on.
 *
 * Every recorded call carries a monotonic `order`, because compositing is
 * layered: the cinematic blitter is only correct if the vector building pass
 * lands on top of the base world and underneath the live glyph overlays.
 * Counting the calls cannot tell those three orderings apart.
 */
export function stubCanvas() {
  const calls = {
    fillRect: 0, fillText: 0, fillPath: 0, stroke: 0,
    rects: [], texts: [], paths: [],
    order: 0,
  };
  let path = [];
  const ctx = {
    font: '',
    textBaseline: 'top',
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineJoin: 'miter',
    measureText: (s) => ({ width: s.length * 8 }),
    fillRect(x, y, w, h) {
      calls.fillRect++;
      calls.rects.push([x, y, w, h, this.fillStyle, calls.order++]);
    },
    fillText(t, x, y) {
      calls.fillText++;
      calls.texts.push([t, x, y, this.fillStyle, calls.order++]);
    },
    beginPath() { path = []; },
    moveTo(x, y) { path.push(['M', x, y]); },
    lineTo(x, y) { path.push(['L', x, y]); },
    closePath() { path.push(['Z']); },
    fill() { calls.fillPath++; calls.paths.push([[...path], calls.order++]); },
    stroke() { calls.stroke++; calls.order++; },
    save() {},
    restore() {},
    createLinearGradient: () => ({ addColorStop() {} }),
  };
  return { canvas: { width: 0, height: 0, getContext: () => ctx }, ctx, calls };
}

/**
 * Build a real Screen sized to give approximately `cols` x `outRows`.
 * The window stub is installed globally, because Screen reads it on resize.
 */
export function makeScreen(cols = 90, outRows = 40, mode = MODE.GLYPH) {
  const cw = 8;
  const lineH = 15 + (mode === MODE.BLOCK ? 1 : 0);   // block mode rounds up to even
  const prev = globalThis.window;
  globalThis.window = {
    innerWidth: cols * cw,
    innerHeight: outRows * lineH,
    addEventListener() {},
    removeEventListener() {},
  };
  const win = globalThis.window;
  const { canvas, ctx, calls } = stubCanvas();
  const screen = new Screen(canvas, mode);
  globalThis.window = prev;

  // Screen reads window on every resize, including a mode switch, so the stub
  // has to be available then too rather than only at construction.
  const resize = screen.resize.bind(screen);
  screen.resize = () => {
    const outer = globalThis.window;
    globalThis.window = win;
    try { resize(); } finally { globalThis.window = outer; }
  };

  screen._calls = calls;
  screen._ctx = ctx;
  return screen;
}

/** The grid as lines of text, for assertions that read like the output. */
export function asText(screen) {
  const out = [];
  for (let y = 0; y < screen.rows; y++) {
    let line = '';
    for (let x = 0; x < screen.cols; x++) {
      const g = screen.glyph[y * screen.cols + x];
      line += g === undefined ? ' ' : g;
    }
    out.push(line);
  }
  return out;
}

/** Glyphs down one column, top to bottom. */
export function columnGlyphs(screen, col) {
  const out = [];
  for (let y = 0; y < screen.rows; y++) out.push(screen.glyph[y * screen.cols + col]);
  return out;
}
