import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRoadGraph, positionOnEdge } from '../src/world/roadgraph.js';

const road = (pts, nodeIds, nameId, tags = {}) => ({
  pts, nodeIds, nameId, cls: 'residential', tags: { highway: 'residential', ...tags },
});

test('shared OSM node ids connect roads and geometric bridge crossings do not', () => {
  const connected = buildRoadGraph([
    road([[0, 1], [1, 1], [2, 1]], [1, 9, 2], 0),
    road([[1, 0], [1, 1], [1, 2]], [3, 9, 4], 1),
  ]);
  assert.equal(connected.junctions.length, 1);

  const bridge = buildRoadGraph([
    road([[0, 1], [1, 1], [2, 1]], [1, 8, 2], 0),
    road([[1, 0], [1, 1], [1, 2]], [3, 9, 4], 1),
  ]);
  assert.equal(bridge.junctions.length, 0);
});

test('one-way and access tags constrain directed edges', () => {
  const graph = buildRoadGraph([
    road([[0, 0], [2, 0]], [1, 2], 0, { oneway: 'yes' }),
    road([[0, 1], [2, 1]], [3, 4], 1, { access: 'private' }),
  ]);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].from, 0);
  assert.equal(graph.edges[0].to, 1);
});

test('signal nodes and lane offsets are represented deterministically', () => {
  const graph = buildRoadGraph([
    road([[0, 0], [2, 0], [4, 0]], [1, 2, 3], 0),
    road([[2, -2], [2, 0], [2, 2]], [4, 2, 5], 1),
  ], { signalNodeIds: new Set([2]) });
  assert.equal(graph.signalJunctions.length, 1);
  const edge = graph.edges[0];
  const p = positionOnEdge(graph, edge, 1, 0.5);
  assert.equal(p.x, 1);
  assert.equal(p.y, -0.5);
});
