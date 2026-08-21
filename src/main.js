import { Screen, MODE as RENDER } from './screen.js';
import { Camera } from './camera.js';
import { Input } from './input.js';
import { Hud } from './hud.js';
import { ProceduralWorld } from './world/procedural.js';
import { OsmWorld } from './world/osm.js';
import { fetchOsm } from './world/overpass.js';
import { Lighting } from './render/materials.js';
import { renderScene } from './render/raycaster.js';
import { renderStreets } from './render/streets.js';
import { drawSky } from './render/sky.js';
import { drawLoading, drawError } from './render/loading.js';
import { Signs } from './render/signs.js';
import { Labels, MODE as LABEL_MODE } from './render/labels.js';
import { Panel } from './render/panel.js';
import { pick, SkyMarks } from './pick.js';
import { AircraftLayer, isLiveTime } from './aircraft.js';
import { WeatherLayer } from './weather.js';
import { Traffic } from './agents.js';
import { TrafficLights } from './render/trafficlights.js';
import { RadioPlayer } from './radio.js';
import { julianDay, sunPos, altAz } from './astro.js';
import { canMoveTo, settle } from './collision.js';
import {
  WALK_SPEED, RUN_MULT, Z_ACCEL, Z_DAMP,
  SPEED_PER_CELL_UP, MAX_SPEED_MULT,
  DEFAULT_LAT, DEFAULT_LON,
} from './config.js';

const canvas = document.getElementById('c');
const screen = new Screen(canvas);
const cam = new Camera();
const input = new Input(canvas);
const light = new Lighting();

/** Everything that changes when a different city is loaded. */
const state = {
  world: null,
  site: { lat: DEFAULT_LAT, lon: DEFAULT_LON },
  view: { preset: 'procedural', bbox: null, label: 'Procedural City' },
  phase: 'ready',            // 'ready' | 'loading' | 'error'
  message: '',
  error: null,
  token: 0,                  // invalidates in-flight loads
  load: null,                // AbortController for the in-flight load
};

const signs = new Signs();
const labels = new Labels();
const panel = new Panel();
const skyMarks = new SkyMarks();
const aircraft = new AircraftLayer();
const weather = new WeatherLayer();
const traffic = new Traffic();
const signals = new TrafficLights();
const radio = new RadioPlayer();
const hud = new Hud({ onLoad: (view) => loadView(view) });

let simTime = Date.now();
let imperial = false;

/** Set the simulated clock to a given local hour today, for a chosen light. */
function setLocalHour(hour, lon) {
  const now = new Date();
  const utcNoon = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  simTime = utcNoon + (hour - lon / 15) * 3600000;
}

window.addEventListener('resize', () => screen.resize());

/* ------------------------------ world load ------------------------------ */

function adoptWorld(world, { lat, lon }, camera = null) {
  state.world = world;
  state.site = { lat, lon };
  cam.placeAt(world.spawn());
  cam.pitch = 0;

  if (camera) {
    if (camera.x !== undefined) cam.x = camera.x;
    if (camera.y !== undefined) cam.y = camera.y;
    if (camera.z !== undefined) cam.z = camera.z;
    if (camera.angle !== undefined) cam.angle = camera.angle;
    if (camera.pitch !== undefined) cam.pitch = camera.pitch;
  }

  hud.setAttribution(world);
  aircraft.setWorld(world);
  weather.setWorld(world);
  traffic.setWorld(world);
  radio.setWorld(world);
}

function loadProcedural(camera = null) {
  const world = new ProceduralWorld();
  world.bbox = null;
  world.label = 'Procedural City';
  adoptWorld(world, { lat: DEFAULT_LAT, lon: DEFAULT_LON }, camera);
  state.phase = 'ready';
}

