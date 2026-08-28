const SERVICE = 'ascii-city-2-api';
const VERSION = '2.0.0';
let startedAt;
const RADIO_HOST = 'https://de1.api.radio-browser.info';
const RADIO_RADIUS_KM = 150;
const FT_PER_M = 3.28084;
const KT_PER_MS = 1.94384;
const UPSTREAM_UA = 'ascii-city-2/2.0 (https://github.com/tweakyourpc/ascii-city-2)';

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(value, status = 200, extra = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...cors, ...extra },
  });
}

function numberParam(url, name, min, max) {
  const value = Number(url.searchParams.get(name));
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function distanceKm(aLat, aLon, bLat, bLon) {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) *
    Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

/**
 * One OpenSky state vector as the `ac` record the client already reads.
 *
 * OpenSky publishes positional arrays in SI units; adsb.lol publishes objects
 * with altitudes in feet and speed in knots. Converting here keeps a provider
 * swap out of the client, and keeps every field either measured or null. A
 * missing value stays null rather than becoming a plausible number.
 */
function fromOpenSkyState(s) {
  if (!Array.isArray(s)) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const baroM = num(s[7]);
  const geomM = num(s[13]);
  const speed = num(s[9]);
  const onGround = s[8] === true;
  return {
    hex: typeof s[0] === 'string' ? s[0] : null,
    flight: typeof s[1] === 'string' ? s[1] : null,
    origin_country: typeof s[2] === 'string' ? s[2] : null,
    lon: num(s[5]),
    lat: num(s[6]),
    alt_geom: geomM === null ? null : Math.round(geomM * FT_PER_M),
    alt_baro: onGround ? 'ground' : (baroM === null ? null : Math.round(baroM * FT_PER_M)),
    gs: speed === null ? null : Math.round(speed * KT_PER_MS * 10) / 10,
    track: num(s[10]),
    squawk: typeof s[14] === 'string' ? s[14] : null,
    on_ground: onGround,
    t: null,
  };
}

/**
 * ADS-B upstreams, in preference order.
 *
 * adsb.lol and adsb.fi rate-limit or refuse Cloudflare's shared egress
 * addresses, so a Worker can be turned away through no fault of this service.
 * OpenSky answers from the same egress and backs the layer up when they do.
 * None of the three sends CORS headers a browser would accept, which is why
 * this proxy exists rather than the page calling them directly.
 */
const AIRCRAFT_UPSTREAMS = [
  {
    name: 'adsb.lol',
    url: (lat, lon, km, nm) => `https://api.adsb.lol/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/${nm}`,
    rows: (d) => (Array.isArray(d?.ac) ? d.ac : null),
  },
  {
    name: 'adsb.fi',
    url: (lat, lon, km, nm) => `https://opendata.adsb.fi/api/v2/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${nm}`,
    rows: (d) => (Array.isArray(d?.aircraft) ? d.aircraft : null),
  },
  {
    name: 'opensky',
    url: (lat, lon, km) => {
      const dLat = km / 111.32;
      const dLon = km / Math.max(1, 111.32 * Math.cos(lat * Math.PI / 180));
      const q = new URLSearchParams({
        lamin: (lat - dLat).toFixed(4), lamax: (lat + dLat).toFixed(4),
        lomin: (lon - dLon).toFixed(4), lomax: (lon + dLon).toFixed(4),
      });
      return `https://opensky-network.org/api/states/all?${q}`;
    },
    rows: (d) => (Array.isArray(d?.states)
      ? d.states.map(fromOpenSkyState).filter((a) => a && a.lat !== null && a.lon !== null)
      : null),
  },
];

async function aircraft(url) {
  const lat = numberParam(url, 'lat', -90, 90);
  const lon = numberParam(url, 'lon', -180, 180);
  const radiusKm = numberParam(url, 'radiusKm', 1, 100) ?? 30;
  if (lat === null || lon === null) return json({ error: 'invalid coordinates' }, 400);
  const radiusNm = Math.max(1, Math.round(radiusKm / 1.852));
  const tried = [];
  for (const provider of AIRCRAFT_UPSTREAMS) {
    let res;
    try {
      res = await fetch(provider.url(lat, lon, radiusKm, radiusNm), {
        // adsb.lol answers 403 to a request that sends no User-Agent, and the
        // Workers runtime does not supply a default one.
        headers: { 'user-agent': UPSTREAM_UA },
        cf: { cacheTtl: 10, cacheEverything: true },
      });
    } catch { tried.push({ provider: provider.name, status: 0 }); continue; }
    if (!res.ok) { tried.push({ provider: provider.name, status: res.status }); continue; }
    let rows = null;
    try { rows = provider.rows(await res.json()); } catch { rows = null; }
    if (!rows) { tried.push({ provider: provider.name, status: 200 }); continue; }
    // Normalize to the `ac` contract the client already reads, so swapping a
    // provider never becomes a client change.
    return json({ ac: rows, source: provider.name }, 200,
      { 'cache-control': 'public, max-age=10' });
  }
  // Report which upstreams refused rather than inventing an empty sky, which
  // the client would draw as "no aircraft here".
  return json({ error: 'aircraft upstream unavailable', tried }, 502);
}

async function radio(url) {
  const lat = numberParam(url, 'lat', -90, 90);
  const lon = numberParam(url, 'lon', -180, 180);
  if (lat === null || lon === null) return json({ error: 'invalid coordinates' }, 400);
  // Radio Browser filters by position itself. Asking it directly costs one
  // request instead of two and removes a rate-limited geocoder that answered
  // 403 under load; it also stops a country-or-state text match from deciding
  // which nearby stations are reachable.
  const q = new URLSearchParams({
    geo_lat: String(lat), geo_long: String(lon),
    geo_distance: String(RADIO_RADIUS_KM * 1000),
    has_geo_info: 'true', hidebroken: 'true', order: 'distance', limit: '300',
  });
  const res = await fetch(`${RADIO_HOST}/json/stations/search?${q}`,
    { headers: { 'user-agent': UPSTREAM_UA }, cf: { cacheTtl: 900 } });
  if (!res.ok) return json({ error: 'radio directory unavailable', upstreamStatus: res.status }, 502);
  const raw = await res.json();
  const candidates = (Array.isArray(raw) ? raw : [])
    .filter((s) => s.stationuuid && s.name && /^https:\/\//i.test(s.url_resolved || '') &&
      !/\.m3u8?(\?|$)/i.test(s.url_resolved || '') &&
      s.geo_lat !== null && s.geo_long !== null &&
      Number.isFinite(Number(s.geo_lat)) && Number.isFinite(Number(s.geo_long)))
    .map((s) => ({ ...s, distanceKm: distanceKm(lat, lon, Number(s.geo_lat), Number(s.geo_long)) }))
    .sort((a, b) => a.distanceKm - b.distanceKm);
  const stations = candidates
    .filter((s) => s.distanceKm <= RADIO_RADIUS_KM).slice(0, 12).map((s) => ({
      id: s.stationuuid, name: String(s.name).trim().slice(0, 80), url: s.url_resolved,
      country: s.country || '', language: s.language || '',
      distanceKm: Math.round(s.distanceKm * 10) / 10,
    }));
  return json({ radiusKm: RADIO_RADIUS_KM, stations }, 200,
    { 'cache-control': stations.length ? 'public, max-age=900' : 'public, max-age=300' });
}

async function clickStation(id) {
  if (!/^[a-f0-9-]{8,64}$/i.test(id)) return json({ error: 'invalid station id' }, 400);
  const res = await fetch(`${RADIO_HOST}/json/url/${encodeURIComponent(id)}`, { method: 'POST' });
  return json({ ok: res.ok }, res.ok ? 200 : 502);
}

/* ------------------------------- flock --------------------------------- */

const FLOCK_CDN = 'https://cdn.deflock.me/regions';
const FLOCK_TILE_DEG = 20;

/** The 20-degree region tile key covering a lat/lon. */
function flockTileKey(lat, lon) {
  const tLat = Math.floor(lat / FLOCK_TILE_DEG) * FLOCK_TILE_DEG;
  const tLon = Math.floor(lon / FLOCK_TILE_DEG) * FLOCK_TILE_DEG;
  return `${tLat}/${tLon}`;
}

/**
 * Fetch the DeFlock region index once per Worker instance to learn the current
 * tile version and which region tiles exist. Cached for an hour; the CDN itself
 * sends a 5-minute max-age, so this is a safe, cheap refresh.
 */
let flockIndex = null;
let flockIndexAt = 0;
async function flockIndexFetch() {
  const now = Date.now();
  if (flockIndex && now - flockIndexAt < 3600000) return flockIndex;
  const res = await fetch(`${FLOCK_CDN}/index.json`, {
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`index ${res.status}`);
  flockIndex = await res.json();
  flockIndexAt = now;
  return flockIndex;
}

async function flock(url) {
  const lat = numberParam(url, 'lat', -90, 90);
  const lon = numberParam(url, 'lon', -180, 180);
  const radiusKm = numberParam(url, 'radiusKm', 1, 500) ?? 30;
  if (lat === null || lon === null) return json({ error: 'invalid coordinates' }, 400);

  // A radius can span more than one 20-degree tile; fetch every tile the
  // bounding box touches and union the cameras, then filter by true distance.
  const mPerDegLat = 110540;
  const mPerDegLon = 111320 * Math.cos(lat * Math.PI / 180);
  const dLat = radiusKm * 1000 / mPerDegLat;
  const dLon = radiusKm * 1000 / mPerDegLon;
  const keys = new Set();
  keys.add(flockTileKey(lat, lon));
  keys.add(flockTileKey(lat + dLat, lon + dLon));
  keys.add(flockTileKey(lat - dLat, lon - dLon));
  keys.add(flockTileKey(lat + dLat, lon - dLon));
  keys.add(flockTileKey(lat - dLat, lon + dLon));

  let index;
  try {
    index = await flockIndexFetch();
  } catch {
    return json({ error: 'flock index unavailable' }, 502);
  }
  const available = new Set(index.regions || []);
  const version = index.v != null ? `?v=${index.v}` : '';
  const tileUrl = index.tile_url || `${FLOCK_CDN}/{lat}/{lon}.json${version}`;

  const cameras = [];
  for (const key of keys) {
    if (!available.has(key)) continue;
    try {
      const [tLat, tLon] = key.split('/');
      const u = tileUrl.replace('{lat}', tLat).replace('{lon}', tLon);
      const res = await fetch(u, { cf: { cacheTtl: 3600, cacheEverything: true } });
      if (!res.ok) continue;
      const list = await res.json();
      if (!Array.isArray(list)) continue;
      for (const c of list) {
        if (typeof c.lat !== 'number' || typeof c.lon !== 'number') continue;
        if (distanceKm(lat, lon, c.lat, c.lon) > radiusKm) continue;
        cameras.push(c);
      }
    } catch {
      // A single bad tile must not sink the whole query.
      continue;
    }
  }
  return json({ cameras }, 200, { 'cache-control': 'public, max-age=3600' });
}

export default {
  async fetch(request, _env) {
    startedAt ||= new Date().toISOString();
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/whoami') {
        return json({
          service: SERVICE, version: VERSION, pid: null, startedAt,
          host: url.hostname, port: Number(url.port) || 443,
        });
      }
       if (request.method === 'GET' && url.pathname === '/api/aircraft') return await aircraft(url);
       if (request.method === 'GET' && url.pathname === '/api/flock') return await flock(url);
       if (request.method === 'GET' && url.pathname === '/api/radio') return await radio(url);
      const click = /^\/api\/radio\/([^/]+)\/click$/.exec(url.pathname);
      if (request.method === 'POST' && click) return await clickStation(click[1]);
      return json({ error: 'not found' }, 404);
    } catch {
      return json({ error: 'upstream unavailable' }, 502);
    }
  },
};
