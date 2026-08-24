import assert from 'node:assert/strict';
import test from 'node:test';

import { SpatialHash, buildSemanticIndex, buildEdgeIndex, cameraEnvelope } from '../src/spatial.js';

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

test('semantic index covers signals and landmarks when present', () => {
  const world = {
    roads: [],
    junctions: [],
    anchor: { n: 0, x: new Float32Array(0), y: new Float32Array(0) },
    roadGraph: { signalJunctions: [{ x: 10, y: 10 }] },
    buildings: [null, { cx: 20, cy: 20, r: 3 }],
    landmarks: [1],
  };
  const indexes = buildSemanticIndex(world, 4);
  assert.equal(indexes.signals.query({ minX: 10, minY: 10, maxX: 10, maxY: 10 }).length, 1);
  const lm = indexes.landmarks.query({ minX: 17, minY: 17, maxX: 23, maxY: 23 });
  assert.equal(lm.length, 1);
  assert.equal(lm[0].cx, 20);
});

test('semantic index is safe when signals/landmarks are absent', () => {
  const world = { roads: [], junctions: [], anchor: null };
  const indexes = buildSemanticIndex(world, 4);
  assert.ok(indexes.signals);
  assert.ok(indexes.landmarks);
  assert.equal(indexes.signals.query({ minX: 0, minY: 0, maxX: 1, maxY: 1 }).length, 0);
  assert.equal(indexes.landmarks.query({ minX: 0, minY: 0, maxX: 1, maxY: 1 }).length, 0);
});

test('edge index returns edges whose segment crosses the query envelope', () => {
  const graph = {
    nodes: [
      { x: 0, y: 0 },   // 0
      { x: 10, y: 0 },  // 1
      { x: 100, y: 100 }, // 2
    ],
    edges: [
      { id: 0, from: 0, to: 1, length: 10 },
      { id: 1, from: 1, to: 2, length: 140 },
    ],
  };
  const index = buildEdgeIndex(graph, 8);
  const near = index.query({ minX: -2, maxX: 2, minY: -2, maxY: 2 });
  assert.equal(near.length, 1);
  assert.equal(near[0].id, 0);
  const far = index.query({ minX: 95, maxX: 105, minY: 95, maxY: 105 });
  assert.equal(far.length, 1);
  assert.equal(far[0].id, 1);
});

test('edge index returns null without a graph', () => {
  assert.equal(buildEdgeIndex(null), null);
  assert.equal(buildEdgeIndex({}), null);
});


test('cameraEnvelope builds a symmetric box around the camera', () => {
  const cam = { x: 100, y: -40 };
  const env = cameraEnvelope(cam, 50);
  assert.deepEqual(env, { minX: 50, maxX: 150, minY: -90, maxY: 10 });
  // Default radius is FOG_FULL * 0.7.
  const def = cameraEnvelope(cam);
  assert.equal(def.maxX - def.minX, def.maxY - def.minY);
  assert.ok(def.maxX - def.minX > 0);
});
