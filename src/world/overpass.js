/**
 * Overpass API client.
 *
 * Overpass is a free, volunteer-run service. Everything here is shaped by that:
 * a small bounding-box cap so a stray query cannot ask for a country, a cache
 * so panning back to a city costs nothing, endpoint fallback, and a hard
 * timeout instead of an indefinite hang.
 *
 * Overpass sends Access-Control-Allow-Origin: *, so this works from a browser
 * with no proxy.
 */

/**
 * Public instances are individually unreliable, and which one is healthy
 * varies by the minute. Measured 2026-08-17: overpass-api.de answered in 1.7s
 * while private.coffee and kumi.systems both returned 504 after 32s, each with
 * fifteen queries backed up server-side. Treat this list as a point-in-time
 * sample, not a ranking. See orderEndpoints() for how health is learned at
 * runtime rather than hard-coded here.
 *
 * Two traps, both of which cost real debugging time:
 *
 * Regional mirrors such as overpass.osm.ch answer 200 with zero elements for
 * anywhere outside their coverage, which is indistinguishable from genuinely
 * empty map data. Only worldwide instances belong here.
 *
 * overpass.osm.jp and overpass.nchc.org.tw serve correct worldwide data but
 * send no Access-Control-Allow-Origin, so a browser cannot read the response.
 * They look fine from curl and fail from the page.
 */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  // Corporate mirror with no published usage policy, and blocked on some
  // school and corporate networks. Last, so a false positive there costs one
  // extra attempt rather than a failed load.
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

/**
 * Buildings and streets are worth waiting for; water and parks are not. The
 * extra layers also get a single attempt rather than the full fallback, which
 * is what keeps a bad minute from turning into four minutes of loading screen.
 */
const CORE_TIMEOUT_MS = 45000;
const EXTRA_TIMEOUT_MS = 20000;

/**
 * How long a failure is held against an instance. Saturation is a property of
 * the last few minutes, so these are deliberately short, and deliberately kept
 * in memory only: persisting them could strand a user whose own network
 * blipped once.
 */
const COOL_BUSY_MS = 10 * 60 * 1000;
const COOL_RATE_MS = 60 * 1000;
const COOL_EMPTY_MS = 6 * 60 * 60 * 1000;

/** Success, by contrast, is worth remembering across a reload. */
const GOOD_KEY = 'ascii-city:overpass-good:1';
const GOOD_TTL_MS = 6 * 60 * 60 * 1000;

// Some instances rate-limit requests that arrive without a meaningful
// User-Agent. Browsers set their own and silently ignore this header; it is
// here so the engine is a good citizen when driven from Node, in tests and
// from tools/.
const UA = 'ascii-city/0.3 (+https://github.com/tweakyourpc/ascii-city)';
const CACHE_PREFIX = 'ascii-city:osm:';
const CACHE_VERSION = 2;

/** Largest bbox we will ask for, in square degrees. About 2km x 2km at 40N. */
export const MAX_BBOX_DEG2 = 0.0006;

/**
 * Preset cities. Boxes are around 1.2km a side: big enough to fly across,
 * small enough that Overpass answers in a few seconds.
 */
export const PRESETS = {
  procedural: { label: 'Procedural City', bbox: null },
  demo: {
    label: 'Demo City (offline)',
    bbox: [40.7400, -73.9900, 40.7520, -73.9750],
    demo: true,
  },
  manhattan: {
    label: 'Manhattan (Midtown)',
    bbox: [40.7466, -73.9900, 40.7576, -73.9750],
  },
  tokyo: {
    label: 'Tokyo (Shinjuku)',
    bbox: [35.6870, 139.6970, 35.6980, 139.7120],
  },
  london: {
    label: 'London (The City)',
    bbox: [51.5100, -0.0920, 51.5210, -0.0760],
  },
  paris: {
    label: 'Paris (Louvre)',
    bbox: [48.8580, 2.3300, 48.8690, 2.3460],
  },
};

/**
 * The query is split in two.
 *
 * Buildings and streets are what make a city recognisable, so they are fetched
 * as one required request. Water and green space are a separate best-effort
 * request: they improve the scene but a slow or failing instance must not stop
 * the city from loading.
 *
 * `out geom` inlines coordinates on ways and on relation members, so there is
 * no second pass to resolve node ids.
 *
 * `timeoutSec` is the server's own budget. It must not outlive the client's,
 * or aborting the fetch leaves the instance computing a result nobody will
 * ever read.
 */
