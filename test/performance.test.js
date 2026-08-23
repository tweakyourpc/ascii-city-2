import assert from 'node:assert/strict';
import test from 'node:test';

import { PerformanceTracker } from '../src/performance.js';

test('performance tracker measures named phases and total frame time', () => {
  let now = 100;
  const tracker = new PerformanceTracker({ clock: () => now, smoothing: 1 });
  tracker.toggle();
  tracker.beginFrame();
  tracker.start('simulation');
  now += 2;
  tracker.end('simulation');
  tracker.start('raycast');
  now += 5;
  tracker.end('raycast');
  now += 3;
  tracker.endFrame();

  const stats = tracker.snapshot();
  assert.equal(stats.simulation, 2);
  assert.equal(stats.raycast, 5);
  assert.equal(stats.frame, 10);
  assert.equal(stats.gpu, null, 'Canvas 2D must not claim a GPU timing');
});

test('disabled performance tracker is a cheap no-op', () => {
  let reads = 0;
  const tracker = new PerformanceTracker({ clock: () => { reads++; return 1; } });
  tracker.beginFrame();
  tracker.start('raycast');
  tracker.end('raycast');
  tracker.endFrame();
  assert.equal(reads, 0);
  assert.equal(tracker.snapshot().raycast, 0);
});
