import assert from 'node:assert/strict';
import test from 'node:test';

import { RadioPlayer } from '../src/radio.js';

class FakeAudio extends EventTarget {
  constructor() {
    super();
    this.paused = true;
    this.src = '';
  }

  pause() { this.paused = true; }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  load() {}
  async play() { this.paused = false; }
}

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

function documentStub() {
  const elements = new Map();
  return {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { textContent: '', addEventListener() {} });
      return elements.get(id);
    },
  };
}

const SARASOTA = { lat: 27.3365805, lon: -82.5308545 };

function directoryFetch(stations, calls) {
  return async (url) => {
    calls.push(String(url));
    if (String(url).includes('nominatim')) {
      return new Response(JSON.stringify({
        address: { country_code: 'us', state: 'Florida' },
      }));
    }
    return new Response(JSON.stringify(stations));
  };
}

function makePlayer({ stations, calls = [], saved = storage() }) {
  const previousDocument = globalThis.document;
  const previousAudio = globalThis.Audio;
  globalThis.document = documentStub();
  globalThis.Audio = FakeAudio;
  const player = new RadioPlayer({
    workerUrl: '', fetchImpl: directoryFetch(stations, calls), storage: saved,
  });
  globalThis.document = previousDocument;
  globalThis.Audio = previousAudio;
  return { player, calls, saved };
}

const station = (id, name, lat, lon) => ({
  stationuuid: id,
  name,
  url_resolved: `https://radio.example/${id}`,
  geo_lat: lat,
  geo_long: lon,
  country: 'United States',
  language: 'English',
});

test('direct discovery searches the resolved state and excludes Miami from Sarasota', async () => {
  const calls = [];
  const { player } = makePlayer({
    calls,
    stations: [
      station('local', 'Sarasota Local', 27.34, -82.54),
      station('miami', 'Miami Station', 25.7824, -80.1923),
    ],
  });

  await player.setWorld(SARASOTA);

  assert.deepEqual(player.stations.map((s) => s.name), ['Sarasota Local']);
  const directory = calls.find((url) => url.includes('/json/stations/search'));
  assert.match(directory, /state=Florida/);
  assert.match(directory, /stateExact=true/);
  assert.match(directory, /limit=1000/);
});

test('direct discovery reports no local stations rather than falling back 290 km', async () => {
  const { player } = makePlayer({
    stations: [station('miami', 'Miami Station', 25.7824, -80.1923)],
  });

  await player.setWorld(SARASOTA);

  assert.deepEqual(player.stations, []);
  assert.equal(player.status, 'NO LOCAL STATIONS');
});

test('radio restores the selected station for the same city', async () => {
  const saved = storage();
  const stations = [
    station('one', 'One', 27.34, -82.54),
    station('two', 'Two', 27.35, -82.53),
  ];
  const first = makePlayer({ stations, saved }).player;
  await first.setWorld(SARASOTA);
  first.step(1);
  assert.equal(first.current().id, 'two');

  const second = makePlayer({ stations, saved }).player;
  await second.setWorld(SARASOTA);
  assert.equal(second.current().id, 'two');
});

test('a world without coordinates reports N/A instead of querying a directory', async () => {
  const calls = [];
  const { player } = makePlayer({ calls, stations: [] });

  await player.setWorld({});

  assert.deepEqual(calls, [], 'no directory or geocoder request is made');
  assert.equal(player.status, 'N/A');
  assert.deepEqual(player.stations, []);
});