export function buildQuery([s, w, n, e], layer = 'core', timeoutSec = 60) {
  const bbox = `${s},${w},${n},${e}`;
  const t = Math.max(5, Math.round(timeoutSec));
  if (layer === 'core') {
    return `[out:json][timeout:${t}];
(
  nwr["building"](${bbox});
  way["highway"](${bbox});
  node["highway"="traffic_signals"](${bbox});
);
out geom;`;
  }
  if (layer === 'poi') {
    return `[out:json][timeout:${t}];
(
  node["amenity"]["name"](${bbox});
  node["shop"]["name"](${bbox});
  node["tourism"]["name"](${bbox});
  node["railway"="subway_entrance"](${bbox});
);
out;`;
  }
  return `[out:json][timeout:${t}];
(
  way["waterway"~"^(river|canal|stream)$"](${bbox});
  nwr["natural"="water"](${bbox});
  nwr["leisure"~"^(park|garden|pitch)$"](${bbox});
  nwr["landuse"~"^(grass|forest|meadow|farmland|cemetery)$"](${bbox});
);
out geom;`;
}

export function bboxArea([s, w, n, e]) {
  return Math.abs(n - s) * Math.abs(e - w);
}

/**
 * Parse a user-supplied location string.
 * Accepts "s,w,n,e", a bare "lat,lon" (a box is built around it), or an
 * openstreetmap.org URL with a #map=zoom/lat/lon fragment.
 */
export function parseLocation(text, { spanDeg = 0.011 } = {}) {
  const raw = String(text).trim();
  if (!raw) return null;

  const osm = /#map=[\d.]+\/(-?[\d.]+)\/(-?[\d.]+)/.exec(raw);
  if (osm) return boxAround(Number(osm[1]), Number(osm[2]), spanDeg);

  const nums = raw.split(/[\s,]+/).map(Number).filter((v) => !Number.isNaN(v));

  if (nums.length === 4) {
    const [a, b, c, d] = nums;
    // Accept either corner ordering.
    const box = [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
    return validBox(box) ? box : null;
  }
  if (nums.length === 2) {
    const [lat, lon] = nums;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return boxAround(lat, lon, spanDeg);
  }
  return null;
}

/** Default span of a box built around a point, in degrees of latitude. */
export const DEFAULT_SPAN_DEG = 0.011;

/**
 * A loadable box centred on a point. Exported because the geocoder needs the
 * same span logic: a place name resolves to a point, and everything downstream
 * expects a box the size the engine can actually render.
 */
export function boxAround(lat, lon, spanDeg = DEFAULT_SPAN_DEG) {
  // Keep the box roughly square on the ground, not in degrees.
  const half = spanDeg / 2;
  const lonHalf = half / Math.max(0.2, Math.cos(lat * Math.PI / 180));
  const box = [lat - half, lon - lonHalf, lat + half, lon + lonHalf];
  return validBox(box) ? box : null;
}

function validBox([s, w, n, e]) {
  return Math.abs(s) <= 90 && Math.abs(n) <= 90
      && Math.abs(w) <= 180 && Math.abs(e) <= 180
      && n > s && e > w;
}

const cacheKey = (bbox) =>
  CACHE_PREFIX + CACHE_VERSION + ':' + bbox.map((v) => v.toFixed(5)).join(',');

function readCache(bbox) {
  try {
    const hit = localStorage.getItem(cacheKey(bbox));
    return hit ? JSON.parse(hit) : null;
  } catch {
    return null;
  }
}

function writeCache(bbox, data) {
  try {
    localStorage.setItem(cacheKey(bbox), JSON.stringify(data));
  } catch {
    // Quota exceeded, or storage disabled. Drop our own old entries and retry
    // once; a cache miss is not worth failing a load over.
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
      }
      localStorage.setItem(cacheKey(bbox), JSON.stringify(data));
    } catch { /* give up silently */ }
  }
}

/**
 * Keep only what the rasterizer reads.
 *
 * Retain way node ids: they are the only reliable way to distinguish a true
 * connected junction from a bridge or tunnel crossing at the same coordinate.
 */
function slim(elements) {
  const out = [];
  for (const el of elements) {
    if (!el.tags) continue;
    const o = { type: el.type, id: el.id, tags: el.tags };
    // Standalone POI nodes carry lat/lon rather than a geometry array. Without
    // this they are dropped here and the POI layer silently fetches nothing.
    if (el.type === 'node' && el.lat !== undefined) {
      o.lat = el.lat;
      o.lon = el.lon;
    }
    if (el.geometry) o.geometry = el.geometry;
    if (el.nodes) o.nodes = el.nodes;
    if (el.members) {
      const rings = el.members.filter((m) => m.geometry && m.geometry.length > 2);
      if (rings.length) o.members = rings.map((m) => ({ role: m.role, geometry: m.geometry }));
    }
    if (o.geometry || o.members || o.lat !== undefined) out.push(o);
  }
  return out;
}

const shuffled = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/* ------------------------------ endpoint health -------------------------- */