async function loadView(view) {
  const token = ++state.token;
  state.view = view;
  hud.select(view.preset);
  hud.syncHash(view);

  state.load?.abort();
  const load = new AbortController();
  state.load = load;

  if (!view.bbox) {
    loadProcedural(view.camera);
    return;
  }

  state.phase = 'loading';
  state.message = 'Loading map data';
  hud.setBusy(true);

  try {
    const elements = await fetchOsm(view.bbox, {
      onProgress: (msg) => { if (token === state.token) state.message = msg; },
      signal: load.signal,
    });
    if (token !== state.token) return;

    state.message = 'Mapping the streets';
    await new Promise((r) => requestAnimationFrame(r));
    if (token !== state.token) return;

    const world = new OsmWorld(view.bbox, elements, view.label);
    if (world.roadCells.length === 0 && world.buildings.length <= 1) {
      throw new Error('No streets in this area. Try somewhere more built up.');
    }
    adoptWorld(world, { lat: world.lat, lon: world.lon }, view.camera);
    state.phase = 'ready';
  } catch (err) {
    if (token !== state.token) return;
    state.phase = 'error';
    state.error = err;
    hud.setError(err.message);
  } finally {
    if (token === state.token) hud.setBusy(false);
  }
}

/* -------------------------------- update -------------------------------- */

function update(dt) {
  const world = state.world;
  const look = input.takeLook();
  if (look.x || look.y) {
    cam.angle -= look.x * 0.004;
    cam.pitch = Math.max(-screen.rows * 0.9,
                 Math.min(screen.rows * 1.5, cam.pitch - look.y * 0.35));
  }

  const running = input.down('shift');
  const altMult = Math.min(MAX_SPEED_MULT, 1 + cam.z * SPEED_PER_CELL_UP);
  const speed = WALK_SPEED * altMult * (running ? RUN_MULT : 1) * dt;
  const fx = Math.cos(cam.angle);
  const fy = Math.sin(cam.angle);

  let mx = 0;
  let my = 0;
  if (input.down('w') || input.down('arrowup')) { mx += fx; my += fy; }
  if (input.down('s') || input.down('arrowdown')) { mx -= fx; my -= fy; }
  if (input.down('a')) { mx -= fy; my += fx; }
  if (input.down('d')) { mx += fy; my -= fx; }
  if (input.down('arrowleft')) cam.angle += 1.8 * dt;
  if (input.down('arrowright')) cam.angle -= 1.8 * dt;

  for (let i = input.takeTaps('n'); i > 0; i--) signs.toggle();
  for (let i = input.takeTaps('l'); i > 0; i--) labels.cycle();
  for (let i = input.takeTaps('b'); i > 0; i--) screen.cycleMode();
  for (let i = input.takeTaps('t'); i > 0; i--) aircraft.toggle();
  for (let i = input.takeTaps('y'); i > 0; i--) weather.toggle();
  for (let i = input.takeTaps('u'); i > 0; i--) imperial = !imperial;
  for (let i = input.takeTaps('g'); i > 0; i--) traffic.cycle();
  for (let i = input.takeTaps('h'); i > 0; i--) signals.toggle();
  for (let i = input.takeTaps('m'); i > 0; i--) radio.toggle();
  for (let i = input.takeTaps(','); i > 0; i--) radio.step(-1);
  for (let i = input.takeTaps('.'); i > 0; i--) radio.step(1);
  if (input.takeTaps('escape')) panel.close();

  let thrust = 0;
  if (input.down('e')) thrust += 1;
  if (input.down('q')) thrust -= 1;
  if (thrust !== 0) cam.vz += thrust * Z_ACCEL * dt * (running ? 2.5 : 1);
  cam.vz *= Math.pow(Z_DAMP, dt);
  cam.z += cam.vz * dt;
  cam.clampZ();
  // Keep the eye above whatever it is standing on: you cannot sink through a
  // roof or the ground. Vertical thrust still lets you climb past buildings.
  settle(world, cam);

  const len = Math.sqrt(mx * mx + my * my);
  if (len > 0) {
    mx = mx / len * speed;
    my = my / len * speed;
    // Per-axis collision so you slide along a wall instead of sticking to it.
    // Each axis is tried independently; a blocked axis simply does not move.
    if (world.size > 0) {
      const nx = Math.max(0.5, Math.min(world.width - 0.5, cam.x + mx));
      const ny = Math.max(0.5, Math.min(world.height - 0.5, cam.y + my));
      if (canMoveTo(world, nx, cam.y, cam.z)) cam.x = nx;
      if (canMoveTo(world, cam.x, ny, cam.z)) cam.y = ny;
    } else {
      if (canMoveTo(world, cam.x + mx, cam.y, cam.z)) cam.x += mx;
      if (canMoveTo(world, cam.x, cam.y + my, cam.z)) cam.y += my;
    }
  }

  // Live aircraft are another truthful layer of the world, like the sky. They
  // only exist while the clock is the real clock; time travel has no planes.
  const live = isLiveTime(simTime, hud.warpFactor());
  aircraft.update(dt, cam, simTime, live, hud.warpFactor());
  // Live weather is the same idea: present-day conditions only, withdrawn on
  // time travel. It polls slowly (minutes), so the per-frame cost is nil.
  weather.update(dt, cam, simTime, live, null);
  // Light ground traffic routes the street grid; it is independent of the live
  // clock, so it runs whenever the world has streets.
  traffic.update(dt, cam);
}

