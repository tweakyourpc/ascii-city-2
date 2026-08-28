import assert from 'node:assert/strict';
import test from 'node:test';

import { laneOffsetForEdge, Traffic } from '../src/agents.js';
import { buildRoadGraph, positionOnEdge } from '../src/world/roadgraph.js';

function straightGraph() {
  return buildRoadGraph([{
    pts: [[0, 0], [20, 0]], nameId: 0, cls: 'residential',
    tags: { highway: 'residential', oneway: 'yes' }, nodeIds: [1, 2],
  }]);
}

test('graph cars advance continuously along the lane', () => {
  const graph = straightGraph();
  const traffic = new Traffic({ roadGraph: graph });
  const car = {
    kind: 'car', edgeId: 0, distance: 2, x: 2, y: -0.55,
    hx: 1, hy: 0, spd: 4, targetSpd: 6, pal: 0,
  };
  traffic._updateGraphCar(car, 0.25, [car]);
  assert.ok(car.distance > 2);
  assert.equal(car.x, car.distance);
  assert.equal(car.y, 0, 'single-lane one-way traffic should use the road centre');
  assert.equal(car.hx, 1);
  assert.equal(car.hy, 0);
});

test('same-lane cars slow to preserve headway', () => {
  const graph = straightGraph();
  const traffic = new Traffic({ roadGraph: graph });
  const rear = { kind: 'car', edgeId: 0, distance: 5, spd: 6, targetSpd: 7 };
  const front = { kind: 'car', edgeId: 0, distance: 8, spd: 2, targetSpd: 7 };
  traffic._updateGraphCar(rear, 0.25, [rear, front]);
  assert.ok(rear.spd < 6);
});

test('traffic preserves graph cars across a reprojected world', () => {
  const first = straightGraph();
  const second = buildRoadGraph([{
    sourceId: 'road:0', pts: [[100, 50], [140, 50]], nameId: 0,
    cls: 'residential', tags: { highway: 'residential', oneway: 'yes' },
    nodeIds: [1, 2],
  }]);
  const traffic = new Traffic({ roadGraph: first });
  const car = {
    kind: 'car', edgeId: 0, distance: 5, x: 5, y: -0.55,
    hx: 1, hy: 0, spd: 4, targetSpd: 6, pal: 0,
  };
  traffic.agents.push(car);
  traffic.rebindWorld({ roadGraph: second });
  assert.equal(traffic.agents.length, 1);
  assert.equal(traffic.agents[0], car);
  assert.equal(car.distance, 10);
  assert.equal(car.x, 110);
  assert.equal(car.y, 50);
});

test('bidirectional traffic uses road-width-aware opposing lane centres', () => {
  const graph = buildRoadGraph([{
    pts: [[0, 0], [20, 0]], width: 6, nameId: 0, cls: 'primary',
    tags: { highway: 'primary' }, nodeIds: [1, 2],
  }]);
  const forward = graph.edges[0];
  const reverse = graph.edges[1];
  assert.equal(laneOffsetForEdge(forward), 1.5);
  assert.equal(laneOffsetForEdge(reverse), 1.5);
  const a = positionOnEdge(graph, forward, 10, laneOffsetForEdge(forward));
  const b = positionOnEdge(graph, reverse, 10, laneOffsetForEdge(reverse));
  assert.equal(a.y, -1.5);
  assert.equal(b.y, 1.5);
});

test('developer traffic seed and density controls are repeatable and bounded', () => {
  const traffic = new Traffic(undefined, { seed: 123 });
  const first = [traffic._random(), traffic._random(), traffic._nextVehicleSeed()];
  traffic.setSeed(123);
  assert.deepEqual([traffic._random(), traffic._random(), traffic._nextVehicleSeed()], first);
  assert.equal(traffic.setDensity(2.3), 60);
  assert.equal(traffic.setDensity(0), 26);
  assert.equal(traffic.setDetailMode('far'), 'far');
  assert.equal(traffic.setDetailMode('invalid'), 'far');
});
