import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { Camera } from '../src/camera.js';
import { Lighting } from '../src/render/materials.js';
import { renderScene } from '../src/render/raycaster.js';
import { rendererWorld } from './fixtures/renderer-world.js';
import { asText, makeScreen } from './support/screen.js';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/camera-plane-frame.json', import.meta.url), 'utf8',
));

test('camera-plane renderer matches the semantic skyline snapshot', () => {
  const { meta } = fixture;
  const screen = makeScreen(meta.cols, meta.rows);
  const cam = new Camera();
  cam.x = meta.x; cam.y = meta.y; cam.z = meta.z;
  cam.angle = meta.angle; cam.pitch = 0; cam.hz = screen.horizon;
  cam.buildRays(screen);
  const lighting = new Lighting();
  lighting.update(meta.sunAlt);

  screen.clear();
  renderScene(screen, cam, rendererWorld(), lighting, 0);

  assert.deepEqual(asText(screen), fixture.lines);
  const depth = Array.from(screen.depth,
    (value) => value >= 1e8 ? null : Math.round(value * 1000));
  const depthHash = createHash('sha256').update(JSON.stringify(depth)).digest('hex');
  const kindHash = createHash('sha256').update(screen.kind).digest('hex');
  assert.equal(depthHash, fixture.depthHash);
  assert.equal(kindHash, fixture.kindHash);
});