/* --------------------------------- draw --------------------------------- */

function draw() {
  const sim = new Date(simTime);
  const jd = julianDay(sim);
  const sun = sunPos(jd);
  const sp = altAz(sun.ra / 15, sun.dec, jd, state.site.lat, state.site.lon);
  const sunAlt = sp.alt;

  const dayK = light.update(sunAlt);

  cam.hz = screen.horizon - cam.pitch;
  cam.buildRays(screen);
  screen.clear();

  const t = simTime / 1000;
  // Buildings + ground via the height-field raycaster. It writes screen.depth
  // for every cell it paints, which is what lets the clean street lines below
  // be occluded by buildings (renderStreets depth-tests against it).
  renderScene(screen, cam, state.world, light, t);
  drawSky(screen, cam, light, state.site, jd, sp, sunAlt, dayK, sim, skyMarks);
  // Clean street lines on top of the pavement, depth-tested against buildings.
  renderStreets(screen, cam, state.world, light);
  signs.draw(screen, cam, state.world, light);
  signals.draw(screen, cam, state.world, light, simTime);
  labels.draw(screen, cam, state.world, light);
  traffic.draw(screen, cam, light);
  aircraft.draw(screen, cam, light);
  weather.draw(screen, cam, light, simTime);
  panel.draw(screen, cam, state.world);
  screen.blit();

  return sunAlt;
}

/* --------------------------------- loop --------------------------------- */

let lastT = performance.now();
let lastHashSync = 0;
let fps = 60;
let acc = 0;
let frames = 0;