/** Just the host, for error messages that name instances rather than URLs. */
function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

/**
 * Remember success, forget failure.
 *
 * The old code shuffled the endpoint list afresh on every query. With three
 * layers per load that is three independent rolls of the dice, so layers two
 * and three cheerfully re-tried mirrors that had 504'd seconds earlier in the
 * same load. Against one healthy instance of four that is most of a minute of
 * pure waste, and if the healthy one happened to hiccup, a failed load.
 *
 * The asymmetry is deliberate. A success is a durable-ish fact worth carrying
 * across a reload; a failure is a statement about the last few minutes and
 * lives in memory only.
 */
const cooling = new Map();      // url -> epoch ms when it may be tried freely

/** Overridable so tests never wait on a real clock. */
let sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function _setSleep(fn) { sleep = fn; }

export function _resetHealth() {
  cooling.clear();
  try { localStorage.removeItem(GOOD_KEY); } catch { /* storage disabled */ }
}

function stickyGood() {
  try {
    const raw = localStorage.getItem(GOOD_KEY);
    if (!raw) return null;
    const { url, at } = JSON.parse(raw);
    if (!url || Date.now() - at > GOOD_TTL_MS) return null;
    // A list edit must not strand us on an endpoint we no longer ship.
    return ENDPOINTS.includes(url) ? url : null;
  } catch {
    return null;
  }
}

function markGood(url) {
  cooling.delete(url);
  try {
    localStorage.setItem(GOOD_KEY, JSON.stringify({ url, at: Date.now() }));
  } catch { /* storage disabled or full; the in-memory path still works */ }
}

function markBad(url, coolMs) {
  cooling.set(url, Date.now() + coolMs);
}

/**
 * Healthy endpoints first, cooling ones after, and never drop any: if
 * everything is cooling, trying them in order of soonest expiry still beats
 * refusing to load.
 *
 * The shuffle survives for the first pick. It exists so users spread
 * themselves across volunteer instances, and dropping it entirely would funnel
 * everybody onto whichever one this file happens to list first.
 */
export function _orderEndpoints(now = Date.now()) {
  const warm = [];
  const cold = [];
  for (const url of ENDPOINTS) {
    const until = cooling.get(url) ?? 0;
    (until > now ? cold : warm).push(url);
  }

  const first = stickyGood();
  const head = first && warm.includes(first) ? [first] : [];
  const rest = shuffled(warm.filter((u) => u !== head[0]));
  cold.sort((a, b) => cooling.get(a) - cooling.get(b));

  return [...head, ...rest, ...cold];
}

/**
 * What a response means for the instance that sent it, in one place rather
 * than spread across a chain of ifs.
 */
function classify(res) {
  if (res.ok) return { kind: 'ok' };
  if (res.status === 429) return { kind: 'rate', coolMs: COOL_RATE_MS };
  if (res.status === 503 || res.status === 504) {
    return { kind: 'busy', coolMs: COOL_BUSY_MS };
  }
  // Any other 4xx is our bug, not theirs. Sending the same malformed query on
  // to three more volunteer servers helps nobody.
  if (res.status >= 400 && res.status < 500) return { kind: 'fatal' };
  return { kind: 'busy', coolMs: COOL_BUSY_MS };
}

/** Honour Retry-After when it is sane, otherwise back off a fixed moment. */
function retryDelay(res) {
  const raw = Number(res.headers?.get?.('Retry-After'));
  if (Number.isFinite(raw) && raw > 0) return Math.min(10000, Math.max(1000, raw * 1000));
  return 4000;
}

/** One honest sentence about why nothing loaded, built from every attempt. */
function describe(causes) {
  if (!causes.length) return { message: 'Could not reach Overpass' };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { message: 'You appear to be offline.', hint: 'Reconnect, then press R to retry.' };
  }
  const every = (k) => causes.every((c) => c.kind === k);
  if (every('empty')) {
    return {
      message: 'No Overpass mirror has data for this area.',
      hint: 'Try somewhere else, or press P for the procedural city.',
    };
  }
  if (every('busy') || every('rate')) {
    return {
      message: `All ${causes.length} Overpass mirrors are busy right now.`,
      hint: 'Press R to retry · P for the procedural city.',
    };
  }
  return {
    message: 'Could not reach any Overpass mirror.',
    hint: 'Press R to retry · P for the procedural city.',
  };
}

/**
 * Run one query, trying instances until one answers.
 * @param {boolean} expectData treat an empty 200 as a failed instance and move
 *   on, rather than as an answer. Guards against a mirror that is up but does
 *   not hold data for the requested area.
 * @param {number} maxEndpoints how far down the list to fall. The expendable
 *   layers pass 1, so a bad minute costs one timeout instead of four.
 */
