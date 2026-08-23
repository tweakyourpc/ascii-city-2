import assert from 'node:assert/strict';
import test from 'node:test';

import { Camera, cameraPlaneRay } from '../src/camera.js';
import { FOV } from '../src/config.js';
import { makeScreen } from './support/screen.js';

const EPS = 1e-10;
const near = (actual, expected, epsilon = EPS) => {
  assert.ok(Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`);
};

test('the centre camera-plane ray equals the forward direction', () => {
  const angle = 0.73;
  const ray = cameraPlaneRay(angle, 60, 121);
  near(ray.x, Math.cos(angle));
  near(ray.y, Math.sin(angle));
  near(ray.inverseForward, 1);
});

test('camera-plane boundaries span the configured horizontal FOV', () => {
  const angle = -0.4;
  const left = cameraPlaneRay(angle, -0.5, 180);
  const right = cameraPlaneRay(angle, 179.5, 180);
  const leftAngle = Math.atan2(left.y, left.x);
  const rightAngle = Math.atan2(right.y, right.x);
  near(leftAngle - angle, FOV / 2);
  near(rightAngle - angle, -FOV / 2);
});

test('every camera-plane ray projects back to its source column centre', () => {
  const cols = 180;
  const angle = 1.13;
  const fwdX = Math.cos(angle);
  const fwdY = Math.sin(angle);
  const projectionScale = (cols / 2) / Math.tan(FOV / 2);

  for (const column of [0, 17, 40, 89, 90, 139, 162, 179]) {
    const ray = cameraPlaneRay(angle, column, cols);
    const forward = ray.x * fwdX + ray.y * fwdY;
    const side = -ray.x * fwdY + ray.y * fwdX;
    const projected = cols / 2 - side / forward * projectionScale;
    near(projected, column + 0.5, 1e-9);
    near(ray.inverseForward, 1 / forward, 1e-9);
  }
});

test('Camera.buildRays fills a symmetric normalized camera-plane table', () => {
  const screen = makeScreen(180, 80);
  const cam = new Camera();
  cam.angle = Math.PI / 2;
  cam.buildRays(screen);

  for (let i = 0; i < screen.cols; i++) {
    near(Math.hypot(cam.rc[i], cam.rs[i]), 1, 1e-6);
    const expected = cameraPlaneRay(cam.angle, i, screen.cols);
    near(cam.rc[i], expected.x, 1e-6);
    near(cam.rs[i], expected.y, 1e-6);
    near(cam.rinv[i], expected.inverseForward, 1e-6);
  }

  near(cam.rc[0], -cam.rc[screen.cols - 1], 1e-6);
  near(cam.rs[0], cam.rs[screen.cols - 1], 1e-6);
});
