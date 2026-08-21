const SERVICE = 'ascii-city-2-api';
const VERSION = '2.0.0';
let startedAt;
const RADIO_HOST = 'https://de1.api.radio-browser.info';

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

async function regionFor(lat, lon) {
  const q = new URLSearchParams({
    format: 'jsonv2', lat: String(lat), lon: String(lon), zoom: '5',
    addressdetails: '1',
  });
  const res = await fetch(`https://nominatim.openstreetmap.org/reverse?${q}`, {
    headers: { 'user-agent': 'ascii-city-2/2.0 (https://github.com/tweakyourpc/ascii-city-2)' },
    cf: { cacheTtl: 86400, cacheEverything: true },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return {
    countrycode: String(data.address?.country_code || '').toUpperCase(),
    state: data.address?.state || data.address?.region || '',
  };
}

async function aircraft(url) {
  const lat = numberParam(url, 'lat', -90, 90);
  const lon = numberParam(url, 'lon', -180, 180);
  const radiusKm = numberParam(url, 'radiusKm', 1, 100) ?? 30;
  if (lat === null || lon === null) return json({ error: 'invalid coordinates' }, 400);
  const radiusNm = Math.max(1, Math.round(radiusKm / 1.852));
  const upstream = `https://api.adsb.lol/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/${radiusNm}`;
  const res = await fetch(upstream);
  if (!res.ok) return json({ error: 'aircraft upstream unavailable', upstreamStatus: res.status }, 502);
  return new Response(await res.text(), {
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=10', ...cors },
  });
}

async function radio(url) {
  const lat = numberParam(url, 'lat', -90, 90);
  const lon = numberParam(url, 'lon', -180, 180);
  if (lat === null || lon === null) return json({ error: 'invalid coordinates' }, 400);
  const region = await regionFor(lat, lon);
  if (!region?.countrycode) return json({ error: 'could not resolve region' }, 502);
  const searches = region.state ? [{ state: region.state, stateExact: 'true' }, {}] : [{}];
  let candidates = [];
  for (const area of searches) {
    const q = new URLSearchParams({
      countrycode: region.countrycode, has_geo_info: 'true', is_https: 'true',
      hidebroken: 'true', order: 'votes', reverse: 'true', limit: '1000', ...area,
    });
    const res = await fetch(`${RADIO_HOST}/json/stations/search?${q}`,
      { headers: { 'user-agent': 'ascii-city-2/2.0' }, cf: { cacheTtl: 900 } });
    if (!res.ok) continue;
    const raw = await res.json();
    candidates = raw
      .filter((s) => s.stationuuid && s.name && /^https:\/\//i.test(s.url_resolved || '') &&
        !/\.m3u8?(\?|$)/i.test(s.url_resolved || '') &&
        Number.isFinite(Number(s.geo_lat)) && Number.isFinite(Number(s.geo_long)))
      .map((s) => ({ ...s, distanceKm: distanceKm(lat, lon, Number(s.geo_lat), Number(s.geo_long)) }))
      .sort((a, b) => a.distanceKm - b.distanceKm);
    if (candidates.length) break;
  }
  for (const radiusKm of [50, 150, 300]) {
    const stations = candidates.filter((s) => s.distanceKm <= radiusKm).slice(0, 12).map((s) => ({
      id: s.stationuuid, name: String(s.name).trim().slice(0, 80), url: s.url_resolved,
      country: s.country || '', language: s.language || '',
      distanceKm: Math.round(s.distanceKm * 10) / 10,
    }));
    if (stations.length) return json({ radiusKm, stations }, 200,
      { 'cache-control': 'public, max-age=900' });
  }
  return json({ radiusKm: 300, stations: [] }, 200, { 'cache-control': 'public, max-age=300' });
}

async function clickStation(id) {
  if (!/^[a-f0-9-]{8,64}$/i.test(id)) return json({ error: 'invalid station id' }, 400);
  const res = await fetch(`${RADIO_HOST}/json/url/${encodeURIComponent(id)}`, { method: 'POST' });
  return json({ ok: res.ok }, res.ok ? 200 : 502);
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
      if (request.method === 'GET' && url.pathname === '/api/radio') return await radio(url);
      const click = /^\/api\/radio\/([^/]+)\/click$/.exec(url.pathname);
      if (request.method === 'POST' && click) return await clickStation(click[1]);
      return json({ error: 'not found' }, 404);
    } catch {
      return json({ error: 'upstream unavailable' }, 502);
    }
  },
};
