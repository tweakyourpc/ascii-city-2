/**
 * Wikipedia summaries for buildings that carry a wikidata or wikipedia tag.
 *
 * Strictly additive. The panel is complete without this, so every failure path
 * ends in "show nothing extra" rather than in an error message. A red "could
 * not reach Wikipedia" inside an ASCII city is exactly the kind of thing that
 * spoils the illusion, and it tells the reader nothing they can act on.
 *
 * Both endpoints send Access-Control-Allow-Origin: *, so this works from a
 * browser with no proxy and no key.
 */

const CACHE = new Map();              // key -> { text } | null
// Version 3 invalidates the old bare-name search cache. Those searches had no
// geographic constraint, so a Sarasota building could retain a Miami article
// for 30 days. Only explicit OSM wikipedia/wikidata links are cached now.
const LS_PREFIX = 'ascii-city:wiki:3:';
const TTL_MS = 30 * 24 * 3600 * 1000;
const TIMEOUT_MS = 6000;
const MAX_CHARS = 600;

let failures = 0;
let coolUntil = 0;
let inFlight = null;

/** The cache key for a tag set, or null if there is nothing to look up. */
export function wikiKey(tags) {
  if (!tags) return null;
  if (tags.wikipedia) return `w:${tags.wikipedia}`;
  if (tags.wikidata) return `q:${tags.wikidata}`;
  return null;
}

/**
 * The key to look up for a building. Geographic identity must come from an
 * explicit OpenStreetMap wikipedia/wikidata tag. A bare name is not enough:
 * chains, churches, and apartment names routinely resolve to another city.
 */
export function wikiKeyFor(tags, _name) {
  return wikiKey(tags);
}

function readLS(key) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || Date.now() - v.at > TTL_MS) return null;
    return v;
  } catch {
    return null;
  }
}

function writeLS(key, value) {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify({ ...value, at: Date.now() }));
  } catch {
    // Quota. Drop our own entries and try once more; a cache miss is not
    // worth failing over.
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith(LS_PREFIX)) localStorage.removeItem(k);
      }
      localStorage.setItem(LS_PREFIX + key, JSON.stringify({ ...value, at: Date.now() }));
    } catch { /* give up quietly */ }
  }
}

async function getJson(url, signal) {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

/** "en:Empire State Building" -> { lang, title }. */
function splitWikipediaTag(v) {
  const m = /^([a-z-]{2,12}):(.+)$/i.exec(v);
  return m ? { lang: m[1].toLowerCase(), title: m[2] } : { lang: 'en', title: v };
}

async function resolve(key, signal) {
  if (key.startsWith('w:')) return splitWikipediaTag(key.slice(2));

  // Wikidata Q-id: resolve to an article title first. `origin=*` is what makes
  // the Action API send CORS headers.
  const qid = key.slice(2);
  const url = 'https://www.wikidata.org/w/api.php?action=wbgetentities'
            + `&ids=${encodeURIComponent(qid)}&props=sitelinks`
            + '&sitefilter=enwiki&format=json&origin=*';
  const j = await getJson(url, signal);
  const title = j?.entities?.[qid]?.sitelinks?.enwiki?.title;
  if (!title) throw new Error('no enwiki sitelink');
  return { lang: 'en', title };
}

async function fetchSummary(key, signal) {
  const { lang, title } = await resolve(key, signal);
  const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/`
            + encodeURIComponent(title.replace(/ /g, '_'));
  const j = await getJson(url, signal);
  const text = (j && j.extract) ? String(j.extract).slice(0, MAX_CHARS) : '';
  if (!text) throw new Error('no extract');
  // The summary is a teaser, so carry the article back with it. The REST
  // response already names its own canonical page; the constructed form is
  // only a fallback, built from what resolve() has already worked out.
  const page = j?.content_urls?.desktop?.page
    || `https://${lang}.wikipedia.org/wiki/`
       + encodeURIComponent((j.title || title).replace(/ /g, '_'));
  return { text, title: j.title || title, url: page };
}

/**
 * Look up a summary. Calls back with `{text}` or with null.
 * Only ever called on a pick, never from the per-frame label pass.
 */
export function summary(key, done) {
  if (!key) { done(null); return; }

  if (CACHE.has(key)) { done(CACHE.get(key)); return; }

  const cached = readLS(key);
  if (cached) { CACHE.set(key, cached); done(cached); return; }

  if (typeof fetch !== 'function') { done(null); return; }
  if (typeof navigator === 'object' && navigator && navigator.onLine === false) {
    done(null);
    return;
  }
  if (Date.now() < coolUntil) { done(null); return; }

  if (inFlight) inFlight.abort();
  const ctl = new AbortController();
  inFlight = ctl;
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);

  fetchSummary(key, ctl.signal)
    .then((v) => {
      failures = 0;
      CACHE.set(key, v);
      writeLS(key, v);
      done(v);
    })
    .catch(() => {
      if (!ctl.signal.aborted) {
        CACHE.set(key, null);        // a genuine miss: do not ask again
        if (++failures >= 2) coolUntil = Date.now() + 60000;
      }
      done(null);
    })
    .finally(() => {
      clearTimeout(timer);
      if (inFlight === ctl) inFlight = null;
    });
}

/** Test hook. */
export function _reset() {
  CACHE.clear();
  failures = 0;
  coolUntil = 0;
  if (inFlight) inFlight.abort();
  inFlight = null;
}
