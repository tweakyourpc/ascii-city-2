import { col2str } from '../screen.js';
import { METERS_PER_CELL } from '../config.js';
import { GROUND_NAME, wind, bearingTo } from '../pick.js';
import { distanceKm } from '../aircraft.js';
import { summary as wikiSummary, wikiKeyFor } from '../wiki.js';

/**
 * The identify panel for v2, drawn in the character grid.
 *
 * Clicking a street, a building, the sky, or an aircraft shows a card. The
 * building card is the richest: it names the tower, its height and use, and —
 * when OpenStreetMap carries a Wikipedia or Wikidata tag — fetches a short
 * encyclopedia summary and a clickable link back to the article. The summary is
 * strictly additive: a fetch that fails or a building with no link simply shows
 * less, never an error, so the ASCII city never breaks its spell.
 */

const W = 46;
const MAX_ROWS = 28;
const MAX_SUMMARY_LINES = 12;

const TITLE = col2str(126, 231, 255);
const LABEL = col2str(58, 132, 152);
const VALUE = col2str(255, 212, 121);
const BODY = col2str(168, 196, 208);
const FRAME = col2str(40, 96, 112);
const LINK = col2str(120, 208, 255);

/** "residential" -> "Residential", for OSM tag values shown as prose. */
function titleCase(s) {
  return String(s).split(/[_;]/).map((w) =>
    w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
}

/** Greedy word-wrap a string to `width` columns, preserving words. */
function wrap(text, width) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (!w) continue;
    if (line && line.length + 1 + w.length > width) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export class Panel {
  constructor() {
    this.hit = null;
    this._layout = null;
  }

  select(hit) {
    this.hit = hit;
    this._layout = null;
    this._wiki = null;        // a fresh pick may name a different building
  }

  close() {
    this.hit = null;
    this._layout = null;
    this._wiki = null;
  }

  get open() { return this.hit !== null; }

  rect(screen) {
    const L = this._layout;
    if (!L) return null;
    const step = screen.rowStep || 1;
    return { x: L.x, y: L.y * step, w: L.w, h: L.h * step };
  }

  _lines(cam, world) {
    const hit = this.hit;
    const L = [];
    const kv = (k, v, url) => { if (v) L.push([k, v, url]); };

    if (hit.kind === 'building') {
      const b = hit.object;
      const tags = b.tags || {};
      const name = b.name || tags.name || 'Building';
      L.title = name;
      L.sub = tags.amenity || tags.office || tags.shop || tags.tourism
        || (tags.building && tags.building !== 'yes' ? titleCase(tags.building) : '');
      L.building = b;

      const metres = Math.round(b.h * METERS_PER_CELL);
      kv('Height', `${metres} m · ${Math.max(1, Math.round(b.h / 1.35))} floors`);
      if (tags['addr:street']) {
        const num = tags['addr:housenumber'] ? `${tags['addr:housenumber']} ` : '';
        kv('Address', `${num}${tags['addr:street']}`);
      }
      if (tags.amenity || tags.office || tags.shop || tags.tourism) {
        kv('Use', titleCase(tags.amenity || tags.office || tags.shop || tags.tourism));
      }
      if (hit.street && hit.street.on) kv('On', hit.street.on);

      // The building's own website, if OpenStreetMap records one. A clickable
      // link, like the Wikipedia and OSM links.
      if (tags.website) {
        const site = String(tags.website).trim();
        if (/^https?:\/\//i.test(site)) L.website = site;
      }

      // Wikipedia: fetch a short summary, and carry the article link so the
      // card can offer a clickable "read more" back to the encyclopedia. Look
      // up by an explicit tag first, then fall back to a name search, so named
      // buildings without a wikidata tag still get an article when one exists.
      const key = wikiKeyFor(tags, name);
      if (key) {
        const cached = this._wiki && this._wiki.key === key ? this._wiki : null;
        if (cached) {
          if (cached.value && cached.value.text) {
            L.summary = cached.value.text;
            L.wikiUrl = cached.value.url;
            L.wikiTitle = cached.value.title;
          }
        } else {
          this._wiki = { key, value: undefined };
          wikiSummary(key, (v) => {
            // Only adopt the result if the panel is still showing this building.
            if (this._wiki && this._wiki.key === key) this._wiki.value = v || null;
          });
        }
      } else {
        this._wiki = null;
      }

      L.footer = b.osm || '';
    } else if (hit.kind === 'weather') {
      L.title = hit.label || 'Weather';
      L.sub = 'current conditions';
      if (hit.tempC != null) {
        const f = Math.round(hit.tempC * 9 / 5 + 32);
        kv('Temp', `${Math.round(hit.tempC)}°C · ${f}°F`);
      }
      if (hit.humidity != null) kv('Humidity', `${Math.round(hit.humidity)}%`);
      if (hit.windKt != null) {
        const dir = hit.windDeg != null ? ` ${wind(hit.windDeg)}` : '';
        const ms = hit.windKt * 0.514444;
        kv('Wind', `${Math.round(hit.windKt)} kt · ${Math.round(ms)} m/s${dir}`);
      }
      if (hit.cloud != null) kv('Cloud', `${Math.round(hit.cloud)}%`);
      L.footer = '';
    } else if (hit.kind === 'ground') {
      const st = hit.street;
      L.title = st && st.on ? st.on : (GROUND_NAME[hit.type] || 'Ground');
      L.sub = st && st.cross ? `near ${st.cross}` : (GROUND_NAME[hit.type] || '');
      kv('Surface', GROUND_NAME[hit.type] || '-');
      kv('Distance', `${Math.round(hit.d * METERS_PER_CELL)} m · ` +
        `${wind(bearingTo(cam, hit.x, hit.y))}`);
      L.footer = world && world.label ? world.label : '';
    } else if (hit.kind === 'flock') {
      L.title = hit.manufacturer || 'ALPR camera';
      L.sub = 'license plate reader';
      if (hit.manufacturer) kv('Maker', hit.manufacturer);
      if (hit.operator) kv('Operator', hit.operator);
      if (hit.direction) kv('Faces', hit.direction);
      if (hit.lat != null && hit.lon != null) {
        kv('Coordinates', `${hit.lat.toFixed(4)}, ${hit.lon.toFixed(4)}`);
      }
      L.footer = 'DeFlock';
    } else if (hit.kind === 'quake') {
      L.title = `M ${hit.mag != null ? hit.mag.toFixed(1) : '?'}`;
      L.sub = 'earthquake';
      if (hit.place) kv('Place', hit.place);
      if (hit.mag != null) kv('Magnitude', `M${hit.mag.toFixed(1)}`);
      if (hit.depthKm != null) kv('Depth', `${hit.depthKm.toFixed(0)} km`);
      if (hit.time != null) {
        const ago = Date.now() - hit.time;
        const mins = Math.floor(ago / 60000);
        const when = mins >= 60
          ? `${Math.floor(mins / 60)}h ${mins % 60}m ago`
          : mins > 1 ? `${mins} min ago` : 'just now';
        kv('When', when);
      }
      if (hit.felt != null) kv('Felt reports', String(hit.felt));
      if (hit.lat != null && hit.lon != null) {
        kv('Coordinates', `${hit.lat.toFixed(3)}, ${hit.lon.toFixed(3)}`);
      }
      L.footer = 'USGS';
    } else if (hit.kind === 'aircraft') {
      const cs = hit.callsign || 'AIRCRAFT';
      L.title = cs;
      L.sub = hit.icao ? `ICAO ${hit.icao.toUpperCase()}` : 'live ADS-B';
      kv('Callsign', hit.callsign || '—');
      kv('ICAO', hit.icao ? hit.icao.toUpperCase() : '—');
      if (hit.altM != null) {
        kv('Altitude', `${Math.round(hit.altM * 3.2808399).toLocaleString('en-US')} ft`);
      }
      if (hit.gsKt != null) kv('Ground speed', `${Math.round(hit.gsKt)} kt`);
      if (hit.trackDeg != null) {
        kv('Heading', `${String(Math.round(hit.trackDeg)).padStart(3, '0')}° · ` +
          `${wind(hit.trackDeg)}`);
      }
      if (hit.lat != null && hit.lon != null && world && world.proj) {
        const d = distanceKm(hit.lat, hit.lon, world.proj.lat0, world.proj.lon0);
        kv('Distance', `${d.toFixed(1)} km`);
      }
      if (hit.type) kv('Type', hit.type);
      if (hit.originCountry) kv('Origin', hit.originCountry);
      if (hit.squawk) kv('Squawk', hit.squawk);
      // A factual tracker link, like the OSM link for ground picks. Unknown
      // aircraft simply have no such page; the link is omitted in that case.
      L.footer = hit.icao ? `icao/${hit.icao}` : '';
    } else {
      const o = hit.object;
      L.title = o ? o.name : 'Sky';
      L.sub = o ? o.kind : 'no catalogued object here';
      if (o && o.detail) kv('', o.detail);
      if (o && Number.isFinite(o.mag)) kv('Magnitude', o.mag.toFixed(2));
      kv('Altitude', `${hit.alt.toFixed(1)}°`);
      kv('Azimuth', `${hit.az.toFixed(1)}° · ${wind(hit.az)}`);
      L.footer = '';
    }
    return L;
  }

  linkAt(screen, col, row) {
    const L = this._layout;
    if (!L || !L.links) return null;
    const line = Math.floor(row / (screen.rowStep || 1));
    for (const k of L.links) {
      if (line === k.y && col >= k.x && col < k.x + k.w) return k.url;
    }
    return null;
  }

  draw(screen, cam, world) {
    if (!this.hit) return;

    const w = Math.min(W, screen.cols - 4);
    const inner = w - 4;
    const L = this._lines(cam, world);

    const rows = [];
    rows.push(['', FRAME]);
    rows.push([L.title.slice(0, inner).toUpperCase(), TITLE]);
    if (L.sub) rows.push([L.sub.slice(0, inner), LABEL]);
    rows.push(['', null]);
    for (const [k, v, url] of L) {
      rows.push([k ? `${k.padEnd(10)}${v}` : v, url ? LINK : (k ? VALUE : BODY), k, url]);
    }
    // A building's encyclopedia summary, wrapped to the card width. The link
    // line below it is clickable, so the reader can leave for the full article.
    if (L.summary) {
      rows.push(['', null]);
      const lines = wrap(L.summary, inner);
      for (let i = 0; i < lines.length && i < MAX_SUMMARY_LINES; i++) {
        rows.push([lines[i], BODY]);
      }
      if (L.wikiUrl) {
        const label = `Wikipedia: ${L.wikiTitle || 'article'}`.slice(0, inner);
        rows.push([label, LINK, null, L.wikiUrl]);
      }
      if (L.website) {
        const host = (() => { try { return new URL(L.website).host; } catch { return L.website; } })();
        const label = `Website: ${host}`.slice(0, inner);
        rows.push([label, LINK, null, L.website]);
      }
    } else if (L.building && this._wiki && this._wiki.key && this._wiki.value === undefined) {
      // A fetch is in flight for this building: show a quiet placeholder rather
      // than nothing, so the card does not look broken mid-lookup.
      rows.push(['', null]);
      rows.push(['Looking up Wikipedia\u2026', LABEL]);
    }
    rows.push(['', null]);
    rows.push([`${L.footer}`.slice(0, inner - 12), FRAME, null,
      /^(node|way|relation)\/\d+$/.test(String(L.footer))
        ? `https://www.openstreetmap.org/${L.footer}`
        : /^icao\/[0-9a-f]+$/.test(String(L.footer))
        ? `https://globe.adsbexchange.com/?icao=${String(L.footer).slice(5)}`
        : null]);

    const h = Math.min(MAX_ROWS, rows.length + 2, screen.outRows - 2);
    const x = 2;
    const y = screen.outRows - h - 1;
    const links = [];
    this._layout = { x, y, w, h, links };

    screen.scrim(x, y, w, h, 'rgba(4,10,14,0.90)');
    screen.clearBox(x, y, w, h);

    const bar = '-'.repeat(w - 2);
    screen.text(x, y, `+${bar}+`, FRAME);
    screen.text(x, y + h - 1, `+${bar}+`, FRAME);
    for (let r = 1; r < h - 1; r++) {
      screen.text(x, y + r, '|', FRAME);
      screen.text(x + w - 1, y + r, '|', FRAME);
    }
    screen.text(x + w - 12, y + h - 1, ' [esc] close ', FRAME);

    for (let r = 0; r < rows.length && r < h - 2; r++) {
      const [text, colour, key, url] = rows[r];
      if (!text) continue;
      if (key) {
        screen.text(x + 2, y + 1 + r, key.padEnd(10), LABEL);
        screen.text(x + 12, y + 1 + r, text.slice(10, inner), colour);
        if (url) links.push({ x: x + 12, y: y + 1 + r, w: text.slice(10, inner).length, url });
      } else {
        const cut = text.slice(0, inner);
        screen.text(x + 2, y + 1 + r, cut, colour);
        if (url) links.push({ x: x + 2, y: y + 1 + r, w: cut.length, url });
      }
    }
  }
}
