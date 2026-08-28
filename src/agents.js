import { T, wrap } from './world/source.js';
import { normAngle } from './camera.js';
import { BLOCK, FOV, MAXD, MAX_CARS, MAX_PEDS, AGENT_CULL_D2 } from './config.js';
import { fogOf } from './render/materials.js';
import { positionOnEdge } from './world/roadgraph.js';
import { buildEdgeIndex } from './spatial.js';
import { signalGroupForIncoming, signalState } from './traffic-signals.js';
import {
  drawVehicle, MAX_RICH_VEHICLES, smoothVehicleHeading, vehicleProfile,
  VEHICLE_LOD,
} from './render/vehicles.js';

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

/** Cars route the directed OSM/procedural graph; pedestrians use surface cells. */
export const TRAFFIC = { OFF: 0, CARS: 1, ALL: 2 };

const ROAD_WIDTH_CELLS = {
  motorway: 8.44, trunk: 7.59, primary: 6.75, secondary: 5.48,
  tertiary: 4.64, residential: 3.80, unclassified: 3.80,
  living_street: 3.38, service: 2.11,
};

/** Centre one lane in each directed half of the mapped carriageway. */
export function laneOffsetForEdge(edge) {
  const width = Number.isFinite(edge?.width)
    ? edge.width : (ROAD_WIDTH_CELLS[edge?.cls] ?? 3.38);
  if (edge?.reverseId < 0 && Number(edge?.tags?.lanes || 1) <= 1) return 0;
  return Math.max(0.48, Math.min(1.75, width * 0.25));
}

export class Traffic {
  constructor(world, { seed = 0x41534349 } = {}) {
    this.world = world;
    this.agents = [];
    this.seed = seed >>> 0;
    this._seedState = this.seed;
    this._routeState = this.seed ^ 0x9e3779b9;
    this.maxCars = MAX_CARS;
    this.detailMode = 'auto';
    this.renderStats = { simulated: 0, visible: 0, cells: 0, near: 0, mid: 0, far: 0 };
    // Cars give a sense of scale that empty roads lack. Pedestrians at this
    // resolution mostly read as noise, so they are opt-in.
    this.mode = TRAFFIC.CARS;
  }

  _nextVehicleSeed() {
    this._seedState = (Math.imul(this._seedState, 1664525) + 1013904223) >>> 0;
    return this._seedState;
  }

  _random() {
    this._routeState = (Math.imul(this._routeState, 1664525) + 1013904223) >>> 0;
    return this._routeState / 0x100000000;
  }

  /** Developer control: repeat a traffic run without adding normal UI. */
  setSeed(seed, { respawn = true } = {}) {
    if (!Number.isFinite(Number(seed))) return this.seed;
    this.seed = Number(seed) >>> 0;
    this._seedState = this.seed;
    this._routeState = this.seed ^ 0x9e3779b9;
    if (respawn) this.agents.length = 0;
    return this.seed;
  }

  /** Developer control: 0.25..2.3 times the normal 26-car cap. */
  setDensity(scale = 1) {
    const value = Math.max(0.25, Math.min(2.3, Number(scale) || 1));
    this.maxCars = Math.max(1, Math.min(60, Math.round(MAX_CARS * value)));
    let cars = 0;
    for (const agent of this.agents) if (agent.kind === 'car') cars++;
    for (let i = this.agents.length - 1; i >= 0 && cars > this.maxCars; i--) {
      if (this.agents[i].kind !== 'car') continue;
      this.agents.splice(i, 1);
      cars--;
    }
    return this.maxCars;
  }

  /** Developer control: force auto/near/mid/far to inspect LOD transitions. */
  setDetailMode(mode = 'auto') {
    if (!['auto', 'near', 'mid', 'far'].includes(mode)) return this.detailMode;
    this.detailMode = mode;
    return this.detailMode;
  }

  _prepareCar(car) {
    if (car.kind !== 'car') return car;
    if (!car.vehicleSeed) car.vehicleSeed = this._nextVehicleSeed();
    if (!car.vehicle) car.vehicle = vehicleProfile(car.vehicleSeed);
    return car;
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
    this._seedState = this.seed;
    this._routeState = this.seed ^ 0x9e3779b9;
  }

