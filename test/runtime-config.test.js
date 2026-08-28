import assert from 'node:assert/strict';
import test from 'node:test';

import { serviceBase, WORKER_URL } from '../src/runtime-config.js';
import { workerUrlForHost } from '../ascii-city.config.js';

test('a clean clone has no inherited Worker endpoint', () => {
  assert.equal(WORKER_URL, '');
});

test('only the official Pages hostname opts into the project Worker', () => {
  assert.equal(workerUrlForHost('tweakyourpc.github.io'),
    'https://ascii-city-2.ascii-city-v2.workers.dev');
  assert.equal(workerUrlForHost('example.github.io'), '');
  assert.equal(workerUrlForHost('localhost'), '');
});

test('serviceBase accepts only credential-free HTTP(S) service URLs', () => {
  assert.equal(serviceBase(' https://worker.example.test/ '), 'https://worker.example.test');
  assert.equal(serviceBase('http://192.0.2.2:8787/api/'), 'http://192.0.2.2:8787/api');
  assert.equal(serviceBase('javascript:alert(1)'), '');
  assert.equal(serviceBase('https://user:secret@example.test'), '');
  assert.equal(serviceBase('not a URL'), '');
});
