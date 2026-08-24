import { FOV, FOG_FULL } from '../config.js';
import { col2str } from '../screen.js';
import { fogOf } from './materials.js';
import { cameraEnvelope } from '../spatial.js';

/**
 * Street signs at intersections.
 *
 * v2's StreetWorld already computes, for every place two or more named streets
 * meet, the set of street names that cross there (`world.junctions`). A real
 * street sign shows exactly that, so this module draws a small signpost at each
 * junction: a board on a post, naming the cross streets, placed where a sign
 * would actually stand (offset from the centreline, at the corner).
 *
 * Signs are depth-tested against the line layer and capped to the nearest few,
 * with hysteresis so they do not flicker as you walk. Toggle with `S`.
 */

const FAR = FOG_FULL * 0.7;
const NEAR = 4;
const SIGN_CAP = 6;

const ABBREV = [
  [/\bSTREET\b/g, 'ST'], [/\bAVENUE\b/g, 'AVE'], [/\bBOULEVARD\b/g, 'BLVD'],
  [/\bROAD\b/g, 'RD'], [/\bDRIVE\b/g, 'DR'], [/\bLANE\b/g, 'LN'],
  [/\bPLACE\b/g, 'PL'], [/\bSQUARE\b/g, 'SQ'], [/\bCOURT\b/g, 'CT'],
  [/\bTERRACE\b/g, 'TER'], [/\bPARKWAY\b/g, 'PKWY'], [/\bHIGHWAY\b/g, 'HWY'],
  [/\bNORTH\b/g, 'N'], [/\bSOUTH\b/g, 'S'], [/\bEAST\b/g, 'E'], [/\bWEST\b/g, 'W'],
];

function short(name) {
  let s = String(name).toUpperCase();
  for (const [re, to] of ABBREV) s = s.replace(re, to);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length <= 16 ? s : s.slice(0, 15).replace(/[ .,-]+$/, '') + '.';
}

export class Signs {
  constructor() {
    this.on = true;
    this.frame = 0;
    this.prev = new Set();
    this.drawn = new Set();
  }

  toggle() { this.on = !this.on; return this.on; }

  draw(screen, cam, world, L, env) {
    this.drawn.clear();
    if (!this.on || !world.junctions || world.junctions.length === 0) return;

    this.frame++;
    const fwdX = Math.cos(cam.angle);
    const fwdY = Math.sin(cam.angle);

    const envelope = env || cameraEnvelope(cam, FAR);
    const junctions = world.spatial?.junctions.query(envelope) || world.junctions;
    const cands = [];
    for (let j = 0; j < junctions.length; j++) {
      const jn = junctions[j];
      if (!jn.approaches || jn.approaches.length < 2) continue;
      const toCamX = cam.x - jn.x;
      const toCamY = cam.y - jn.y;
      const toCamLen = Math.hypot(toCamX, toCamY) || 1;
      const current = jn.approaches.reduce((best, a) =>
        (a.dx * toCamX + a.dy * toCamY > best.dx * toCamX + best.dy * toCamY ? a : best));
      const cross = jn.approaches
        .filter((a) => a.nameId !== current.nameId && a.nameId >= 0)
        .sort((a, b) => Math.abs(a.dx * current.dx + a.dy * current.dy) -
          Math.abs(b.dx * current.dx + b.dy * current.dy))[0];
      if (!cross) continue;
      // The board is aligned with the street it names. Edge-on boards are not
      // readable, which prevents seeing the current street's sign ahead.
      const face = Math.abs(-cross.dx * fwdY + cross.dy * fwdX);
      if (face < 0.22) continue;
      const cornerX = jn.x + toCamX / toCamLen * 1.5 + cross.dx * 0.8;
      const cornerY = jn.y + toCamY / toCamLen * 1.5 + cross.dy * 0.8;
      const dx = cornerX - cam.x;
      const dy = cornerY - cam.y;
      const along = dx * fwdX + dy * fwdY;
      if (along < NEAR || along > FAR) continue;
      const side = -dx * fwdY + dy * fwdX;
      const halfW = along * Math.tan(FOV / 2) * 1.04;
      if (side > halfW || side < -halfW) continue;
      const col = screen.cols / 2 - (side / along) * cam.proj;
      const row = cam.hz + cam.z * screen.vscale / along;
      if (row < 2 || row >= screen.rows - 2) continue;

      const names = [world.streetNames[cross.nameId]].filter(Boolean);
      if (names.length === 0) continue;

      // Score: nearer and more-named wins; hysteresis keeps a sign stable.
      const score = -along
        + 0.5 * names.length
        + (this.prev.has(j) ? 30 : 0);
      cands.push({ j: jn._spatialIndex ?? world.junctions.indexOf(jn), col, row, along, names, score });
    }

    cands.sort((a, b) => b.score - a.score);

    let placed = 0;
    for (let k = 0; k < cands.length && placed < SIGN_CAP; k++) {
      if (this._place(screen, cam, cands[k], L)) {
        this.drawn.add(cands[k].j);
        placed++;
      }
    }

    const swap = this.prev;
    this.prev = this.drawn;
    this.drawn = swap;
  }

