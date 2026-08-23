import assert from 'node:assert/strict';
import test from 'node:test';

import { SpatialHash, buildSemanticIndex } from '../src/spatial.js';

test('spatial hash returns objects in queried cells without duplicates', () => {
  const index = new SpatialHash(10);
  const road = { id: 1 };
  index.insert({ minX: 2, minY: 2, maxX: 22, maxY: 2 }, road);
  assert.deepEqual(index.query({ minX: 0, minY: 0, maxX: 5, maxY: 5 }), [road]);
  assert.deepEqual(index.query({ minX: 30, minY: 30, maxX: 35, maxY: 35 }), []);
});

test('semantic indexes cover roads, junctions, and packed anchors', () => {
  const world = {
    roads: [{ pts: [[0, 0], [8, 0]] }],
    junctions: [{ x: 4, y: 4 }],
    anchor: { n: 1, x: new Float32Array([5]), y: new Float32Array([5]) },
  };
  const indexes = buildSemanticIndex(world, 4);
  assert.equal(indexes.roads.query({ minX: 0, minY: 0, maxX: 1, maxY: 1 }).length, 1);
  assert.equal(indexes.junctions.query({ minX: 4, minY: 4, maxX: 4, maxY: 4 }).length, 1);
  assert.deepEqual(indexes.anchors.query({ minX: 5, minY: 5, maxX: 5, maxY: 5 }), [0]);
});
