import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CityClock, buildTimeZoneUrl, fetchTimeZone, formatCityTime,
  normalizeTimeZone, _resetTimeZoneCache,
} from '../src/clock.js';
import { buildViewHash, parseInitialView } from '../src/hud.js';

test('Tampa civil time observes EDT and EST for the simulated instant', () => {
  const summer = formatCityTime(Date.UTC(2026, 7, 21, 5, 0), 'America/New_York');
  assert.equal(summer.clock, '01:00');
  assert.equal(summer.zone, 'EDT');
  assert.equal(summer.date, 'Fri 21 Aug 2026');

  const winter = formatCityTime(Date.UTC(2026, 0, 21, 6, 0), 'America/New_York');
  assert.equal(winter.clock, '01:00');
  assert.equal(winter.zone, 'EST');
});

test('invalid time zones fall back explicitly to UTC', () => {
  assert.equal(normalizeTimeZone('Not/A_Zone'), null);
  const shown = formatCityTime(0, 'Not/A_Zone');
  assert.equal(shown.clock, '00:00');
  assert.match(shown.zone, /UTC|GMT/);
});

test('timezone lookup requests automatic IANA resolution and caches success', async () => {
  _resetTimeZoneCache();
  let calls = 0;
  const stub = async (url) => {
    calls++;
    assert.match(url, /latitude=27\.9506/);
    assert.match(url, /longitude=-82\.4572/);
    assert.match(url, /timezone=auto/);
    return { ok: true, json: async () => ({ timezone: 'America/New_York' }) };
  };
  const one = await fetchTimeZone(27.9506, -82.4572, { fetchImpl: stub });
  const two = await fetchTimeZone(27.9506, -82.4572, { fetchImpl: stub });
  assert.equal(one, 'America/New_York');
  assert.equal(two, one);
  assert.equal(calls, 1);
  assert.match(buildTimeZoneUrl(27.9506, -82.4572), /forecast_days=1/);
});

test('LIVE follows wall time and warp or shifting enters SIM', () => {
  const clock = new CityClock({ nowMs: 1000 });
  clock.advance(0.016, 1, 5000);
  assert.equal(clock.live, true);
  assert.equal(clock.instantMs, 5000, 'background gaps snap to the current clock');

  clock.advance(0.1, 10, 6000);
  assert.equal(clock.live, false);
  assert.equal(clock.instantMs, 6900);
  clock.advance(1, 1, 999999);
  assert.equal(clock.instantMs, 7900, 'SIM advances independently of wall time');

  clock.goLive(8000);
  clock.shiftHours(-1, 8000);
  assert.equal(clock.live, false);
  assert.equal(clock.instantMs, 8000 - 3600000);
});

test('NOW restores explicit live mode', () => {
  const clock = new CityClock({ nowMs: 123, mode: 'sim' });
  clock.goLive(456);
  assert.equal(clock.live, true);
  assert.equal(clock.instantMs, 456);
});

test('live hashes omit time and simulated hashes round-trip an instant', () => {
  const view = { preset: 'manhattan', bbox: null };
  const cam = { x: 1, y: 2, z: 3, angle: 4, pitch: 5 };
  const live = buildViewHash(view, cam);
  assert.doesNotMatch(live, /[&?]t=/);

  const sim = buildViewHash(view, cam, 1787288400123);
  assert.match(sim, /&t=1787288400123$/);
  assert.equal(parseInitialView(sim).instantMs, 1787288400123);
});

test('legacy h values are ignored because old live URLs wrote them', () => {
  const view = parseInitialView('#city=manhattan&h=16.25');
  assert.equal(view.instantMs, undefined);
});
