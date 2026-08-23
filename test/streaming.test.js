import assert from 'node:assert/strict';
import test from 'node:test';

import { OSMStream } from '../src/world/streaming.js';

function makeStream(overrides = {}) {
  const calls = [];
  const stream = new OSMStream({
    initialBBox: [40, -75, 40.011, -74.985],
    initialElements: [{ type: 'way', id: 1, tags: { highway: 'residential' } }],
    fetchChunk: async (bbox) => {
      calls.push(bbox);
      return [{ type: 'way', id: calls.length + 1, tags: { highway: 'primary' } }];
    },
    maxConcurrent: 1,
    ...overrides,
  });
  stream.calls = calls;
  return stream;
}

test('stream tile keys are stable and boxes are bounded', () => {
  const stream = makeStream();
  const key = stream.tileKey(40.011, -74.985);
  const [ix, iy] = key.split(',').map(Number);
  const box = stream.tileBox(ix, iy);
  assert.equal(box.length, 4);
  assert.ok(box[2] > box[0] && box[3] > box[1]);
  assert.equal(stream.tileKey(40.011, -74.985), key);
});

test('stream requests neighbors, deduplicates elements, and emits merged snapshots', async () => {
  const snapshots = [];
  const stream = makeStream({ onUpdate: (snapshot) => snapshots.push(snapshot) });
  stream.update(40, -75);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(stream.calls.length >= 1);
  assert.ok(snapshots.length >= 1);
  const latest = snapshots.at(-1);
  assert.ok(latest.loaded.length >= 2);
  assert.equal(latest.elements.filter((el) => el.id === 1).length, 1);
});

test('dispose aborts work and prevents later updates', () => {
  const stream = makeStream();
  stream.dispose();
  stream.update(41, -74);
  assert.equal(stream.queue.length, 0);
  assert.equal(stream.inFlight.size, 0);
});