  /**
   * A green cross-street sign for the road you are currently facing.
   *
   * Real intersections post a sign naming the street you are about to cross,
   * mounted on the near corner and turned to face oncoming traffic. This draws
   * exactly one such sign: the cross street at the nearest junction ahead on the
   * street the camera is facing. It is a solid green board with white lettering,
   * depth-tested like every other world object, and only appears when you are
   * actually approaching an intersection (not when you are past it or looking
   * away from it).
   */
  drawFacing(screen, cam, world, L, env) {
    if (!this.on || !world.junctions || world.junctions.length === 0) return;
    const fwdX = Math.cos(cam.angle);
    const fwdY = Math.sin(cam.angle);

    // Nearest junction ahead on the street we face.
    let best = null;
    let bestAlong = Infinity;
    const envelope = env || cameraEnvelope(cam, FAR);
    const junctions = world.spatial?.junctions.query(envelope) || world.junctions;
    for (let j = 0; j < junctions.length; j++) {
      const jn = junctions[j];
      if (!jn.approaches || jn.approaches.length < 2) continue;
      // The street we are facing is the approach whose direction best matches
      // the camera forward vector (we are travelling along it toward the node).
      const current = jn.approaches.reduce((b, a) =>
        (a.dx * fwdX + a.dy * fwdY > b.dx * fwdX + b.dy * fwdY ? a : b));
      // The cross street is the approach most perpendicular to the one we face.
      const cross = jn.approaches
        .filter((a) => a.nameId !== current.nameId && a.nameId >= 0)
        .sort((a, b) => Math.abs(a.dx * current.dx + a.dy * current.dy) -
          Math.abs(b.dx * current.dx + b.dy * current.dy))[0];
      if (!cross) continue;
      const dx = jn.x - cam.x;
      const dy = jn.y - cam.y;
      const along = dx * fwdX + dy * fwdY;
      if (along < NEAR || along > FAR) continue;
      if (along >= bestAlong) continue;
      best = { jn, cross, along };
      bestAlong = along;
    }
    if (!best) return;

    const { jn, cross, along } = best;
    const dx = jn.x - cam.x;
    const dy = jn.y - cam.y;
    const side = -dx * fwdY + dy * fwdX;
    const halfW = along * Math.tan(FOV / 2) * 1.04;
    if (side > halfW || side < -halfW) return;
    const col = screen.cols / 2 - (side / along) * cam.proj;
    const row = cam.hz + cam.z * screen.vscale / along;
    if (row < 2 || row >= screen.rows - 2) return;

    const name = world.streetNames[cross.nameId];
    if (!name) return;

    const put = (x, y, g, colour, d = along) => {
      if (x < 0 || x >= screen.cols || y < 0 || y >= screen.rows) return;
      const i = y * screen.cols + x;
      if (screen.depth && screen.depth[i] < d) return;
      screen.setDepth(x, y, g, colour, d);
    };

    const label = short(name);
    const w = label.length + 2;
    const boardH = 3;                 // top/bottom rule + one name line
    const postTop = Math.round(row) - boardH - 1;
    const postBot = Math.round(row);
    if (postTop < 1 || postBot >= screen.rows) return;

    const f = Math.max(0.12, fogOf(along));
    const board = col2str(18, 110, 46);          // green board
    const ink = col2str(238, 244, 248);          // white lettering
    const post = L.depth(150, 150, 160, f);

    const cx = Math.round(col);
    const left = cx - Math.floor(w / 2);

    // Post: a vertical line from the board down to the road.
    for (let y = postTop + boardH; y <= postBot; y++) put(cx, y, '|', post);

    // Board frame.
    put(left, postTop, '+', board);
    put(left + w - 1, postTop, '+', board);
    put(left, postTop + boardH - 1, '+', board);
    put(left + w - 1, postTop + boardH - 1, '+', board);
    for (let x = left + 1; x < left + w - 1; x++) {
      put(x, postTop, '-', board);
      put(x, postTop + boardH - 1, '-', board);
    }
    for (let y = postTop + 1; y < postTop + boardH - 1; y++) {
      put(left, y, '|', board);
      put(left + w - 1, y, '|', board);
    }

    // The cross-street name, centred, in white on green.
    const x0 = left + Math.floor((w - label.length) / 2);
    for (let ch = 0; ch < label.length; ch++) {
      put(x0 + ch, postTop + 1, label[ch], ink, along - 0.01);
    }
  }

