import { T, wrap } from './world/source.js';
import { normAngle } from './camera.js';
import { BLOCK, FOV, MAXD, MAX_CARS, MAX_PEDS, AGENT_CULL_D2 } from './config.js';
import { fogOf } from './render/materials.js';
import { col2str } from './screen.js';
import { positionOnEdge } from './world/roadgraph.js';
import { signalGroupForIncoming, signalState } from './traffic-signals.js';

/**
 * Sprites at three detail levels, chosen by on-screen height.
 *
 * A single three-row template stretched over twelve screen rows repeats each
 * row four times, which is where the blockiness came from. Nearest-neighbour
 * sampling is fine; it just needs source art at roughly the right resolution.
 */
const CAR_LOD = [
  [ // far: 3 rows
    ' .------. ',
    ' |##||##| ',
    '-[o]--[o]-',
  ],
  [ // mid: 6 rows
    '   .------.   ',
    '  /  ||  \\  ',
    ' /___||___\\ ',
    '|##  ||  ##|',
    '|___________|',
    ' (o)-----(o) ',
  ],
  [ // near: 11 rows
    '     .--------.     ',
    '    /  ______  \\   ',
    '   /  /      \\  \\ ',
    '  /  /________\\  \\',
    ' /__/          \\__\\',
    '|## |          | ##|',
    '|   |          |   |',
    '|___|__________|___|',
    '|__________________|',
    ' \\(o)/      \\(o)/ ',
    '  `--`        `--`  ',
  ],
];

/**
 * Seen head-on or from behind a car is much narrower. Without this a car
 * driving toward you looks like one driving across you.
 */
const CAR_END_LOD = [
  [
    ' .--. ',
    ' |##| ',
    '-o--o-',
  ],
  [
    '  .--.  ',
    ' /____\\ ',
    '|# ## #|',
    '|______|',
    ' o    o ',
    ' `----` ',
  ],
  [
    '   .----.   ',
    '  /______\\ ',
    ' /  ____  \\',
    '|  /    \\  |',
    '| |      | |',
    '|_|______|_|',
    '|##      ##|',
    '|__________|',
    ' (o)    (o) ',
    '  \\      /  ',
    '  `------`  ',
  ],
];

/** Pedestrians, with arms. Two phases so a walk cycle is possible. */
const PED_LOD = [
  [
    [' o ', '/|\\', '/ \\'],
    [' o ', '\\|/', '| |'],
  ],
  [
    ['  o  ', ' /|\\ ', '  |  ', ' / \\ ', '/   \\'],
    ['  o  ', ' \\|/ ', '  |  ', ' | | ', ' | | '],
  ],
  [
    ['   o   ', '  ___  ', ' / | \\ ', '/  |  \\', '   |   ', '  / \\  ', ' /   \\ ', '/     \\'],
    ['   o   ', '  ___  ', ' \\ | / ', '  \\|/  ', '   |   ', '  | |  ', '  | |  ', ' /   \\ '],
  ],
];

/**
 * Pick a detail level from how many TEXT LINES the sprite covers. Internal
 * rows are twice as fine in block mode, so the span is divided by rowStep or
 * every sprite jumps to the highest detail level when the mode changes.
 */
function lodFor(rows, rowStep) {
  const lines = rows / rowStep;
  return lines >= 14 ? 2 : lines >= 6 ? 1 : 0;
}

/**
 * Cars and pedestrians routing the street grid.
 *
 * Only meaningful on a world that has a block-aligned road grid; worlds without
 * one report `hasStreets = false` and traffic is skipped.
 */
export const TRAFFIC = { OFF: 0, CARS: 1, ALL: 2 };

export class Traffic {
  constructor(world) {
    this.world = world;
    this.agents = [];
    // Cars give a sense of scale that empty roads lack. Pedestrians at this
    // resolution mostly read as noise, so they are opt-in.
    this.mode = TRAFFIC.CARS;
  }

  cycle() {
    this.mode = (this.mode + 1) % 3;
    if (this.mode === TRAFFIC.OFF) this.agents.length = 0;
    if (this.mode === TRAFFIC.CARS) {
      for (let i = this.agents.length - 1; i >= 0; i--) {
        if (this.agents[i].kind === 'ped') this.agents.splice(i, 1);
      }
    }
    return this.mode;
  }

