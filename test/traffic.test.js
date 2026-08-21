import assert from 'node:assert/strict';
import test from 'node:test';

import { Traffic } from '../src/agents.js';
import { buildRoadGraph } from '../src/world/roadgraph.js';

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
  assert.equal(car.y, -0.55);
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