  /**
   * Draw a signpost at a junction. The board sits a couple of rows above the
   * junction cell (where a real sign would hang), with the post dropping to the
   * road. Each cross street gets its own line on the board.
   */
  _place(screen, cam, c, L) {
    const put = screen.setDepth
      ? (x, y, g, colour, d = c.along) => {
          if (x < 0 || x >= screen.cols || y < 0 || y >= screen.rows) return;
          const i = y * screen.cols + x;
          // A sign is a world object, not UI. Never paint it over a nearer
          // facade, roof, or aircraft already recorded in the depth buffer.
          if (screen.depth && screen.depth[i] < d) return;
          screen.setDepth(x, y, g, colour, d);
        }
      : (x, y, g, colour) => screen.set(x, y, g, colour);
    const lines = c.names.map(short);
    const w = Math.max(...lines.map((s) => s.length)) + 2;
    const boardH = lines.length + 2;             // top/bottom rule + lines
    const postTop = Math.round(c.row) - boardH - 1;
    const postBot = Math.round(c.row);

    if (postTop < 1 || postBot >= screen.rows) return false;

    const f = Math.max(0.12, fogOf(c.along));
    const board = col2str(28, 34, 44);
    const ink = L.depth(220, 226, 235, f);
    const post = L.depth(150, 150, 160, f);

    const cx = Math.round(c.col);
    const left = cx - Math.floor(w / 2);

    // Post: a vertical line from the board down to the road.
    for (let y = postTop + boardH; y <= postBot; y++) {
      put(cx, y, '|', post);
    }

    // Board frame.
    put(left, postTop, '+', board);
    put(left + w - 1, postTop, '+', board);
    put(left, postTop + boardH - 1, '+', board);
    put(left + w - 1, postTop + boardH - 1, '+', board);
    for (let x = left + 1; x < left + w - 1; x++) {
      put(x, postTop, '-', board);
      put(x, postTop + boardH - 1, '-', board);
    }
    for (let y = postTop + 1; y < postTop + boardH - 1; y++) {
      put(left, y, '|', board);
      put(left + w - 1, y, '|', board);
    }

    // Names, one per line, centred in the board.
    for (let i = 0; i < lines.length; i++) {
      const s = lines[i];
      const x = left + Math.floor((w - s.length) / 2);
      for (let ch = 0; ch < s.length; ch++) {
        put(x + ch, postTop + 1 + i, s[ch], ink, c.along - 0.01);
      }
    }
    return true;
  }
}