  setWorld(world) {
    this.world = world;
    this.agents.length = 0;
  }

  /**
   * OSM streets are not on a 14-cell block grid, so the lane maths below has
   * nothing to align to. Put the agent on a known road cell near the camera
   * instead, and let the off-road reversal in update() keep it on the street.
   */
  _spawnOsm(kind, cam) {
    const world = this.world;
    if (kind === 'car' && world.roadGraph?.edges.length) {
      const graph = world.roadGraph;
      for (let attempt = 0; attempt < 30; attempt++) {
        const edge = graph.edges[(Math.random() * graph.edges.length) | 0];
        if (edge.length < 1) continue;
        const distance = Math.random() * edge.length;
        const p = positionOnEdge(graph, edge, distance, 0.55);
        const d2 = (p.x - cam.x) ** 2 + (p.y - cam.y) ** 2;
        if (d2 < 256 || d2 > AGENT_CULL_D2 * 0.75) continue;
        this.agents.push({
          kind, edgeId: edge.id, distance, x: p.x, y: p.y,
          hx: edge.dx, hy: edge.dy, spd: 2 + Math.random() * 2,
          targetSpd: 5 + Math.random() * 3, pal: (Math.random() * 4) | 0,
        });
        return true;
      }
      return false;
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      const p = world.randomRoadCell();
      if (!p) return false;
      const dx = p.x - cam.x;
      const dy = p.y - cam.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 256 || d2 > AGENT_CULL_D2 * 0.75) continue;

      const t = world.type[world.sample(p.x, p.y)];
      if (kind === 'car' ? t !== T.ROAD : t !== T.SIDEWALK) continue;

      this.agents.push({
        kind,
        axis: Math.random() < 0.5 ? 'x' : 'y',
        dir: Math.random() < 0.5 ? 1 : -1,
        side: Math.random() < 0.5,
        x: p.x, y: p.y, inX: false,
        spd: kind === 'car' ? 3 + Math.random() * 5 : 0.9 + Math.random() * 0.7,
        pal: (Math.random() * 4) | 0,
      });
      return true;
    }
    return false;
  }

  _spawn(kind, cam) {
    const world = this.world;
    if (world.randomRoadCell) return this._spawnOsm(kind, cam);

    const ang = Math.random() * Math.PI * 2;
    const rad = 16 + Math.random() * 58;
    const sx = cam.x + Math.cos(ang) * rad;
    const sy = cam.y + Math.sin(ang) * rad;
    const bx = Math.floor(sx / BLOCK) * BLOCK;
    const by = Math.floor(sy / BLOCK) * BLOCK;

    const a = {
      kind,
      axis: Math.random() < 0.5 ? 'x' : 'y',
      dir: Math.random() < 0.5 ? 1 : -1,
      side: Math.random() < 0.5,
      x: sx, y: sy, inX: false,
      spd: kind === 'car' ? 3 + Math.random() * 5 : 0.9 + Math.random() * 0.7,
      pal: (Math.random() * 4) | 0,
    };

    if (kind === 'car') {
      if (a.axis === 'y') a.x = bx + (a.dir > 0 ? 0.6 : 2.4);
      else a.y = by + (a.dir > 0 ? 0.6 : 2.4);
    } else if (a.axis === 'y') {
      a.x = bx + (a.side ? 3.5 : 13.5);
    } else {
      a.y = by + (a.side ? 3.5 : 13.5);
    }

    const t = world.type[world.sample(a.x, a.y)];
    if (kind === 'car' ? t !== T.ROAD : t !== T.SIDEWALK) return false;
    this.agents.push(a);
    return true;
  }

  update(dt, cam) {
    const world = this.world;
    if (this.mode === TRAFFIC.OFF || world.hasStreets === false) {
      this.agents.length = 0;
      return;
    }
    const agents = this.agents;

    for (let i = agents.length - 1; i >= 0; i--) {
      const a = agents[i];
      const dx = a.x - cam.x;
      const dy = a.y - cam.y;
      if (dx * dx + dy * dy > AGENT_CULL_D2) { agents.splice(i, 1); continue; }

      if (a.kind === 'car' && a.edgeId !== undefined && world.roadGraph) {
        this._updateGraphCar(a, dt, agents);
        continue;
      }

      if (a.axis === 'x') a.x += a.dir * a.spd * dt;
      else a.y += a.dir * a.spd * dt;

      const mx = wrap(a.x, BLOCK);
      const my = wrap(a.y, BLOCK);
      const atCross = mx < 3 && my < 3;

      if (atCross && !a.inX) {
        a.inX = true;
        if (Math.random() < (a.kind === 'car' ? 0.35 : 0.5)) {
          a.axis = a.axis === 'x' ? 'y' : 'x';
          a.dir = Math.random() < 0.5 ? 1 : -1;
          const bx = Math.floor(a.x / BLOCK) * BLOCK;
          const by = Math.floor(a.y / BLOCK) * BLOCK;
          if (a.kind === 'car') {
            if (a.axis === 'y') a.x = bx + (a.dir > 0 ? 0.6 : 2.4);
            else a.y = by + (a.dir > 0 ? 0.6 : 2.4);
          }
        }
      } else if (!atCross) {
        a.inX = false;
      }

      // Keep agents on their own surface. Pedestrians always did this; cars
      // need it too on OSM streets, which have no lane grid to follow.
      const surface = world.type[world.sample(a.x, a.y)];
      const wanted = a.kind === 'car' ? T.ROAD : T.SIDEWALK;
      if (surface !== wanted) {
        a.dir = -a.dir;
        // Step back onto the road immediately, or it oscillates on the kerb.
        if (a.axis === 'x') a.x += a.dir * a.spd * dt;
        else a.y += a.dir * a.spd * dt;
      }
    }

    let cars = 0;
    let peds = 0;
    for (let i = 0; i < agents.length; i++) {
      if (agents[i].kind === 'car') cars++; else peds++;
    }
    for (let i = 0; i < 3; i++) if (cars < MAX_CARS && this._spawn('car', cam)) cars++;
    if (this.mode === TRAFFIC.ALL) {
      for (let i = 0; i < 3; i++) if (peds < MAX_PEDS && this._spawn('ped', cam)) peds++;
    }
  }

  _updateGraphCar(a, dt, agents) {
    const graph = this.world.roadGraph;
    let edge = graph.edges[a.edgeId];
    if (!edge) return;
    const remaining = edge.length - a.distance;
    let desired = a.targetSpd;

    const node = graph.nodes[edge.to];
    if (node.signal && remaining < 8) {
      const group = signalGroupForIncoming(graph, node, edge);
      const state = signalState(Date.now() / 1000, group, node.id * 0.17);
      if (state !== 'green') desired = Math.min(desired, Math.max(0, (remaining - 1.2) * 1.4));
    }

    // Simple same-lane headway. It removes overlaps without coupling cars to
    // raster cells, so their motion remains continuous on diagonal streets.
    let gap = Infinity;
    for (const other of agents) {
      if (other === a || other.kind !== 'car' || other.edgeId !== a.edgeId) continue;
      const ahead = other.distance - a.distance;
      if (ahead > 0 && ahead < gap) gap = ahead;
    }
    if (gap < 5) desired = Math.min(desired, Math.max(0, (gap - 2) * 1.5));

    const rate = desired < a.spd ? 7 : 2.2;
    a.spd += Math.max(-rate * dt, Math.min(rate * dt, desired - a.spd));
    a.distance += a.spd * dt;

    while (a.distance >= edge.length && edge.length > 0) {
      const overflow = a.distance - edge.length;
      const outgoing = graph.nodes[edge.to].outgoing
        .filter((id) => id !== edge.reverseId);
      const choices = outgoing.length ? outgoing : graph.nodes[edge.to].outgoing;
      if (!choices.length) {
        a.distance = Math.max(0, edge.length - 0.1);
        a.spd = 0;
        break;
      }
      a.edgeId = choices[(Math.random() * choices.length) | 0];
      edge = graph.edges[a.edgeId];
      a.distance = Math.min(overflow, Math.max(0, edge.length - 0.001));
    }
    const p = positionOnEdge(graph, edge, a.distance, 0.55);
    a.x = p.x; a.y = p.y; a.hx = edge.dx; a.hy = edge.dy;
  }

  /**
   * Draw sprites, back to front, depth-tested per cell against the scene depth
   * buffer. The original tested one distance per column, which cannot handle a
   * rooftop seen from above partially hiding the street behind it.
   */
  draw(screen, cam, L) {
    const agents = this.agents;
    if (agents.length === 0) return;

    const vis = [];
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      const rx = a.x - cam.x;
      const ry = a.y - cam.y;
      const d = Math.sqrt(rx * rx + ry * ry);
      if (d < 0.5 || d > MAXD) continue;
      const da = normAngle(Math.atan2(ry, rx) - cam.angle);
      if (Math.abs(da) > FOV * 0.72) continue;
      vis.push({ a, d, ang: da });
    }
    vis.sort((p, q) => q.d - p.d);

    const { cols, rows, depth } = screen;

    for (let i = 0; i < vis.length; i++) {
      const { a, d, ang } = vis[i];
      const dp = d * Math.cos(ang);
      if (dp < 0.3) continue;

      const wWorldSide = a.kind === 'car' ? 2.4 : 0.85;
      const hWorld = a.kind === 'car' ? 1.5 : 1.8;

      const baseR = cam.rowOf(0, dp);
      const topR = cam.rowOf(hWorld, dp);
      const y0 = Math.floor(topR);
      const y1 = Math.max(y0 + 1, Math.ceil(baseR));
      const span = Math.max(0.001, baseR - topR);
      const lod = lodFor(span, screen.rowStep || 1);

      // Which face of the car is toward us: its heading against the view ray.
      let tpl;
      let wWorld = wWorldSide;
      if (a.kind === 'car') {
        const hx = a.hx ?? (a.axis === 'x' ? a.dir : 0);
        const hy = a.hy ?? (a.axis === 'y' ? a.dir : 0);
        const vx = a.x - cam.x;
        const vy = a.y - cam.y;
        const vlen = Math.hypot(vx, vy) || 1;
        const facing = Math.abs((hx * vx + hy * vy) / vlen);
        const endOn = facing > 0.7;
        tpl = endOn ? CAR_END_LOD[lod] : CAR_LOD[lod];
        if (endOn) wWorld = 1.6;
      } else {
        // Two-frame walk cycle, phased by distance travelled.
        const phase = ((a.axis === 'x' ? a.x : a.y) * 1.6 | 0) & 1;
        tpl = PED_LOD[lod][phase];
      }

      const cx = cols / 2 - Math.tan(ang) * cam.proj;
      const wcols = Math.max(1, wWorld * cam.proj / dp);
      const x0 = cx - wcols / 2;
      const f = Math.max(0.12, fogOf(dp));

      const toward = ((a.hx ?? (a.axis === 'x' ? a.dir : 0)) * (a.x - cam.x) +
        (a.hy ?? (a.axis === 'y' ? a.dir : 0)) * (a.y - cam.y)) < 0;
      const lampCol = toward ? col2str(255, 250, 220) : col2str(255, 70, 50);
      const bodyCol = L.depth(64 + a.pal * 18, 68, 82, f);
      const pedCol = L.depth(150 * L.amb + 46, 152 * L.amb + 44, 168 * L.amb + 50, f);

      const yA = Math.max(0, y0);
      const yB = Math.min(rows, y1);
      const xA = Math.max(0, Math.floor(x0));
      const xB = Math.min(cols, Math.ceil(x0 + wcols));

      for (let y = yA; y < yB; y++) {
        let tr = Math.floor((y + 0.5 - topR) / span * tpl.length);
        if (tr < 0) tr = 0;
        if (tr >= tpl.length) tr = tpl.length - 1;
        const row = tpl[tr];

        for (let x = xA; x < xB; x++) {
          if (dp >= depth[y * cols + x]) continue;
          let tc = Math.floor((x + 0.5 - x0) / wcols * row.length);
          if (tc < 0) tc = 0;
          if (tc >= row.length) tc = row.length - 1;
          const g = row[tc];
          if (g === ' ') continue;
          // setDepth, not set: labels are drawn after sprites and depth-test
          // against the buffer, so a car in front of a street name has to
          // record that it is there.
          screen.setDepth(x, y, g,
            a.kind === 'car' ? (g === 'o' ? lampCol : bodyCol) : pedCol, dp);
        }
      }
    }
  }
}
