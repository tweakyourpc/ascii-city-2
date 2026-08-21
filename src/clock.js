/**
 * Simulation clock and loaded-city civil-time formatting.
 *
 * The instant is always an absolute Unix timestamp. A time zone is metadata
 * used only for display; astronomy and animation must never receive a shifted
 * "local" Date because that would apply the UTC offset twice.
 */

const TIMEZONE_URL = 'https://api.open-meteo.com/v1/forecast';
const TIMEOUT_MS = 8000;
const LIVE_WARP_MAX = 1.0001;
const zoneCache = new Map();

export function buildTimeZoneUrl(lat, lon) {
  return TIMEZONE_URL
    + `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
    + '&current=weather_code&timezone=auto&forecast_days=1';
}

/** Return a valid IANA time-zone identifier, or null. */
export function normalizeTimeZone(value) {
  const zone = typeof value === 'string' ? value.trim() : '';
  if (!zone) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0);
    return zone;
  } catch {
    return null;
  }
}

/** Resolve a coordinate to an IANA time zone through Open-Meteo. */
export async function fetchTimeZone(lat, lon, {
  signal, timeoutMs = TIMEOUT_MS,
  fetchImpl = (typeof fetch === 'function' ? fetch : null),
} = {}) {
  if (!fetchImpl) throw new Error('no fetch available');
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (zoneCache.has(key)) return zoneCache.get(key);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      throw new DOMException('Aborted', 'AbortError');
    }
    signal.addEventListener('abort', () => ctl.abort(), { once: true });
  }

  try {
    const res = await fetchImpl(buildTimeZoneUrl(lat, lon), { signal: ctl.signal });
    if (!res.ok) throw new Error(String(res.status));
    const json = await res.json();
    const zone = normalizeTimeZone(json?.timezone);
    if (!zone) throw new Error('no valid timezone in response');
    zoneCache.set(key, zone);
    return zone;
  } finally {
    clearTimeout(timer);
  }
}

/** Stable pieces for the HUD, independent of the browser's own time zone. */
export function formatCityTime(instantMs, timeZone = 'UTC') {
  const zone = normalizeTimeZone(timeZone) || 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    timeZoneName: 'short',
  }).formatToParts(new Date(instantMs));
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return {
    clock: `${get('hour')}:${get('minute')}`,
    date: `${get('weekday')} ${get('day')} ${get('month')} ${get('year')}`,
    zone: get('timeZoneName') || zone,
  };
}

/** Explicit LIVE/SIM state; never infer intent from clock drift. */
export class CityClock {
  constructor({ nowMs = Date.now(), mode = 'live', timeZone = 'UTC' } = {}) {
    this.mode = mode === 'sim' ? 'sim' : 'live';
    this.instantMs = nowMs;
    this.timeZone = normalizeTimeZone(timeZone) || 'UTC';
  }

  get live() { return this.mode === 'live'; }

  advance(dt, warpFactor, nowMs = Date.now()) {
    const warp = Number.isFinite(warpFactor) ? Math.max(1, warpFactor) : 1;
    if (this.live) {
      if (warp <= LIVE_WARP_MAX) {
        this.instantMs = nowMs;
        return;
      }
      this.mode = 'sim';
      // Date.now already includes the frame's normal passage of time. Add only
      // the accelerated portion when crossing from LIVE into SIM.
      this.instantMs = nowMs + Math.max(0, dt) * 1000 * (warp - 1);
      return;
    }
    this.instantMs += Math.max(0, dt) * 1000 * warp;
  }

  shiftHours(hours, nowMs = Date.now()) {
    if (!Number.isFinite(hours) || hours === 0) return;
    if (this.live) this.instantMs = nowMs;
    this.mode = 'sim';
    this.instantMs += hours * 3600000;
  }

  setSim(instantMs) {
    if (!Number.isFinite(instantMs)) return false;
    this.mode = 'sim';
    this.instantMs = instantMs;
    return true;
  }

  goLive(nowMs = Date.now()) {
    this.mode = 'live';
    this.instantMs = nowMs;
  }

  setTimeZone(timeZone) {
    this.timeZone = normalizeTimeZone(timeZone) || 'UTC';
  }
}

/** Test hook. */
export function _resetTimeZoneCache() {
  zoneCache.clear();
}
