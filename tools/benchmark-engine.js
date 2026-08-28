/**
 * Hermetic Engine Next benchmark. No provider or network access is permitted.
 *
 * Usage:
 *   npm run benchmark
 *   npm run benchmark -- --frames 240 --json
 */
import { performance } from 'node:perf_hooks';

import { Traffic, TRAFFIC } from '../src/agents.js';
import { Camera } from '../src/camera.js';
import { Lighting } from '../src/render/materials.js';
import { renderScene } from '../src/render/raycaster.js';
import { Signs } from '../src/render/signs.js';
import { TrafficLights } from '../src/render/trafficlights.js';
import { Labels } from '../src/render/labels.js';
import { renderStreets } from '../src/render/streets.js';
import { ProceduralWorld } from '../src/world/procedural.js';
import { OsmWorld } from '../src/world/osm.js';
import { DEMO_BBOX, DEMO_ELEMENTS } from '../src/world/demo-city.js';
import { querySemanticFrame } from '../src/spatial.js';
import { makeScreen, MODE } from '../test/support/screen.js';

const argv = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (!key.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith('--')) { argv.set(key.slice(2), next); i++; }
  else argv.set(key.slice(2), true);
}

const frames = Math.max(30, Number(argv.get('frames') || 120));
const warmup = Math.max(10, Number(argv.get('warmup') || 30));
const json = argv.has('json');

const C = 1024;
const SCENES = [
  {
    id: 'dense-downtown', label: 'Dense downtown', cols: 180, rows: 80,
    x: C + 82, y: C + 4, z: 1.65, angle: Math.PI, pitch: 0, traffic: TRAFFIC.CARS,
  },
  {
    id: 'low-density-suburb', label: 'Low-density suburb', cols: 180, rows: 80,
    x: C + 360, y: C + 4, z: 1.65, angle: Math.PI, pitch: 0, traffic: TRAFFIC.CARS,
  },
  {
    id: 'street-detail', label: 'Street-level detail', cols: 160, rows: 72,
    x: C + 0.5, y: C - 47.5, z: 1.65, angle: Math.PI / 2, pitch: 0,
    traffic: TRAFFIC.ALL,
  },
  {
    id: 'skyline', label: 'Overlapping skyline', cols: 180, rows: 80,
    x: C + 0.5, y: C - 47.5, z: 10, angle: Math.PI / 2, pitch: -3,
    traffic: TRAFFIC.CARS,
  },
  {
    id: 'integrated-gpu-stress', label: 'Integrated-GPU stress', cols: 240, rows: 108,
    x: C + 82, y: C + 4, z: 1.65, angle: Math.PI, pitch: 0,
    traffic: TRAFFIC.ALL, mode: MODE.BLOCK,
  },
  {
    id: 'demo-osm', label: 'Irregular OSM demo', cols: 180, rows: 80,
    z: 1.65, angle: Math.PI / 2, pitch: 0, traffic: TRAFFIC.CARS, demo: true,
  },
];

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function percentile(values, p) {
  const ordered = values.slice().sort((a, b) => a - b);
  return ordered[Math.floor((ordered.length - 1) * p)];
}

function summary(values) {
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    mean: sum / values.length,
    p50: percentile(values, 0.50),
    p95: percentile(values, 0.95),
  };
}