  /**
   * Rebind traffic to a rebuilt geographic world without making every moving
   * car disappear. Directed edge keys are stable across OSM reprojection, so
   * progress can be restored as a fraction of the replacement edge length.
   */
  rebindWorld(world, { preserve = true } = {}) {
    const previous = this.world?.roadGraph;
    if (!preserve || !previous || !world?.roadGraph) {
      this.setWorld(world);
      return;
    }
    const saved = [];
    for (const agent of this.agents) {
      if (agent.kind !== 'car' || agent.edgeId === undefined) continue;
      const edge = previous.edges[agent.edgeId];
      if (!edge?.key) continue;
      saved.push({
        agent,
        key: edge.key,
        fraction: edge.length > 0 ? agent.distance / edge.length : 0,
      });
    }
    this.world = world;
    const byKey = new Map(world.roadGraph.edges.map((edge) => [edge.key, edge]));
    this.agents = saved.flatMap(({ agent, key, fraction }) => {
      const edge = byKey.get(key);
      if (!edge) return [];
      agent.edgeId = edge.id;
      agent.distance = Math.max(0, Math.min(edge.length, fraction * edge.length));
      const p = positionOnEdge(world.roadGraph, edge, agent.distance,
        laneOffsetForEdge(edge));
      agent.x = p.x;
      agent.y = p.y;
      agent.renderX = p.x;
      agent.renderY = p.y;
      agent.hx = edge.dx;
      agent.hy = edge.dy;
      return [agent];
    });
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
      // Build (once) a spatial index of edges so spawning picks a nearby edge
      // instead of scanning the whole graph. Cached on the world; rebuilt only
      // if the graph identity changes (e.g. after a streamed merge).
      if (!world._edgeIndex || world._edgeIndexGraph !== graph) {
        world._edgeIndex = buildEdgeIndex(graph);
        world._edgeIndexGraph = graph;
      }
      const envelope = {
        minX: cam.x - 90, maxX: cam.x + 90,
        minY: cam.y - 90, maxY: cam.y + 90,
      };
      const candidates = world._edgeIndex?.query(envelope);
      const pool = candidates && candidates.length ? candidates : graph.edges;
      for (let attempt = 0; attempt < 30; attempt++) {
        const edge = pool[(this._random() * pool.length) | 0];
        if (edge.length < 1) continue;
        const distance = this._random() * edge.length;
        const p = positionOnEdge(graph, edge, distance, laneOffsetForEdge(edge));
        const d2 = (p.x - cam.x) ** 2 + (p.y - cam.y) ** 2;
        if (d2 < 256 || d2 > AGENT_CULL_D2 * 0.75) continue;
        const car = this._prepareCar({
          kind, edgeId: edge.id, distance, x: p.x, y: p.y,
          renderX: p.x, renderY: p.y,
          hx: edge.dx, hy: edge.dy, spd: 2 + this._random() * 2,
          targetSpd: 5 + this._random() * 3, pal: (this._random() * 4) | 0,
        });
        this.agents.push(car);
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
        axis: this._random() < 0.5 ? 'x' : 'y',
        dir: this._random() < 0.5 ? 1 : -1,
        side: this._random() < 0.5,
        x: p.x, y: p.y, inX: false,
        spd: kind === 'car' ? 3 + this._random() * 5 : 0.9 + this._random() * 0.7,
        pal: (this._random() * 4) | 0,
      });
      return true;
    }
    return false;
  }

  _spawn(kind, cam) {
    const world = this.world;
    if (world.randomRoadCell) return this._spawnOsm(kind, cam);

    const ang = this._random() * Math.PI * 2;
    const rad = 16 + this._random() * 58;
    const sx = cam.x + Math.cos(ang) * rad;
    const sy = cam.y + Math.sin(ang) * rad;
    const bx = Math.floor(sx / BLOCK) * BLOCK;
    const by = Math.floor(sy / BLOCK) * BLOCK;

    const a = {
      kind,
      axis: this._random() < 0.5 ? 'x' : 'y',
      dir: this._random() < 0.5 ? 1 : -1,
      side: this._random() < 0.5,
      x: sx, y: sy, inX: false,
      spd: kind === 'car' ? 3 + this._random() * 5 : 0.9 + this._random() * 0.7,
      pal: (this._random() * 4) | 0,
    };

    if (kind === 'car') {
      if (a.axis === 'y') a.x = bx + (a.dir > 0 ? 0.6 : 2.4);
      else a.y = by + (a.dir > 0 ? 0.6 : 2.4);
      a.hx = a.axis === 'x' ? a.dir : 0;
      a.hy = a.axis === 'y' ? a.dir : 0;
      this._prepareCar(a);
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
        this._prepareCar(a);
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
        if (this._random() < (a.kind === 'car' ? 0.35 : 0.5)) {
          a.axis = a.axis === 'x' ? 'y' : 'x';
          a.dir = this._random() < 0.5 ? 1 : -1;
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

      if (a.kind === 'car') {
        this._prepareCar(a);
        smoothVehicleHeading(a, a.axis === 'x' ? a.dir : 0,
          a.axis === 'y' ? a.dir : 0, dt);
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
    for (let i = 0; i < 3; i++) if (cars < this.maxCars && this._spawn('car', cam)) cars++;
    if (this.mode === TRAFFIC.ALL) {
      for (let i = 0; i < 3; i++) if (peds < MAX_PEDS && this._spawn('ped', cam)) peds++;
    }
  }

  _updateGraphCar(a, dt, agents) {
    this._prepareCar(a);
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
    if (gap < 6) {
      let leadLength = a.vehicle.length;
      for (const other of agents) {
        if (other === a || other.kind !== 'car' || other.edgeId !== a.edgeId) continue;
        if (other.distance > a.distance && Math.abs(other.distance - a.distance - gap) < 0.001) {
          this._prepareCar(other);
          leadLength = other.vehicle.length;
          break;
        }
      }
      const clearance = (a.vehicle.length + leadLength) * 0.5 + 0.55;
      desired = Math.min(desired, Math.max(0, (gap - clearance) * 1.5));
    }

    a.braking = desired < a.targetSpd - 0.75 && desired < a.spd + 0.25;

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
      a.edgeId = choices[(this._random() * choices.length) | 0];
      edge = graph.edges[a.edgeId];
      a.distance = Math.min(overflow, Math.max(0, edge.length - 0.001));
    }
    const p = positionOnEdge(graph, edge, a.distance, laneOffsetForEdge(edge));
    a.x = p.x;
    a.y = p.y;
    if (!Number.isFinite(a.renderX) || !Number.isFinite(a.renderY)) {
      a.renderX = p.x;
      a.renderY = p.y;
    } else {
      const blend = 1 - Math.exp(-Math.max(0, dt) * 13);
      a.renderX += (p.x - a.renderX) * blend;
      a.renderY += (p.y - a.renderY) * blend;
    }
    smoothVehicleHeading(a, edge.dx, edge.dy, dt);
  }

  /**
   * Draw sprites, back to front, depth-tested per cell against the scene depth
   * buffer. The original tested one distance per column, which cannot handle a
   * rooftop seen from above partially hiding the street behind it.
   */
  draw(screen, cam, L) {
    const agents = this.agents;
    if (agents.length === 0) {
      this.renderStats = { simulated: 0, visible: 0, cells: 0, near: 0, mid: 0, far: 0 };
      return this.renderStats;
    }

    const vis = [];
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      const rx = (a.renderX ?? a.x) - cam.x;
      const ry = (a.renderY ?? a.y) - cam.y;
      const d = Math.sqrt(rx * rx + ry * ry);
      if (d < 0.5 || d > MAXD) continue;
      const da = normAngle(Math.atan2(ry, rx) - cam.angle);
      if (Math.abs(da) > FOV * 0.72) continue;
      vis.push({ a, d, ang: da });
    }
    vis.sort((p, q) => q.d - p.d);

    let visibleCars = 0;
    for (const item of vis) if (item.a.kind === 'car') visibleCars++;
    let carOrdinal = 0;
    const stats = {
      simulated: 0,
      visible: visibleCars, cells: 0, near: 0, mid: 0, far: 0,
    };
    for (const agent of agents) if (agent.kind === 'car') stats.simulated++;

    const { cols, rows, depth } = screen;

    for (let i = 0; i < vis.length; i++) {
      const { a, d, ang } = vis[i];
      const dp = d * Math.cos(ang);
      if (dp < 0.3) continue;

      if (a.kind === 'car') {
        this._prepareCar(a);
        const rich = carOrdinal >= visibleCars - MAX_RICH_VEHICLES;
        carOrdinal++;
        const forcedLod = this.detailMode === 'near' ? VEHICLE_LOD.NEAR
          : this.detailMode === 'mid' ? VEHICLE_LOD.MID
          : this.detailMode === 'far' ? VEHICLE_LOD.FAR : null;
        const result = drawVehicle(screen, cam, L, a, { distance: d, rich, forcedLod });
        stats.cells += result.cells;
        if (result.lod === VEHICLE_LOD.NEAR) stats.near++;
        else if (result.lod === VEHICLE_LOD.MID) stats.mid++;
        else stats.far++;
        continue;
      }

      const wWorldSide = 0.85;
      const hWorld = 1.8;

      const baseR = cam.rowOf(0, dp);
      const topR = cam.rowOf(hWorld, dp);
      const y0 = Math.floor(topR);
      const y1 = Math.max(y0 + 1, Math.ceil(baseR));
      const span = Math.max(0.001, baseR - topR);
      const lod = lodFor(span, screen.rowStep || 1);

      // Two-frame walk cycle, phased by distance travelled.
      const phase = ((a.axis === 'x' ? a.x : a.y) * 1.6 | 0) & 1;
      const tpl = PED_LOD[lod][phase];

      const cx = cols / 2 - Math.tan(ang) * cam.proj;
      const wcols = Math.max(1, wWorldSide * cam.proj / dp);
      const x0 = cx - wcols / 2;
      const f = Math.max(0.12, fogOf(dp));

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
          screen.setDepth(x, y, g, pedCol, dp);
        }
      }
    }
    this.renderStats = stats;
    return stats;
  }
}
