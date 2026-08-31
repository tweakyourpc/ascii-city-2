---
title: "Aircraft as oriented solids, and airfield surfaces"
created_at: "2026-08-30T23:30:00.000000+00:00"
type: "pending-writeback"
---

# Summary

Reported from the ground at ORD: approaching traffic dropped in elevation as it should, but the glyph never grew and no aircraft was ever seen to land. Four separate causes, none of them the one the symptom suggested.

1. There was no sprite at all. `aircraft.js` painted one `screen.set(cx, cy, '✈')` per contact at every range. Distance changed only the fog colour and the draw order.
2. Low and surface traffic was discarded twice: `normalizeAc` returned null because `alt_baro` is the string `'ground'` and `altM` came out `NaN`, and a separate `AIR_ALT_MIN_M = 30` gate dropped anything under about 98 ft. An arrival left the layer entirely on short final.
3. `aeroway` appeared nowhere in the Overpass query, so an `aeroway=runway` way matched none of the five tag keys the classifier tests and was counted as skipped. There was no runway in the world to land on.
4. The layer read the depth buffer but wrote with `screen.set`, leaving depth at its cleared value. Planes could not occlude anything and could not be picked.

A fifth defect surfaced while tracing: the aircraft, weather, quake and flock click handlers in `main.js` were unreachable. They sat behind `if (!hit)`, and `pick()` returns null only for an out-of-bounds cell, so an in-bounds click on empty sky returned a truthy `{ kind: 'sky' }` and the branch never ran.

# Rules

- ADS-B already carries the ICAO type designator in `t` and the tail number in `r`. No registration lookup service is needed or useful; the only provider missing the type is the OpenSky fallback, which is also missing the registration, so there would be nothing to key on. The emitter `category` is the fallback there.
- Ingest reports what the feed says. Filtering belongs in the draw path, where a budget can be spent nearest-first, not at the point where data enters.
- A filled quad only paints where a cell centre falls inside it. A wing seen head-on is hundredths of a row tall and vanishes entirely however wide it is, so thin structure must be stroked, not filled. This is the single most important thing about drawing anything slender in a character grid.
- Airfield surfaces must never reach `roadCells` or `world.roads`. That pool is what `spawn()` and `randomRoadCell()` draw from, and cars would drive on the runway.
- A picker that compares a cell against one representative depth rejects half of any object longer than the tolerance. Store the depth span.

# Approach

- `src/render/mesh.js` (new) holds the projection and rasterization that were private to `vehicles.js`, plus `strokeSegment` for thin structure. `vehicles.js` now imports them; `renderer-snapshot.test.js` passed unchanged, which is what says the extraction was behaviour-preserving.
- `src/render/aircraft-model.js` (new) is a static designator to dimensions table, ~45 types, resolving exact then family prefix then ADS-B category then generic, and reporting which tier it used.
- `src/render/aircraft-mesh.js` (new) builds fuselage, wings, tailplane, fin and engines in the aircraft frame, rotated by track and by the flight path angle derived from vertical and ground speed. Three LOD tiers by apparent wingspan in columns. Navigation lights are real and carry the silhouette at night.
- Runways, taxiways and aprons are new surface types laid by `_layAeroway`, deliberately outside the road path.

# Provenance

Position, altitude, speed, track, vertical rate, registration and type designator are OBSERVED. The hull dimensions are DERIVED from the published type; the info panel says so, and says when only the size category was known. Nothing is SIMULATED.

# Verified

- Real ORD OpenStreetMap data through the browser: 240 aeroway elements, 64,181 runway cells, 105,999 taxiway, 33,201 apron, and `roadCells` unaffected.
- Headless frames standing on 09R/27L with arrivals inbound, in both cinematic and glyph modes.
- Growth is monotonic across 8 km, 2 km, 500 m and 150 m, and a 777 draws more than a CRJ at the same range. A test asserting only "something was drawn" would have passed the old code.
- Clicking the aircraft returns it with tail number and type; clicking the runway beneath it still returns ground.
- `npm run check`: 245 pass, lint clean. Up from 224.

# Measured

`npm run benchmark` gained an `Arrival stream` scene, 40 contacts over the demo city. The aircraft draw is about 0.3 ms p50 with the mesh budget at 12, and it is the cheapest scene in the set. No other scene runs the aircraft layer, so none of them can see this cost.

# Verify next time

- Live traffic at a genuinely busy field. The synthetic and injected sets are deterministic and cannot reproduce the contact volume ORD delivers now that surface traffic is kept.
- The 20 s poll with one-sample-delayed interpolation was tuned for en-route contacts. An aircraft in the flare covers about 1.3 km between polls, so touchdown itself is interpolated, not observed. Whether that reads convincingly at close range is a judgement only live use can settle.
- `MAX_BBOX_DEG2` allows the ORD preset only because a runway box is long and thin. A squarer airfield may not fit and would need the streaming path from the first load.

# Prevents

- Assuming a rendering symptom has one cause. The glyph not growing and the aircraft never landing were unrelated defects in different files, and the runway was a third.
- Reaching for an external lookup when the data is already in the payload and simply discarded.

# Look here first

- src/render/aircraft-mesh.js
- src/render/aircraft-model.js
- src/render/mesh.js
- src/aircraft.js
- src/world/osm.js `_layAeroway`