function runScene(spec) {
  const originalRandom = Math.random;
  Math.random = seededRandom(0xaced0000 ^ spec.id.length);
  try {
    const world = spec.demo
      ? new OsmWorld(DEMO_BBOX, DEMO_ELEMENTS, 'Offline Demo City')
      : new ProceduralWorld({ seed: 1337 });
    const screen = makeScreen(spec.cols, spec.rows, spec.mode ?? MODE.GLYPH);
    const cam = new Camera();
    const spawn = spec.demo ? world.spawn() : null;
    cam.x = spawn?.x ?? spec.x; cam.y = spawn?.y ?? spec.y; cam.z = spec.z;
    cam.angle = spec.angle; cam.pitch = spec.pitch;
    cam.hz = screen.horizon - cam.pitch;
    const lighting = new Lighting();
    lighting.update(35);
    const traffic = new Traffic(world);
    traffic.mode = spec.traffic;
    const signs = new Signs();
    const signals = new TrafficLights();
    const labels = new Labels();

    const samples = {
      simulation: [], raycast: [], worldQuery: [], compose: [], frame: [],
      semanticQuery: [], streets: [], signs: [], signals: [], labels: [], trafficDraw: [],
    };
    let candidateCounts = null;

    const oneFrame = (record, frameIndex) => {
      const frameStart = performance.now();
      cam.angle += 0.00025;
      cam.buildRays(screen);

      let start = performance.now();
      traffic.update(1 / 60, cam);
      if (record) samples.simulation.push(performance.now() - start);

      screen.clear();
      start = performance.now();
      renderScene(screen, cam, world, lighting, frameIndex / 60);
      if (record) samples.raycast.push(performance.now() - start);

      start = performance.now();
      let layerStart = performance.now();
      const semantic = querySemanticFrame(world, cam);
      if (record) samples.semanticQuery.push(performance.now() - layerStart);
      candidateCounts = {
        roads: semantic.roads.length,
        junctions: semantic.junctions.length,
        anchors: semantic.anchors.length,
        signals: semantic.signals.length,
        landmarks: semantic.landmarks.length,
      };
      layerStart = performance.now();
      renderStreets(screen, cam, world, lighting, semantic);
      if (record) samples.streets.push(performance.now() - layerStart);
      layerStart = performance.now();
      signs.draw(screen, cam, world, lighting, semantic);
      if (record) samples.signs.push(performance.now() - layerStart);
      layerStart = performance.now();
      signals.draw(screen, cam, world, lighting, frameIndex / 60, semantic);
      if (record) samples.signals.push(performance.now() - layerStart);
      layerStart = performance.now();
      labels.draw(screen, cam, world, lighting, semantic);
      if (record) samples.labels.push(performance.now() - layerStart);
      layerStart = performance.now();
      traffic.draw(screen, cam, lighting);
      if (record) samples.trafficDraw.push(performance.now() - layerStart);
      if (record) samples.worldQuery.push(performance.now() - start);

      screen._calls.texts.length = 0;
      screen._calls.rects.length = 0;
      screen._calls.fillText = 0;
      screen._calls.fillRect = 0;
      start = performance.now();
      screen.blit();
      if (record) {
        samples.compose.push(performance.now() - start);
        samples.frame.push(performance.now() - frameStart);
      }
    };

    for (let i = 0; i < warmup; i++) oneFrame(false, i);
    for (let i = 0; i < frames; i++) oneFrame(true, warmup + i);

    let visibleCells = 0;
    for (let i = 0; i < screen.kind.length; i++) if (screen.kind[i]) visibleCells++;

    return {
      id: spec.id,
      label: spec.label,
      mode: screen.mode === MODE.BLOCK ? 'BLOCK' : 'GLYPH',
      resolution: `${screen.cols}x${screen.rows}`,
      outputRows: screen.outRows,
      roads: world.roads.length,
      junctions: world.junctions.length,
      agents: traffic.agents.length,
      candidates: candidateCounts,
      visibleCells,
      canvasCalls: screen._calls.fillText + screen._calls.fillRect,
      timings: Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, summary(values)])),
    };
  } finally {
    Math.random = originalRandom;
  }
}

const results = SCENES.map(runScene);
if (json) {
  console.log(JSON.stringify({ frames, warmup, results }, null, 2));
} else {
  console.log(`Engine benchmark: ${frames} measured frames after ${warmup} warmup frames`);
  console.log('Scene                    Grid       sim p50  ray p50  world p50  compose p50  frame p95');
  for (const r of results) {
    const t = r.timings;
    console.log(
      r.label.padEnd(24)
      + r.resolution.padEnd(11)
      + t.simulation.p50.toFixed(2).padStart(7)
      + t.raycast.p50.toFixed(2).padStart(9)
      + t.worldQuery.p50.toFixed(2).padStart(11)
      + t.compose.p50.toFixed(2).padStart(13)
      + t.frame.p95.toFixed(2).padStart(11),
    );
  }
  console.log('Times are milliseconds. Compose is Canvas submission; GPU time is unavailable in Canvas 2D.');
}
