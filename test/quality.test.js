import assert from 'node:assert/strict';
import test from 'node:test';

import { QualityController } from '../src/quality.js';

test('quality controller degrades one step after sustained slow frames', () => {
  const q = new QualityController({ clock: () => 10000 });
  for (let i = 0; i < 30; i++) q.sample(45);
  assert.equal(q.level, 1);
  assert.equal(q.scale, 0.88);
});

test('quality controller waits for a settle window before recovering', () => {
  let now = 0;
  const q = new QualityController({ clock: () => now });
  q.setLevel(2);
  for (let i = 0; i < 30; i++) q.sample(45, now);
  assert.equal(q.level, 3);
  now += 2000;
  for (let i = 0; i < 30; i++) q.sample(18, now);
  assert.equal(q.level, 2);
});
