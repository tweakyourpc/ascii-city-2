import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { Camera } from '../src/camera.js';
import { Lighting } from '../src/render/materials.js';
import { renderScene } from '../src/render/raycaster.js';
import { rendererWorld } from '../test/fixtures/renderer-world.js';
import { asText, makeScreen } from '../test/support/screen.js';

const fixture = JSON.parse(readFileSync(
  new URL('../test/fixtures/camera-plane-frame.json', import.meta.url), 'utf8',
));

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

const lines = asText(screen);
const depth = Array.from(screen.depth,
  (value) => value >= 1e8 ? null : Math.round(value * 1000));
const depthHash = createHash('sha256').update(JSON.stringify(depth)).digest('hex');
const kindHash = createHash('sha256').update(screen.kind).digest('hex');

const out = { meta, lines, depthHash, kindHash };
writeFileSync(new URL('../test/fixtures/camera-plane-frame.json', import.meta.url),
  JSON.stringify(out, null, 2) + '\n');
console.log('regenerated fixture; lines match previous:', JSON.stringify(lines) === JSON.stringify(fixture.lines));
