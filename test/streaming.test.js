import assert from 'node:assert/strict';
import test from 'node:test';

import { OSMStream } from '../src/world/streaming.js';

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for stream condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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
    rebuildDebounceMs: 0,
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
  assert.equal(stream._wanted('0,0').length, 9);
  assert.equal(stream._wanted('0,0')[0], '0,0');
});

test('stream requests neighbors, deduplicates elements, and emits merged snapshots', async () => {
  const snapshots = [];
  const stream = makeStream({ onUpdate: (snapshot) => snapshots.push(snapshot) });
  stream.update(40, -75);
  await waitFor(() => snapshots.length > 0);
  assert.ok(stream.calls.length >= 1);
  assert.ok(snapshots.length >= 1);
  const latest = snapshots.at(-1);
  assert.ok(latest.loaded.length >= 2);
  assert.equal(latest.elements.filter((el) => el.id === 1).length, 1);
  assert.equal(latest.centerKey, stream.tileKey(40, -75));
  assert.ok(latest.revision >= 1);
});

test('stream drops the initial region and stale work after a long move', async () => {
  const pending = new Map();
  const aborted = [];
  const stream = makeStream({
    maxConcurrent: 2,
    fetchChunk: (bbox, { signal }) => new Promise((resolve, reject) => {
      const key = stream.tileKey((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2);
      pending.set(key, resolve);
      signal.addEventListener('abort', () => {
        aborted.push(key);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }),
  });

  stream.update(stream.originLat, stream.originLon);
  assert.ok(stream.inFlight.size > 0);
  const farLat = stream.originLat + stream.spanDeg * 8;
  const farLon = stream.originLon + stream.lonStep * 8;
  stream.update(farLat, farLon);
  await Promise.resolve();

  assert.ok(aborted.length > 0);
  assert.equal(stream.loaded.has('0,0'), false);
  assert.equal(stream.lastCenter, '8,8');
  assert.ok([...stream.inFlight.keys(), ...stream.queue].every((key) => stream.wanted.has(key)));
  stream.dispose();
});

test('stream snapshots stay within the active 3x3 region', () => {
  const stream = makeStream();
  stream.lastCenter = '5,5';
  stream.wanted = new Set(stream._wanted('5,5'));
  stream.loaded.clear();
  for (const key of stream.wanted) {
    const { ix, iy } = stream._parseKey(key);
    stream.loaded.set(key, { key, bbox: stream.tileBox(ix, iy), elements: [] });
  }
  stream._prune('5,5');
  const snapshot = stream.snapshot();
  assert.equal(snapshot.loaded.length, 9);
  assert.ok(snapshot.bbox[2] - snapshot.bbox[0] <= stream.spanDeg * 3 + 1e-12);
  assert.ok(snapshot.bbox[3] - snapshot.bbox[1] <= stream.lonStep * 3 + 1e-12);
});

test('stream coalesces completed chunks into one trailing update', async () => {
  const callbacks = [];
  let scheduled = null;
  const stream = makeStream({
    maxConcurrent: 2,
    schedule: (fn) => { scheduled = fn; return 1; },
    cancel: () => { scheduled = null; },
    onUpdate: (snapshot) => callbacks.push(snapshot),
  });
  stream.update(stream.originLat, stream.originLon);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(callbacks.length, 0);
  assert.equal(typeof scheduled, 'function');
  scheduled();
  assert.equal(callbacks.length, 1);
});

test('dispose aborts work and prevents later updates', () => {
  const stream = makeStream();
  stream.dispose();
  stream.update(41, -74);
  assert.equal(stream.queue.length, 0);
  assert.equal(stream.inFlight.size, 0);
});

test('a wide seed extract survives while the camera is still inside it', async () => {
  // An airfield box is several kilometres of runway against 0.6 km tiles, so
  // dropping the seed the moment the camera crosses one tile boundary shrinks
  // the world below what was asked for and the far end of the runway you are
  // flying down disappears.
  const wide = [41.9785, -87.9350, 41.9893, -87.8805];
  const stream = makeStream({ initialBBox: wide });
  const seedId = 'way/1';

  const hasSeed = () => [...stream.loaded.values()]
    .some((c) => c.elements.some((el) => `${el.type}/${el.id}` === seedId));
  assert.ok(hasSeed(), 'the seed starts loaded');

  // Walk east along the box, well past the first tile boundary but still on it.
  stream.update(41.9839, -87.9000);
  await waitFor(() => stream.inFlight.size === 0, 1000);
  assert.notEqual(stream.lastCenter, '0,0', 'the camera did cross a tile boundary');
  assert.ok(hasSeed(), 'and the original extract is still in the world');

  // Leave the box entirely and it is released, so the grid stays bounded.
  stream.update(41.9839, -87.8000);
  await waitFor(() => stream.inFlight.size === 0, 1000);
  assert.ok(!hasSeed(), 'once outside, the seed is dropped like any other chunk');
  stream.dispose();
});
