import { FOV, FOG_FULL } from '../config.js';
import { col2str } from '../screen.js';
import { fogOf } from './materials.js';
import { signalState } from '../traffic-signals.js';

/**
 * Traffic signals at intersections.
 *
 * Every place two or more named streets meet (world.junctions) gets a signal
 * head: a short vertical mast with three lamps — red, amber, green — drawn as
 * solid filled colour blocks (no glyphs), so they read as real lights rather
 * than letters. Exactly one lamp is lit at a time, cycling on a realistic
 * four-phase beat: green holds, amber warns, red holds, then straight back to
 * green. The amber phase is the transition in BOTH directions — it gives
 * traffic time to clear on green→red, and a brief all-stop before red→green —
 * which is how a real signal behaves. Each junction is offset so the city does
 * not blink in unison, and the head glows brighter after dark.
 *
 * The head is projected to the screen at a real world size and distance, so it
 * shrinks with distance like any other object, and it is depth-tested against
 * the scene buffer so a building in front of a junction hides it — the same
 * occlusion rule the streets and signs obey.
 */

const FAR = FOG_FULL * 0.7;
const NEAR = 3;

// Three lamps, top to bottom. Each is [r, g, b] when lit.
const LAMPS = [
  [255, 60, 48],    // red
  [255, 176, 40],   // amber
  [70, 220, 90],    // green
];

// A signal's phase at time `t` (seconds), given a per-junction offset.
// Returns 0=red, 1=amber, 2=green. The cycle is a realistic four-beat:
//   green  (long)  ->  amber (brief, "stop if you can")  ->
//   red    (long)  ->  amber (brief, all-stop clearance)  ->  green ...
// Amber therefore appears on both the green->red and red->green transitions.
const LAMP_INDEX = { red: 0, amber: 1, green: 2 };

export class TrafficLights {
  constructor() {
    this.on = true;
  }

  toggle() { this.on = !this.on; return this.on; }

  draw(screen, cam, world, L, simTime) {
    const junctions = world.roadGraph?.signalJunctions || [];
    if (!this.on || junctions.length === 0) return;

    const t = (simTime ?? Date.now()) / 1000;
    const fwdX = Math.cos(cam.angle);
    const fwdY = Math.sin(cam.angle);
    const { cols, rows, depth } = screen;

    // Night makes the lamps glow; by day they are still drawn but dimmer, like
    // real signals that read in sunlight too.
    const glow = 0.45 + 0.55 * (1 - L.dayAmt);

    for (let j = 0; j < junctions.length; j++) {
      const jn = junctions[j];
      for (const approach of jn.approaches) {
      // One head faces each incoming approach and sits just before the stop
      // line, instead of a single camera-facing light in the intersection.
      const hx = jn.x + approach.dx * 2.1 + approach.dy * 0.8;
      const hy = jn.y + approach.dy * 2.1 - approach.dx * 0.8;
      const dx = hx - cam.x;
      const dy = hy - cam.y;
      const along = dx * fwdX + dy * fwdY;
      if (along < NEAR || along > FAR) continue;
      const side = -dx * fwdY + dy * fwdX;
      const halfW = along * Math.tan(FOV / 2) * 1.04;
      if (side > halfW || side < -halfW) continue;
      const col = Math.round(screen.cols / 2 - (side / along) * cam.proj);
      const row = Math.round(cam.hz + cam.z * screen.vscale / along);
      if (row < 1 || row >= rows - 1) continue;
      if (col < 1 || col >= cols - 1) continue;

      // Occlusion: a building nearer than the junction hides the signal.
      const i = row * cols + col;
      if (depth[i] < along) continue;

      const f = Math.max(0.12, fogOf(along));
      const lit = LAMP_INDEX[signalState(t, approach.group, jn.id * 0.17)];

      // The head is a real object: a vertical housing ~0.7 cells wide and ~2.4
      // cells tall, projected to the screen at distance `along`. Up close it is
      // a few cells of solid colour; far away it collapses to a single lit
      // cell, which is correct perspective, not a bug.
      const HEAD_W = 0.7;           // world width of the housing, cells
      const HEAD_H = 2.4;           // world height of the housing, cells
      const HEAD_CZ = 3.6;          // world height of the head centre, cells
      const headW = Math.max(1, Math.round(HEAD_W * cam.proj / along));
      const headH = Math.max(1, Math.round(HEAD_H * cam.proj / along / screen.rowStep));
      const cx0 = col - (headW >> 1);
      const topRow = Math.round(cam.rowOf(HEAD_CZ + HEAD_H / 2, along));
      const botRow = topRow + headH - 1;

      // Three lamp centres, red on top, amber, green at the bottom, evenly
      // spaced down the housing.
      const lampRows = [];
      for (let k = 0; k < 3; k++) {
        const z = HEAD_CZ + HEAD_H / 2 - (k + 0.5) * (HEAD_H / 3);
        lampRows.push(Math.round(cam.rowOf(z, along)));
      }

      const housing = L.depth(70, 74, 84, f);
      // A solid filled cell: a space glyph still inks the whole cell in block
      // mode, and in glyph mode a space over a dark colour reads as a solid
      // block too. We use ' ' so no letter ever appears.
      const put = (cx, cy, c) => {
        if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) return;
        if (depth[cy * cols + cx] < along) return;
        screen.setDepth(cx, cy, ' ', c, along);
      };

      // Housing: a solid dark box behind the lamps.
      for (let cy = topRow; cy <= botRow; cy++) {
        for (let cx = cx0; cx < cx0 + headW; cx++) put(cx, cy, housing);
      }

      // The lamps: the lit one is a bright solid block, the others are dim
      // embers of their hue. Each lamp fills its slice of the housing.
      for (let k = 0; k < 3; k++) {
        const isLit = k === lit;
        const lr = isLit ? LAMPS[k][0] : LAMPS[k][0] * 0.10 + 14;
        const lg = isLit ? LAMPS[k][1] : LAMPS[k][1] * 0.10 + 14;
        const lb = isLit ? LAMPS[k][2] : LAMPS[k][2] * 0.10 + 16;
        const scale = isLit ? glow : 1;
        const c = col2str(
          Math.min(255, lr * scale), Math.min(255, lg * scale), Math.min(255, lb * scale));
        // The lamp occupies the central band of its row slice.
        const band = Math.max(1, Math.floor(headW * 0.7));
        const bx0 = col - (band >> 1);
        for (let cx = bx0; cx < bx0 + band; cx++) put(cx, lampRows[k], c);
      }

      // Mast: a post dropping from the head down to the road.
      for (let cy = botRow + 1; cy <= row; cy++) put(col, cy, housing);
      }
    }
  }
}