async function runQuery(query, {
  onProgress, signal, label, expectData = false,
  timeoutMs = CORE_TIMEOUT_MS, maxEndpoints = ENDPOINTS.length,
}) {
  const urls = _orderEndpoints().slice(0, maxEndpoints);
  // Every attempt, not just the last one: "that instance is busy" was a lie
  // whenever all of them failed, and it gave the user nothing to act on.
  const causes = [];

  const once = async (url) => {
    // An already-aborted signal would never fire the relay below, so it has to
    // be checked rather than merely listened for.
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(), timeoutMs);
    const relay = () => timer.abort();
    if (signal) signal.addEventListener('abort', relay, { once: true });
    try {
      return await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA,
        },
        signal: timer.signal,
      });
    } finally {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', relay);
    }
  };

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const host = hostOf(url);
    onProgress(i === 0 ? `Querying ${label}` : `Retrying ${label} (${i + 1}/${urls.length})`);

    try {
      let res = await once(url);
      let verdict = classify(res);

      // A 429 means "wait", not "you are broken". Give it exactly one more
      // chance on the same instance before moving on; more than that would be
      // hammering something that has just asked us not to.
      if (verdict.kind === 'rate') {
        await sleep(retryDelay(res));
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        res = await once(url);
        verdict = classify(res);
      }

      if (verdict.kind === 'fatal') {
        markGood(url);      // it answered us; the query is what is wrong
        throw new Error(`Overpass rejected the query (${res.status})`);
      }
      if (verdict.kind !== 'ok') {
        markBad(url, verdict.coolMs);
        causes.push({ host, kind: verdict.kind });
        continue;
      }

      const json = await res.json();
      const elements = json.elements || [];
      if (expectData && elements.length === 0) {
        // Up, but holds nothing here. Ask somebody else before concluding the
        // area is empty. This is a coverage property, not a transient one, so
        // it earns a long cooldown.
        markBad(url, COOL_EMPTY_MS);
        causes.push({ host, kind: 'empty' });
        continue;
      }
      markGood(url);
      return elements;
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err.name !== 'AbortError' && !/^Overpass rejected/.test(err.message)) {
        // A network TypeError: DNS, CORS, or offline.
        markBad(url, COOL_BUSY_MS);
        causes.push({ host, kind: 'network' });
        continue;
      }
      if (err.name === 'AbortError') {
        // Our own timer. No retry: the instance is still computing, so asking
        // again immediately only adds to the queue that made us time out.
        markBad(url, COOL_BUSY_MS);
        causes.push({ host, kind: 'busy' });
        continue;
      }
      throw err;
    }
  }

  const { message, hint } = describe(causes);
  const err = new Error(message);
  err.causes = causes;
  if (hint) err.hint = hint;
  throw err;
}

/**
 * Fetch OSM elements for a bounding box.
 * @param {number[]} bbox [south, west, north, east]
 * @param {{ onProgress?: (msg: string) => void, signal?: AbortSignal }} opts
 * @returns {Promise<Array>} OSM elements with inline geometry
 */
export async function fetchOsm(bbox, { onProgress = () => {}, signal } = {}) {
  if (!validBox(bbox)) throw new Error('Invalid bounding box');

  const area = bboxArea(bbox);
  if (area > MAX_BBOX_DEG2) {
    const times = (area / MAX_BBOX_DEG2).toFixed(1);
    throw new Error(
      `Area is ${times}x the limit. Try a smaller box (about 2km a side).`);
  }

  const cached = readCache(bbox);
  if (cached) {
    onProgress('Loaded from cache');
    return cached;
  }

  const coreSec = Math.floor(CORE_TIMEOUT_MS / 1000);
  const extraSec = Math.floor(EXTRA_TIMEOUT_MS / 1000);

  const core = await runQuery(buildQuery(bbox, 'core', coreSec),
    { onProgress, signal, label: 'buildings and streets', expectData: true,
      timeoutMs: CORE_TIMEOUT_MS });

  // Best effort. A missing river is worth far less than a failed load, so
  // these get one attempt on a short budget, and because the core query just
  // marked a winner, that one attempt is the instance that has already
  // answered us seconds ago.
  const bestEffort = async (layer, label) => {
    try {
      return await runQuery(buildQuery(bbox, layer, extraSec),
        { onProgress, signal, label, timeoutMs: EXTRA_TIMEOUT_MS, maxEndpoints: 1 });
    } catch (err) {
      if (signal?.aborted) throw err;
      onProgress(`Skipped ${label}`);
      return [];
    }
  };

  const extra = await bestEffort('detail', 'water and parks');
  const pois = await bestEffort('poi', 'places');

  const elements = slim(core.concat(extra, pois));
  writeCache(bbox, elements);
  return elements;
}
