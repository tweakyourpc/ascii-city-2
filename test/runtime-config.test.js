import assert from 'node:assert/strict';
import test from 'node:test';

import { serviceBase, WORKER_URL, workerOverride } from '../src/runtime-config.js';
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

test('a runtime Worker override is accepted from the query or the hash', () => {
  const store = new Map();
  const storage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  assert.equal(workerOverride(['?worker=http://localhost:8791', ''], storage),
    'http://localhost:8791');
  // Remembered for this browser, so a later load without the parameter keeps it.
  assert.equal(workerOverride(['', ''], storage), 'http://localhost:8791');
  assert.equal(workerOverride(['', '#city=demo&worker=https://w.example'], storage),
    'https://w.example');
  // An empty value forgets it; other schemes are refused outright.
  assert.equal(workerOverride(['?worker=', ''], storage), '');
  assert.equal(workerOverride(['', ''], storage), '');
  assert.equal(workerOverride(['?worker=javascript:alert(1)', ''], storage), '');
});