function frame() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;

  acc += dt;
  frames++;
  if (acc > 0.5) { fps = frames / acc; acc = 0; frames = 0; }

  if (state.phase === 'loading') {
    drawLoading(screen, {
      title: 'LOADING MAP DATA',
      detail: state.message,
      t: now / 1000,
    });
    requestAnimationFrame(frame);
    return;
  }

  if (state.phase === 'error') {
    if (input.takeTaps('r') && state.view) {
      loadView(state.view);
    } else if (input.takeTaps('p')) {
      loadView({ preset: 'procedural', bbox: null, label: 'Procedural Streets' });
    }
    input.takeClick();

    drawError(screen, {
      title: 'COULD NOT LOAD THAT AREA',
      detail: state.error?.message ?? 'Unknown error',
      hint: state.error?.hint ?? 'R retry · P procedural streets · or pick another city above',
    });
    requestAnimationFrame(frame);
    return;
  }

  const warp = hud.warpFactor();
  simTime += dt * 1000 * warp;
  simTime += input.takeHourShift() * 3600000;

  update(dt);
  const sunAlt = draw();

  const clicked = input.takeClick();
  if (clicked) handleClick(clicked);

  hud.update({
    warp, simTime, lon: state.site.lon, sunAlt, cam, screen, fps,
    where: state.world.nearestStreet
      ? state.world.nearestStreet(cam.x, cam.y)
      : null,
    signMode: signs.on,
    renderMode: screen.mode,
    live: isLiveTime(simTime, warp),
    imperial,
    air: {
      enabled: aircraft.enabled,
      active: aircraft.active,
      live: isLiveTime(simTime, warp),
      count: aircraft.records.size,
    },
    weather: {
      enabled: weather.enabled,
      active: weather.active,
      status: weather.statusOf(imperial),
    },
  });

  if (input.hover) {
    const r = canvas.getBoundingClientRect();
    const over = panel.open && panel.linkAt(screen,
      Math.floor((input.hover.x - r.left) / screen.cw),
      Math.floor((input.hover.y - r.top) / screen.ch));
    canvas.style.cursor = over ? 'pointer' : '';
  }

  if (now - lastHashSync > 1000) {
    lastHashSync = now;
    const local = new Date(simTime + state.site.lon / 15 * 3600000);
    hud.syncHash(state.view, cam,
      local.getUTCHours() + local.getUTCMinutes() / 60);
  }

  requestAnimationFrame(frame);
}

/* -------------------------------- picking -------------------------------- */

function handleClick(c) {
  const r = canvas.getBoundingClientRect();
  const col = Math.floor((c.x - r.left) / screen.cw);
  const row = Math.floor((c.y - r.top) / screen.ch);

  const box = panel.rect(screen);
  if (box && col >= box.x && col < box.x + box.w &&
      row >= box.y && row < box.y + box.h) {
    // A click inside the card: if it landed on a link row, follow it; the
    // panel stays open so the reader can keep reading. Anywhere else on the
    // card dismisses it.
    const url = panel.linkAt(screen, col, row);
    if (url) {
      window.open(url, '_blank', 'noopener');
      return;
    }
    panel.close();
    return;
  }

  const hit = pick(screen, cam, state.world, col, row, skyMarks);
  if (!hit) {
    const ac = aircraft.pickAt(col, row);
    if (ac) {
      const info = aircraft.info(ac);
      if (info) {
        panel.select({
          kind: 'aircraft', icao: ac,
          lat: info.lat, lon: info.lon, altM: info.altM,
          callsign: info.callsign, gsKt: info.gsKt, trackDeg: info.trackDeg,
          type: info.type, squawk: info.squawk, originCountry: info.originCountry,
        });
        return;
      }
    }
    // A click on open sky can surface the current conditions card, if weather
    // is loaded. The mark is a single point at top-centre of the sky.
    const wm = weather.pickAt(col, row);
    if (wm && weather.cur) {
      const w = weather.cur;
      panel.select({
        kind: 'weather',
        label: w.label,
        tempC: w.tempC, humidity: w.humidity, windKt: w.windKt,
        windDeg: w.windDeg, cloud: w.cloud, weatherKind: w.kind,
        glyph: w.glyph,
      });
      return;
    }
    panel.close();
    return;
  }
  panel.select(hit);
}

/* --------------------------------- boot --------------------------------- */

if (new URLSearchParams(location.hash.slice(1)).get('hud') === '0') {
  const el = document.getElementById('hud');
  if (el) el.style.display = 'none';
}

const initial = Hud.initialView();
if (initial.hour !== undefined) {
  setLocalHour(initial.hour, initial.bbox
    ? (initial.bbox[1] + initial.bbox[3]) / 2
    : DEFAULT_LON);
}

loadProcedural(initial.bbox ? null : initial.camera);
requestAnimationFrame(frame);

if (initial.bbox) loadView(initial);

Object.assign(window, {
  cam, screen, state, signs, labels, panel,
  RENDER, LABEL_MODE, pick,
});
