/**
 * Build a compact directed road graph from the polylines worlds already keep.
 * OSM connectivity is determined by shared node ids, not geometric crossings:
 * two ways crossing at different nodes may be a bridge and must not create a
 * junction. Synthetic worlds fall back to exact, quantized vertex positions.
 */

const NON_DRIVABLE = new Set([
  'bridleway', 'construction', 'corridor', 'cycleway', 'elevator', 'footway',
  'path', 'pedestrian', 'platform', 'proposed', 'raceway', 'steps', 'track',
]);

const DENIED = new Set(['no', 'private']);

function nodeKey(road, i) {
  const id = road.nodeIds && road.nodeIds[i];
  if (id !== undefined && id !== null) return `n:${id}`;
  const [x, y] = road.pts[i];
  return `p:${Math.round(x * 1000)},${Math.round(y * 1000)}`;
}

function drivable(tags = {}, cls = '') {
  if (NON_DRIVABLE.has(cls)) return false;
  if (DENIED.has(tags.access) || DENIED.has(tags.vehicle) ||
      DENIED.has(tags.motor_vehicle)) return false;
  return true;
}

function oneWay(tags = {}) {
  if (tags.oneway === '-1') return -1;
  if (tags.oneway === 'yes' || tags.oneway === '1' || tags.oneway === 'true' ||
      tags.junction === 'roundabout') return 1;
  return 0;
}

function normal(ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return null;
  return { dx: dx / length, dy: dy / length, length };
}

function signalNear(node, points) {
  for (const p of points) {
    const dx = p.x - node.x;
    const dy = p.y - node.y;
    if (dx * dx + dy * dy <= 0.75 * 0.75) return true;
  }
  return false;
}

/** Assign two alternating signal groups from the approach bearings. */
function assignGroups(approaches) {
  if (approaches.length === 0) return;
  const first = approaches[0];
  for (const a of approaches) {
    a.group = Math.abs(first.dx * a.dx + first.dy * a.dy) >= Math.SQRT1_2 ? 0 : 1;
  }
}

/**
 * @param {Array} roads world road records
 * @param {{signalNodeIds?:Set, signalPoints?:Array}} options
 */
export function buildRoadGraph(roads, {
  signalNodeIds = new Set(), signalPoints = [],
} = {}) {
  const nodes = [];
  const byKey = new Map();
  const edges = [];

  const getNode = (road, i) => {
    const key = nodeKey(road, i);
    let id = byKey.get(key);
    if (id !== undefined) return id;
    const [x, y] = road.pts[i];
    const osmId = road.nodeIds && road.nodeIds[i] !== undefined
      ? road.nodeIds[i] : null;
    id = nodes.length;
    nodes.push({
      id, key, osmId, x, y, incoming: [], outgoing: [], incident: [],
      signal: osmId !== null && signalNodeIds.has(osmId),
    });
    byKey.set(key, id);
    return id;
  };

  const addEdge = (from, to, roadId, road, geom) => {
    const id = edges.length;
    const edge = {
      id, from, to, roadId, nameId: road.nameId ?? -1,
      cls: road.cls || 'road', tags: road.tags || {},
      length: geom.length, dx: geom.dx, dy: geom.dy,
      reverseId: -1,
    };
    edges.push(edge);
    nodes[from].outgoing.push(id);
    nodes[to].incoming.push(id);
    nodes[from].incident.push(id);
    nodes[to].incident.push(id);
    return id;
  };

  for (let roadId = 0; roadId < roads.length; roadId++) {
    const road = roads[roadId];
    if (!road || !Array.isArray(road.pts) || road.pts.length < 2) continue;
    const ids = road.pts.map((_, i) => getNode(road, i));
    if (!drivable(road.tags, road.cls)) continue;
    const ow = oneWay(road.tags);
    for (let i = 1; i < road.pts.length; i++) {
      const a = road.pts[i - 1];
      const b = road.pts[i];
      const geom = normal(a[0], a[1], b[0], b[1]);
      if (!geom) continue;
      if (ow >= 0) {
        const fwd = addEdge(ids[i - 1], ids[i], roadId, road, geom);
        if (ow === 0) {
          const rev = addEdge(ids[i], ids[i - 1], roadId, road,
            { dx: -geom.dx, dy: -geom.dy, length: geom.length });
          edges[fwd].reverseId = rev;
          edges[rev].reverseId = fwd;
        }
      } else {
        addEdge(ids[i], ids[i - 1], roadId, road,
          { dx: -geom.dx, dy: -geom.dy, length: geom.length });
      }
    }
  }

  // A geometry-only signal point is the fallback for recorded/test data whose
  // ways do not retain OSM node ids.
  for (const node of nodes) {
    if (!node.signal && signalNear(node, signalPoints)) node.signal = true;
  }

  const junctions = [];
  const signalJunctions = [];
  for (const node of nodes) {
    const arms = new Map();
    for (const edgeId of node.outgoing) {
      const e = edges[edgeId];
      const key = `${e.to}:${e.nameId}`;
      if (!arms.has(key)) arms.set(key, {
        edgeId, nodeId: e.to, nameId: e.nameId, cls: e.cls,
        dx: e.dx, dy: e.dy, group: 0,
      });
    }
    for (const edgeId of node.incoming) {
      const e = edges[edgeId];
      const key = `${e.from}:${e.nameId}`;
      if (!arms.has(key)) arms.set(key, {
        edgeId, nodeId: e.from, nameId: e.nameId, cls: e.cls,
        dx: -e.dx, dy: -e.dy, group: 0,
      });
    }
    const approaches = [...arms.values()];
    assignGroups(approaches);
    const names = [...new Set(approaches.map((a) => a.nameId).filter((n) => n >= 0))];
    const j = { id: node.id, x: node.x, y: node.y, names, approaches, signal: node.signal };
    if (names.length >= 2) junctions.push(j);
    if (node.signal && approaches.length >= 2) signalJunctions.push(j);
  }

  return { nodes, edges, junctions, signalJunctions };
}

export function positionOnEdge(graph, edge, distance, laneOffset = 0) {
  const a = graph.nodes[edge.from];
  const d = Math.max(0, Math.min(edge.length, distance));
  return {
    x: a.x + edge.dx * d + edge.dy * laneOffset,
    y: a.y + edge.dy * d - edge.dx * laneOffset,
  };
}
