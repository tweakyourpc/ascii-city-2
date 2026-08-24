import { FOV, FOG_FULL } from '../config.js';
import { col2str } from '../screen.js';
import { fogOf } from './materials.js';
import { signalState } from '../traffic-signals.js';
import { cameraEnvelope } from '../spatial.js';

/**
 * Traffic signals at intersections.
 *
 * Every place two or more named streets meet (world.junctions) gets one signal
 * head per approach, mounted on the near-right corner of the crossing so the
 * four heads sit at the four corners instead of piling up in the middle. Each
 * head is a narrow 2-wide column of three lamps — red, amber, green — drawn
 * with the full-block glyph `█` so they read as solid lights in every render
 * mode (glyph mode paints the character; block/cinematic modes paint the cell
 * as a solid block). Exactly one lamp is lit at a time, cycling on a realistic
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
    // Disabled by default: the mast-mounted signal heads read poorly at the
    // engine's scale and resolution (clustered, flickering, wrong proportions).
    // The signal *timing* still drives traffic (see traffic-signals.js); the
    // rendered heads are suppressed until a cleaner representation lands.
    this.on = false;
  }

  toggle() { this.on = !this.on; return this.on; }

  draw(screen, cam, world, L, simTime, env) {
    const all = world.roadGraph?.signalJunctions || [];
    if (!this.on || all.length === 0) return;

    // Coarse envelope prefilter: only junctions near the camera are candidates.
    // The exact along/side/depth checks below remain the real filter.
    const envelope = env || cameraEnvelope(cam, FAR);
    const junctions = world.spatial?.signals.query(envelope) || all;

    const t = (simTime ?? Date.now()) / 1000;
    const fwdX = Math.cos(cam.angle);
    const fwdY = Math.sin(cam.angle);
    const { cols, rows, depth } = screen;

    // The head is a real object floating above the road. These sizes are used
    // both for the occlusion test (at the head's own row) and for drawing.
    const HEAD_W = 1.0;           // world width of the housing, cells
    const HEAD_H = 3.4;           // world height of the housing, cells
    const HEAD_CZ = 4.8;          // world height of the head centre, cells

    // Night makes the lamps glow; by day they are still drawn but dimmer, like
    // real signals that read in sunlight too.
    const glow = 0.45 + 0.55 * (1 - L.dayAmt);

    for (let j = 0; j < junctions.length; j++) {
      const jn = junctions[j];
      for (const approach of jn.approaches) {
      // One head per approach, mounted on the near-right corner of the crossing
      // (offset along the approach and to its right) so the four heads of a
      // four-way sit at the four corners instead of piling up in the middle.
      const px = -approach.dy, py = approach.dx;   // right-hand axis
      const hx = jn.x + approach.dx * 2.6 + px * 1.6;
      const hy = jn.y + approach.dy * 2.6 + py * 1.6;
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

      // The head floats at HEAD_CZ above the road, so its screen row is well
      // above the base `row`. Test occlusion at the head's own row: a building
      // nearer than the junction at that height hides the signal. Testing at the
      // base row (the ground) would always fail, because the ground is nearer
      // than the elevated head and would hide every signal.
      const headTop = Math.round(cam.rowOf(HEAD_CZ + HEAD_H / 2, along));
      if (headTop < 1 || headTop >= rows - 1) continue;
      if (depth[headTop * cols + col] < along) continue;

      const f = Math.max(0.12, fogOf(along));
      const lit = LAMP_INDEX[signalState(t, approach.group, jn.id * 0.17)];

      // The head is a narrow 2-wide column of three lamps. We draw it with the
      // full-block glyph `█` so it reads as a solid light in every render mode:
      // glyph mode paints the character, block/cinematic modes paint the cell as
      // a solid block. A 2-wide column keeps it from becoming a billboard.
      const headW = Math.max(1, Math.min(2, Math.round(HEAD_W * cam.proj / along)));
      const headH = Math.max(6, Math.round(HEAD_H * cam.proj / along / screen.rowStep));
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
      // A lamp cell: lit lamps are bright full blocks, unlit are dim embers.
      const put = (cx, cy, c) => {
        if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) return;
        if (depth[cy * cols + cx] < along) return;
        screen.setDepth(cx, cy, '█', c, along);
      };

      // Housing: a dark column behind the lamps (the mast + head shell).
      for (let cy = topRow; cy <= botRow; cy++) {
        for (let cx = cx0; cx < cx0 + headW; cx++) {
          if (depth[cy * cols + cx] < along) continue;
          screen.setDepth(cx, cy, '█', housing, along);
        }
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
        for (let cx = cx0; cx < cx0 + headW; cx++) put(cx, lampRows[k], c);
      }

      // Mast: a thin post dropping from the head down to the road.
      const mx0 = col - (headW >> 1);
      for (let cy = botRow + 1; cy <= row; cy++) {
        for (let cx = mx0; cx < mx0 + headW; cx++) {
          if (depth[cy * cols + cx] < along) continue;
          screen.setDepth(cx, cy, '|', housing, along);
        }
      }
      }
    }
  }
}
